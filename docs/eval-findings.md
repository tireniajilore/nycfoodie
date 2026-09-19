# Eval findings — 2026-09-19

Source: user-run evaluation, two rounds + 3-agent eval (20 traced calls).
Consolidated by dropping superseded material per the reporter's own notes:
entry 1's two main claims and entry 2's closing guide_consensus claim are
wrong; entry 3 + the hyphen and min_rating findings from entry 2 are accurate.

## HIGH

1. **No borough hierarchy.** `neighborhood='Brooklyn'` only matches stored
   strings containing "Brooklyn" (Brooklyn Heights, Downtown Brooklyn),
   silently omitting Williamsburg, Fort Greene, Carroll Gardens, Bed-Stuy,
   Red Hook. Plausible-looking but badly incomplete — worst failure mode.
2. **Unsupported city returns `[]`, not an error.** `top_rated(city='chicago')`
   yields `[]`; an agent reports "no good restaurants in Chicago" instead of
   "NYC only". Only `new-york` is supported.
3. **guide_consensus pads with off-theme venues.** When matching venues <
   limit, it fills with off-theme venues instead of returning fewer.
   `theme='ramen' limit=2` → 2 correct; `limit=5` adds Radio Kwara, Taste
   From Everest, Vatan. (Earlier "theme join is broken" diagnosis retracted:
   the join is fine, the padding is the bug.)

## MEDIUM

4. **Hyphen tokenization.** Text matching is literal substring per
   whitespace-delimited token, ANDed. Hyphens are not separators:
   `query='date-night Italian'` → `[]` (the tool description's own example!),
   `occasion='date-night'` → `[]` while `occasion='date night'` works.
   ('Bedford-Stuyvesant' works only as a literal substring.)
5. **`min_rating=0` is not a no-op.** It silently drops venues with
   `rating=null` (e.g. Shuya); nulls should be excluded only by a positive
   threshold.
6. **Occasion vocabulary mismatch.** `occasion='group dinner'` (the tool
   description's second example) returns `[]`; stored values are things like
   "Date Nights". Tiny vocabulary, no enum, no list endpoint to discover it.
   Normalize input or expose allowed values.
7. **LaRina's reservation URL is hardcoded to `?date=2025-05-02`** — a date
   well in the past.
8. **`booking` is null even when `reservation.url` exists**, so the field
   meant to answer "can I book" often can't.
9. **`include_closed=true` adds closed venues but compact results have no
   closed flag**, so they can't be distinguished in search output.

## LOW

10. **Empty strings in tag arrays.** `good_for`/`occasion` contain `""`
    (e.g. laliko: `["", "Date Nights"]`) — parsing leak.
11. **Schema drift across tools** — `neighborhood` (string) vs
    `neighborhoods` (pipe-delimited) vs `good_for` vs `tags.occasion`;
    `closed` (bool) vs `is_closed` (0/1).
12. **`found:false` returns no near-match suggestions.** Name resolver maps
    typo "Sema" to Houseman instead of Semma — needs fuzzy matching +
    did-you-mean.
13. **Empty query silently returns the top-rated default** — document or flag it.

## Regression checklist (must keep working)

- Search by neighborhood + cuisine, sorted by rating with guide counts
- `get_restaurant` full picture (rating, resy/opentable link, review meta, guide blurbs)
- `compare_restaurants`, `find_guides` ranked with blurbs
- `find_similar` (semma → NY dosas/dhamaka)
- Proximity search returns `distance_km`
- Unknown names fail clean with `found:false`
- Partial-failure in `compare_restaurants`, accented name resolution,
  `min_rating` inclusive boundary, `sort=guides`, untuned guide_consensus,
  `include_prose`, five stacked structured filters

## Open feature request

- **Feedback read-back.** `submit_feedback` is write-only; there is no way to
  audit or retrieve what was logged. Proposal: admin-only HTTP endpoint behind
  a token (NOT an MCP tool — feedback must not be visible to all agents).

## Fixed 2026-09-19 (MEDIUM + LOW sweep)

1. **Hyphens are token separators now.** Free-text queries split on
   `[\s-]+`, so `query='date-night Italian'` works (returns Via Carota et al).
   Structured tag filters (cuisine/neighborhood/occasion) treat `-` as a
   LIKE wildcard: `occasion='date-night'` matches 'Date Nights',
   `neighborhood='Bedford-Stuyvesant'` still matches literally.
2. **`min_rating=0` is a no-op.** Falsy check instead of `!== undefined`;
   null-rated venues (e.g. Shuya) are no longer dropped by an explicit 0.
3. **Occasion vocabulary exposed.** The `occasion` param description now lists
   all allowed values (Date Nights, Happy Hours, Pre-Theater, See & Be Seen,
   Serious Takeout Operation, Unique Dining Experiences, Wasting Your Time &
   Money). 'group dinner' has no equivalent in the data — documented as such.
4. **Stale reservation dates stripped.** Migration 007 removes crawl-time
   `date=`/`default_date=` params from 216 reservation URLs (LaRina,
   L'Artusi, Lilia, Thai Diner, Tatiana, The Grill, SevenRooms venues…).
   Dockerfile now also copies `db/migrations` into the image so migrations
   run against the live volume DB on boot.
5. **Booking fallback.** When `reservation.url` exists but no booking policy
   is stated, `booking` is `'reservations-available'` (search) /
   `{policy:'reservations-available'}` (`get_restaurant`) instead of null.
6. **Closed flag: not a bug.** Verified against the originally deployed code:
   `include_closed=true` results already carried `closed:true` for all five
   known-closed venues. Made it always-present (`closed:false` when open)
   for consistency.
7. **Empty tag strings fixed at the root.** The crawler's `tagFromPath`
   created one empty-label occasion tag per listing (54 rows, 12,025 links);
   now skips blank labels. Migration 007 deletes the junk rows. Read-time
   filtering added as a safety net.
8. **Schema drift reduced.** `closed` is now a boolean on every tool
   (`get_restaurant` dropped the `{status}` wrapper — the underlying
   `closed_status` data was junk, always 'Open'). `guide_consensus`
   `neighborhoods` is now an array, not pipe-delimited. Search cards always
   carry `closed` and `booking` (possibly null).
9. **Typo-tolerant name resolution.** `resolveRestaurant` now ranks all names
   by exact/prefix/word-boundary match then Levenshtein distance: 'Sema' →
   Semma (was: Houseman). `found:false` responses include `suggestions`
   (top-3 names) on `get_restaurant`, `find_similar`, `compare_restaurants`.
10. **Empty query documented.** `search_restaurants` description now states
    that no query/filters returns the highest-rated venues.

## Round 2 — regression (2026-09-19, feedback 7e2a4723, get_restaurant, 4/5)
Confirmed FIXED (10 of 12): hyphen tokenization, min_rating=0 null retention,
unsupported-city error, guide_consensus theme padding, borough hierarchy,
'Bed-Stuy' alias, LaRina stale reservation date, empty occasion tags,
guide_consensus neighborhoods array, closed in list results.
STILL OPEN: (a) occasion='group dinner' returns [] — no such tag in data;
vocabulary is documented in the tool description, 'group dinner' appears only
as conversational copy on the landing page (http.ts:176), not as a schema
example. (b) LaRina review.headline null while summary populated (source data).
NEW: (1) multi-neighborhood venues only findable under the primary listing's
neighborhood — L'industrie (f0c3b727) tagged ['Little Italy','Williamsburg']
across listings, but the neighborhood filter checks the primary listing only;
(2) collapsed neighborhood unstable across tools (toCard takes primary
listing's first GROUP_CONCAT value; compare takes all-listings tags[0]);
(3) duplicate cuisines ['Pizza','Pizza'] — getRestaurant aggregates tags
across listings with no dedup; (4) chain entity resolution — L'industrie has
2 DB records for 3 editorial locations, curly vs straight apostrophes,
price_tier 2 vs 1; (5) booking has three shapes — string (cards), object
(get_restaurant), string-or-null (compare); (6) reservation null (get) vs
false (compare) for the same venue. METHOD NOTE: guide_appearances 7 vs 8
across calls treated as deploy noise.

## Round 3 — geo / vocabulary / thin data (2026-09-19, feedback 847bea14, find_similar, 3/5)
(1) CONFIRMED: lat+lng without radius_km silently ignored — buildWhere only
applies the geo bounding box when lat+lng+radiusKm are ALL present; live
check returned city-wide top picks with no distance_km. Same for
lat+radius without lng. (2) CONFIRMED: query matches names and tag labels
only — review prose and guide blurbs unsearchable ('cacio e pepe' -> []).
(3) CONFIRMED live: La Bastide (8.8, Westchester, guide_appearances=0) ranks
6th in top_rated cuisine='French' under city='new-york'. (4) CONFIRMED BUG in
findSimilar scorer: `SUM(CASE mt.kind WHEN 'cuisine' THEN 3 ... ELSE 1 END)`
— unmatched candidate tags have mt.kind NULL, which falls through to ELSE 1,
so EVERY candidate tag scores >= 1 and tag_score measures candidate tag
breadth, not intersection. NY Dosas (6 cuisine tags) scored 8 vs Cenadou's 7
with zero shared tags. HAVING tag_score > 0 is therefore vacuous. (5) One
transient 5xx on top_rated, not reproducible — flagged flaky.
ROOT-CAUSE THESIS from evaluator: the server fills the requested limit
whether or not it has signal (borough omission, city-slug silence, geo drop,
consensus padding, find_similar noise); suggests a shared policy — fewer
results or a confidence field — rather than per-tool fixes.
