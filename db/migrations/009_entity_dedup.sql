-- 009_entity_dedup.sql
--
-- Merge duplicate restaurant rows created by curly/straight apostrophe
-- variants in source names (e.g. "L'industrie" vs "L’industrie Pizzeria").
-- Listings move to the surviving row, keeping their own addresses, tags,
-- reviews and guide entries; the orphan restaurant row is deleted.
-- Survivor rule: most listings wins, ties broken toward the straight-
-- apostrophe spelling. Afterwards every restaurant name is normalised to
-- straight quotes so the crawler's canonical matching (which folds quotes)
-- keeps working.

-- 1. l'industrie -> keep f0c3b727 ("L’industrie Pizzeria", 2 listings)
UPDATE source_listings SET restaurant_id = 'f0c3b727-4128-4106-b33d-e06aedfb5fe4'
  WHERE restaurant_id = '622cd889-309f-481e-97ec-bc1b13334a18';
DELETE FROM restaurants WHERE id = '622cd889-309f-481e-97ec-bc1b13334a18';

-- 2. breakfast by salt's cure -> keep 0c506b7e (straight apostrophe)
UPDATE source_listings SET restaurant_id = '0c506b7e-27f1-42a7-afca-44d41d3118be'
  WHERE restaurant_id = '16307bc7-8d69-4db9-9970-8b169c14ed9b';
DELETE FROM restaurants WHERE id = '16307bc7-8d69-4db9-9970-8b169c14ed9b';

-- 3. bubby's -> keep 6e539f3e (straight apostrophe)
UPDATE source_listings SET restaurant_id = '6e539f3e-2851-4df3-af0c-ddfcaacbfd98'
  WHERE restaurant_id = '079c4b1e-62d0-438f-aaa2-49d4b9efa706';
DELETE FROM restaurants WHERE id = '079c4b1e-62d0-438f-aaa2-49d4b9efa706';

-- 4. compton's -> keep e8153558 (straight apostrophe)
UPDATE source_listings SET restaurant_id = 'e8153558-05b9-411a-89db-7e12709f58b3'
  WHERE restaurant_id = 'cf6d33a3-4deb-4792-964c-c2c54440c110';
DELETE FROM restaurants WHERE id = 'cf6d33a3-4deb-4792-964c-c2c54440c110';

-- 5. herbie's burgers -> keep 3c4f0dcc (straight apostrophe)
UPDATE source_listings SET restaurant_id = '3c4f0dcc-dbd8-457d-9053-934f1abd3463'
  WHERE restaurant_id = '7fcb0629-28d1-4414-9e22-ecfd5204174c';
DELETE FROM restaurants WHERE id = '7fcb0629-28d1-4414-9e22-ecfd5204174c';

-- 6. let's chama -> keep 25921ae4 (straight apostrophe)
UPDATE source_listings SET restaurant_id = '25921ae4-fc1c-4237-b276-ae3f639f4f5b'
  WHERE restaurant_id = 'e6b71f11-e420-4d1e-a332-98e6eefced7b';
DELETE FROM restaurants WHERE id = 'e6b71f11-e420-4d1e-a332-98e6eefced7b';

-- 7. little ruby's -> keep d37c1233 (straight apostrophe)
UPDATE source_listings SET restaurant_id = 'd37c1233-5b65-4cca-b513-1c9fb7d74b41'
  WHERE restaurant_id = '8118a685-3055-43b5-9a2a-8aa919ead2c6';
DELETE FROM restaurants WHERE id = '8118a685-3055-43b5-9a2a-8aa919ead2c6';

-- 8. nene's taqueria -> keep 96907b96 (straight apostrophe)
UPDATE source_listings SET restaurant_id = '96907b96-b1e4-4782-bf50-9a3b4e63b089'
  WHERE restaurant_id = '3f9e3337-7a56-470f-8a88-09cc4940c42e';
DELETE FROM restaurants WHERE id = '3f9e3337-7a56-470f-8a88-09cc4940c42e';

-- 9. regina's grocery -> keep 65d7a18a (2 listings)
UPDATE source_listings SET restaurant_id = '65d7a18a-4b48-4e81-a25f-e0b056cd5385'
  WHERE restaurant_id = 'cbdffde9-b1e7-405c-b2ce-d4bd1177bc55';
DELETE FROM restaurants WHERE id = 'cbdffde9-b1e7-405c-b2ce-d4bd1177bc55';

-- 10. roberta's -> keep bb684088 (straight apostrophe)
UPDATE source_listings SET restaurant_id = 'bb684088-d2bf-4db9-860b-ddb18a0473a6'
  WHERE restaurant_id = '6ec4a054-bee6-4ec9-9450-996e4df380b8';
DELETE FROM restaurants WHERE id = '6ec4a054-bee6-4ec9-9450-996e4df380b8';

-- 11. xi'an famous foods -> keep 08ba771d (3 listings)
UPDATE source_listings SET restaurant_id = '08ba771d-26fe-4482-bfd7-6428918b1b01'
  WHERE restaurant_id = '419e1760-eabf-497e-ab49-63c9e5230fc6';
DELETE FROM restaurants WHERE id = '419e1760-eabf-497e-ab49-63c9e5230fc6';

-- 12. zaro's family bakery -> keep 91a90785 (straight apostrophe)
UPDATE source_listings SET restaurant_id = '91a90785-6180-44cc-a552-8a75d7aae1cb'
  WHERE restaurant_id = 'd24c3009-7076-4a7e-9458-08423e413efb';
DELETE FROM restaurants WHERE id = 'd24c3009-7076-4a7e-9458-08423e413efb';

-- Normalise every remaining restaurant name to straight quotes so future
-- crawler upserts (which fold quotes before matching) hit existing rows.
UPDATE restaurants
SET name = REPLACE(REPLACE(REPLACE(REPLACE(name, '’', ''''), '‘', ''''), '“', '"'), '”', '"')
WHERE name LIKE '%’%' OR name LIKE '%‘%' OR name LIKE '%“%' OR name LIKE '%”%';
