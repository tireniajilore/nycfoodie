-- 004_guide_entries_nullable_listing.sql
--
-- Guide entries must keep their rank position even when the referenced
-- review resolves to no known listing (wrong city, delisted review).
-- Dropping such entries would corrupt the ranking, and guessing a link
-- would corrupt the data — so the link is nullable and the blurb stays.
-- (guide_entries is empty in every existing database; the rebuild is safe.)

CREATE TABLE guide_entries_new (
  id TEXT PRIMARY KEY,
  guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  source_listing_id TEXT REFERENCES source_listings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  blurb TEXT,
  UNIQUE (guide_id, position),
  UNIQUE (guide_id, source_listing_id)
);
INSERT INTO guide_entries_new (id, guide_id, source_listing_id, position, blurb)
  SELECT id, guide_id, source_listing_id, position, blurb FROM guide_entries;
DROP TABLE guide_entries;
ALTER TABLE guide_entries_new RENAME TO guide_entries;
