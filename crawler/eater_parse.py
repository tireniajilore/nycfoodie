"""Parse a Firecrawl-scraped Eater NY maps page (markdown) into structured entries.

Usage: python3 eater_parse.py /tmp/fc_map_<slug>.json
Writes /tmp/eater_parsed_<slug>.json with map meta + entries list.

Pilot learnings baked in:
- Entries are `## Name` sections in document order (position = order).
- A section is an entry if it has at least one Location/Phone/Website list
  item; this filters sponsored insertions (e.g. the Coqodaq US Open ad) and
  chrome sections ("More maps in Eater NY", "The Latest").
- The older template adds `**Open for:**` / `**Price range:**` lines; the
  newer template omits them, so they are optional.
- Entries never link to Eater venue pages; the name's website link is found by
  matching the link anchor text against the entry name.
- Address/phone live in trailing `- [Location...](google maps)` /
  `- [Phone...](tel:...)` list items.
"""
import json
import re
import sys
import unicodedata

MONTHS = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",
    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}
TZ_OFFSETS = {"EDT": "-04:00", "EST": "-05:00", "CDT": "-05:00", "CST": "-06:00",
              "MDT": "-06:00", "MST": "-07:00", "PDT": "-07:00", "PST": "-08:00"}


def parse_updated(text):
    # the byline ("Updated Sep 10, 2026, 1:23 PM EDT") sits below long nav /
    # image-URL lines, so search a generous window; first match wins
    m = re.search(
        r"[Uu]pdated\s+([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{4}),?\s+"
        r"(\d{1,2}):(\d{2})\s*([AP]M)\s*([A-Z]{2,4})?",
        text[:20000],
    )
    if not m:
        return None
    mon, day, year, hh, mm, ampm, tz = m.groups()
    mon = MONTHS.get(mon[:3].lower())
    if not mon:
        return None
    hh = int(hh)
    if ampm == "PM" and hh != 12:
        hh += 12
    if ampm == "AM" and hh == 12:
        hh = 0
    off = TZ_OFFSETS.get(tz or "", "-04:00")
    return f"{year}-{mon}-{int(day):02d}T{hh:02d}:{mm}:00{off}"


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return s.lower()


def parse_address(raw):
    """'766 E 152nd St, Bronx, NY, 10455, US' -> dict. Best effort."""
    out = {"address_line1": None, "locality": None, "region": None,
           "postal_code": None, "raw": raw}
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return out
    if re.fullmatch(r"US(A)?|United States", parts[-1], re.I):
        parts.pop()
    if not parts:
        return out
    # trailing "ST 12345" or "12345"
    m = re.match(r"^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$", parts[-1])
    if m:
        out["region"], out["postal_code"] = m.group(1), m.group(2)
        parts.pop()
    else:
        m = re.match(r"^(\d{5}(?:-\d{4})?)$", parts[-1])
        if m:
            out["postal_code"] = m.group(1)
            parts.pop()
        else:
            # "Queens 11104" -> locality + zip; but "New York 11215" after
            # "Brooklyn," is state + zip, not locality + zip
            m = re.match(r"^(.+?)\s+(\d{5}(?:-\d{4})?)$", parts[-1])
            if m and len(parts) >= 2:
                place, zipc = m.group(1).strip(), m.group(2)
                state = {"new york": "NY", "ny": "NY", "new jersey": "NJ",
                         "nj": "NJ", "connecticut": "CT", "ct": "CT"}.get(place.lower())
                if state:
                    out["region"], out["postal_code"] = state, zipc
                else:
                    out["locality"], out["postal_code"] = place, zipc
                parts.pop()
    if not parts:
        return out
    # missing-comma case: "46-11 Skillman Avenue Sunnyside"
    if out["locality"] is None and len(parts) == 1:
        # try to split trailing locality word(s): assume last 1-2 tokens before
        # a known borough/city name... keep simple: whole thing is line1
        out["address_line1"] = parts[0]
        return out
    out["address_line1"] = parts[0]
    if len(parts) >= 2 and out["locality"] is None:
        out["locality"] = parts[1]
    if len(parts) >= 3 and out["region"] is None:
        rm = re.match(r"^([A-Z]{2})$", parts[2])
        if rm:
            out["region"] = rm.group(1)
    return out


def clean_blurb(text):
    # drop image lines, the Location/Phone list items, and the stray "Link"
    # line that follows the entry heading in the newer template
    lines = []
    for line in text.split("\n"):
        s = line.strip()
        if not s or s.startswith("![") or re.match(r"^-\s*\[(Location|Phone)", s):
            continue
        if s == "Link":
            continue
        lines.append(line)
    text = "\n".join(lines)
    # markdown links -> anchor text
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # bold/italic markers
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def find_website(name, body):
    """Authoritative: the `- [LinkVisit website](url)` list item.
    Fallback: a blurb link whose anchor text matches the entry name."""
    m = re.search(r"-\s*\[LinkVisit website\]\((https?://[^)]+)\)", body)
    if m:
        return m.group(1)
    nn = norm(name)
    name_toks = {t for t in nn.split() if len(t) > 2}
    for anchor, url in re.findall(r"\[([^\]]+)\]\((https?://[^)]+)\)", body):
        if "eater.com" in url or "google.com/maps" in url:
            continue
        na = norm(anchor).strip()
        if not na:
            continue
        if na == nn or nn in na or na in nn:
            return url
        # tolerant: truncated anchors, e.g. "A&A Bake & Double and Roti Sho"
        anchor_toks = {t for t in na.split() if len(t) > 2}
        if name_toks and anchor_toks:
            overlap = len(name_toks & anchor_toks) / len(name_toks)
            if overlap >= 0.6:
                return url
    return None


def parse_map(md, meta_title, map_url):
    title = None
    m = re.search(r"^#\s+(.+)$", md, re.M)
    if m:
        title = m.group(1).strip()
    if not title and meta_title:
        title = re.sub(r"\s*\|\s*Eater.*$", "", meta_title).strip() or None
    updated = parse_updated(md)

    sections = re.split(r"^##\s+", md, flags=re.M)
    entries = []
    for sec in sections[1:]:
        nl = sec.find("\n")
        name = sec[:nl].strip() if nl != -1 else sec.strip()
        # unescape markdown-escaped chars in headings (e.g. "Ankara \#3")
        name = re.sub(r"\\([#\-\.\!\(\)\[\]\*\_])", r"\1", name)
        body = sec[nl + 1:] if nl != -1 else ""
        if not name or len(name) > 120:
            continue
        if name.lower() in {"see more", "more maps in eater ny"}:
            continue
        # colon may sit inside or outside the bold markers (**Price range:** vs
        # **Price range**:); the newer map template omits these metadata lines
        # entirely, so they are optional. What marks a real entry section is at
        # least one of the trailing Location/Phone/Website list items, which
        # sponsored insertions and chrome sections ("More maps...", "The
        # Latest") lack.
        mo = re.search(r"\*\*Open for:?\*\*:?\s*(.+)", body)
        mp = re.search(r"\*\*Price range:?\*\*:?\s*(\$+(?:\s*-\s*\$+)?)", body)
        has_contact = re.search(r"^-\s*\[(Location|Phone|LinkVisit website)",
                                body, re.M)
        if not has_contact:
            continue
        open_for = mo.group(1).strip() if mo else None
        price = re.sub(r"\s+", "", mp.group(1)) if mp else None
        # blurb: after the price line, before the Location item
        blurb_src = body
        if mp:
            blurb_src = body[mp.end():]
        loc = re.search(r"^-\s*\[Location", blurb_src, re.M)
        if loc:
            blurb_src = blurb_src[:loc.start()]
        blurb = clean_blurb(blurb_src)
        website = find_website(name, body)
        ma = re.search(r"^-\s*\[Location[^\n]*\n([^\]]+?)External Link\]\(", body, re.M)
        addr = parse_address(ma.group(1).strip()) if ma else {
            "address_line1": None, "locality": None, "region": None,
            "postal_code": None, "raw": None}
        mh = re.search(r"^-\s*\[Phone([^\]]+)\]\(tel:", body, re.M)
        phone = mh.group(1).strip() if mh else None
        entries.append({
            "name": name,
            "open_for": open_for,
            "price_range": price,
            "website": website,
            "phone": phone,
            "blurb": blurb,
            **{k: v for k, v in addr.items() if k != "raw"},
            "address_raw": addr["raw"],
        })
    slug = map_url.rstrip("/").split("/")[-1]
    return {
        "map_slug": slug,
        "map_url": map_url,
        "title": title,
        "updated_at": updated,
        "entries": entries,
    }


def main():
    src = sys.argv[1]
    d = json.load(open(src))
    data = d.get("data") or {}
    md = data.get("markdown") or ""
    meta = data.get("metadata") or {}
    # map url: prefer explicit argv[2], else metadata url
    map_url = sys.argv[2] if len(sys.argv) > 2 else (meta.get("url") or "")
    parsed = parse_map(md, meta.get("title"), map_url)
    slug = parsed["map_slug"]
    out = f"/tmp/eater_parsed_{slug}.json"
    json.dump(parsed, open(out, "w"), ensure_ascii=False, indent=1)
    print(f"map: {parsed['title']}")
    print(f"updated: {parsed['updated_at']}")
    print(f"entries: {len(parsed['entries'])}")
    print(f"wrote: {out}")
    for e in parsed["entries"][:3]:
        print(f"  - {e['name']} | {e['price_range']} | {e['address_line1']}")


if __name__ == "__main__":
    main()
