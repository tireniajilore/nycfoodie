-- 003_google_verification.sql — Google Places cross-check on canonical restaurants.
--
-- Verification is about the real-world venue, so it lives on restaurants,
-- not on per-source listings. google_business_status carries Google's own
-- vocabulary: OPERATIONAL, CLOSED_TEMPORARILY, CLOSED_PERMANENTLY.
-- A match is only written when the candidate is close to our coordinates
-- (see crawler/src/google/places.ts); confidence records how strict
-- that match was.

ALTER TABLE restaurants ADD COLUMN google_place_id TEXT;
ALTER TABLE restaurants ADD COLUMN google_business_status TEXT;
ALTER TABLE restaurants ADD COLUMN google_match_confidence TEXT
  CHECK (google_match_confidence IN ('high', 'low'));
ALTER TABLE restaurants ADD COLUMN google_last_checked_at TEXT;
-- SQLite forbids UNIQUE inside ADD COLUMN, so the uniqueness lands here
-- (valid in both SQLite and Postgres).
CREATE UNIQUE INDEX IF NOT EXISTS ux_restaurants_google_place_id
  ON restaurants (google_place_id);
