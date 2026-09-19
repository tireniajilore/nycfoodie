// Query layer for the nycfoodie MCP server (read-only).
//
// Every tool resolves restaurants to their single "primary" Infatuation
// listing: the one with review prose wins, then the highest rating.
// Known-closed venues are excluded unless include_closed is set.

import type { Database } from "better-sqlite3";

const SOURCE = "infatuation";

/** One primary listing per restaurant: prose first, then highest rating. */
const PRIMARY_LISTINGS_CTE = `primary_listings AS (
  SELECT * FROM (
    SELECT sl.*,
      ROW_NUMBER() OVER (
        PARTITION BY sl.restaurant_id
        ORDER BY (rv.id IS NOT NULL) DESC, sl.rating DESC
      ) AS rn
    FROM source_listings sl
    LEFT JOIN reviews rv ON rv.source_listing_id = sl.id
    WHERE sl.source_slug = '${SOURCE}'
  )
  WHERE rn = 1
)`;

export interface Filters {
  city: string;
  query?: string;
  cuisine?: string;
  neighborhood?: string;
  occasion?: string;
  minRating?: number;
  priceTier?: number;
  includeClosed?: boolean;
  lat?: number;
  lng?: number;
  radiusKm?: number;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

interface CardRow {
  id: string;
  name: string;
  rating: number | null;
  price_tier: number | null;
  price_label: string | null;
  locality: string | null;
  address_line1: string | null;
  latitude: number | null;
  longitude: number | null;
  is_closed: number | null;
  booking_policy: string | null;
  cuisines: string | null;
  neighborhoods: string | null;
  guide_count: number;
  review_headline: string | null;
}

function buildWhere(f: Filters, params: unknown[]): string {
  const conds: string[] = ["r.city_slug = ?"];
  params.push(f.city);
  if (!f.includeClosed) conds.push("(pl.is_closed IS NULL OR pl.is_closed = 0)");
  if (f.minRating !== undefined) {
    conds.push("pl.rating >= ?");
    params.push(f.minRating);
  }
  if (f.priceTier !== undefined) {
    conds.push("pl.price_tier = ?");
    params.push(f.priceTier);
  }
  const tagFilter = (kind: string, value: string) => {
    conds.push(
      `EXISTS (SELECT 1 FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
        WHERE lt.source_listing_id = pl.id AND t.kind = ? AND t.label LIKE ? ESCAPE '\\')`
    );
    params.push(kind, `%${likeEscape(value)}%`);
  };
  if (f.cuisine) tagFilter("cuisine", f.cuisine);
  if (f.neighborhood) tagFilter("neighborhood", f.neighborhood);
  if (f.occasion) tagFilter("occasion", f.occasion);
  if (f.query) {
    for (const tok of f.query.split(/\s+/).filter(Boolean)) {
      conds.push(
        `(r.name LIKE ? ESCAPE '\\' OR pl.name LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
            WHERE lt.source_listing_id = pl.id AND t.label LIKE ? ESCAPE '\\'))`
      );
      const p = `%${likeEscape(tok)}%`;
      params.push(p, p, p);
    }
  }
  if (f.lat !== undefined && f.lng !== undefined && f.radiusKm !== undefined) {
    // Bounding box pre-filter; exact distance is computed in JS.
    const dLat = f.radiusKm / 111;
    const dLng = f.radiusKm / (111 * Math.cos((f.lat * Math.PI) / 180));
    conds.push("pl.latitude BETWEEN ? AND ?");
    params.push(f.lat - dLat, f.lat + dLat);
    conds.push("pl.longitude BETWEEN ? AND ?");
    params.push(f.lng - dLng, f.lng + dLng);
  }
  return conds.length ? `WHERE ${conds.join(" AND ")}` : "";
}

const CARD_SELECT = `
  WITH ${PRIMARY_LISTINGS_CTE}
  SELECT r.id, r.name,
    pl.rating, pl.price_tier, pl.price_label, pl.locality,
    pl.address_line1, pl.latitude, pl.longitude, pl.is_closed, pl.booking_policy,
    (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.source_listing_id = pl.id AND t.kind = 'cuisine') AS cuisines,
    (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.source_listing_id = pl.id AND t.kind = 'neighborhood') AS neighborhoods,
    (SELECT COUNT(DISTINCT ge.guide_id) FROM guide_entries ge
      WHERE ge.source_listing_id = pl.id) AS guide_count,
    rv.headline AS review_headline
  FROM restaurants r
  JOIN primary_listings pl ON pl.restaurant_id = r.id
  LEFT JOIN reviews rv ON rv.source_listing_id = pl.id`;

function toCard(row: CardRow, distanceKm?: number): Record<string, unknown> {
  const card: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    rating: row.rating,
    price_tier: row.price_tier,
    price_label: row.price_label,
    neighborhood: row.neighborhoods?.split("|")[0] ?? row.locality,
    cuisines: row.cuisines?.split("|") ?? [],
    address: row.address_line1,
    guide_appearances: row.guide_count,
  };
  if (row.booking_policy) card.booking = row.booking_policy;
  if (row.is_closed === 1) card.closed = true;
  if (row.review_headline) card.review_headline = row.review_headline;
  if (distanceKm !== undefined) card.distance_km = Math.round(distanceKm * 10) / 10;
  return card;
}

export function searchRestaurants(
  db: Database,
  f: Filters,
  limit = 10,
  sort: "rating" | "guides" | "distance" = "rating"
): Record<string, unknown>[] {
  const params: unknown[] = [];
  const where = buildWhere(f, params);
  const order =
    sort === "guides"
      ? "guide_count DESC, pl.rating DESC"
      : "pl.rating DESC, guide_count DESC";
  const rows = db
    .prepare(`${CARD_SELECT} ${where} ORDER BY ${order} LIMIT ?`)
    .all(...params, limit) as CardRow[];
  const geo = f.lat !== undefined && f.lng !== undefined && f.radiusKm !== undefined;
  let cards = rows.map((r) => {
    const d =
      geo && r.latitude !== null && r.longitude !== null
        ? haversineKm(f.lat!, f.lng!, r.latitude, r.longitude)
        : undefined;
    return { card: toCard(r, d), d };
  });
  if (geo) {
    cards = cards.filter((c) => c.d !== undefined && c.d <= f.radiusKm!);
    if (sort === "distance" || sort === "rating") {
      cards.sort((a, b) =>
        sort === "distance" ? a.d! - b.d! : b.card.rating as number - (a.card.rating as number)
      );
    }
  }
  return cards.map((c) => c.card);
}

/** Resolve an id or a name to a canonical restaurant. */
export function resolveRestaurant(
  db: Database,
  city: string,
  idOrName: string
): { id: string; name: string } | null {
  const exact = db
    .prepare(
      `SELECT id, name FROM restaurants
       WHERE city_slug = ? AND (id = ? OR lower(name) = lower(?)) LIMIT 1`
    )
    .get(city, idOrName, idOrName) as { id: string; name: string } | undefined;
  if (exact) return exact;
  return db
    .prepare(
      `SELECT id, name FROM restaurants
       WHERE city_slug = ? AND name LIKE ? ESCAPE '\\'
       ORDER BY length(name) LIMIT 1`
    )
    .get(city, `%${likeEscape(idOrName)}%`) as { id: string; name: string } | undefined ?? null;
}

export function getRestaurant(
  db: Database,
  city: string,
  idOrName: string,
  includeProse = false
): Record<string, unknown> | null {
  const r = resolveRestaurant(db, city, idOrName);
  if (!r) return null;
  const row = db
    .prepare(
      `WITH ${PRIMARY_LISTINGS_CTE}
      SELECT r.name,
        pl.rating, pl.price_tier, pl.price_label, pl.address_line1, pl.locality,
        pl.region, pl.postal_code, pl.latitude, pl.longitude, pl.phone, pl.website,
        pl.reservation_url, pl.reservation_platform, pl.booking_policy, pl.wait_notes,
        pl.is_closed, pl.closed_status, pl.source_url,
        rv.title AS review_title, rv.headline AS review_headline, rv.summary AS review_summary,
        rv.body_text AS review_body, rv.author AS review_author,
        rv.published_at AS review_published_at, rv.url AS review_url
      FROM restaurants r
      JOIN primary_listings pl ON pl.restaurant_id = r.id
      LEFT JOIN reviews rv ON rv.source_listing_id = pl.id
      WHERE r.id = ?`
    )
    .get(r.id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const tags = db
    .prepare(
      `SELECT t.kind, t.label FROM listing_tags lt
       JOIN tags t ON t.id = lt.tag_id
       JOIN source_listings sl ON sl.id = lt.source_listing_id
       WHERE sl.restaurant_id = ? AND sl.source_slug = '${SOURCE}'
       ORDER BY t.kind, t.label`
    )
    .all(r.id) as { kind: string; label: string }[];
  const grouped: Record<string, string[]> = {};
  for (const t of tags) (grouped[t.kind] ??= []).push(t.label);
  const guides = db
    .prepare(
      `SELECT g.title, g.url, ge.position, ge.entry_name, ge.blurb FROM guide_entries ge
       JOIN guides g ON g.id = ge.guide_id
       JOIN source_listings sl ON sl.id = ge.source_listing_id
       WHERE sl.restaurant_id = ? AND sl.source_slug = '${SOURCE}'
       ORDER BY g.title, ge.position`
    )
    .all(r.id) as Record<string, unknown>[];
  const review: Record<string, unknown> = {
    title: row.review_title,
    headline: row.review_headline,
    summary: row.review_summary,
    author: row.review_author,
    published_at: row.review_published_at,
    url: row.review_url,
  };
  if (includeProse) review.body = row.review_body;
  return {
    id: r.id,
    name: row.name,
    rating: row.rating,
    price_tier: row.price_tier,
    price_label: row.price_label,
    address: {
      line1: row.address_line1,
      locality: row.locality,
      region: row.region,
      postal_code: row.postal_code,
      latitude: row.latitude,
      longitude: row.longitude,
    },
    phone: row.phone,
    website: row.website,
    reservation: row.reservation_url
      ? { url: row.reservation_url, platform: row.reservation_platform }
      : null,
    booking: row.booking_policy
      ? { policy: row.booking_policy, notes: row.wait_notes }
      : null,
    closed: row.is_closed === 1 ? { status: row.closed_status ?? true } : false,
    source_url: row.source_url,
    review: row.review_title ? review : null,
    tags: grouped,
    guide_appearances: guides,
  };
}

export function compareRestaurants(
  db: Database,
  city: string,
  idsOrNames: string[]
): Record<string, unknown>[] {
  return idsOrNames.map((s) => {
    const r = resolveRestaurant(db, city, s);
    if (!r) return { query: s, found: false };
    const full = getRestaurant(db, city, r.id, false)!;
    return {
      query: s,
      found: true,
      id: full.id,
      name: full.name,
      rating: full.rating,
      price_tier: full.price_tier,
      neighborhood: (full.tags as Record<string, string[]>).neighborhood?.[0] ?? null,
      cuisines: (full.tags as Record<string, string[]>).cuisine ?? [],
      good_for: ((full.tags as Record<string, string[]>).occasion ?? []).slice(0, 5),
      reservation: full.reservation ? true : false,
      booking: (full.booking as { policy: string } | null)?.policy ?? null,
      closed: full.closed,
      review_headline: (full.review as { headline: string } | null)?.headline ?? null,
      guide_appearances: (full.guide_appearances as unknown[]).length,
    };
  });
}

export function findGuides(
  db: Database,
  city: string,
  query: string | undefined,
  limit = 5
): Record<string, unknown>[] {
  const params: unknown[] = [city];
  let where = "g.city_slug = ?";
  if (query) {
    where += " AND (g.title LIKE ? ESCAPE '\\' OR g.summary LIKE ? ESCAPE '\\')";
    const p = `%${likeEscape(query)}%`;
    params.push(p, p);
  }
  const guides = db
    .prepare(
      `SELECT g.id, g.title, g.url, g.summary, g.published_at,
        (SELECT COUNT(*) FROM guide_entries ge WHERE ge.guide_id = g.id) AS entry_count
       FROM guides g WHERE ${where} ORDER BY g.published_at DESC LIMIT ?`
    )
    .all(...params, limit) as Record<string, unknown>[];
  return guides.map((g) => {
    const entries = db
      .prepare(
        `SELECT ge.position, ge.entry_name, ge.blurb,
           r.id AS restaurant_id, r.name AS restaurant_name, pl.rating
         FROM guide_entries ge
         LEFT JOIN source_listings pl ON pl.id = ge.source_listing_id
         LEFT JOIN restaurants r ON r.id = pl.restaurant_id
         WHERE ge.guide_id = ? ORDER BY ge.position`
      )
      .all(g.id) as Record<string, unknown>[];
    return { ...g, entries };
  });
}

export function findSimilar(
  db: Database,
  city: string,
  idOrName: string,
  limit = 10
): Record<string, unknown>[] | null {
  const r = resolveRestaurant(db, city, idOrName);
  if (!r) return null;
  const mine = db
    .prepare(
      `WITH ${PRIMARY_LISTINGS_CTE}
       SELECT id FROM primary_listings WHERE restaurant_id = ?`
    )
    .get(r.id) as { id: string } | undefined;
  if (!mine) return [];
  const rows = db
    .prepare(
      `WITH ${PRIMARY_LISTINGS_CTE}, my_tags AS (
         SELECT lt.tag_id, t.kind FROM listing_tags lt
         JOIN tags t ON t.id = lt.tag_id
         WHERE lt.source_listing_id = ?
       ),
       my_guides AS (
         SELECT DISTINCT guide_id FROM guide_entries WHERE source_listing_id = ?
       )
       SELECT r.id, r.name, pl.rating, pl.price_tier,
         (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
           WHERE lt.source_listing_id = pl.id AND t.kind = 'neighborhood') AS neighborhoods,
         COALESCE(SUM(CASE mt.kind WHEN 'cuisine' THEN 3 WHEN 'occasion' THEN 2
           WHEN 'neighborhood' THEN 2 ELSE 1 END), 0) AS tag_score,
         (SELECT COUNT(*) FROM guide_entries ge
           WHERE ge.source_listing_id = pl.id
             AND ge.guide_id IN (SELECT guide_id FROM my_guides)) AS guide_overlap
       FROM restaurants r
       JOIN primary_listings pl ON pl.restaurant_id = r.id
       LEFT JOIN listing_tags lt ON lt.source_listing_id = pl.id
       LEFT JOIN my_tags mt ON mt.tag_id = lt.tag_id
       WHERE r.city_slug = ? AND r.id != ?
         AND (pl.is_closed IS NULL OR pl.is_closed = 0)
       GROUP BY r.id
       HAVING tag_score > 0 OR guide_overlap > 0
       ORDER BY (tag_score + guide_overlap * 2) DESC, pl.rating DESC
       LIMIT ?`
    )
    .all(mine.id, mine.id, city, r.id, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    rating: row.rating,
    price_tier: row.price_tier,
    neighborhood: (row.neighborhoods as string | null)?.split("|")[0] ?? null,
    similarity: (row.tag_score as number) + (row.guide_overlap as number) * 2,
    shared_guides: row.guide_overlap,
  }));
}

export function guideConsensus(
  db: Database,
  city: string,
  theme: string | undefined,
  limit = 10
): Record<string, unknown>[] {
  const params: unknown[] = [city];
  let themeCond = "";
  if (theme) {
    themeCond = "AND (g.title LIKE ? ESCAPE '\\' OR g.summary LIKE ? ESCAPE '\\')";
    const p = `%${likeEscape(theme)}%`;
    params.push(p, p);
  }
  // Two-phase: (1) cheap guide-count ranking over all restaurants — no
  // per-restaurant subqueries; (2) details only for the top rows including
  // guide_count ties, so the scalar probes run on a handful of rows.
  const ranked = db
    .prepare(
      `SELECT sl.restaurant_id AS rid, COUNT(DISTINCT ge.guide_id) AS guide_count
       FROM guide_entries ge
       JOIN guides g ON g.id = ge.guide_id
       JOIN source_listings sl ON sl.id = ge.source_listing_id AND sl.source_slug = '${SOURCE}'
       JOIN restaurants r ON r.id = sl.restaurant_id
       WHERE r.city_slug = ? ${themeCond}
       GROUP BY sl.restaurant_id
       ORDER BY guide_count DESC`
    )
    .all(...params) as { rid: number; guide_count: number }[];
  if (ranked.length === 0) return [];
  // Tie-inclusive cutoff: every row at least as popular as the limit-th row.
  const cutoff = ranked[Math.min(limit, ranked.length) - 1].guide_count;
  const contenders = ranked.filter((row) => row.guide_count >= cutoff);
  const countById = new Map(contenders.map((row) => [row.rid, row.guide_count]));
  // Primary-listing preference (prose first, then highest rating) as scalar
  // subqueries: indexed probes, evaluated once per contender.
  const primaryCol = (col: string) => `(SELECT sl2.${col} FROM source_listings sl2
    LEFT JOIN reviews rv2 ON rv2.source_listing_id = sl2.id
    WHERE sl2.restaurant_id = r.id AND sl2.source_slug = '${SOURCE}'
    ORDER BY (rv2.id IS NOT NULL) DESC, sl2.rating DESC LIMIT 1)`;
  const placeholders = contenders.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT r.id, r.name,
         ${primaryCol("rating")} AS rating,
         ${primaryCol("price_tier")} AS price_tier,
         (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt
          JOIN tags t ON t.id = lt.tag_id
          JOIN source_listings slx ON slx.id = lt.source_listing_id
          WHERE slx.restaurant_id = r.id AND slx.source_slug = '${SOURCE}'
            AND t.kind = 'neighborhood') AS neighborhoods,
         EXISTS (SELECT 1 FROM source_listings slc
           WHERE slc.restaurant_id = r.id AND slc.source_slug = '${SOURCE}' AND slc.is_closed = 1) AS is_closed
       FROM restaurants r
       WHERE r.id IN (${placeholders})`
    )
    .all(...contenders.map((row) => row.rid)) as Record<string, unknown>[];
  type ConsensusRow = Record<string, unknown> & {
    id: number;
    rating: number | null;
    guide_count: number | undefined;
  };
  return (rows as ConsensusRow[])
    .filter((row) => !row.is_closed)
    .map((row) => ({ ...row, guide_count: countById.get(row.id) }))
    .sort(
      (a, b) =>
        (b.guide_count ?? 0) - (a.guide_count ?? 0) || (b.rating ?? 0) - (a.rating ?? 0)
    )
    .slice(0, limit);
}

export function topRated(
  db: Database,
  f: Filters,
  limit = 10
): Record<string, unknown>[] {
  const filters = { ...f, minRating: f.minRating ?? 8.0 };
  return searchRestaurants(db, filters, limit, "rating");
}
