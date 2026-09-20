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

## Resolution — commit 6174a2d (2026-09-19, pushed, Railway redeploy pending)
All Round 2 + Round 3 items addressed:
- 008_listing_text_fts.sql: FTS5 over review prose + guide blurbs with sync
  triggers; query tokens also match FTS. 'cacio e pepe' -> Via Carota, Lilia...
- Geo: lone lat/lng/radius_km now throws; lat+lng defaults radius to 5 km;
  points outside (30 km + radius) of Manhattan get a coverage error, not [].
- Coverage: city='new-york' discovery (search/top_rated/find_similar)
  scoped to 30 km around Manhattan; La Bastide gone from top French.
- find_similar: unmatched tags score 0 (was ELSE 1); La Bastide seed now
  returns French venues (similarity 3 = one shared cuisine tag).
- Neighborhood filter (+ borough expansion) matches across all listings;
  L'industrie found under Little Italy.
- Canonical collapsed neighborhood (primary listing, deduped, alphabetical)
  shared by cards/get/compare; cuisines deduped everywhere.
- booking is {policy, notes}|null and reservation an object|null in all
  tools (was string/object/boolean across tools).
- review.headline falls back to truncated summary (LaRina fixed).
- 009_entity_dedup.sql: merged 12 curly/straight-apostrophe dup restaurant
  rows; L'industrie is one row with three listings; crawler match-or-create
  folds quotes going forward; all names normalised to straight quotes.
- 'group dinner': no code change — the occasion vocabulary was already
  documented in the tool description; the phrase appears only as landing-
  page conversational copy, not as a schema example.
- Transient 5xx + guide_appearances wobble: treated as deploy noise, no action.
Verified locally against nycfoodie.db; verified live on production 2026-09-19:
- "cacio e pepe" -> Via Carota, Lilia, Mama's Too, Misi, L'Artusi
- top_rated French: La Bastide gone (Le Veau d'Or, Le Bernardin top)
- find_similar La Bastide -> French venues, similarity 3, no NY Dosas
- geo lat+lng without radius -> distance_km returned (5 km default)
- card booking shape is {policy, notes} live.

## Round 4 — 2026-09-19 23:04:15Z — get_restaurant — 2/5 (id 00738b50)
14 calls. Raw: goals/nycfoodie-restaurant-data-product/hidden_files/feedback-round4.txt.
Fixed confirmed: booking object shape consistent across get/search/top_rated.
Bugs:
1. CRITICAL: get_restaurant('Atla') closed:false, but guide "NYC's Most Exciting
   Fall Restaurant Openings" (2026-09-08) says Atla closed earlier this year,
   Bar Cosme taking its Noho space. Same guide flags Sam's (closed 2025),
   Wizard Hat (shut 2024), Genesis House (pivoting). Editorial layer is fresher
   than the closed flag; suggest audit of closure-language blurbs vs flag.
   Evaluator notes include_closed=true seemed to change nothing -> very little
   marked closed at all. guide_consensus top 50 all is_closed=0 (weak evidence).
2. neighborhood='Noho' returns Fish Cheeks (Williamsburg) because its review
   headline mentions "the Noho original". Reproduces in search + top_rated
   (shared filter logic). False positives now, after Round 3 fixed false
   negatives (L'industrie/Little Italy). Casing fine ('Noho' vs 'NOHO').
3. find_guides has no entries-off mode: 73 blurbs for 3 guides with no query.
   Suggest include_entries:false mirroring include_prose.
4. review_headline conflates headline and summary: Atla headline == summary
   byte-identical; Il Buco, Torien also descriptive sentences. Opposite of
   LaRina's null headline (Round 2/3).
5. NULL restaurant_id guide entries persist: black & white cookies guide pos 5,
   fall openings pos 34. (Round 1 carryover.)
Pattern note: rounds 1-3 were API-logic (padding, dropped params, empty vs
error); round 4 is structured-vs-editorial disagreement -> data-pipeline
problem, needs a different fix.

## Round 4 resolutions — 2026-09-19 (commit pending)
1. CLOSED FLAG vs EDITORIAL: audit of 182 blurbs with closure language.
   Marked closed (migration 011, evidence in comments): Atla (fall openings
   guide 2026-09-08: "closed earlier this year", Bar Cosme taking the space),
   La Taq (closed 2011), 232 Bleecker ("now-closed"). Deliberately not marked:
   Sam's Cobble Hill (closed 2025 but reborn Sept 2026), Angel's Share
   (original room closed, popup operating), Wizard Hat (comeback pending),
   Babbo (renovations), Dante (reopened), Boulud UWS trio (unnamed,
   unresolvable), and 8 venues with no DB row at all. Ugly Baby needed no
   change — its listing already carries the new 364 Grand St Williamsburg
   address (reopened Sept 2026 per bkmag). Closed venues: 5 -> 8.
2. FISH CHEEKS/NOHO: evaluator's mechanism was wrong — the filter is
   tag-based, never prose-based. Fish Cheeks genuinely has an open NOHO-tagged
   listing (original location) plus Williamsburg; both marked Open. The match
   is legitimate; the card just didn't explain it. Fix: cards now carry
   matched_neighborhood when a neighbourhood filter is active (Fish Cheeks ->
   NOHO). Also: tags on closed listings no longer satisfy the filter unless
   include_closed is set.
3. FIND_GUIDES: new include_entries=false parameter (default true); returns
   guide metadata with entry_count and entries: [].
4. HEADLINE: detail review.headline is now the real headline or null (a
   stored headline byte-identical to the summary, e.g. Atla, is treated as
   absent). Cards and comparisons keep the truncated-summary fallback so no
   display line goes blank (Round 2/3 fix stands). Only 328/1837 reviews have
   a distinct headline — the rest is data coverage, not code.
5. ORPHANED GUIDE ENTRIES: 1,912/12,419 (15%), ALL with entry_name NULL —
   blurb-only. The cited examples' venues (William Greenberg, Genesis House)
   have no restaurant row at all, so there is nothing to link to. Needs a
   crawler entity-linking pass (backlog, not a code fix).

## Round 5 + Instinct round 3 — 2026-09-19 (feedback ids a0c9d8f0, 5d2d6c1b)

Verdicts from live reproduction against production. B1–B4 = booking, O5–O10 = other.

### Booking (evaluator: "the weakest part of the API" — agreed)

B1. **Policy contradicts notes — CONFIRMED.** Ramen By Ra: policy
`reservations-recommended`, notes "Reservations are required…"; Bong:
`reservations-recommended`, notes "officially they're reservation-only".
Root: `bookingIntel()` in crawler/src/store.ts maps any "reservation" mention
to `reservations-recommended`; no `reservations-required` value exists.
Fix: add the value + detect required-language ("reservations are required",
"reservation-only", "doesn't take walk-ins", "no walk-ins") before the
generic reservation branch.

B2. **Null is overloaded — CONFIRMED, with a correction.** Le French Diner,
Lucali, Chrissy's Pizza → booking null. The evaluator claims "there is no
walk-ins-only value" — the code HAS `walk-in-only`, but a census of top-50
cards shows 13 recommended / 14 available / 23 null / 0 walk-in-only: no
listing's tips ever matched the walk-in patterns, so the value is dead in
practice. These three venues have no booking intel at all (only ~50 listings
do). Fix: broaden walk-in patterns; document that null means "no intel" —
policy must not be invented without source evidence.

B3. **Via Carota `reservations-available` + notes null — CONFIRMED, and the
inference is the bug.** The policy is not stored; toCard() infers it from
`reservation_url` (`booking_policy ?? (reservation_url ?
"reservations-available" : null)`). This was added for round-2 item 8
("booking null even when reservation.url exists") and now produces the exact
structured-vs-editorial contradiction class from round 4. Fix: drop the
URL→policy inference; booking comes only from real intel, the Resy link
already travels separately in `reservation`.

B4. **Notes truncate mid-word — CONFIRMED.** `trunc(s, n=280)` in
crawler/src/store.ts slices at 279 chars + "…". Raw tips text is not stored,
so existing rows need a re-crawl to restore full notes. Fix trunc() to a
word boundary for future crawls.

### Other

O5. **query='industrie' dilution — REPRODUCED, low severity.** L'industrie
Pizzeria ranks first; Semma/Mama's Too/Di Fara/Lucia/Titi's follow via FTS
prose matching. Correct behaviour, noisy tail. Evaluator suggests a
relevance floor or name-match mode.

O6. **Suggestions fire on UUIDs — CONFIRMED.** Missing UUID →
['320 Club','Mexico 2000','Pick-A-Bagel']. Root: suggestRestaurants() has no
score threshold and no id-shape guard. Fix: return [] for UUID-shaped input
or when the best score is poor.

O7. **find_similar ties — CONFIRMED.** La Bastide: all 12 results at
similarity 3, shared_guides 0 — one shared cuisine tag each; price
unweighted, neighbourhood match not decisive. Fix: add price-tier proximity
to scoring; verify neighbourhood tag matching (evaluator's Cenadou example).

O8. **guide_consensus multi-word themes — CONFIRMED, two compounding
causes.** 'cookies' → [] because the tag EXISTS clause (added in 13be7aa to
stop padding) requires a restaurant tag LIKE '%cookies%', which cannot exist.
'black and white cookies' → [] additionally because the guide is titled
"The Best Black & White Cookies In NYC" (& vs "and" defeats the LIKE).
Fix: drop the tag requirement (the ranked query already constrains to
theme-matching guides; verify ramen stays clean) + normalise &/and and
tokenise multi-word themes.

O9. **guide_appearances disagree — CONFIRMED (L'industrie = f0c3b727).**
Search card: 3 = COUNT(DISTINCT guide_id) on the primary listing only.
Compare: 11 = guide_entries ROWS across all listings (not distinct, not
primary-only). Post-merge inflation. Fix: one definition everywhere —
distinct guides across all the restaurant's listings — in search cards,
compare, and the get_restaurant count.

O10. **compare(X,X) duplicates — CONFIRMED.** compareRestaurants() maps each
input independently. Fix: dedupe by resolved id.

### Instinct agent round 3

I1. **Contra FAIL — MISATTRIBUTION, with a real UX gap underneath.** There
is no "Contra" venue in the database; get_restaurant("Contra")
prefix-resolves to Contrasto (open Greenpoint restaurant, rating null). The
closed:false and rating:null the evaluator saw are Contrasto's, not Contra's.
Closure tracking cannot flag a venue that isn't in the data. Real gap:
fuzzy matches are unlabeled — the evaluator could not tell "Contra" wasn't
an exact hit. Fix: surface match type (exact vs fuzzy) on get_restaurant.

I2. **"Sema"→Houseman — STALE, already fixed.** Live "Sema" resolves to
Semma correctly. No action.

### Round 5 correction (no action)

Evaluator withdrew the round-4 Fish Cheeks neighbourhood-text claim:
Fish Cheeks is genuinely tagged NOHO+Williamsburg; matched_neighborhood
makes it self-explanatory. Closed.

## Round 5 fixes shipped 2026-09-20 (commit pending)

All ten confirmed issues fixed, fixture-tested (27 assertions green), deployed.

- **B1** — crawler `bookingIntel()` v1: new `reservations-required` policy with
  required-language detection (are required / reservation-only / doesn't take
  walk-ins / no walk-ins / walk-ins not accepted), checked before the generic
  reservation branch. Migration 012 re-derives policies from stored wait_notes.
- **B2** — walk-in-only patterns broadened (walk-ins only, no reservations
  needed/necessary, first-come); booking:null documented as "no booking intel".
- **B3** — dropped the reservation-URL→policy inference everywhere. booking
  reflects editorial intel only; the link still travels in `reservation`.
- **B4** — crawler truncates at word boundaries; queries clean old mid-word
  cuts at read time (raw tips aren't stored, so existing rows can't be
  restored — only made honest).
- **O6** — suggestions return [] for UUID-shaped input.
- **O10** — compare_restaurants dedupes by resolved id.
- **O8** — guide_consensus: tokenized theme matching with &/and normalization;
  the tag-EXISTS clause removed. Same matching applied to find_guides.
- **O9** — guide_appearances = distinct guides across ALL listings, used by
  search cards, compare and get_restaurant alike.
- **O7** — find_similar adds price-tier proximity (+2 same tier, +1 adjacent).
- **I1** — get_restaurant returns match_type ("exact" | "fuzzy") and the tool
  description tells agents not to present fuzzy matches as named venues.
