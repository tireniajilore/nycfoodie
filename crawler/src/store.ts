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
  tagListing(listingId, upsertTag(citySlug, kind, slug, label ?? slug));
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
  const existing = db
    .prepare(`SELECT id FROM restaurants WHERE city_slug = ? AND lower(name) = lower(?)`)
    .get(citySlug, name.trim()) as { id: string } | undefined;
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
    name.trim(),
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
