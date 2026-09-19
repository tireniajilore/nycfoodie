-- 008_listing_text_fts.sql
--
-- Full-text index over review prose (title/headline/summary/body) and guide
-- entry blurbs, keyed by source_listing_id. Lets free-text search match dishes
-- and descriptions ("cacio e pepe"), not just venue names and tags.
--
-- Kept in sync by triggers below, so future crawler writes are indexed
-- automatically. Rebuild-from-scratch if ever needed:
--   DELETE FROM listing_text_fts;
--   <repeat the initial INSERT>
--
-- NOTE: FTS5 is SQLite-specific. The runtime database is SQLite
-- (better-sqlite3); this migration is not Postgres-compatible.

CREATE VIRTUAL TABLE listing_text_fts USING fts5(
  source_listing_id UNINDEXED,
  text
);

INSERT INTO listing_text_fts (source_listing_id, text)
SELECT
  sl.id,
  COALESCE(rv.title, '') || ' ' || COALESCE(rv.headline, '') || ' ' ||
  COALESCE(rv.summary, '') || ' ' || COALESCE(rv.body_text, '') || ' ' ||
  COALESCE(
    (SELECT GROUP_CONCAT(ge.blurb, ' ') FROM guide_entries ge
     WHERE ge.source_listing_id = sl.id),
    ''
  )
FROM source_listings sl
LEFT JOIN reviews rv ON rv.source_listing_id = sl.id;

-- After any review/guide change, rebuild that listing's FTS row from the
-- current table contents (handles insert, update and delete uniformly).

CREATE TRIGGER listing_text_fts_reviews_insert AFTER INSERT ON reviews BEGIN
  DELETE FROM listing_text_fts WHERE source_listing_id = NEW.source_listing_id;
  INSERT INTO listing_text_fts (source_listing_id, text)
  SELECT NEW.source_listing_id,
    COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.headline, '') || ' ' ||
    COALESCE(NEW.summary, '') || ' ' || COALESCE(NEW.body_text, '') || ' ' ||
    COALESCE(
      (SELECT GROUP_CONCAT(ge.blurb, ' ') FROM guide_entries ge
       WHERE ge.source_listing_id = NEW.source_listing_id),
      ''
    );
END;

CREATE TRIGGER listing_text_fts_reviews_update AFTER UPDATE ON reviews BEGIN
  DELETE FROM listing_text_fts WHERE source_listing_id = NEW.source_listing_id;
  INSERT INTO listing_text_fts (source_listing_id, text)
  SELECT NEW.source_listing_id,
    COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.headline, '') || ' ' ||
    COALESCE(NEW.summary, '') || ' ' || COALESCE(NEW.body_text, '') || ' ' ||
    COALESCE(
      (SELECT GROUP_CONCAT(ge.blurb, ' ') FROM guide_entries ge
       WHERE ge.source_listing_id = NEW.source_listing_id),
      ''
    );
END;

CREATE TRIGGER listing_text_fts_reviews_delete AFTER DELETE ON reviews BEGIN
  DELETE FROM listing_text_fts WHERE source_listing_id = OLD.source_listing_id;
  INSERT INTO listing_text_fts (source_listing_id, text)
  SELECT OLD.source_listing_id,
    COALESCE(
      (SELECT GROUP_CONCAT(
        COALESCE(rv.title, '') || ' ' || COALESCE(rv.headline, '') || ' ' ||
        COALESCE(rv.summary, '') || ' ' || COALESCE(rv.body_text, ''), ' ')
       FROM reviews rv WHERE rv.source_listing_id = OLD.source_listing_id),
      ''
    ) || ' ' ||
    COALESCE(
      (SELECT GROUP_CONCAT(ge.blurb, ' ') FROM guide_entries ge
       WHERE ge.source_listing_id = OLD.source_listing_id),
      ''
    );
END;

CREATE TRIGGER listing_text_fts_guides_insert AFTER INSERT ON guide_entries BEGIN
  DELETE FROM listing_text_fts WHERE source_listing_id = NEW.source_listing_id;
  INSERT INTO listing_text_fts (source_listing_id, text)
  SELECT NEW.source_listing_id,
    COALESCE(
      (SELECT GROUP_CONCAT(
        COALESCE(rv.title, '') || ' ' || COALESCE(rv.headline, '') || ' ' ||
        COALESCE(rv.summary, '') || ' ' || COALESCE(rv.body_text, ''), ' ')
       FROM reviews rv WHERE rv.source_listing_id = NEW.source_listing_id),
      ''
    ) || ' ' ||
    COALESCE(
      (SELECT GROUP_CONCAT(ge.blurb, ' ') FROM guide_entries ge
       WHERE ge.source_listing_id = NEW.source_listing_id),
      ''
    );
END;

CREATE TRIGGER listing_text_fts_guides_update AFTER UPDATE ON guide_entries BEGIN
  DELETE FROM listing_text_fts WHERE source_listing_id = NEW.source_listing_id;
  INSERT INTO listing_text_fts (source_listing_id, text)
  SELECT NEW.source_listing_id,
    COALESCE(
      (SELECT GROUP_CONCAT(
        COALESCE(rv.title, '') || ' ' || COALESCE(rv.headline, '') || ' ' ||
        COALESCE(rv.summary, '') || ' ' || COALESCE(rv.body_text, ''), ' ')
       FROM reviews rv WHERE rv.source_listing_id = NEW.source_listing_id),
      ''
    ) || ' ' ||
    COALESCE(
      (SELECT GROUP_CONCAT(ge.blurb, ' ') FROM guide_entries ge
       WHERE ge.source_listing_id = NEW.source_listing_id),
      ''
    );
END;

CREATE TRIGGER listing_text_fts_guides_delete AFTER DELETE ON guide_entries BEGIN
  DELETE FROM listing_text_fts WHERE source_listing_id = OLD.source_listing_id;
  INSERT INTO listing_text_fts (source_listing_id, text)
  SELECT OLD.source_listing_id,
    COALESCE(
      (SELECT GROUP_CONCAT(
        COALESCE(rv.title, '') || ' ' || COALESCE(rv.headline, '') || ' ' ||
        COALESCE(rv.summary, '') || ' ' || COALESCE(rv.body_text, ''), ' ')
       FROM reviews rv WHERE rv.source_listing_id = OLD.source_listing_id),
      ''
    ) || ' ' ||
    COALESCE(
      (SELECT GROUP_CONCAT(ge.blurb, ' ') FROM guide_entries ge
       WHERE ge.source_listing_id = OLD.source_listing_id),
      ''
    );
END;
