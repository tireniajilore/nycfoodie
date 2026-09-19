-- 007_data_cleanup.sql
--
-- 1. Remove empty-label tags: a crawler parsing leak created one empty
--    "occasion" tag per listing (label '' with thousands of links).
-- 2. Strip stale crawl-time `date=` params from Resy reservation URLs
--    (e.g. ?date=2025-05-02&seats=2 -> ?seats=2). The date was the crawl
--    date, not a meaningful default.

DELETE FROM listing_tags WHERE tag_id IN (SELECT id FROM tags WHERE label = '');
DELETE FROM tags WHERE label = '';

-- ?date=YYYY-MM-DD&... -> ?...
UPDATE source_listings
SET reservation_url = REPLACE(
  reservation_url,
  SUBSTR(reservation_url, INSTR(reservation_url, '?date='), 17),
  '?'
)
WHERE reservation_url LIKE '%?date=__________&%';

-- ...&date=YYYY-MM-DD&... -> ...&...
UPDATE source_listings
SET reservation_url = REPLACE(
  reservation_url,
  SUBSTR(reservation_url, INSTR(reservation_url, '&date='), 17),
  '&'
)
WHERE reservation_url LIKE '%&date=__________&%';

-- ...&date=YYYY-MM-DD (trailing) -> ...
UPDATE source_listings
SET reservation_url = REPLACE(
  reservation_url,
  SUBSTR(reservation_url, INSTR(reservation_url, '&date='), 16),
  ''
)
WHERE reservation_url LIKE '%&date=__________';

-- ?date=YYYY-MM-DD (sole trailing param) -> base URL
UPDATE source_listings
SET reservation_url = REPLACE(
  reservation_url,
  SUBSTR(reservation_url, INSTR(reservation_url, '?date='), 16),
  ''
)
WHERE reservation_url LIKE '%?date=__________'
  AND reservation_url NOT LIKE '%?date=__________&%';

-- SevenRooms' default_date param (same staleness problem)
UPDATE source_listings
SET reservation_url = REPLACE(
  reservation_url,
  SUBSTR(reservation_url, INSTR(reservation_url, '?default_date='), 25),
  '?'
)
WHERE reservation_url LIKE '%?default_date=__________&%';

UPDATE source_listings
SET reservation_url = REPLACE(
  reservation_url,
  SUBSTR(reservation_url, INSTR(reservation_url, '&default_date='), 25),
  '&'
)
WHERE reservation_url LIKE '%&default_date=__________&%';

UPDATE source_listings
SET reservation_url = REPLACE(
  reservation_url,
  SUBSTR(reservation_url, INSTR(reservation_url, '?default_date='), 24),
  ''
)
WHERE reservation_url LIKE '%?default_date=__________'
  AND reservation_url NOT LIKE '%?default_date=__________&%';

UPDATE source_listings
SET reservation_url = REPLACE(
  reservation_url,
  SUBSTR(reservation_url, INSTR(reservation_url, '&default_date='), 24),
  ''
)
WHERE reservation_url LIKE '%&default_date=__________'
  AND reservation_url NOT LIKE '%&default_date=__________&%';
