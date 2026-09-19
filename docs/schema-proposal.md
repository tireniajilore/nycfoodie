# NYCfoodie — Database Schema Proposal (step 3)

Status: **proposed, awaiting Tireni's approval.** Nothing is implemented yet —
on approval this becomes `db/migrations/001_initial_schema.sql`.

Follows the repo's Postgres-compatibility rules (`db/migrations/README.md`):
only `TEXT`/`INTEGER`/`REAL`, ISO-8601 `TEXT` timestamps, booleans as `0`/`1`,
JSON in `TEXT`, app-generated `TEXT` UUID primary keys.

## Design goals

1. **City is a parameter everywhere.** Every city-scoped table carries
   `city_slug`; no NYC-specific hardcoding.
2. **Canonical restaurants, source-specific opinions.** One `restaurants` row per
   real-world place; each source's listing, review and rating hang off it.
   This is what makes head-to-head comparison and a future consensus signal
   possible.
3. **Guides are first-class.** Ranked guide entries are their own table, not a
   tag — rank order is the product.
4. **Occasions/vibes are taxonomy.** Neighbourhoods, cuisines, perfect-for
   occasions and venue types share one `tags` table with a `kind` column.
5. **Staleness is tracked everywhere.** `last_crawled_at` on every crawled row
   plus a `crawl_state` watermark table per (source, city, collection).
6. **Multi-source ready.** `sources` table from day one; nothing assumes
   Infatuation except the data we choose to store.

## Tables

```sql
CREATE TABLE IF NOT EXISTS cities (
  slug TEXT PRIMARY KEY,            -- 'new-york'
  name TEXT NOT NULL,               -- 'New York'
  country_code TEXT NOT NULL,       -- 'US'
  timezone TEXT NOT NULL,           -- 'America/New_York'
  created_at TEXT NOT NULL          -- ISO-8601 UTC
);

CREATE TABLE IF NOT EXISTS sources (
  slug TEXT PRIMARY KEY,            -- 'infatuation', later 'eater', 'nyt', 'michelin'
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per real-world restaurant, matched across sources.
CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,
  city_slug TEXT NOT NULL REFERENCES cities(slug),
  name TEXT NOT NULL,
  address_line1 TEXT,
  locality TEXT,
  region TEXT,
  postal_code TEXT,
  country_code TEXT,
  latitude REAL,
  longitude REAL,
  phone TEXT,
  website TEXT,
  price_tier INTEGER CHECK (price_tier BETWEEN 1 AND 4),  -- normalised 1..4
  timezone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (city_slug, name)
);
CREATE INDEX IF NOT EXISTS idx_restaurants_city ON restaurants(city_slug);
CREATE INDEX IF NOT EXISTS idx_restaurants_geo ON restaurants(latitude, longitude);

-- A source's record of a restaurant. restaurant_id is NULL until matched
-- to a canonical row (matching rules live in app code, not SQL).
CREATE TABLE IF NOT EXISTS source_listings (
  id TEXT PRIMARY KEY,
  source_slug TEXT NOT NULL REFERENCES sources(slug),
  restaurant_id TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,         -- stable per-source id, e.g. Infatuation documentIdentifier
  source_url TEXT NOT NULL,
  name TEXT NOT NULL,               -- as the source lists it
  rating REAL,                      -- source-native; NULL = unrated
  rating_scale REAL,                -- e.g. 10 for Infatuation
  review_count INTEGER,             -- source-native count of ratings (e.g. Google's total); NULL when the source doesn't publish one
  price_label TEXT,                 -- source-native, e.g. '$$'
  price_tier INTEGER CHECK (price_tier BETWEEN 1 AND 4),
  price_per_head_min REAL,          -- all-in estimate per person, source-native where available
  price_per_head_max REAL,
  price_currency TEXT,              -- e.g. 'USD'
  reservation_url TEXT,
  reservation_platform TEXT,        -- e.g. 'opentable', 'resy'
  booking_policy TEXT,              -- 'walk-in-only' | 'reservations-recommended' | 'reservations-required'; NULL = unknown
  typical_wait_minutes INTEGER,     -- prime-time typical wait; NULL = unknown
  wait_notes TEXT,
  hours_json TEXT,                  -- PROVISIONAL: hours not yet confirmed in source data
  phone TEXT,
  website TEXT,
  address_line1 TEXT,
  locality TEXT,
  region TEXT,
  postal_code TEXT,
  latitude REAL,
  longitude REAL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_crawled_at TEXT NOT NULL,
  checksum TEXT,                    -- change detection for the source payload
  UNIQUE (source_slug, source_key)
);
CREATE INDEX IF NOT EXISTS idx_listings_restaurant ON source_listings(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_listings_city_source ON source_listings(source_slug);

-- The editorial review itself (one per listing per source for the MVP).
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  source_listing_id TEXT NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  title TEXT,
  headline TEXT,
  summary TEXT,
  body_text TEXT,                   -- full prose, stored as markdown
  rating REAL,
  author TEXT,
  url TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT,
  last_crawled_at TEXT NOT NULL,
  UNIQUE (source_listing_id)
);

-- "What to order": the food rundown, in the review's own order.
CREATE TABLE IF NOT EXISTS dishes (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  UNIQUE (review_id, position)
);

-- Neighbourhoods, cuisines, occasions/vibes, venue types.
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  city_slug TEXT NOT NULL REFERENCES cities(slug),
  kind TEXT NOT NULL,               -- 'neighborhood' | 'cuisine' | 'occasion' | 'venue_type'
  slug TEXT NOT NULL,               -- e.g. 'date-night'
  label TEXT NOT NULL,              -- e.g. 'Date Night'
  source_slug TEXT NOT NULL REFERENCES sources(slug),
  UNIQUE (city_slug, kind, slug)
);

CREATE TABLE IF NOT EXISTS listing_tags (
  source_listing_id TEXT NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (source_listing_id, tag_id)
);

-- Curated ranked guides.
CREATE TABLE IF NOT EXISTS guides (
  id TEXT PRIMARY KEY,
  source_slug TEXT NOT NULL REFERENCES sources(slug),
  city_slug TEXT NOT NULL REFERENCES cities(slug),
  source_key TEXT NOT NULL,         -- guide slug at the source
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  guide_type TEXT,                  -- 'Modular' | 'Top25' | 'HitList' | 'NewOpenings' | ...
  summary TEXT,
  published_at TEXT,
  updated_at TEXT,
  last_crawled_at TEXT NOT NULL,
  UNIQUE (source_slug, source_key)
);
CREATE INDEX IF NOT EXISTS idx_guides_city ON guides(city_slug);

-- Ranked entries inside a guide. Position IS the product.
CREATE TABLE IF NOT EXISTS guide_entries (
  id TEXT PRIMARY KEY,
  guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  source_listing_id TEXT NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,        -- 1 = top of the ranking
  blurb TEXT,                       -- the guide's write-up of this entry
  UNIQUE (guide_id, position),
  UNIQUE (guide_id, source_listing_id)
);

-- Crawl watermarks: what we fetched, when, and where we got to.
CREATE TABLE IF NOT EXISTS crawl_state (
  source_slug TEXT NOT NULL REFERENCES sources(slug),
  city_slug TEXT NOT NULL REFERENCES cities(slug),
  collection TEXT NOT NULL,         -- e.g. 'reviews', 'guides', 'taxonomy:occasion'
  last_crawled_at TEXT,
  last_cursor TEXT,                 -- resume token for paginated sweeps
  item_count INTEGER,
  checksum TEXT,
  PRIMARY KEY (source_slug, city_slug, collection)
);
```

## Key decisions and why

- **Ratings stay source-native** (`rating` + `rating_scale`), normalised to a
  0–10 scale in application code at query time. Sources use different scales;
  baking one scale into storage would corrupt the data.
- **`source_listings.restaurant_id` is nullable.** A listing lands first;
  canonical matching happens as a separate step, so unmatched rows are never
  lost. MVP matching rule: same `city_slug` + normalised name + street
  address. Fuzzy cross-source matching is deferred, not designed.
- **One review per listing** (`UNIQUE(source_listing_id)`). True for
  Infatuation; revisit when a source republishes the same restaurant.
- **`hours_json` is provisional.** Hours are unconfirmed in the source data
  (see `docs/infatuation-data-surface.md` §6). The column exists so the
  "one call returns hours" differentiator has a home; it stays nullable until
  the crawler verifies a real source.
- **Review count, line intel and price-per-head are nullable by design.**
  `review_count` is trivially populated wherever a source publishes one.
  `booking_policy` / `typical_wait_minutes` / `wait_notes` and
  `price_per_head_min` / `price_per_head_max` will *not* come from the
  structured API — no source publishes them as fields. They get populated by
  a prose-extraction step over review text at crawl time (Infatuation's
  `reservationTipsText` is the seed for line intel; price mentions in prose
  for per-head). The schema carries them now; the extractor lands with the
  crawler. Explicitly out of scope: chef/kitchen-leadership fields and an
  events layer — dropped per feedback, not deferred.
- **No full-text index yet.** `search_restaurants` will start on
  `LIKE`/equality over name, tags and city; an FTS5 virtual table is a
  follow-up migration once query patterns are real.

## Deliberately deferred

- **Consensus signal** (cross-source agreement score): needs ≥2 sources.
  Future table, not designed now.
- **Eater / NYT / Michelin specifics:** the schema accepts them without
  changes; source-specific quirks get their own migrations if needed.
- **Licensing:** unchanged — deferred per plan, not resolved here.

## What approval unlocks

1. Write `db/migrations/001_initial_schema.sql` from this proposal.
2. Build the Infatuation crawler (step 4) against it.
