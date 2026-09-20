-- 012_booking_policy_corrections.sql
-- Round 5 (B1, B2): re-derive booking policies from the stored wait_notes
-- using bookingIntel v1 rules, fixing rows the old classifier got wrong.
--
-- 1. reservations-recommended -> reservations-required where the stored
--    notes use required-language ("reservations are required",
--    "reservation-only", "doesn't take walk-ins", ...).
-- 2. null -> walk-in-only where the notes describe walk-in-only and never
--    mention reservations.
-- Both mirrors of the crawler's bookingIntel(); nothing is invented: rows
-- without matching notes keep their existing policy.

UPDATE source_listings
SET booking_policy = 'reservations-required'
WHERE booking_policy = 'reservations-recommended'
  AND wait_notes IS NOT NULL
  AND (
    wait_notes LIKE '%reservations are required%'
    OR wait_notes LIKE '%reservation is required%'
    OR wait_notes LIKE '%reservation-only%'
    OR wait_notes LIKE '%reservations-only%'
    OR wait_notes LIKE '%doesn’t take walk-ins%'
    OR wait_notes LIKE '%doesn''t take walk-ins%'
    OR wait_notes LIKE '%does not take walk-ins%'
    OR wait_notes LIKE '%do not take walk-ins%'
    OR wait_notes LIKE '%no walk-ins%'
    OR wait_notes LIKE '%walk-ins not accepted%'
    OR wait_notes LIKE '%walk-ins are not accepted%'
  );

UPDATE source_listings
SET booking_policy = 'walk-in-only'
WHERE (booking_policy IS NULL OR booking_policy = '')
  AND wait_notes IS NOT NULL
  AND wait_notes NOT LIKE '%reservation%'
  AND (
    wait_notes LIKE '%walk-in only%'
    OR wait_notes LIKE '%walk ins only%'
    OR wait_notes LIKE '%walk-ins only%'
    OR wait_notes LIKE '%no reservations%'
    OR wait_notes LIKE '%first-come%'
    OR wait_notes LIKE '%first come%'
  );
