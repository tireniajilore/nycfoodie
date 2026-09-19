-- 011_closure_corrections.sql
-- Round 4 evaluation (2026-09-19): the structured closed flag contradicted the
-- editorial layer, which is the freshest source. Audit of guide blurbs with
-- closure language found these venues unambiguously described as closed with
-- no operating incarnation; mark them so customers are not sent to shuttered
-- restaurants. Deliberately NOT marked: Sam's Cobble Hill (closed 2025 but
-- "being reborn" with a Sept 2026 reopening), Angel's Share (original room
-- closed but operating as a popup), Wizard Hat (shut 2024, brick-and-mortar
-- comeback pending), Babbo (renovations), Dante (reopened under new owners),
-- Daniel Boulud's UWS trio (unnamed in the blurb — unresolvable), and venues
-- with no restaurant row at all (Llama Inn, Del Posto, Uncle Boon, Artopolis,
-- Lalou, Boca Santa, Ferdinando's Focacceria, The Four Seasons).

-- Atla. Evidence: "NYC's Most Exciting Fall Restaurant Openings" (published
-- 2026-09-08), entry 37: "Noho all-day Mexican spot Atla closed earlier this
-- year. In its place, the same team will open Bar Cosme."
UPDATE source_listings SET is_closed = 1, closed_status = 'Closed'
WHERE restaurant_id = (SELECT id FROM restaurants WHERE name = 'Atla');

-- La Taq. Evidence: "The Best Restaurants In Park Slope": "When La
-- Taq—formerly La Taqueria—closed in 2011..."
UPDATE source_listings SET is_closed = 1, closed_status = 'Closed'
WHERE restaurant_id = (SELECT id FROM restaurants WHERE name = 'La Taq');

-- 232 Bleecker. Evidence: "NYC's Most Exciting Spring Restaurant Openings":
-- "A former chef of Greenwich Village's now-closed 232 Bleecker..."
UPDATE source_listings SET is_closed = 1, closed_status = 'Closed'
WHERE restaurant_id = (SELECT id FROM restaurants WHERE name = '232 Bleecker');
