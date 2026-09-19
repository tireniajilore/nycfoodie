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
