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

/** Throw a clear error for unsupported cities instead of silently returning []. */
function requireCity(db: Database, city: string): void {
  const row = db.prepare("SELECT slug FROM cities WHERE slug = ?").get(city) as
    | { slug: string }
    | undefined;
  if (!row) {
    const supported = (
      db.prepare("SELECT slug FROM cities ORDER BY 1").all() as { slug: string }[]
    ).map((r) => r.slug);
    throw new Error(
      `Unsupported city '${city}'. Supported: ${supported.join(", ") || "(none)"}.`
    );
  }
}

// Borough → neighborhood tag labels. A neighborhood filter naming a borough
// expands to all of its neighborhoods, so "Brooklyn" includes Williamsburg,
// Fort Greene, Bed-Stuy, etc. — not just labels containing the word "Brooklyn".
const BOROUGHS: Record<string, string[]> = {
  manhattan: [
    "Alphabet City", "Chelsea", "Chinatown", "Columbus Circle", "East Harlem",
    "East Village", "Financial District", "Flatiron", "Garment District",
    "Governors Island", "Gramercy", "Greenwich Village", "Harlem",
    "Hell's Kitchen", "Hudson Square", "Hudson Yards", "Inwood", "Kips Bay",
    "Koreatown", "Little Italy", "Lower East Side", "Meatpacking District",
    "Midtown", "Midtown East", "Midtown West", "Morningside Heights",
    "Murray Hill", "NOHO", "Nolita", "Nomad", "Soho", "South Street Seaport",
    "Times Square", "Tribeca", "Two Bridges", "Union Square", "Upper East Side",
    "Upper West Side", "Washington Heights", "West Harlem", "West Village",
  ],
  brooklyn: [
    "Bath Beach", "Bay Ridge", "Bedford-Stuyvesant", "Bensonhurst",
    "Boerum Hill", "Borough Park", "Brighton Beach", "Broadway Junction",
    "Brooklyn", "Brooklyn Heights", "Brooklyn Navy Yard", "Brownsville",
    "Bushwick", "Canarsie", "Carroll Gardens", "City Line", "Clinton Hill",
    "Cobble Hill", "Coney Island", "Crown Heights", "Cypress Hills", "DUMBO",
    "Ditmas Park", "Downtown Brooklyn", "Dyker Heights", "East Flatbush",
    "East Williamsburg", "Flatbush", "Fort Greene", "Gowanus", "Gravesend",
    "Greenpoint", "Greenwood Heights", "Kensington", "Mapleton", "Marine Park",
    "Midwood", "New Lots", "Park Slope", "Prospect Heights",
    "Prospect Lefferts Gardens", "Red Hook", "Sheepshead Bay", "Sunset Park",
    "Williamsburg", "Windsor Terrace",
  ],
  queens: [
    "Arverne", "Astoria", "Auburndale", "Bayside", "Broad Channel",
    "College Point", "Corona", "Elmhurst", "Far Rockaway", "Floral Park",
    "Flushing", "Forest Hills", "Fresh Meadows", "Glendale", "Howard Beach",
    "Jackson Heights", "JFK Airport", "LaGuardia Airport", "Lindenwood",
    "Long Island City", "Middle Village", "Murray Hill, Queens", "Ozone Park",
    "Pomonok", "Queens", "Rego Park", "Ridgewood", "Rockaway Beach",
    "Rockaway Park", "South Ozone Park", "South Richmond Hill", "Sunnyside",
    "Whitestone", "Woodhaven", "Woodside",
  ],
  bronx: [
    "Belmont", "Castle Hill", "City Island", "Concourse", "Crotona",
    "Fieldston", "Fordham", "Highbridge", "Kingsbridge", "Melrose",
    "Morris Park", "Mott Haven", "Parkchester", "Pelham Bay", "Port Morris",
    "Riverdale", "Soundview", "South Bronx", "The Bronx", "Throggs Neck",
    "Unionport", "University Heights", "Van Nest", "Wakefield",
    "Westchester Square", "Williamsbridge/East Bronx",
  ],
  "the bronx": [
    "Belmont", "Castle Hill", "City Island", "Concourse", "Crotona",
    "Fieldston", "Fordham", "Highbridge", "Kingsbridge", "Melrose",
    "Morris Park", "Mott Haven", "Parkchester", "Pelham Bay", "Port Morris",
    "Riverdale", "Soundview", "South Bronx", "The Bronx", "Throggs Neck",
    "Unionport", "University Heights", "Van Nest", "Wakefield",
    "Westchester Square", "Williamsbridge/East Bronx",
  ],
  "staten island": [
    "Brighton Heights", "Castleton Corners", "Charleston", "Dongan Hills",
    "Great Kills", "Heartland Village", "New Dorp", "New Springville",
    "Port Richmond", "St. George", "Stapleton Heights", "Staten Island",
    "Tompkinsville", "West New Brighton",
  ],
};

/** If the value names a borough, return its neighborhood labels; else null. */
function boroughNeighborhoods(value: string): string[] | null {
  return BOROUGHS[value.trim().toLowerCase()] ?? null;
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

// Coverage for city='new-york': the five boroughs plus the immediate metro.
// Venues beyond this radius from central Manhattan (e.g. Westchester, the
// Hamptons) are out of scope for discovery tools — they stay in the database
// but never surface under city='new-york'.
const NYC_CENTER_LAT = 40.758;
const NYC_CENTER_LNG = -73.9855;
const NYC_COVERAGE_KM = 30;
const DEG_TO_RAD = 0.017453292519943295;

/** SQL fragment: true when the primary listing is inside the NYC coverage area. */
const NYC_COVERAGE_SQL = `(pl.latitude IS NULL OR (6371 * 2 * asin(sqrt(
  pow(sin((pl.latitude - ${NYC_CENTER_LAT}) * ${DEG_TO_RAD}) / 2, 2) +
  cos(${NYC_CENTER_LAT} * ${DEG_TO_RAD}) * cos(pl.latitude * ${DEG_TO_RAD}) *
  pow(sin((pl.longitude - ${NYC_CENTER_LNG}) * ${DEG_TO_RAD}) / 2, 2)
))) <= ${NYC_COVERAGE_KM})`;

/** Truncate prose to a word boundary; null in, null out. */
function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * The canonical collapsed neighbourhood: the primary listing's neighbourhood
 * tags, deduplicated, alphabetical, first — one deterministic rule every tool
 * follows, so search cards and comparisons never disagree.
 */
function canonicalNeighborhood(labels: string[], fallback: string | null): string | null {
  const uniq = [...new Set(labels.map((s) => s.trim()).filter(Boolean))].sort();
  if (uniq.length > 0) return uniq[0];
  const f = fallback?.trim();
  return f ? f : null;
}

/** Escape a free-text token as an FTS5 phrase query. */
function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
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
  wait_notes: string | null;
  reservation_url: string | null;
  cuisines: string | null;
  neighborhoods: string | null;
  guide_count: number;
  review_headline: string | null;
  review_summary: string | null;
}

function buildWhere(f: Filters, params: unknown[]): string {
  const conds: string[] = ["r.city_slug = ?"];
  params.push(f.city);
  if (!f.includeClosed) conds.push("(pl.is_closed IS NULL OR pl.is_closed = 0)");
  if (f.city === "new-york") {
    // Scope discovery to the NYC coverage area (five boroughs + near metro).
    conds.push(NYC_COVERAGE_SQL);
  }
  if (f.minRating) {
    conds.push("pl.rating >= ?");
    params.push(f.minRating);
  }
  if (f.priceTier !== undefined) {
    conds.push("pl.price_tier = ?");
    params.push(f.priceTier);
  }
  // scope 'restaurant': match a tag on ANY of the restaurant's listings, not
  // just the primary — a venue must not vanish under one of its own
  // neighbourhoods (or cuisines) because the primary listing is elsewhere.
  const tagFilter = (kind: string, value: string, scope: "primary" | "restaurant" = "primary") => {
    // Hyphens act as wildcards: 'date-night' matches 'Date Nights',
    // 'Bedford-Stuyvesant' still matches literally.
    const pattern = `%${likeEscape(value).replace(/-/g, "%")}%`;
    const owner =
      scope === "restaurant"
        ? `JOIN source_listings sl2 ON sl2.id = lt.source_listing_id
           WHERE sl2.restaurant_id = r.id`
        : `WHERE lt.source_listing_id = pl.id`;
    conds.push(
      `EXISTS (SELECT 1 FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
        ${owner} AND t.kind = ? AND t.label LIKE ? ESCAPE '\\')`
    );
    params.push(kind, pattern);
  };
  if (f.cuisine) tagFilter("cuisine", f.cuisine);
  if (f.neighborhood) {
    const borough = boroughNeighborhoods(f.neighborhood);
    if (borough) {
      // Borough expansion: match any of its neighborhoods, on any listing.
      const ors = borough.map(() => `t.label LIKE ? ESCAPE '\\'`).join(" OR ");
      conds.push(
        `EXISTS (SELECT 1 FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
          JOIN source_listings sl2 ON sl2.id = lt.source_listing_id
          WHERE sl2.restaurant_id = r.id AND t.kind = 'neighborhood' AND (${ors}))`
      );
      for (const n of borough) params.push(`%${likeEscape(n)}%`);
    } else {
      tagFilter("neighborhood", f.neighborhood, "restaurant");
    }
  }
  if (f.occasion) tagFilter("occasion", f.occasion);
  if (f.query) {
    // Hyphens are token separators: 'date-night Italian' -> date, night, Italian.
    // Each token matches the name, a tag, or the full-text index over review
    // prose and guide blurbs — dishes live in prose, not in names.
    for (const tok of f.query.split(/[\s-]+/).filter(Boolean)) {
      conds.push(
        `(r.name LIKE ? ESCAPE '\\' OR pl.name LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
            WHERE lt.source_listing_id = pl.id AND t.label LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM listing_text_fts fts
            WHERE fts.source_listing_id = pl.id AND fts.text MATCH ?))`
      );
      const p = `%${likeEscape(tok)}%`;
      params.push(p, p, p, ftsPhrase(tok));
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
    pl.wait_notes, pl.reservation_url,
    (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.source_listing_id = pl.id AND t.kind = 'cuisine') AS cuisines,
    (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.source_listing_id = pl.id AND t.kind = 'neighborhood') AS neighborhoods,
    (SELECT COUNT(DISTINCT ge.guide_id) FROM guide_entries ge
      WHERE ge.source_listing_id = pl.id) AS guide_count,
    rv.headline AS review_headline,
    rv.summary AS review_summary
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
    neighborhood: canonicalNeighborhood(
      row.neighborhoods?.split("|") ?? [],
      row.locality
    ),
    cuisines: [...new Set((row.cuisines?.split("|") ?? []).map((s) => s.trim()).filter(Boolean))],
    address: row.address_line1,
    guide_appearances: row.guide_count,
    closed: row.is_closed === 1,
  };
  // One booking shape everywhere: an object, or null. A reservation link
  // means booking is possible even without a stated policy.
  const bookingPolicy = row.booking_policy ?? (row.reservation_url ? "reservations-available" : null);
  card.booking = bookingPolicy
    ? { policy: bookingPolicy, notes: row.wait_notes ?? null }
    : null;
  const headline = row.review_headline ?? truncate(row.review_summary, 160);
  if (headline) card.review_headline = headline;
  if (distanceKm !== undefined) card.distance_km = Math.round(distanceKm * 10) / 10;
  return card;
}

export function searchRestaurants(
  db: Database,
  f: Filters,
  limit = 10,
  sort: "rating" | "guides" | "distance" = "rating"
): Record<string, unknown>[] {
  requireCity(db, f.city);
  // Geo parameters are all-or-nothing: a lone lat, lng or radius_km is a
  // caller error, never silently ignored. lat+lng without a radius searches
  // within a 5 km default.
  const latDef = f.lat !== undefined;
  const lngDef = f.lng !== undefined;
  const radDef = f.radiusKm !== undefined;
  if (latDef !== lngDef || (radDef && !(latDef && lngDef))) {
    throw new Error(
      "Geo search needs 'lat' and 'lng' together; 'radius_km' is optional " +
        "(defaults to 5 km) and requires both."
    );
  }
  const radiusKm = latDef && lngDef ? (f.radiusKm ?? 5) : undefined;
  const geo = radiusKm !== undefined;
  if (geo) {
    // The query point must be able to reach the coverage area; a "near me"
    // from another city is an error, not an empty list.
    const d = haversineKm(f.lat!, f.lng!, NYC_CENTER_LAT, NYC_CENTER_LNG);
    if (d > NYC_COVERAGE_KM + radiusKm) {
      throw new Error(
        `Location (${f.lat}, ${f.lng}) is outside the New York coverage area ` +
          `(${NYC_COVERAGE_KM} km around Manhattan).`
      );
    }
  }
  const nf: Filters = { ...f, radiusKm };
  const params: unknown[] = [];
  const where = buildWhere(nf, params);
  const order =
    sort === "guides"
      ? "guide_count DESC, pl.rating DESC"
      : "pl.rating DESC, guide_count DESC";
  const rows = db
    .prepare(`${CARD_SELECT} ${where} ORDER BY ${order} LIMIT ?`)
    .all(...params, limit) as CardRow[];
  let cards = rows.map((r) => {
    const d =
      geo && r.latitude !== null && r.longitude !== null
        ? haversineKm(nf.lat!, nf.lng!, r.latitude, r.longitude)
        : undefined;
    return { card: toCard(r, d), d };
  });
  if (geo) {
    cards = cards.filter((c) => c.d !== undefined && c.d <= radiusKm);
    if (sort === "distance" || sort === "rating") {
      cards.sort((a, b) =>
        sort === "distance" ? a.d! - b.d! : b.card.rating as number - (a.card.rating as number)
      );
    }
  }
  return cards.map((c) => c.card);
}

/** Classic edit distance for typo-tolerant name resolution. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ScoredName {
  id: string;
  name: string;
  score: number;
}

/**
 * Rank all restaurant names against a query: exact, prefix and word-boundary
 * matches first (negative scores), then by edit distance. "Sema" scores
 * Semma (distance 1) ahead of Houseman (mere substring).
 */
function rankedNames(db: Database, city: string, query: string): ScoredName[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rows = db
    .prepare("SELECT id, name FROM restaurants WHERE city_slug = ?")
    .all(city) as { id: string; name: string }[];
  const wordRe = new RegExp(`\\b${escapeRegExp(q)}`);
  return rows
    .map((r) => {
      const n = r.name.toLowerCase();
      const score =
        n === q
          ? -1000
          : n.startsWith(q)
            ? -500 + (n.length - q.length)
            : wordRe.test(n)
              ? -200 + (n.length - q.length)
              : levenshtein(q, n);
      return { id: r.id, name: r.name, score };
    })
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
}

/** Did-you-mean candidates for a name that didn't resolve. */
export function suggestRestaurants(
  db: Database,
  city: string,
  name: string,
  limit = 3
): { id: string; name: string }[] {
  return rankedNames(db, city, name)
    .slice(0, limit)
    .map(({ id, name }) => ({ id, name }));
}

/** Resolve an id or a name to a canonical restaurant (typo-tolerant). */
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
  const [best] = rankedNames(db, city, idOrName);
  if (!best) return null;
  // Accept clear prefix/word matches outright; otherwise require a small
  // edit distance so "Sema" -> Semma but gibberish stays unresolved.
  if (best.score < 0) return { id: best.id, name: best.name };
  const threshold = Math.max(2, Math.floor(idOrName.trim().length / 3));
  return best.score <= threshold ? { id: best.id, name: best.name } : null;
}

export function getRestaurant(
  db: Database,
  city: string,
  idOrName: string,
  includeProse = false
): Record<string, unknown> | null {
  requireCity(db, city);
  const r = resolveRestaurant(db, city, idOrName);
  if (!r) return null;
  const row = db
    .prepare(
      `WITH ${PRIMARY_LISTINGS_CTE}
      SELECT r.name,
        pl.id AS primary_listing_id,
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
  for (const t of tags) {
    if (!t.label.trim()) continue; // safety net: skip empty-label tags
    const arr = (grouped[t.kind] ??= []);
    if (!arr.includes(t.label)) arr.push(t.label); // dedupe across listings
  }
  // Canonical collapsed neighbourhood: the primary listing's tags, same rule
  // as search cards, so tools never disagree about it.
  const primaryNeighborhoods = (
    db
      .prepare(
        `SELECT t.label FROM listing_tags lt
         JOIN tags t ON t.id = lt.tag_id
         WHERE lt.source_listing_id = ? AND t.kind = 'neighborhood'`
      )
      .all(row.primary_listing_id) as { label: string }[]
  ).map((x) => x.label);
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
    headline: row.review_headline ?? truncate(row.review_summary as string | null, 160),
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
    neighborhood: canonicalNeighborhood(primaryNeighborhoods, row.locality as string | null),
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
    booking:
      row.booking_policy || row.reservation_url
        ? {
            policy: (row.booking_policy as string | null) ?? "reservations-available",
            notes: row.wait_notes,
          }
        : null,
    closed: row.is_closed === 1,
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
  requireCity(db, city);
  return idsOrNames.map((s) => {
    const r = resolveRestaurant(db, city, s);
    if (!r)
      return {
        query: s,
        found: false,
        suggestions: suggestRestaurants(db, city, s).map((x) => x.name),
      };
    const full = getRestaurant(db, city, r.id, false)!;
    return {
      query: s,
      found: true,
      id: full.id,
      name: full.name,
      rating: full.rating,
      price_tier: full.price_tier,
      neighborhood: full.neighborhood,
      cuisines: (full.tags as Record<string, string[]>).cuisine ?? [],
      good_for: ((full.tags as Record<string, string[]>).occasion ?? []).slice(0, 5),
      // Same shapes as get_restaurant: objects, or null.
      reservation: full.reservation,
      booking: full.booking,
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
  requireCity(db, city);
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
  requireCity(db, city);
  const r = resolveRestaurant(db, city, idOrName);
  if (!r) return null;
  const mine = db
    .prepare(
      `WITH ${PRIMARY_LISTINGS_CTE}
       SELECT id FROM primary_listings WHERE restaurant_id = ?`
    )
    .get(r.id) as { id: string } | undefined;
  if (!mine) return [];
  const coverage = city === "new-york" ? `AND ${NYC_COVERAGE_SQL}` : "";
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
         -- Only SHARED tags score: an unmatched candidate tag (mt.tag_id NULL)
         -- contributes 0, so tag breadth alone can never rank a venue.
         COALESCE(SUM(CASE WHEN mt.tag_id IS NULL THEN 0
           WHEN mt.kind = 'cuisine' THEN 3 WHEN mt.kind = 'occasion' THEN 2
           WHEN mt.kind = 'neighborhood' THEN 2 ELSE 1 END), 0) AS tag_score,
         (SELECT COUNT(*) FROM guide_entries ge
           WHERE ge.source_listing_id = pl.id
             AND ge.guide_id IN (SELECT guide_id FROM my_guides)) AS guide_overlap
       FROM restaurants r
       JOIN primary_listings pl ON pl.restaurant_id = r.id
       LEFT JOIN listing_tags lt ON lt.source_listing_id = pl.id
       LEFT JOIN my_tags mt ON mt.tag_id = lt.tag_id
       WHERE r.city_slug = ? AND r.id != ?
         AND (pl.is_closed IS NULL OR pl.is_closed = 0)
         ${coverage}
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
    neighborhood: canonicalNeighborhood(
      ((row.neighborhoods as string | null)?.split("|") ?? []),
      null
    ),
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
  requireCity(db, city);
  const params: unknown[] = [city];
  let themeCond = "";
  if (theme) {
    // Theme must match the guide text AND a tag on the restaurant itself.
    // Otherwise venues that merely appear in a textually-matching guide get
    // padded into themed results (e.g. non-ramen spots in "ramen" results).
    themeCond = `AND (g.title LIKE ? ESCAPE '\\' OR g.summary LIKE ? ESCAPE '\\')
      AND EXISTS (SELECT 1 FROM listing_tags lt2 JOIN tags t2 ON t2.id = lt2.tag_id
        JOIN source_listings slt ON slt.id = lt2.source_listing_id
        WHERE slt.restaurant_id = r.id AND slt.source_slug = '${SOURCE}'
          AND t2.label LIKE ? ESCAPE '\\')`;
    const p = `%${likeEscape(theme)}%`;
    params.push(p, p, p);
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
    .map((row) => ({
      ...row,
      guide_count: countById.get(row.id),
      neighborhoods: ((row.neighborhoods as string | null)?.split("|").filter((s) => s.trim()) ?? []),
    }))
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
