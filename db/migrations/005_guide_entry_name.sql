-- 005_guide_entry_name.sql
--
-- Guide entries keep the caption headline as a display name so unlinked
-- entries (no matching listing) still show a name in guide output.
-- Populated on future guide crawls; existing rows stay NULL.

ALTER TABLE guide_entries ADD COLUMN entry_name TEXT;
