-- 012_eater_closure_audit.sql
-- Closure audits run 2026-09-20 as part of the Eater backfill (branch eater-backfill).
-- Evidence: live web checks on 2026-09-20, documented below.
-- NOT marked closed:
-- - La Taq (70 Seventh Ave, Brooklyn): migration 011 (main branch) marked it closed
--   based on the 2011 closure. Live audit shows it REOPENED: lataq.com reports
--   "Currently Open" with full hours, Wanderlog notes "recently reopened after
--   closing in 2011", and the Infatuation/Grubstreet reviews describe the comeback
--   by the original owner. The 011 flag must be REVERSED at deploy time on main.
--   (This branch's DB predates 011, so nothing to undo here.)
-- - Mighty Quinn's Barbeque (75 Greenwich Ave): address conflict — Li-Lac
--   Chocolates has verifiably occupied 75 Greenwich Ave since 2005 (own site)
--   and is open today. Mighty Quinn's chain still operates elsewhere in NYC and
--   directory pages show the Greenwich Ave entry with operating hours; no
--   evidence of closure. Kept open, flagged as unresolved address conflict.

-- Koloman (16 W 29th St). Evidence: OpenTable (all regions, checked 2026-09-20)
-- marks it "Permanently Closed".
UPDATE source_listings SET is_closed = 1, closed_status = 'Closed'
WHERE restaurant_id = (SELECT id FROM restaurants WHERE name = 'Koloman');

-- El Castillo de Jagua (113 Rivington St). Evidence: OpenTable (checked
-- 2026-09-20) marks it "Permanently Closed"; Toast ordering page also closed.
UPDATE source_listings SET is_closed = 1, closed_status = 'Closed'
WHERE restaurant_id = (SELECT id FROM restaurants WHERE name = 'El Castillo de Jagua');

-- La Taq reversal (applies on production, where migration 011 marked it closed
-- based on the 2011 closure). Live audit 2026-09-20: La Taq (70 Seventh Ave,
-- Brooklyn) has REOPENED — lataq.com reports "Currently Open" with full hours,
-- Wanderlog notes "recently reopened after closing in 2011", and the
-- Infatuation/Grubstreet reviews describe the comeback by the original owner.
UPDATE source_listings SET is_closed = 0, closed_status = 'Open'
WHERE restaurant_id = (SELECT id FROM restaurants WHERE name = 'La Taq');
