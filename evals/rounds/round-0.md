# Round 0 — founding round (2026-09-20)

Seed: `a83e2416bb3915d9` (random; exploration only — seeding and regression are deterministic).
Build under test: `d6f0959` (live Railway). Baseline pin (`get_restaurant Lilia`) re-ran
byte-identical to `metrics/baseline.json`, and `data_as_of` is unchanged
(`2026-09-19T19:35:47.520Z`). This is the founding round, so there is no prior round
to compare against; the suite ran in full anyway. 66 tool calls logged to `rounds/calls.jsonl`.

## Exploration shape (derived from seed a83e2416bb3915d9)

- Persona: indecisive user revising constraints
- Angle: one named field in depth → **booking** (recently-touched classifier code)
- Focus tools: get_restaurant, guide_consensus, compare_restaurants
- Depth: 18 calls, breadth-first

## Regressions

None. All nine seeded fix-shipped findings passed their stored repro_call envelopes
against the live server and moved to `verified` (round_fixed 0):

- f-001 booking `reservations-required` for Ramen By Ra (Bong confirmed with the same mechanism)
- f-002 Via Carota booking null despite Resy URL
- f-003 Lilia notes 278 chars, ends `…phone…` — word boundary, not mid-word
- f-004 unknown UUID → `{found: false, suggestions: []}`
- f-005 `compare_restaurants(["Lilia","Lilia"])` → 1 row
- f-006 `guide_consensus` "cookies" and "black and white cookies" → 10 results each
- f-007 L'Industrie: 11 guide appearances in get (list), search (count) and compare (count)
- f-008 find_similar on Lilia: numeric `similarity` sorted desc, all 10 rows tier 2–3 (source tier 3)
- f-009 get_restaurant "Contra" → Contrasto, `match_type: "fuzzy"`

## New findings

### Medium
- **f-013** `guide_appearances` is a list in `get_restaurant` but an int count in
  `search_restaurants`/`compare_restaurants` (open). Values agree (L'Industrie 11 == 11,
  Lilia 18 == 18), so this is representational, not data disagreement — negative control
  held. Same field name, two shapes; unify the type or rename the card field.

### Low
- **f-012** unknown `occasion` string returns `[]` instead of an error (open). The schema
  validates the value's type (number → MCP -32602) but not its value against the documented
  allowed set; `city: "nyc"` gets a helpful rejection message, a typo'd occasion gets
  silence. Negative control: no invalid string occasion errors; theory survived.
- **f-010a** coverage boundary not enforced in `get_restaurant` (open, tracked deferral).
  Mechanism isolated this round: Cenadou is in the DB (North Salem NY, 73.5 km from Times
  Sq). `search_restaurants` enforces the 30 km boundary (text query → `[]`; geo search near
  North Salem → "outside the New York coverage area"), but `get_restaurant` resolves it by
  exact name with no distance gate. Design decision deferred in Round 5; tracked, not fixed.
- **f-010b** "industrie" ranking dilution (open, tracked deferral). Confirmed non-issue:
  `L'industrie Pizzeria` ranks first; deliberately not implemented.

## Passes worth recording

- **Filter honesty**: `neighborhood="Williamsburg"` — all 10 rows matched a member of the
  row's neighborhood set; `matched_neighborhood` discloses the match (incl. multi-tag
  venues like Birria-Landia: Jackson Heights / Williamsburg). Negative control
  `neighborhood="Narnia"` (prose-only term) → `[]`: the filter does not match prose.
  Note: `neighborhood="Williamsburg"` also returns East Williamsburg rows via substring
  matching; disclosed via `matched_neighborhood`, treated as intended semantics, not filed.
- **No padding**: `cuisine=ramen min_rating=9 limit=50` → 0 rows; `guide_consensus` ramen
  limit 5 → 5 rows.
- **Error over silence (mostly)**: partial coordinates and radius-without-coords are
  rejected with descriptive result messages (not JSON-RPC errors, not silent); `city="nyc"`
  → "Unsupported city 'nyc'. Supported: new-york."; empty id → `{found:false, suggestions:[]}`
  (consistent with f-004). The one gap is f-012 above.
- **Idempotency**: identical `get_restaurant Lilia` twice → result payloads byte-identical
  (the envelope id echo differs, which is a harness artifact, not a server difference).
- **Cross-tool agreement**: booking policy agrees between get and compare rows (Tatiana,
  Don Angie, Lilia `reservations-recommended`; Via Carota, Katz's Deli null); ratings and
  tiers agree across search/compare/get.
- **Booking field in depth** (exploration): 5/7 sampled venues carry booking intel; notes
  cap at 280 chars, none end mid-word (f-003's fix holds beyond Lilia); policy values
  observed: `reservations-required`, `reservations-recommended`, null-when-no-intel.
- **Theme normalization**: "date night" / "date-night" / "DATE NIGHT" return identical
  rankings; "cookies" fix (f-006) generalizes.
- **Compare dedupe** generalizes f-005: `["Semma","semma"]` and `["Lilia","lilia "]` each
  return 1 row (case- and whitespace-insensitive).
- **include_prose** works: adds `review.body` (not a `prose` key — check the right field).
- **Structured vs editorial**: La Taq `closed:false` with live recommendation prose
  ("Go for the carnitas…") — consistent; Fedora `closed:true` with pre-closure review
  prose — no contradiction in the sample.
- **Atla** still `closed:true` via `search include_closed=true`.

## Corrections / notes

- f-011 (La Taq) was **not filed as a finding**, against the draft instruction to seed it.
  The instruction's own condition governed: file only if the API logic is wrong. La Taq
  now returns `closed:false` via a deliberate data reversal (migration 014 "reopen
  reversal") and the editorial prose agrees — data changed, not a defect. Noted here so
  it isn't rediscovered.
- f-010a's repro was corrected during the round: the seeded envelope used a text search
  for "Cenadou" (returns `[]`), but the actual mechanism is that `get_restaurant`
  resolves the out-of-coverage venue by name. The envelope now reflects the real path.
- The regression assertion evaluator needs a builtins allowlist (`len`, `all`, `any`,
  `sorted`, `isinstance`, …); bare `eval` with `__builtins__` stripped breaks `len()`.
  Future harness runs should reuse the round-0 evaluator convention.
- `submit_feedback` was deliberately not exercised (it writes to the production feedback
  store); `find_guides` untouched — both tracked in `metrics/coverage.json`.

## Metrics

- `metrics/population.json`: 60 search cards + 7 detail records. Card booking null rate
  0.80 (null-when-no-intel, consistent with f-002); detail booking notes lengths
  273/191/278 (not emptied — f-003's fix didn't cheat); policy distribution on cards:
  11 recommended / 1 required / 48 null.
- `metrics/coverage.json`: seeded; 6/8 tools exercised.

## Files

- `findings.json` — 13 findings (9 verified, 4 open)
- `rounds/round-0.md` — this report
- `rounds/calls.jsonl` — 66 logged calls (all repro envelopes replayable)
- `rounds/seed-repro.json`, `rounds/seed-repro-results.json`, `rounds/regression-0.json`,
  `rounds/regression-0-results.json`, `rounds/invariants-a-results.json`,
  `rounds/explore-0-results.json`
- `metrics/population.json`, `metrics/coverage.json`

Nothing committed (parent reviews and commits).
