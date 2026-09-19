// Write path: upsert normalised Infatuation data into nycfoodie-db.
// All timestamps are ISO-8601 UTC text, per db/migrations/README.md.

import { randomUUID } from "node:crypto";
import { migrate } from "nycfoodie-db/dist/migrate.js";
import { getDb, openDb } from "nycfoodie-db";
import type {
  RawPostReview,
  RawNeighborhood,
  RawCuisine,
  RawCategory,
} from "./infatuation/types.js";
import type { EnrichedReview } from "./infatuation/pagedata.js";
import { slugify } from "./infatuation/pagedata.js";

export const SOURCE_SLUG = "infatuation";
export const SOURCE_NAME = "The Infatuation";
export const SOURCE_BASE_URL = "https://www.theinfatuation.com";

function now(): string {
  return new Date().toISOString();
}

export function initStore(dbPath: string): void {
  migrate(dbPath);
  openDb(dbPath);
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO sources (slug, name, base_url, created_at) VALUES (?, ?, ?, ?)`
  ).run(SOURCE_SLUG, SOURCE_NAME, SOURCE_BASE_URL, now());
}

export function ensureCity(
  slug: string,
  name: string,
  countryCode = "US",
  timezone = "America/New_York"
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO cities (slug, name, country_code, timezone, created_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(slug, name, countryCode, timezone, now());
}

const PRICE_TIER: Record<string, number> = {
  INEXPENSIVE: 1,
  MODERATELY_EXPENSIVE: 2,
  EXPENSIVE: 3,
  VERY_EXPENSIVE: 4,
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function trunc(s: string, n = 280): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Heuristic v0: classify booking policy from reservation tips prose. */
export function bookingIntel(tips: string | string[] | undefined): {
  policy: string | null;
  waitNotes: string | null;
} {
  const text = Array.isArray(tips) ? tips.join(" ") : (tips ?? "");
  if (!text.trim()) return { policy: null, waitNotes: null };
  const t = text;
  if (/does not (take|accept) reservations|reservations are not accepted|no reservations/i.test(t)) {
    return { policy: "walk-in-only", waitNotes: trunc(t) };
  }
  if (/walk-?ins?/i.test(t) && !/reservation/i.test(t)) {
    return { policy: "walk-in-only", waitNotes: trunc(t) };
  }
  if (/reservation/i.test(t)) {
    return {
      policy: "reservations-recommended",
      waitNotes: /wait|line|walk-?in|advance/i.test(t) ? trunc(t) : null,
    };
  }
  return { policy: null, waitNotes: /wait|line/i.test(t) ? trunc(t) : null };
}

function pathSlug(p: string | undefined): string | null {
  if (!p) return null;
  const seg = p.split("/").filter(Boolean).pop();
  return seg ?? null;
}

function upsertTag(
  citySlug: string,
  kind: string,
  slug: string,
  label: string
): string {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM tags WHERE city_slug = ? AND kind = ? AND slug = ?`)
    .get(citySlug, kind, slug) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tags (id, city_slug, kind, slug, label, source_slug) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, citySlug, kind, slug, label, SOURCE_SLUG);
  return id;
}

function tagListing(listingId: string, tagId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO listing_tags (source_listing_id, tag_id) VALUES (?, ?)`)
    .run(listingId, tagId);
}

function tagFromPath(
  citySlug: string,
  listingId: string,
  kind: string,
  attrPath: string | undefined,
  label: string | undefined
): void {
  const slug = pathSlug(attrPath) ?? (label ? slugify(label) : null);
  if (!slug) return;
  const cleanLabel = label?.trim() || slug;
  if (!cleanLabel) return;
  tagListing(listingId, upsertTag(citySlug, kind, slug, cleanLabel));
}

/** Canonical name key: fold curly quotes/apostrophes so "L’industrie" and
 *  "L'industrie" match instead of creating duplicate restaurant rows. */
export function canonicalName(name: string): string {
  return name.replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').trim();
}

/** Match-or-create the canonical restaurant row. MVP rule: same city + normalised name. */
function matchOrCreateRestaurant(
  citySlug: string,
  name: string,
  addr: {
    address_line1?: string | null;
    locality?: string | null;
    region?: string | null;
    postal_code?: string | null;
    country_code?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    phone?: string | null;
    website?: string | null;
    price_tier?: number | null;
  }
): string {
  const db = getDb();
  const clean = canonicalName(name);
  const existing = db
    .prepare(`SELECT id FROM restaurants WHERE city_slug = ? AND lower(name) = lower(?)`)
    .get(citySlug, clean) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO restaurants
      (id, city_slug, name, address_line1, locality, region, postal_code, country_code,
       latitude, longitude, phone, website, price_tier, timezone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    citySlug,
    clean,
    addr.address_line1 ?? null,
    addr.locality ?? null,
    addr.region ?? null,
    addr.postal_code ?? null,
    addr.country_code ?? null,
    addr.latitude ?? null,
    addr.longitude ?? null,
    addr.phone ?? null,
    addr.website ?? null,
    addr.price_tier ?? null,
    null,
    ts,
    ts
  );
  return id;
}

export interface ListingResult {
  listingId: string;
  restaurantId: string;
}

/** Upsert one review node (layer A) plus optional enrichment (layer B). */
export function upsertReviewListing(
  raw: RawPostReview,
  citySlug: string,
  enriched: EnrichedReview | null
): ListingResult | null {
  const name = raw.placeName?.trim();
  // source_key is the URL slug: it's the stable cross-reference between the
  // search API, guide entries and page-data URLs.
  const sourceKey = raw.slugName ?? raw.documentIdentifier;
  if (!name || !sourceKey) return null;
  const db = getDb();
  const ts = now();

  const rating =
    raw.placeRatingNumber && raw.placeRatingNumber > 0 ? round1(raw.placeRatingNumber) : null;
  const priceTier = raw.placePriceIndicatorCode
    ? (PRICE_TIER[raw.placePriceIndicatorCode] ?? null)
    : null;
  const intel = bookingIntel(raw.reservationTipsText);
  const venue = enriched?.venue;

  const restaurantId = matchOrCreateRestaurant(citySlug, name, {
    address_line1: venue?.street ?? raw.placeStreetName ?? null,
    locality: venue?.city ?? raw.placeCityName ?? null,
    region: venue?.state ?? raw.placeStateName ?? null,
    postal_code: venue?.postalCode ?? raw.placeAddressPostalCode ?? null,
    country_code: venue?.country || raw.placeCountryName || null,
    latitude: venue?.lat ?? raw.placeLocation?.latitudeNumber ?? null,
    longitude: venue?.lon ?? raw.placeLocation?.longitudeNumber ?? null,
    phone: venue?.phone ?? raw.placeKnownTelephoneNumber ?? null,
    website: venue?.url ?? raw.placeUrl ?? null,
    price_tier: venue?.price ?? priceTier,
  });

  const sourceUrl =
    raw.url ??
    `${SOURCE_BASE_URL}${raw.canonicalPathText ?? "/" + citySlug}/reviews/${raw.slugName}`;

  const existing = db
    .prepare(`SELECT id, first_seen_at FROM source_listings WHERE source_slug = ? AND source_key = ?`)
    .get(SOURCE_SLUG, sourceKey) as { id: string; first_seen_at: string } | undefined;

  const listingId = existing?.id ?? randomUUID();
  const row = {
    id: listingId,
    source_slug: SOURCE_SLUG,
    restaurant_id: restaurantId,
    source_key: sourceKey,
    source_url: sourceUrl,
    name,
    rating,
    rating_scale: rating !== null ? 10 : null,
    review_count: raw.communityScores?.surveyRecordCount ?? null,
    price_label: raw.placePriceIndicatorCode ?? null,
    price_tier: priceTier,
    price_per_head_min: null,
    price_per_head_max: null,
    price_currency: null,
    reservation_url:
      raw.placeReservationUrl ?? raw.openTableReservationUrl ?? venue?.reservationUrl ?? null,
    reservation_platform: raw.placeReservationPlatformName ?? null,
    booking_policy: intel.policy,
    typical_wait_minutes: null,
    wait_notes: intel.waitNotes,
    hours_json: null,
    is_closed:
      venue?.closed === true ? 1 : venue?.closed === false ? 0 : null,
    closed_status: venue?.closedStatus ?? null,
    phone: venue?.phone ?? raw.placeKnownTelephoneNumber ?? null,
    website: venue?.url ?? raw.placeUrl ?? null,
    address_line1: venue?.street ?? raw.placeStreetName ?? null,
    locality: venue?.city ?? raw.placeCityName ?? null,
    region: venue?.state ?? raw.placeStateName ?? null,
    postal_code: venue?.postalCode ?? raw.placeAddressPostalCode ?? null,
    latitude: venue?.lat ?? raw.placeLocation?.latitudeNumber ?? null,
    longitude: venue?.lon ?? raw.placeLocation?.longitudeNumber ?? null,
    first_seen_at: existing?.first_seen_at ?? ts,
    last_seen_at: ts,
    last_crawled_at: ts,
    checksum: null as string | null,
  };
  row.checksum = checksumListing(raw);

  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  const updates = cols
    .filter((c) => c !== "id" && c !== "first_seen_at")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  db.prepare(
    `INSERT INTO source_listings (${cols.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (source_slug, source_key) DO UPDATE SET ${updates}`
  ).run(...cols.map((c) => (row as Record<string, unknown>)[c]));

  // Tags from layer A taxonomies.
  for (const n of raw.neighborhoods ?? []) {
    const nb = n as RawNeighborhood;
    tagFromPath(citySlug, listingId, "neighborhood", nb.neighborhoodAttributePathText, nb.neighborhoodDisplayName ?? nb.neighborhoodName);
  }
  for (const c of raw.cuisines ?? []) {
    const cu = c as RawCuisine;
    tagFromPath(citySlug, listingId, "cuisine", cu.cuisineAttributePathText, cu.cuisineDisplayName || cu.cuisineName);
  }
  for (const c of raw.categories ?? []) {
    const cat = c as RawCategory;
    const p = cat.categoryAttributePathText ?? "";
    const kind = p.includes("/perfect-for/") ? "occasion" : p.includes("/cuisines/") ? "cuisine" : p.includes("/neighborhoods/") ? "neighborhood" : "occasion";
    tagFromPath(citySlug, listingId, kind, p, cat.categoryDisplayName ?? cat.categoryDocumentName);
  }
  // Perfect-for names from layer B (dedupe via tag UNIQUE).
  for (const label of enriched?.perfectFor ?? []) {
    tagListing(listingId, upsertTag(citySlug, "occasion", slugify(label), label));
  }

  // Review + dishes from enrichment.
  if (enriched) {
    const reviewId = randomUUID();
    db.prepare(
      `INSERT INTO reviews (id, source_listing_id, title, headline, summary, body_text, rating, author, url, published_at, updated_at, last_crawled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_listing_id) DO UPDATE SET
         title = excluded.title, headline = excluded.headline, summary = excluded.summary,
         body_text = excluded.body_text, rating = excluded.rating, author = excluded.author,
         url = excluded.url, published_at = excluded.published_at, updated_at = excluded.updated_at,
         last_crawled_at = excluded.last_crawled_at`
    ).run(
      reviewId,
      listingId,
      enriched.title,
      enriched.headline,
      enriched.preview,
      enriched.bodyMarkdown || null,
      enriched.rating,
      enriched.author,
      sourceUrl,
      enriched.publishedAt,
      null,
      ts
    );
    const rev = db
      .prepare(`SELECT id FROM reviews WHERE source_listing_id = ?`)
      .get(listingId) as { id: string };
    db.prepare(`DELETE FROM dishes WHERE review_id = ?`).run(rev.id);
    enriched.dishes.forEach((d, i) => {
      db.prepare(
        `INSERT INTO dishes (id, review_id, position, name, description) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), rev.id, i + 1, d.name, d.description);
    });
  }

  return { listingId, restaurantId };
}

function checksumListing(raw: RawPostReview): string {
  const s = JSON.stringify([
    raw.placeName,
    raw.placeRatingNumber,
    raw.placePriceIndicatorCode,
    raw.headline,
    raw.shortDescriptionText,
    raw.updateTimestamp,
  ]);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Read the saved pagination cursor for (source, city, collection), if any. */
export function getCrawlCursor(citySlug: string, collection: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT last_cursor FROM crawl_state WHERE source_slug = ? AND city_slug = ? AND collection = ?`
    )
    .get(SOURCE_SLUG, citySlug, collection) as { last_cursor: string | null } | undefined;
  return row?.last_cursor ?? null;
}

/** Record a crawl watermark for (source, city, collection). */
export function recordCrawlState(
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
    .run(SOURCE_SLUG, citySlug, collection, now(), lastCursor, itemCount, null);
}

export type { GooglePlaceMatch } from "./google/places.js";

/** Write a Google Places verification result onto the canonical restaurant. */
export function recordGoogleVerification(
  restaurantId: number,
  match: import("./google/places.js").GooglePlaceMatch,
  checkedAt: string
): void {
  getDb()
    .prepare(
      `UPDATE restaurants
       SET google_place_id = ?, google_business_status = ?,
           google_match_confidence = ?, google_last_checked_at = ?
       WHERE id = ?`
    )
    .run(match.placeId, match.businessStatus, match.confidence, checkedAt, restaurantId);
}

/** Mark a restaurant as checked-but-unmatched so it isn't retried immediately. */
export function recordGoogleCheckedNoMatch(restaurantId: number, checkedAt: string): void {
  getDb()
    .prepare(`UPDATE restaurants SET google_last_checked_at = ? WHERE id = ?`)
    .run(checkedAt, restaurantId);
}

/** Upsert a guide; returns its id. */
export function upsertGuide(
  citySlug: string,
  guide: {
    sourceKey: string;
    title: string;
    url: string;
    summary: string | null;
    publishedAt: string | null;
    updatedAt: string | null;
  }
): string {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM guides WHERE source_slug = ? AND source_key = ?`)
    .get(SOURCE_SLUG, guide.sourceKey) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  db.prepare(
    `INSERT INTO guides (id, source_slug, city_slug, source_key, title, url, summary,
                         published_at, updated_at, last_crawled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_slug, source_key) DO UPDATE SET
       title = excluded.title, url = excluded.url, summary = excluded.summary,
       published_at = excluded.published_at, updated_at = excluded.updated_at,
       last_crawled_at = excluded.last_crawled_at`
  ).run(
    id,
    SOURCE_SLUG,
    citySlug,
    guide.sourceKey,
    guide.title,
    guide.url,
    guide.summary,
    guide.publishedAt,
    guide.updatedAt,
    now()
  );
  return id;
}

/**
 * Upsert one ranked guide entry. Links to the listing through the review
 * slug (source_listings.source_key). Entries that resolve to no known
 * listing keep their position and blurb but stay unlinked (NULL) — never
 * guessed, never dropped (dropping would corrupt the ranking).
 */
export function upsertGuideEntry(
  guideId: string,
  entry: { position: number; sourceKey: string; name: string | null; blurb: string | null }
): { linked: boolean } {
  const db = getDb();
  const listing = db
    .prepare(`SELECT id FROM source_listings WHERE source_slug = ? AND source_key = ?`)
    .get(SOURCE_SLUG, entry.sourceKey) as { id: string } | undefined;
  const existing = db
    .prepare(`SELECT id FROM guide_entries WHERE guide_id = ? AND position = ?`)
    .get(guideId, entry.position) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  // A re-crawl may resolve a previously unlinked entry; the old
  // (guide_id, source_listing_id) unique row is replaced by upserting on
  // (guide_id, position), deleting any conflicting listing-link row first.
  db.prepare(
    `DELETE FROM guide_entries
     WHERE guide_id = ? AND source_listing_id IS NOT NULL
       AND source_listing_id = ? AND position != ?`
  ).run(guideId, listing?.id ?? null, entry.position);
  db.prepare(
    `INSERT INTO guide_entries (id, guide_id, source_listing_id, position, entry_name, blurb)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (guide_id, position) DO UPDATE SET
       source_listing_id = excluded.source_listing_id,
       entry_name = excluded.entry_name,
       blurb = excluded.blurb`
  ).run(id, guideId, listing?.id ?? null, entry.position, entry.name, entry.blurb);
  return { linked: !!listing };
}

/** Candidate listings for enrichment: rated, no review prose stored yet. */
export function enrichmentCandidates(
  citySlug: string,
  limit: number
): Array<{ id: string; source_key: string; source_url: string; name: string }> {
  return getDb()
    .prepare(
      `SELECT sl.id, sl.source_key, sl.source_url, sl.name
       FROM source_listings sl
       LEFT JOIN reviews r ON r.source_listing_id = sl.id
       WHERE sl.rating IS NOT NULL
         AND r.id IS NULL
         AND sl.source_url LIKE '%/' || ? || '/%'
       ORDER BY sl.rating DESC
       LIMIT ?`
    )
    .all(citySlug, limit) as Array<{
    id: string;
    source_key: string;
    source_url: string;
    name: string;
  }>;
}

/**
 * Apply layer-B page data to an existing listing: venue fields (never
 * clobbering layer-A values with NULL), the review prose row, dishes and
 * perfect-for tags. Booking intel stays as-is — it comes from layer A.
 */
export function applyEnrichment(
  citySlug: string,
  listingId: string,
  sourceUrl: string,
  enriched: EnrichedReview
): void {
  const db = getDb();
  const ts = now();
  const v = enriched.venue;
  db.prepare(
    `UPDATE source_listings SET
       phone = COALESCE(?, phone),
       website = COALESCE(?, website),
       address_line1 = COALESCE(?, address_line1),
       locality = COALESCE(?, locality),
       region = COALESCE(?, region),
       postal_code = COALESCE(?, postal_code),
       latitude = COALESCE(?, latitude),
       longitude = COALESCE(?, longitude),
       price_tier = COALESCE(?, price_tier),
       reservation_url = COALESCE(?, reservation_url),
       is_closed = COALESCE(?, is_closed),
       closed_status = COALESCE(?, closed_status),
       last_crawled_at = ?
     WHERE id = ?`
  ).run(
    v.phone ?? null,
    v.url ?? null,
    v.street ?? null,
    v.city ?? null,
    v.state ?? null,
    v.postalCode ?? null,
    v.lat ?? null,
    v.lon ?? null,
    v.price ?? null,
    v.reservationUrl ?? null,
    v.closed === true ? 1 : v.closed === false ? 0 : null,
    v.closedStatus ?? null,
    ts,
    listingId
  );

  const reviewId = randomUUID();
  db.prepare(
    `INSERT INTO reviews (id, source_listing_id, title, headline, summary, body_text, rating, author, url, published_at, updated_at, last_crawled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_listing_id) DO UPDATE SET
       title = excluded.title, headline = excluded.headline, summary = excluded.summary,
       body_text = excluded.body_text, rating = excluded.rating, author = excluded.author,
       url = excluded.url, published_at = excluded.published_at, updated_at = excluded.updated_at,
       last_crawled_at = excluded.last_crawled_at`
  ).run(
    reviewId,
    listingId,
    enriched.title ?? null,
    enriched.headline ?? null,
    enriched.preview ?? null,
    enriched.bodyMarkdown || null,
    enriched.rating ?? null,
    enriched.author ?? null,
    sourceUrl,
    enriched.publishedAt ?? null,
    null,
    ts
  );
  const rev = db
    .prepare(`SELECT id FROM reviews WHERE source_listing_id = ?`)
    .get(listingId) as { id: string };
  db.prepare(`DELETE FROM dishes WHERE review_id = ?`).run(rev.id);
  enriched.dishes.forEach((d, i) => {
    db.prepare(
      `INSERT INTO dishes (id, review_id, position, name, description) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), rev.id, i + 1, d.name, d.description ?? null);
  });

  for (const label of enriched.perfectFor ?? []) {
    tagListing(listingId, upsertTag(citySlug, "occasion", slugify(label), label));
  }
}

/** Candidate venues for Google verification: have coordinates, not checked recently. */export function googleVerifyCandidates(
  citySlug: string,
  limit: number,
  recheckDays: number
): Array<{ id: number; name: string; lat: number; lng: number; best_rating: number | null }> {
  return getDb()
    .prepare(
      `SELECT r.id, r.name, sl.latitude AS lat, sl.longitude AS lng,
              MAX(rv.rating) AS best_rating
       FROM restaurants r
       JOIN source_listings sl ON sl.restaurant_id = r.id AND sl.source_slug = ?
       JOIN cities c ON c.id = sl.city_id AND c.slug = ?
       LEFT JOIN reviews rv ON rv.listing_id = sl.id
       WHERE sl.latitude IS NOT NULL AND sl.longitude IS NOT NULL
         AND (r.google_last_checked_at IS NULL
              OR r.google_last_checked_at < datetime('now', '-' || ? || ' days'))
       GROUP BY r.id
       ORDER BY best_rating DESC, r.id
       LIMIT ?`
    )
    .all(SOURCE_SLUG, citySlug, recheckDays, limit) as Array<{
    id: number;
    name: string;
    lat: number;
    lng: number;
    best_rating: number | null;
  }>;
}
