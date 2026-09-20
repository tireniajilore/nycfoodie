-- 013_dataset_freshness.sql
-- Dataset vintage tracking: data_as_of for every API response.
-- built_at = when the dataset was last built/crawled. Backfilled from the
-- most recent listing crawl so existing databases get an honest value;
-- the crawler upserts it on every write run (see stampDatasetBuiltAt).

CREATE TABLE IF NOT EXISTS dataset_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO dataset_meta (key, value, updated_at)
SELECT 'built_at', m, m
FROM (SELECT MAX(last_crawled_at) AS m FROM source_listings)
WHERE m IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dataset_meta WHERE key = 'built_at');
