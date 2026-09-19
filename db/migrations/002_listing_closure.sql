-- 002_listing_closure.sql — closure tracking on source listings.
--
-- The Infatuation exposes closure only in layer B page data
-- (venue.closed / venue.closedStatus, verified live 2026-09-19:
-- "Permanently Closed" on a shut venue). Layer A's reviewStatus is
-- "UNSPECIFIED" even for closed restaurants, so it is ignored.
-- NULL is_closed = unknown (not yet enriched), not open.

ALTER TABLE source_listings ADD COLUMN is_closed INTEGER CHECK (is_closed IN (0, 1));
ALTER TABLE source_listings ADD COLUMN closed_status TEXT;
