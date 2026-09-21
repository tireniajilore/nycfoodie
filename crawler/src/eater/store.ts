// Database write path for the Eater crawler.
//
// Reuses matchOrCreateRestaurant / canonicalName / ensureCity from
// crawler/src/store.ts (the spec's "already source-generic" helpers) and
// adds the Eater-specific pieces: guide rows (guide_type 'eater-map'),
// composite `{guide-slug}/{venue-slug}` listing keys, and the variant-tolerant
// venue linker ported from the one-off ingestion (exact → normalised →
// token-set → address tiebreak).
//
// Honesty rules, enforced here and asserted by tests:
// - ratings and price tiers are NEVER written for Eater listings (Eater
//   abolished ratings; structured prices don't exist). Recrawls update only
//   the columns a map crawl actually produces and never null out columns
//   they don't own.
// - new canonical restaurants are created only when name AND address are
//   both present; otherwise the listing stays unlinked and is flagged for
//   human review instead of inventing a duplicate.
// - map pin coordinates and "Also featured in" cross-references are stored
//   with explicit provenance (also_featured_in_json, migration 016).

import { randomUUID } from "node:crypto";
import { migrate } from "nycfoodie-db/dist/migrate.js";
import { getDb, openDb } from "nycfoodie-db";
import { canonicalName, matchOrCreateRestaurant } from "../store.js";
import { slugify } from "../infatuation/pagedata.js";
import {
  EATER_BASE_URL,
  EATER_SOURCE_NAME,
  EATER_SOURCE_SLUG,
  type EaterCrawlStats,
  type EaterMapPage,
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

export function initEaterStore(dbPath: string): void {
  migrate(dbPath);
  openDb(dbPath);
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sources (slug, name, base_url, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(EATER_SOURCE_SLUG, EATER_SOURCE_NAME, EATER_BASE_URL, now());
}

/* ------------------------------------------------------------------ */
/* Name/address normalisation (ported from the one-off eater_ingest.py) */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  "the a an of and bar restaurant cafe café nyc new york eatery kitchen house co".split(" ")
);

const STREET_ABBR: Array<[RegExp, string]> = [
  "street",
  "avenue",
  "boulevard",
  "road",
  "drive",
  "lane",
  "place",
  "plaza",
  "parkway",
  "terrace",
  "court",
  "circle",
].map((w) => [new RegExp(`\\b${w}\\b`, "g"), { street: "st", avenue: "ave", boulevard: "blvd", road: "rd", drive: "dr", lane: "ln", place: "pl", plaza: "plz", parkway: "pkwy", terrace: "ter", court: "ct", circle: "cir" }[w]!]);

function normName(name: string): string {
  let s = canonicalName(name).toLowerCase().replace(/&/g, " and ");
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[^a-z0-9 ]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function tokens(name: string): string[] {
  return normName(name)
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t) && t.length > 1);
}

function tokenKey(name: string): string {
  return [...new Set(tokens(name))].sort().join(" ");
}

function normAddr(a: string | null): string {
  if (!a) return "";
  let s = a.toLowerCase().replace(/[.,#]/g, "");
  for (const [re, short] of STREET_ABBR) s = s.replace(re, short);
  s = s.replace(/\b(suite|ste|floor|fl|unit|apt)\b\.?\s*\w*/g, "");
  return s.replace(/\s+/g, " ").trim();
}

function nameSimilar(a: string, b: string): boolean {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  for (const t of ta) if (tb.has(t)) return true;
  const na = normName(a).replace(/ /g, "");
  const nb = normName(b).replace(/ /g, "");
  return !!na && (na.includes(nb) || nb.includes(na));
}

/* ------------------------------------------------------------------ */
/* Variant-tolerant venue linker                                         */
/* ------------------------------------------------------------------ */

type LinkOutcome =
  | { kind: "linked"; restaurantId: string }
  | { kind: "flag"; flag: string }
  | { kind: "none" };

class VenueLinker {
  private byExact = new Map<string, string>();
  private byNorm = new Map<string, string>();
  private byTokens = new Map<string, string>();
  private byAddr = new Map<string, Array<{ id: string; name: string }>>();

  constructor(citySlug: string) {
    const rows = getDb()
      .prepare(`SELECT id, name, address_line1 FROM restaurants WHERE city_slug = ?`)
      .all(citySlug) as Array<{ id: string; name: string; address_line1: string | null }>;
    for (const r of rows) this.index(r.id, r.name, r.address_line1);
  }

  private index(id: string, name: string, addr: string | null): void {
    this.byExact.set(canonicalName(name).toLowerCase(), id);
    const nn = normName(name).replace(/ /g, "");
    if (nn && !this.byNorm.has(nn)) this.byNorm.set(nn, id);
    const tk = tokenKey(name);
    if (tk && !this.byTokens.has(tk)) this.byTokens.set(tk, id);
    const na = normAddr(addr);
    if (na) {
      const list = this.byAddr.get(na) ?? [];
      list.push({ id, name });
      this.byAddr.set(na, list);
    }
  }

  /** Register a freshly created canonical so later entries in the run can link to it. */
  track(id: string, name: string, addr: string | null): void {
    this.index(id, name, addr);
  }

  link(name: string, addressLine1: string | null, ref: string): LinkOutcome {
    const clean = canonicalName(name);
    const hit = this.byExact.get(clean.toLowerCase());
    if (hit) return { kind: "linked", restaurantId: hit };
    const nn = normName(clean).replace(/ /g, "");
    const nhit = nn ? this.byNorm.get(nn) : undefined;
    if (nhit) return { kind: "linked", restaurantId: nhit };
    const tk = tokenKey(clean);
    const thit = tk ? this.byTokens.get(tk) : undefined;
    if (thit) return { kind: "linked", restaurantId: thit };
    // Address tiebreak as a second pass.
    if (addressLine1) {
      const cands = this.byAddr.get(normAddr(addressLine1)) ?? [];
      if (cands.length === 1) {
        const [c] = cands;
        if (nameSimilar(clean, c.name)) return { kind: "linked", restaurantId: c.id };
        return {
          kind: "flag",
          flag: `[${ref}] address-match-name-mismatch: eater=${JSON.stringify(clean)} existing=${JSON.stringify(c.name)} addr=${JSON.stringify(addressLine1)}`,
        };
      }
      if (cands.length > 1) {
        return {
          kind: "flag",
          flag: `[${ref}] address-ambiguous: eater=${JSON.stringify(clean)} addr=${JSON.stringify(addressLine1)} matches ${cands.length} venues`,
        };
      }
    }
    return { kind: "none" };
  }
}

/* ------------------------------------------------------------------ */
/* Guide / listing / entry upserts                                     */
/* ------------------------------------------------------------------ */

export function upsertEaterGuide(
  citySlug: string,
  guide: { sourceKey: string; title: string; url: string; publishedAt: string | null; updatedAt: string | null }
): string {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM guides WHERE source_slug = ? AND source_key = ?`)
    .get(EATER_SOURCE_SLUG, guide.sourceKey) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO guides (id, source_slug, city_slug, source_key, title, url, guide_type,
                         summary, published_at, updated_at, last_crawled_at)
     VALUES (?, ?, ?, ?, ?, ?, 'eater-map', NULL, ?, ?, ?)
     ON CONFLICT (source_slug, source_key) DO UPDATE SET
       title = excluded.title, url = excluded.url,
       published_at = excluded.published_at, updated_at = excluded.updated_at,
       last_crawled_at = excluded.last_crawled_at`
  ).run(
    id,
    EATER_SOURCE_SLUG,
    citySlug,
    guide.sourceKey,
    guide.title,
    guide.url,
    guide.publishedAt,
    guide.updatedAt,
    ts
  );
  return id;
}

function findListingByKey(
  sourceKey: string
): { id: string; restaurant_id: string | null; source_key: string } | undefined {
  return getDb()
    .prepare(
      `SELECT id, restaurant_id, source_key FROM source_listings WHERE source_slug = ? AND source_key = ?`
    )
    .get(EATER_SOURCE_SLUG, sourceKey) as
    | { id: string; restaurant_id: string | null; source_key: string }
    | undefined;
}

/**
 * Upsert one map entry's listing. Ratings and price columns are insert-only
 * NULL and are never touched on update: a map crawl carries no rating or
 * structured price data, and must not null out values another path wrote.
 */
function upsertEaterListing(
  citySlug: string,
  mapSlug: string,
  mapUrl: string,
  guideId: string,
  entry: {
    position: number;
    name: string;
    phone: string | null;
    website: string | null;
    address_line1: string | null;
    locality: string | null;
    region: string | null;
    postal_code: string | null;
    latitude: number | null;
    longitude: number | null;
    alsoFeaturedIn: string[];
  },
  linker: VenueLinker,
  stats: EaterCrawlStats
): { listingId: string; linked: boolean } {
  const db = getDb();
  const ts = now();
  const ref = `${mapSlug}#${entry.position}`;
  const name = canonicalName(entry.name);

  // Resolve the listing. If this guide+position already has an entry, its
  // listing is ours — this keeps recrawls idempotent even when names shift
  // slightly. Otherwise compute the composite key, disambiguating a
  // same-map duplicate with a `#position` suffix (the one-off's convention).
  let listing: { id: string; restaurant_id: string | null; source_key: string } | undefined;
  const priorEntry = db
    .prepare(`SELECT source_listing_id FROM guide_entries WHERE guide_id = ? AND position = ?`)
    .get(guideId, entry.position) as { source_listing_id: string } | undefined;
  if (priorEntry) listing = findListingById(priorEntry.source_listing_id);

  let sourceKey: string;
  if (listing) {
    sourceKey = listing.source_key;
  } else {
    const base = `${mapSlug}/${slugify(name) || "venue"}`;
    sourceKey = base;
    if (findListingByKey(base)) {
      sourceKey = `${base}#${entry.position}`;
      listing = findListingByKey(sourceKey); // a duplicate entry seen on an earlier crawl
    }
  }

  let restaurantId: string | null = listing?.restaurant_id ?? null;
  let linked = restaurantId !== null;

  // Link (or create) the canonical when there is none yet — either a fresh
  // listing, or a previously unlinked one whose recrawl now carries enough
  // data. Already-linked rows keep their link: re-running the linker on
  // every crawl would risk un-linking on transient name tweaks.
  if (restaurantId === null) {
    const outcome = linker.link(name, entry.address_line1, ref);
    if (outcome.kind === "linked") {
      restaurantId = outcome.restaurantId;
      linked = true;
    } else if (outcome.kind === "flag") {
      stats.flags.push(outcome.flag);
    } else if (entry.address_line1) {
      // New canonical only with name + address both present.
      restaurantId = matchOrCreateRestaurant(citySlug, name, {
        address_line1: entry.address_line1,
        locality: entry.locality,
        region: entry.region,
        postal_code: entry.postal_code,
        country_code: "US",
        phone: entry.phone,
        website: entry.website,
        price_tier: null,
      });
      linker.track(restaurantId, name, entry.address_line1);
      linked = true;
      stats.newCanonicals++;
    } else {
      stats.flags.push(`[${ref}] unlinked-no-address: ${JSON.stringify(name)}`);
    }
  }

  if (!listing) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO source_listings
        (id, source_slug, restaurant_id, source_key, source_url, name,
         rating, rating_scale, review_count, price_label, price_tier,
         phone, website, address_line1, locality, region, postal_code,
         latitude, longitude, also_featured_in_json,
         first_seen_at, last_seen_at, last_crawled_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      EATER_SOURCE_SLUG,
      restaurantId,
      sourceKey,
      mapUrl,
      name,
      entry.phone,
      entry.website,
      entry.address_line1,
      entry.locality,
      entry.region,
      entry.postal_code,
      entry.latitude,
      entry.longitude,
      entry.alsoFeaturedIn.length > 0 ? JSON.stringify(entry.alsoFeaturedIn) : null,
      ts,
      ts,
      ts
    );
    stats.listingsUpserted++;
    return { listingId: id, linked };
  }

  // Update path: refresh only what a map crawl owns. rating / price columns
  // are deliberately absent — never write NULL over another path's values.
  // restaurant_id is written only when this run resolved a link (it was NULL
  // before); an existing link is never overwritten.
  db.prepare(
    `UPDATE source_listings
     SET name = ?, source_url = ?, phone = ?, website = ?,
         address_line1 = ?, locality = ?, region = ?, postal_code = ?,
         latitude = ?, longitude = ?, also_featured_in_json = ?,
         restaurant_id = COALESCE(restaurant_id, ?),
         last_seen_at = ?, last_crawled_at = ?
     WHERE id = ?`
  ).run(
    name,
    mapUrl,
    entry.phone,
    entry.website,
    entry.address_line1,
    entry.locality,
    entry.region,
    entry.postal_code,
    entry.latitude,
    entry.longitude,
    entry.alsoFeaturedIn.length > 0 ? JSON.stringify(entry.alsoFeaturedIn) : null,
    restaurantId,
    ts,
    ts,
    listing.id
  );
  stats.listingsUpserted++;
  return { listingId: listing.id, linked };
}

function findListingById(id: string): { id: string; restaurant_id: string | null; source_key: string } | undefined {
  return getDb()
    .prepare(`SELECT id, restaurant_id, source_key FROM source_listings WHERE id = ?`)
    .get(id) as { id: string; restaurant_id: string | null; source_key: string } | undefined;
}

/**
 * Upsert one ranked guide entry. Same (guide_id, position) semantics as the
 * Infatuation path: a re-crawl may resolve a previously unlinked entry, so
 * the old listing-link row is replaced rather than duplicated.
 */
function upsertEaterGuideEntry(
  guideId: string,
  listingId: string,
  position: number,
  blurb: string | null
): void {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM guide_entries WHERE guide_id = ? AND position = ?`)
    .get(guideId, position) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  db.prepare(
    `DELETE FROM guide_entries
     WHERE guide_id = ? AND source_listing_id IS NOT NULL
       AND source_listing_id = ? AND position != ?`
  ).run(guideId, listingId, position);
  db.prepare(
    `INSERT INTO guide_entries (id, guide_id, source_listing_id, position, blurb)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guide_id, position) DO UPDATE SET
       source_listing_id = excluded.source_listing_id,
       blurb = excluded.blurb`
  ).run(id, guideId, listingId, position, blurb);
}

/**
 * Persist one parsed map page: guide row, then one listing + guide entry per
 * map entry. Idempotent — safe to re-run on every crawl. A map's writes are
 * one transaction: a mid-map failure rolls the map back instead of leaving
 * half-written listings, and the crawl moves on to the next map.
 */
export function crawlEaterMap(
  citySlug: string,
  page: EaterMapPage,
  linker: VenueLinker,
  stats: EaterCrawlStats
): void {
  const db = getDb();
  // Stats merge only on commit: a rolled-back map must not inflate counters.
  const local: EaterCrawlStats = {
    mapsDiscovered: 0,
    mapsFetched: 0,
    mapsNotModified: 0,
    mapsFailed: 0,
    entries: 0,
    listingsUpserted: 0,
    linked: 0,
    unlinked: 0,
    newCanonicals: 0,
    flags: [],
  };
  const run = db.transaction(() => {
    const guideId = upsertEaterGuide(citySlug, {
      sourceKey: page.slug,
      title: page.title,
      url: page.url,
      publishedAt: page.publishedAt,
      updatedAt: page.updatedAt,
    });
    for (const entry of page.entries) {
      const { listingId, linked } = upsertEaterListing(
        citySlug,
        page.slug,
        page.url,
        guideId,
        entry,
        linker,
        local
      );
      upsertEaterGuideEntry(guideId, listingId, entry.position, entry.blurb);
      local.entries++;
      if (linked) local.linked++;
      else local.unlinked++;
    }
  });
  run();
  stats.entries += local.entries;
  stats.listingsUpserted += local.listingsUpserted;
  stats.linked += local.linked;
  stats.unlinked += local.unlinked;
  stats.newCanonicals += local.newCanonicals;
  stats.flags.push(...local.flags);
}

/** Exported for crawl orchestration: one linker per crawl run. */
export { VenueLinker };

/** Record a crawl watermark for (eater, city, collection). */
export function recordEaterCrawlState(
  citySlug: string,
  collection: string,
  itemCount: number,
  lastCursor: string | null
): void {
  getDb()
    .prepare(
      `INSERT INTO crawl_state (source_slug, city_slug, collection, last_crawled_at, last_cursor, item_count, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_slug, city_slug, collection) DO UPDATE SET
         last_crawled_at = excluded.last_crawled_at, last_cursor = excluded.last_cursor,
         item_count = excluded.item_count`
    )
    .run(EATER_SOURCE_SLUG, citySlug, collection, now(), lastCursor, itemCount, null);
}
