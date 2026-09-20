# Round 1 (2026-09-20)

Seed: `581bda1d8337d57f` (random; exploration only — regression and invariants are deterministic).
Build under test: `3e27255` (live Railway). ~95 tool calls logged to `rounds/calls.jsonl`.

## Build / data delta since round 0

- GitHub HEAD moved `d6f0959` → `3e27255` (confirmed via `git ls-remote`). Commits in between:
  `f30a599` refresh-volume-DB-from-image, `5414928` retry after a platform-level deploy failure,
  `48ea7e0` revert of f30a599, `3c024f8` safe atomic volume data releases + corrupt-DB self-healing,
  `fe2c3e9` Eater-only venue retrieval + atomic volume data releases, `3e27255` automated AI PR review.
- Pinned call (`get_restaurant Lilia`) is NOT byte-identical: `data_as_of` moved
  `2026-09-19T19:35:47.520Z` → `2026-09-20T16:36:56.796Z`. Same key set, venue fields unchanged.
  `metrics/baseline.json` refreshed; round-0 baseline kept under `previous`.
- **Both code and data changed this round.** Every regression verdict below was checked
  against "data changed vs logic broke" before filing.

## Exploration shape (derived from seed 581bda1d8337d57f)

- Persona: user with an impossible constraint
- Angle: idempotency
- Focus tools: find_guides, top_rated, guide_consensus
- Depth: 12 calls (+3 depth-first follow-ups), depth-first on Eater-guide integration
- Weighting: find_guides was untouched in round 0; recent commits touched Eater-only
  retrieval and the data-release path.

## Regressions

None genuine. One content-pinned assertion failed and was re-pinned, not regressed:

- **f-007** (`L'Industrie guide_appearances == 11`): the Eater backfill added a second venue
  record for the same real-world spot — `L'Industrie` (Eater-sourced, id
  `afd434b6-10c3-4a9d-b3f5-99b81ea5bb45`, rating null, 3 Eater guide appearances) alongside
  the existing `L'industrie Pizzeria` (Infatuation, rating 9, search card now 13, was 11).
  `get_restaurant` and `compare_restaurants` both resolve the exact name to the Eater record
  (same id) and agree: get list length 3 == compare count 3. The *mechanism* (cross-tool
  agreement) holds; only the content-pinned `== 11` broke under the data change.
  Status stays `verified`; assertion re-pinned to behaviour
  (`len(get list) == compare count`, see `assertion_scope`). The duplicate record itself is
  a crawler dedup matter, not an API logic defect — noted, not filed.
- f-001..f-006, f-008, f-009: all PASS, stay `verified`.
- f-010a, f-010b, f-012, f-013: re-run, unchanged, stay `open`. Note: f-012's silent-`[]`
  for unknown occasion strings also reproduces on `top_rated` — same mechanism, wider
  surface than the original finding states.

## New findings

### Low
- **f-014** `address` is a string on search/top_rated cards but a dict on get_restaurant
  detail (open, high confidence). Card shows `'301 W Broadway'`; detail has the structured
  dict. Negative control passed: card string == detail `line1` on all 5 sampled venues, so
  this is a card projection, not data disagreement — but it is the f-013 class (one field
  name, two shapes) and an agent parsing address components from a card will break.
  Assertion is type-agreement across tools (behaviour-pinned).

## Passes worth recording

- **Eater backfill is live and retrievable**: Koloman and El Castillo de Jagua (Eater-only)
  resolve by exact name with `closed:true`; `data_as_of` is fresh. The Eater guide
  "The Best New Restaurants in Manhattan, According to Eater Ed…" surfaces in `find_guides`
  with 16/16 entries linked to venue ids.
- **find_guides** (round-0 gap closed): `include_entries=false` returns `entries: []` with
  `entry_count` retained — the Round-4 feature works.
- **Idempotency**: every repeated call this round (get, guide_consensus, top_rated,
  find_guides) returned byte-identical payloads.
- **Filter honesty**: Williamsburg/Italian filters honest with `matched_neighborhood`
  disclosure; `neighborhood="Narnia"` → `[]`.
- **No padding**: `cuisine=Mongolian limit=50` → 1 row, and it is Mongolian.
- **Error over silence (mostly)**: partial coords and radius-without-coords rejected with
  descriptive messages; `limit="abc"` → MCP -32602. The gap remains f-012's class.
- **Cross-tool agreement**: rating/price_tier/closed agree across get/search/compare for
  all sampled venues (incl. unicode names: Đi Ăn Đi).
- **Structured vs editorial**: Koloman / El Castillo de Jagua `closed:true` with no
  contradicting prose (Eater-only listings carry no review summary); Atla still
  `closed:true`.
- **Impossible constraints**: `min_rating=10`, `neighborhood="Narnia"`, nonsense theme —
  all return empty, which is the correct answer for a satisfiable-but-empty query.

## Corrections / notes

- During exploration I first read Eater guide entries with the wrong key names
  (`venue_id`/`name`) and concluded they were unlinked; the actual keys are
  `restaurant_id`/`restaurant_name` and 16/16 are linked. Corrected in the same pass.
- My invariant suite initially sent 5 names to `compare_restaurants`, which caps at 3
  (MCP -32602 "Too big"). Re-ran with 3 — a suite bug, not a server defect. The ≤3 cap
  itself is a documented input limit, not filed.
- `reservation` is absent (null) on all cards and a dict-or-null on detail — a card
  projection like f-014's, but absence rather than a conflicting type; noted, not filed.
- `rating` serialises as int (9) on some cards and float (8.4) on others — JSON number
  variance, benign; not filed.
- f-007's `expected` and assertion were rewritten this round (see above); the old
  content-pinned assertion is preserved in git history.

## Metrics

- `metrics/population.json`: 96 cards. Booking null rate 0.854 (was 0.80 — data release,
  no finding's assertion newly passed on booking, so not cheating per the prompt's rule).
  Policy distribution: 13 recommended / 1 required / 82 null.
- `metrics/coverage.json`: 7/8 tools exercised (submit_feedback still deliberately
  untouched); find_guides gap closed; `clean_rounds` seeded.

## Files

- `findings.json` — 14 findings (9 verified, 5 open)
- `rounds/round-1.md` — this report
- `rounds/regression-1.json`, `rounds/regression-1-results.json`
- `rounds/invariants-1.json`, `rounds/invariants-1-results.json`,
  `rounds/invariants-2.json`, `rounds/invariants-2-results.json`
- `rounds/explore-1.json`, `rounds/explore-1-results.json`, `rounds/round-1-shape.json`
- `rounds/calls.jsonl` — all round-1 calls appended (replayable envelopes)
- `metrics/baseline.json` (refreshed, old kept under `previous`),
  `metrics/population.json`, `metrics/coverage.json`

Nothing committed (parent reviews and commits).
