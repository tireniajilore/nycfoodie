-- 016_eater_also_featured_in.sql
--
-- Provenance for the Eater maps crawler (2026-09-21): each map entry's
-- "Also featured in" cross-references — permalinks of the other Eater maps
-- that feature the same venue — are stored as a JSON array on the listing.
-- NULL when the map page carried no cross-references.
--
-- This preserves the cross-guide discovery signal the parser extracts from
-- MapLayoutQuery's venue.posts.nodes, rather than dropping it on the floor.
-- The Eater crawler upserts this column (insert + update); other ingestion
-- paths never touch it.
--
-- Postgres-compatible: plain ADD COLUMN, no default.

ALTER TABLE source_listings ADD COLUMN also_featured_in_json TEXT;
