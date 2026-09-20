// Query layer for the nycfoodie MCP server (read-only).
//
// Every tool resolves restaurants to their single "primary" listing: the
// Infatuation listing when one exists (review prose first, then highest
// rating), otherwise the best listing from any other source. Eater-only
// venues must resolve too — previously a venue with no Infatuation listing
// vanished from search and get_restaurant entirely.
// Known-closed venues are excluded unless include_closed is set.

import type { Database } from "better-sqlite3";

const SOURCE = "infatuation";

/**
 * One primary listing per restaurant. Infatuation wins wherever a venue has
 * one, so existing primaries never change; otherwise the best listing from
 * any other source is picked (review prose, rating, then the venue-named
 * listing over remediated "Dish at Venue" rows on exact ties).
 */
const PRIMARY_LISTINGS_CTE = `primary_listings AS (
  SELECT * FROM (
    SELECT sl.*,
      ROW_NUMBER() OVER (
        PARTITION BY sl.restaurant_id
        ORDER BY (sl.source_slug = '${SOURCE}') DESC,
                 (rv.id IS NOT NULL) DESC,
                 sl.rating DESC,
                 (sl.name = r2.name) DESC
      ) AS rn
    FROM source_listings sl
    JOIN restaurants r2 ON r2.id = sl.restaurant_id
    LEFT JOIN reviews rv ON rv.source_listing_id = sl.id
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

/**
 * Stored wait_notes were truncated mid-word by the crawler (Round 5: B4).
 * Never surface a dangling word fragment: if the note ends with "…" glued
 * to a partial word, back up to the last word boundary. New crawls truncate
 * cleanly at word boundaries; this keeps old rows honest at read time.
 */
function cleanNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const t = notes.trim();
  if (!t.endsWith("…")) return t;
  const body = t.slice(0, -1);
  if (!body || /[\s.,;:!?]$/.test(body)) return t;
  const lastSpace = body.lastIndexOf(" ");
  return (lastSpace > 0 ? body.slice(0, lastSpace) : body).trimEnd() + "…";
}

/**
 * Tokenized theme matching for guide titles/summaries (Round 5: O8).
 * Every token must appear in the title or summary, with & treated as "and"
 * on both sides ("black and white cookies" matches "Black & White Cookies").
 * Replaces the old whole-string LIKE and the tag-EXISTS clause, which made
 * tag-less themes like "cookies" unanswerable.
 */
function themeClauses(theme: string, params: unknown[]): string {
  const tokens = theme
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[\s-]+/)
    .filter(Boolean);
  let cond = "";
  for (const tok of tokens) {
    cond += ` AND (REPLACE(LOWER(g.title), '&', 'and') LIKE ? ESCAPE '\\'
      OR REPLACE(LOWER(g.summary), '&', 'and') LIKE ? ESCAPE '\\')`;
    const p = `%${likeEscape(tok)}%`;
    params.push(p, p);
  }
  return cond;
}

/** Distinct guides featuring a restaurant, across all its listings — the one
 *  definition every tool uses (Round 5: O9). */
export function guideAppearanceCount(
  db: Database,
  restaurantId: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT ge.guide_id) AS c FROM guide_entries ge
       JOIN source_listings sl ON sl.id = ge.source_listing_id
       WHERE sl.restaurant_id = ?`
    )
    .get(restaurantId) as { c: number };
  return row.c;
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

/**
 * The documented occasion tags. Single source of truth: the tool-schema
 * description in server.ts is built from this list, so they cannot drift.
 * Matches exactly the distinct occasion labels in the database.
 */
export const OCCASION_VALUES = [
  "Date Nights",
  "Happy Hours",
  "Pre-Theater",
  "See & Be Seen",
  "Serious Takeout Operation",
  "Unique Dining Experiences",
  "Wasting Your Time & Money",
] as const;

function normalizeOccasion(s: string): string {
  return s.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Resolve an occasion input to its canonical allowed value, or throw.
 * Every input token (hyphens/spaces/underscores split) must be a prefix of
 * the corresponding allowed-value token, in order: 'date-night' and
 * 'happy_hours' both resolve to their documented labels. Unknown values
 * ('date-nite', 'BanquetXYZ') and ambiguous prefixes ('s' matches both
 * 'See & Be Seen' and 'Serious Takeout Operation') are rejected with an
 * error naming the allowed values — never a silent []. The empty string
 * keeps its existing no-filter meaning (undefined out); a value that
 * normalises to nothing is rejected outright.
 *
 * The canonical value is what the SQL filter matches on, so validation and
 * filtering can never disagree about what an input means.
 */
function canonicalOccasion(occasion: string | undefined): string | undefined {
  if (!occasion) return undefined;
  const unsupported = (why: string) =>
    new Error(
      `${why} '${occasion}'. Allowed: ${OCCASION_VALUES.join(", ")}.`
    );
  const inputTokens = normalizeOccasion(occasion).split(" ").filter(Boolean);
  if (inputTokens.length === 0) throw unsupported("Unsupported occasion");
  const matches = OCCASION_VALUES.filter((v) => {
    const allowed = normalizeOccasion(v).split(" ");
    return (
      inputTokens.length <= allowed.length &&
      inputTokens.every((tok, i) => allowed[i].startsWith(tok))
    );
  });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw unsupported("Unsupported occasion");
  throw unsupported(
    `Ambiguous occasion (matches ${matches.map((m) => `'${m}'`).join(", ")})`
  );
}

/** Bronx neighborhoods, shared by the "bronx" and "the bronx" keys. */
const bronxNeighborhoods = [
  "Belmont", "Castle Hill", "City Island", "Concourse", "Crotona",
  "Fieldston", "Fordham", "Highbridge", "Kingsbridge", "Melrose",
  "Morris Park", "Mott Haven", "Parkchester", "Pelham Bay", "Port Morris",
  "Riverdale", "Soundview", "South Bronx", "The Bronx", "Throggs Neck",
  "Unionport", "University Heights", "Van Nest", "Wakefield",
  "Westchester Square", "Williamsbridge/East Bronx",
];

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
  bronx: bronxNeighborhoods,
  "the bronx": bronxNeighborhoods,
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

/**
 * Which neighbourhood tag satisfied an active neighbourhood filter, so the
 * card can explain the match. Round 4: Fish Cheeks' primary listing is
 * Williamsburg but it matches neighborhood='Noho' via its NOHO-tagged
 * listing — the filter is tag-based (not prose-based), and without this the
 * card looks like a false positive. Uses the same match rule and the same
 * closed-listing exclusion as the filter itself.
 */
function matchedNeighborhoodLabel(
  db: Database,
  restaurantId: string,
  filterValue: string,
  includeClosed: boolean | undefined
): string | null {
  const borough = boroughNeighborhoods(filterValue);
  const labels = (
    db
      .prepare(
        `SELECT DISTINCT t.label FROM listing_tags lt
         JOIN tags t ON t.id = lt.tag_id
         JOIN source_listings sl ON sl.id = lt.source_listing_id
         WHERE sl.restaurant_id = ? AND t.kind = 'neighborhood'
         ${includeClosed ? "" : "AND (sl.is_closed IS NULL OR sl.is_closed = 0)"}
         ORDER BY t.label`
      )
      .all(restaurantId) as { label: string }[]
  ).map((r) => r.label);
  if (borough) {
    const set = new Set(borough.map((b) => b.trim().toLowerCase()));
    return labels.find((l) => set.has(l.trim().toLowerCase())) ?? null;
  }
  // Same rule as the SQL LIKE in buildWhere: hyphens are wildcards.
  const re = new RegExp(escapeRegExp(filterValue.trim()).replace(/-/g, ".*"), "i");
  return labels.find((l) => re.test(l)) ?? null;
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
 * The source sometimes stores the summary text in the headline column
 * (Round 4: Atla's headline and summary are byte-identical) — that is not a
 * headline. Treat a missing or summary-duplicating headline as absent so the
 * detail stays honest; cards keep their truncated-summary fallback for the
 * display line (Round 2/3: no blank headlines).
 */
function realHeadline(
  headline: string | null | undefined,
  summary: string | null | undefined
): string | null {
  const h = headline?.trim();
  if (!h) return null;
  if (summary && h === summary.trim()) return null;
  return h;
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
  last_crawled_at: string | null;
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
    // A shuttered location's tags must not make the venue match: unless
    // include_closed is set, tags on listings marked closed are ignored, so
    // a closed Noho outpost doesn't surface under neighborhood='Noho'.
    const openListings =
      f.includeClosed || scope === "primary" ? "" : "AND (sl2.is_closed IS NULL OR sl2.is_closed = 0)";
    const owner =
      scope === "restaurant"
        ? `JOIN source_listings sl2 ON sl2.id = lt.source_listing_id
           WHERE sl2.restaurant_id = r.id ${openListings}`
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
      const openListings = f.includeClosed ? "" : "AND (sl2.is_closed IS NULL OR sl2.is_closed = 0)";
      conds.push(
        `EXISTS (SELECT 1 FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
          JOIN source_listings sl2 ON sl2.id = lt.source_listing_id
          WHERE sl2.restaurant_id = r.id AND t.kind = 'neighborhood' AND (${ors}) ${openListings})`
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
    pl.wait_notes, pl.reservation_url, pl.last_crawled_at,
    (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.source_listing_id = pl.id AND t.kind = 'cuisine') AS cuisines,
    (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.source_listing_id = pl.id AND t.kind = 'neighborhood') AS neighborhoods,
    (SELECT COUNT(DISTINCT ge.guide_id) FROM guide_entries ge
      JOIN source_listings slx ON slx.id = ge.source_listing_id
      WHERE slx.restaurant_id = r.id) AS guide_count,
    rv.headline AS review_headline,
    rv.summary AS review_summary
  FROM restaurants r
  JOIN primary_listings pl ON pl.restaurant_id = r.id
  LEFT JOIN reviews rv ON rv.source_listing_id = pl.id`;

function toCard(
  row: CardRow,
  distanceKm?: number,
  matchedNeighborhood?: string | null
): Record<string, unknown> {
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
    // Card projections use unambiguous names: the street line is
    // `address_line` (get_restaurant's `address` is the structured object),
    // and the guide total is `guide_appearance_count` (get_restaurant's
    // `guide_appearances` is the entry list).
    address_line: row.address_line1,
    guide_appearance_count: row.guide_count,
    closed: row.is_closed === 1,
    // When this venue's data was last crawled — agents should caveat
    // fast-decaying claims (closures especially) on stale values.
    crawled_at: row.last_crawled_at,
  };
  // Present only when a neighbourhood filter is active: which of the venue's
  // neighbourhoods satisfied it. May differ from the canonical neighbourhood
  // for multi-location venues (e.g. Fish Cheeks matches 'Noho' via its
  // NOHO-tagged listing while the primary is Williamsburg).
  if (matchedNeighborhood !== undefined) card.matched_neighborhood = matchedNeighborhood;
  // One booking shape everywhere: an object, or null. Booking reflects
  // editorial intel only — a reservation link alone never implies a policy
  // (Round 5: B3). The link still travels in `reservation`.
  card.booking = row.booking_policy
    ? { policy: row.booking_policy, notes: cleanNotes(row.wait_notes) }
    : null;
  const headline = realHeadline(row.review_headline, row.review_summary) ?? truncate(row.review_summary, 160);
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
  // Canonicalise the occasion BEFORE filtering: the SQL filter matches on
  // the resolved label, so 'happy_hours' can never pass validation and
  // then silently match nothing.
  const occasion = canonicalOccasion(f.occasion);
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
  const nf: Filters = { ...f, radiusKm, occasion };
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
    // When a neighbourhood filter is active, say which neighbourhood
    // satisfied it — the match may come from a non-primary listing.
    const matched =
      nf.neighborhood !== undefined
        ? matchedNeighborhoodLabel(db, r.id, nf.neighborhood, nf.includeClosed)
        : undefined;
    return { card: toCard(r, d, matched), d };
  });
  if (geo) {
    cards = cards.filter((c) => c.d !== undefined && c.d <= radiusKm);
    // SQL can't order by the computed haversine distance, so distance sort
    // happens here. Rating/guide sorts are already handled by the ORDER BY.
    if (sort === "distance") cards.sort((a, b) => a.d! - b.d!);
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
  // UUID-shaped input is an id, not a misspelled name: a missing id gets no
  // "did you mean" list (Round 5: O6).
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      name.trim()
    )
  ) {
    return [];
  }
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
        pl.id AS primary_listing_id, pl.source_slug AS primary_source_slug,
        pl.rating, pl.price_tier, pl.price_label, pl.address_line1, pl.locality,
        pl.region, pl.postal_code, pl.latitude, pl.longitude, pl.phone, pl.website,
        pl.reservation_url, pl.reservation_platform, pl.booking_policy, pl.wait_notes,
        pl.is_closed, pl.closed_status, pl.source_url, pl.last_crawled_at,
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
  // Tags stay source-honest: the primary listing's source, so Infatuation
  // venues keep exactly their Infatuation tags while Eater-only venues show
  // their Eater tags (possibly none) instead of vanishing. Guides are NOT
  // source-siloed: a venue lists every guide that includes it, whichever
  // source the entry came through — guide entries link forward to the
  // venue's restaurant_id across listings, so the reverse direction must
  // read across listings too.
  const primarySource = row.primary_source_slug as string;
  const tags = db
    .prepare(
      `SELECT t.kind, t.label FROM listing_tags lt
       JOIN tags t ON t.id = lt.tag_id
       JOIN source_listings sl ON sl.id = lt.source_listing_id
       WHERE sl.restaurant_id = ? AND sl.source_slug = ?
       ORDER BY t.kind, t.label`
    )
    .all(r.id, primarySource) as { kind: string; label: string }[];
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
  // Cross-source: every guide entry linked to this venue's restaurant_id,
  // whichever listing/source it came through (an Eater entry links to the
  // Infatuation venue's id via its Eater listing).
  const guides = db
    .prepare(
      `SELECT g.title, g.url, ge.position, ge.entry_name, ge.blurb FROM guide_entries ge
       JOIN guides g ON g.id = ge.guide_id
       JOIN source_listings sl ON sl.id = ge.source_listing_id
       WHERE sl.restaurant_id = ?
       ORDER BY g.title, ge.position`
    )
    .all(r.id) as Record<string, unknown>[];
  const review: Record<string, unknown> = {
    title: row.review_title,
    // Honest headline: the source's real headline, or null when it has none
    // (a stored headline identical to the summary is not a headline).
    headline: realHeadline(row.review_headline as string | null, row.review_summary as string | null),
    summary: row.review_summary,
    author: row.review_author,
    published_at: row.review_published_at,
    url: row.review_url,
  };
  if (includeProse) review.body = row.review_body;
  return {
    id: r.id,
    name: row.name,
    // How the query resolved: "exact" (id or name matched verbatim) or
    // "fuzzy" (prefix/fuzzy resolution, e.g. "Sema" -> Semma). Round 5: I1.
    // resolveRestaurant tries the exact predicate first, so an exact input
    // can only have resolved exactly — no second query needed.
    match_type:
      r.id === idOrName || r.name.toLowerCase() === idOrName.toLowerCase()
        ? "exact"
        : "fuzzy",
    crawled_at: row.last_crawled_at,
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
    booking: row.booking_policy
      ? {
          policy: row.booking_policy as string,
          notes: cleanNotes(row.wait_notes as string | null),
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
  // Dedupe: compare(X, X) lists X once (Round 5: O10).
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const s of idsOrNames) {
    const r = resolveRestaurant(db, city, s);
    if (!r) {
      out.push({
        query: s,
        found: false,
        suggestions: suggestRestaurants(db, city, s).map((x) => x.name),
      });
      continue;
    }
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const full = getRestaurant(db, city, r.id, false)!;
    out.push({
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
      review_headline:
        (full.review as { headline: string | null; summary: string | null } | null)?.headline ??
        truncate((full.review as { summary: string | null } | null)?.summary ?? null, 160) ??
        null,
      // Same definition as search cards: distinct guides across all
      // listings (Round 5: O9). Named `guide_appearance_count` so the field
      // never collides with get_restaurant's `guide_appearances` entry list.
      guide_appearance_count: guideAppearanceCount(db, r.id),
    });
  }
  return out;
}

export function findGuides(
  db: Database,
  city: string,
  query: string | undefined,
  limit = 5,
  includeEntries = true
): Record<string, unknown>[] {
  requireCity(db, city);
  const params: unknown[] = [city];
  let where = "g.city_slug = ?";
  if (query) {
    // Same tokenized matching as guide_consensus (Round 5: O8).
    where += themeClauses(query, params);
  }
  const guides = db
    .prepare(
      `SELECT g.id, g.title, g.url, g.summary, g.published_at,
        (SELECT COUNT(*) FROM guide_entries ge WHERE ge.guide_id = g.id) AS entry_count
       FROM guides g WHERE ${where} ORDER BY g.published_at DESC LIMIT ?`
    )
    .all(...params, limit) as Record<string, unknown>[];
  return guides.map((g) => {
    // Entries-off mode: guide metadata only, for when the caller wants titles
    // without pulling every blurb.
    if (!includeEntries) return { ...g, entries: [] };
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
       ),
       my_price AS (
         SELECT price_tier FROM primary_listings WHERE restaurant_id = ?
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
             AND ge.guide_id IN (SELECT guide_id FROM my_guides)) AS guide_overlap,
         -- Price-tier proximity (Round 5: O7): same tier +2, adjacent +1, so
         -- a same-price near-match outranks a far cheaper/more expensive one.
         CASE WHEN (SELECT price_tier FROM my_price) IS NOT NULL
               AND pl.price_tier = (SELECT price_tier FROM my_price) THEN 2
              WHEN (SELECT price_tier FROM my_price) IS NOT NULL
               AND pl.price_tier IS NOT NULL
               AND ABS(pl.price_tier - (SELECT price_tier FROM my_price)) = 1 THEN 1
              ELSE 0 END AS price_score
       FROM restaurants r
       JOIN primary_listings pl ON pl.restaurant_id = r.id
       LEFT JOIN listing_tags lt ON lt.source_listing_id = pl.id
       LEFT JOIN my_tags mt ON mt.tag_id = lt.tag_id
       WHERE r.city_slug = ? AND r.id != ?
         AND (pl.is_closed IS NULL OR pl.is_closed = 0)
         ${coverage}
       GROUP BY r.id
       HAVING tag_score > 0 OR guide_overlap > 0
       ORDER BY (tag_score + guide_overlap * 2 + price_score) DESC, pl.rating DESC
       LIMIT ?`
    )
    .all(mine.id, mine.id, r.id, city, r.id, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    rating: row.rating,
    price_tier: row.price_tier,
    neighborhood: canonicalNeighborhood(
      ((row.neighborhoods as string | null)?.split("|") ?? []),
      null
    ),
    similarity:
      (row.tag_score as number) +
      (row.guide_overlap as number) * 2 +
      (row.price_score as number),
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
    // Tokenized matching: every theme token must appear in the guide title
    // or summary, with & treated as "and". The old tag-EXISTS clause is gone:
    // it made tag-less themes ("cookies") unanswerable, and ranked venues
    // are still only those appearing in theme-matching guides (Round 5: O8).
    themeCond = themeClauses(theme, params);
  }
  // Two-phase: (1) cheap guide-count ranking over all restaurants — no
  // per-restaurant subqueries; (2) details only for the top rows including
  // guide_count ties, so the scalar probes run on a handful of rows.
  // Votes count across sources: an Eater guide appearance is an editorial
  // vote like any other, so the source filter stays off here.
  const ranked = db
    .prepare(
      `SELECT sl.restaurant_id AS rid, COUNT(DISTINCT ge.guide_id) AS guide_count
       FROM guide_entries ge
       JOIN guides g ON g.id = ge.guide_id
       JOIN source_listings sl ON sl.id = ge.source_listing_id
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
  // Display columns come from each venue's primary listing — the same
  // Infatuation-first definition every other tool uses — so Eater-only
  // venues keep their own rating/neighbourhood instead of nulls.
  const placeholders = contenders.map(() => "?").join(",");
  const rows = db
    .prepare(
      `WITH ${PRIMARY_LISTINGS_CTE}
       SELECT r.id, r.name,
         pl.rating, pl.price_tier,
         (SELECT GROUP_CONCAT(t.label, '|') FROM listing_tags lt
          JOIN tags t ON t.id = lt.tag_id
          WHERE lt.source_listing_id = pl.id AND t.kind = 'neighborhood') AS neighborhoods,
         pl.is_closed AS is_closed
       FROM restaurants r
       JOIN primary_listings pl ON pl.restaurant_id = r.id
       WHERE r.id IN (${placeholders})`
    )
    .all(...contenders.map((row) => row.rid)) as Record<string, unknown>[];
  type ConsensusRow = Record<string, unknown> & {
    id: number;
    rating: number | null;
    guide_appearance_count: number | undefined;
  };
  return (rows as ConsensusRow[])
    .filter((row) => !row.is_closed)
    .map((row) => ({
      ...row,
      // Named guide_appearance_count so the count field never collides with
      // get_restaurant's guide_appearances entry list (f-013).
      guide_appearance_count: countById.get(row.id),
      neighborhoods: ((row.neighborhoods as string | null)?.split("|").filter((s) => s.trim()) ?? []),
    }))
    .sort(
      (a, b) =>
        (b.guide_appearance_count ?? 0) - (a.guide_appearance_count ?? 0) || (b.rating ?? 0) - (a.rating ?? 0)
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
