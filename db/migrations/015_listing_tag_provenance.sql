-- 015_listing_tag_provenance.sql
-- Provenance for backfilled tags (Eater enrichment, 2026-09-21;
-- spec docs/eater-enrichment-spec.md §4.5).
--
-- assigned_by records the rule that created the row, e.g.
-- 'guide-theme-map:v1' (curated guide-theme -> cuisine map) or
-- 'backfill:neighborhood:v1' (canonical neighbourhood 1:1 match).
-- assigned_at is the UTC ISO-8601 timestamp of the write.
--
-- Both stay NULL for pre-existing Infatuation rows: their provenance is the
-- crawler, recorded in code rather than per row. Backfill writes are
-- idempotent (re-runnable, same result), auditable (rule + timestamp per
-- row) and reversible (DELETE FROM listing_tags WHERE assigned_by LIKE
-- 'guide-theme-map:%' OR assigned_by LIKE 'backfill:neighborhood:%').
--
-- Postgres-compatible: plain ADD COLUMN, TEXT timestamps, no defaults.

ALTER TABLE listing_tags ADD COLUMN assigned_by TEXT;
ALTER TABLE listing_tags ADD COLUMN assigned_at TEXT;
