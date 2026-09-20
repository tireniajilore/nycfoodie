"""Ingest parsed Eater NY map(s) into nycfoodie.db.

Usage: python3 eater_ingest.py /tmp/eater_parsed_<slug>.json [/tmp/eater_parsed_<slug2>.json ...]
       python3 eater_ingest.py --pilot38   # re-ingest the Eater 38 from /tmp/eater38_entries.json

Idempotent: skips guides/listings/entries already present.
Writes open_for values to docs/eater-open-for.json (no schema home yet).

Linking (two-pass, per pilot):
  A.  exact name match on canonicalName folding (city new-york)
  A2. variant-tolerant: normalised-name equality or identical token sets
      (handles word order, &/and, quote styles)
  B.  address tiebreak as a SECOND pass: if exactly one restaurant shares the
      normalised address AND the names are similar -> link; if the names
      differ entirely -> FLAG (possible replacement, e.g. Zimmi's vs Bar a Part),
      do NOT auto-merge; the listing stays unlinked.
New canonicals only when name + address_line1 are both present and unflagged.
"""
import json
import os
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone
from uuid import uuid4

DB = os.environ.get("NYCFOODIE_DB",
                   os.path.expanduser("~/workspace/nycfoodie/nycfoodie.db"))
OPEN_FOR_PATH = os.path.expanduser("~/workspace/nycfoodie/docs/eater-open-for.json")
CITY = "new-york"

STOPWORDS = {"the", "a", "an", "of", "and", "bar", "restaurant", "cafe", "café",
             "nyc", "new", "york", "eatery", "kitchen", "house", "co"}

STREET_ABBR = {
    "street": "st", "avenue": "ave", "boulevard": "blvd", "road": "rd",
    "drive": "dr", "lane": "ln", "place": "pl", "plaza": "plz",
    "parkway": "pkwy", "terrace": "ter", "court": "ct", "circle": "cir",
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_name(name):
    return name.replace("\u2019", "'").replace("\u2018", "'").replace("`", "'") \
               .replace("\u00b4", "'").replace("\u201c", '"').replace("\u201d", '"').strip()


def slugify(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "venue"


def norm_name(name):
    s = canonical_name(name).lower()
    s = s.replace("&", " and ")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokens(name):
    return [t for t in norm_name(name).split() if t not in STOPWORDS and len(t) > 1]


def norm_addr(a):
    if not a:
        return ""
    s = a.lower()
    s = re.sub(r"[.,#]", "", s)
    for long, short in STREET_ABBR.items():
        s = re.sub(rf"\b{long}\b", short, s)
    s = re.sub(r"\b(suite|ste|floor|fl|unit|apt)\b\.?\s*\w*", "", s)
    return re.sub(r"\s+", " ", s).strip()


def name_similar(a, b):
    ta, tb = set(tokens(a)), set(tokens(b))
    if ta & tb:
        return True
    na, nb = norm_name(a).replace(" ", ""), norm_name(b).replace(" ", "")
    return bool(na) and (na in nb or nb in na)


class Linker:
    def __init__(self, db):
        self.db = db
        rows = db.execute(
            "SELECT id, name, address_line1 FROM restaurants WHERE city_slug = ?",
            (CITY,)).fetchall()
        self.by_exact = {}   # lower(canonical) -> id
        self.by_norm = {}    # norm_nospace -> id
        self.by_tokens = {}  # frozenset(tokens) -> id
        self.by_addr = {}    # norm_addr -> [(id, name)]
        for r in rows:
            rid, nm, ad = r["id"], r["name"], r["address_line1"]
            self.by_exact[nm.lower()] = rid
            nn = norm_name(nm).replace(" ", "")
            self.by_norm.setdefault(nn, rid)
            self.by_tokens.setdefault(frozenset(tokens(nm)), rid)
            if ad:
                self.by_addr.setdefault(norm_addr(ad), []).append((rid, nm))

    def link(self, name, address_line1):
        """Returns (restaurant_id|None, flag|None)."""
        clean = canonical_name(name)
        rid = self.by_exact.get(clean.lower())
        if rid:
            return rid, None
        nn = norm_name(clean).replace(" ", "")
        if nn in self.by_norm:
            return self.by_norm[nn], None
        ts = frozenset(tokens(clean))
        if ts and ts in self.by_tokens:
            return self.by_tokens[ts], None
        # pass B: address tiebreak
        if address_line1:
            cands = self.by_addr.get(norm_addr(address_line1), [])
            if len(cands) == 1:
                cid, cname = cands[0]
                if name_similar(clean, cname):
                    return cid, None
                return None, (f"address-match-name-mismatch: eater={clean!r} "
                              f"existing={cname!r} addr={address_line1!r}")
            if len(cands) > 1:
                return None, (f"address-ambiguous: eater={clean!r} "
                              f"addr={address_line1!r} matches {len(cands)}")
        return None, None

    def create_restaurant(self, name, e):
        rid = str(uuid4())
        ts = now()
        self.db.execute(
            """INSERT INTO restaurants
               (id, city_slug, name, address_line1, locality, region, postal_code,
                country_code, latitude, longitude, phone, website, price_tier,
                timezone, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rid, CITY, canonical_name(name), e.get("address_line1"),
             e.get("locality"), e.get("region"), e.get("postal_code"), "US",
             None, None, e.get("phone"), e.get("website"),
             price_tier(e.get("price_range")), None, ts, ts))
        # index for subsequent entries in this run
        self.by_exact[canonical_name(name).lower()] = rid
        nn = norm_name(name).replace(" ", "")
        self.by_norm.setdefault(nn, rid)
        self.by_tokens.setdefault(frozenset(tokens(name)), rid)
        if e.get("address_line1"):
            self.by_addr.setdefault(norm_addr(e["address_line1"]), []).append((rid, name))
        return rid


def price_tier(label):
    first = re.split(r"\s*-\s*", (label or "").strip())[0]
    return {"$": 1, "$$": 2, "$$$": 3, "$$$$": 4}.get(first)


def ingest_map(db, linker, parsed, stats, flags):
    map_slug, map_url = parsed["map_slug"], parsed["map_url"]
    db.execute(
        "INSERT OR IGNORE INTO sources (slug, name, base_url, created_at)"
        " VALUES ('eater','Eater','https://ny.eater.com', ?)", (now(),))
    row = db.execute(
        "SELECT id FROM guides WHERE source_slug='eater' AND source_key=?",
        (map_slug,)).fetchone()
    if row:
        guide_id = row["id"]
        stats["maps_skipped"] += 1
    else:
        guide_id = str(uuid4())
        ts = now()
        db.execute(
            """INSERT INTO guides
               (id, source_slug, city_slug, source_key, title, url, guide_type,
                summary, published_at, updated_at, last_crawled_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (guide_id, "eater", CITY, map_slug, parsed["title"], map_url,
             "eater-map", None, None, parsed.get("updated_at"), ts))
        stats["maps"] += 1

    open_for_entries = []
    for i, e in enumerate(parsed["entries"], start=1):
        name = canonical_name(e["name"])
        name_slug = slugify(name)
        source_key = f"{map_slug}/{name_slug}"
        # collision fallback (same venue twice in one map)
        chk = db.execute(
            "SELECT id FROM source_listings WHERE source_slug='eater' AND source_key=?",
            (source_key,)).fetchone()
        if chk and chk["id"]:
            # verify it's the same map entry, else disambiguate
            source_key = f"{map_slug}/{name_slug}#{i}"
        existing = db.execute(
            "SELECT id, restaurant_id FROM source_listings WHERE source_slug='eater'"
            " AND source_key=?", (source_key,)).fetchone()
        if existing:
            listing_id = existing["id"]
            stats["listings_skipped"] += 1
        else:
            restaurant_id, flag = linker.link(name, e.get("address_line1"))
            if flag:
                flags.append(f"[{map_slug}#{i}] {flag}")
            new_canonical = False
            if not restaurant_id and not flag and e.get("address_line1"):
                restaurant_id = linker.create_restaurant(name, e)
                new_canonical = True
                stats["new_canonicals"].append(name)
            listing_id = str(uuid4())
            ts = now()
            db.execute(
                """INSERT INTO source_listings
                   (id, source_slug, restaurant_id, source_key, source_url, name,
                    rating, rating_scale, review_count, price_label, price_tier,
                    phone, website, address_line1, locality, region, postal_code,
                    first_seen_at, last_seen_at, last_crawled_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (listing_id, "eater", restaurant_id, source_key, map_url, name,
                 None, None, None, e.get("price_range"), price_tier(e.get("price_range")),
                 e.get("phone"), e.get("website"), e.get("address_line1"),
                 e.get("locality"), e.get("region"), e.get("postal_code"),
                 ts, ts, ts))
            stats["listings"] += 1
            if restaurant_id:
                stats["linked"] += 1
            else:
                stats["unlinked"] += 1
                if not flag:
                    flags.append(f"[{map_slug}#{i}] unlinked-no-address: {name!r}")

        erow = db.execute(
            "SELECT id FROM guide_entries WHERE guide_id=? AND position=?",
            (guide_id, i)).fetchone()
        if not erow:
            db.execute(
                """INSERT INTO guide_entries
                   (id, guide_id, source_listing_id, position, blurb, entry_name)
                   VALUES (?,?,?,?,?,?)""",
                (str(uuid4()), guide_id, listing_id, i, e.get("blurb"), name))
            stats["entries"] += 1
        else:
            stats["entries_skipped"] += 1
        if e.get("open_for"):
            open_for_entries.append(
                {"position": i, "name": name, "open_for": e["open_for"]})
    return guide_id, open_for_entries


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    use_pilot38 = "--pilot38" in sys.argv

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    linker = Linker(db)

    stats = {"maps": 0, "maps_skipped": 0, "entries": 0, "entries_skipped": 0,
             "listings": 0, "listings_skipped": 0, "linked": 0, "unlinked": 0,
             "new_canonicals": []}
    flags = []
    open_for_all = {}
    if os.path.exists(OPEN_FOR_PATH):
        open_for_all = json.load(open(OPEN_FOR_PATH))

    files = []
    if use_pilot38:
        e38 = json.load(open("/tmp/eater38_entries.json"))
        files.append(("pilot38", {
            "map_slug": "best-new-york-restaurants-38-map",
            "map_url": "https://ny.eater.com/maps/best-new-york-restaurants-38-map",
            "title": "The 38 Best Restaurants in New York City",
            "updated_at": "2026-07-09T16:20:00-04:00",
            "entries": e38,
        }))

    for f in args:
        parsed = json.load(open(f))
        with db:  # transaction per map
            gid, ofe = ingest_map(db, linker, parsed, stats, flags)
            if ofe:
                open_for_all[parsed["map_slug"]] = {
                    "title": parsed["title"], "entries": ofe}
    if use_pilot38:
        for label, parsed in files:
            with db:
                gid, ofe = ingest_map(db, linker, parsed, stats, flags)
                if ofe:
                    open_for_all[parsed["map_slug"]] = {
                        "title": parsed["title"], "entries": ofe}

    json.dump(open_for_all, open(OPEN_FOR_PATH, "w"), ensure_ascii=False, indent=1)

    print(json.dumps({**stats, "new_canonicals": stats["new_canonicals"]}, indent=1))
    print(f"open_for maps recorded: {len(open_for_all)}")
    if flags:
        print(f"FLAGS ({len(flags)}):")
        for fl in flags[:40]:
            print("  " + fl)


if __name__ == "__main__":
    main()
