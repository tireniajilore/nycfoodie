-- 001_initial_schema.sql — NYCfoodie v1 schema.
-- Approved proposal: docs/schema-proposal.md (2026-09-19).
-- Conventions: TEXT/INTEGER/REAL only, ISO-8601 TEXT timestamps,
-- booleans as 0/1, JSON in TEXT, app-generated TEXT UUID primary keys.

CREATE TABLE IF NOT EXISTS cities (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country_code TEXT NOT NULL,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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
  price_tier INTEGER CHECK (price_tier BETWEEN 1 AND 4),
  timezone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (city_slug, name)
);
CREATE INDEX IF NOT EXISTS idx_restaurants_city ON restaurants(city_slug);
CREATE INDEX IF NOT EXISTS idx_restaurants_geo ON restaurants(latitude, longitude);

CREATE TABLE IF NOT EXISTS source_listings (
  id TEXT PRIMARY KEY,
  source_slug TEXT NOT NULL REFERENCES sources(slug),
  restaurant_id TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  name TEXT NOT NULL,
  rating REAL,
  rating_scale REAL,
  review_count INTEGER,
  price_label TEXT,
  price_tier INTEGER CHECK (price_tier BETWEEN 1 AND 4),
  price_per_head_min REAL,
  price_per_head_max REAL,
  price_currency TEXT,
  reservation_url TEXT,
  reservation_platform TEXT,
  booking_policy TEXT,
  typical_wait_minutes INTEGER,
  wait_notes TEXT,
  hours_json TEXT,
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
  checksum TEXT,
  UNIQUE (source_slug, source_key)
);
CREATE INDEX IF NOT EXISTS idx_listings_restaurant ON source_listings(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_listings_source ON source_listings(source_slug);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  source_listing_id TEXT NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  title TEXT,
  headline TEXT,
  summary TEXT,
  body_text TEXT,
  rating REAL,
  author TEXT,
  url TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT,
  last_crawled_at TEXT NOT NULL,
  UNIQUE (source_listing_id)
);

CREATE TABLE IF NOT EXISTS dishes (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  UNIQUE (review_id, position)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  city_slug TEXT NOT NULL REFERENCES cities(slug),
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  source_slug TEXT NOT NULL REFERENCES sources(slug),
  UNIQUE (city_slug, kind, slug)
);

CREATE TABLE IF NOT EXISTS listing_tags (
  source_listing_id TEXT NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (source_listing_id, tag_id)
);

CREATE TABLE IF NOT EXISTS guides (
  id TEXT PRIMARY KEY,
  source_slug TEXT NOT NULL REFERENCES sources(slug),
  city_slug TEXT NOT NULL REFERENCES cities(slug),
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  guide_type TEXT,
  summary TEXT,
  published_at TEXT,
  updated_at TEXT,
  last_crawled_at TEXT NOT NULL,
  UNIQUE (source_slug, source_key)
);
CREATE INDEX IF NOT EXISTS idx_guides_city ON guides(city_slug);

CREATE TABLE IF NOT EXISTS guide_entries (
  id TEXT PRIMARY KEY,
  guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  source_listing_id TEXT NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  blurb TEXT,
  UNIQUE (guide_id, position),
  UNIQUE (guide_id, source_listing_id)
);

CREATE TABLE IF NOT EXISTS crawl_state (
  source_slug TEXT NOT NULL REFERENCES sources(slug),
  city_slug TEXT NOT NULL REFERENCES cities(slug),
  collection TEXT NOT NULL,
  last_crawled_at TEXT,
  last_cursor TEXT,
  item_count INTEGER,
  checksum TEXT,
  PRIMARY KEY (source_slug, city_slug, collection)
);
