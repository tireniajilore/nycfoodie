# Spec: Eater-only venue enrichment ("Half 2")

Status: proposal. Fixes the skeleton-record problem for the 404 Eater-only
restaurants (of 6,159 total) that have no Infatuation listing.

## 1. Problem

Eater-only venues resolve (the merge works) but arrive as skeletons:

| Field | State for Eater-only venues | Why |
|---|---|---|
| rating | NULL, always | Eater abolished star ratings site-wide in Sept 2021 — there is no numeric rating to extract, ever |
| price_tier / price_label | NULL, all 404 | Eater publishes no price tiers; prices appear only incidentally in blurb prose ("$12 cocktails") |
| tags | zero, all 404 | The tag pipeline is Infatuation-only; Eater entries carry no cuisine/occasion taxonomy |
| reviews | zero, all 404 | Eater writes no full critic reviews; its content unit is the guide-entry blurb, stored in `guide_entries.blurb` (captured, but not surfaced as venue review text) |

Consequences (confirmed in `mcp/src/queries.ts`):

- Any `min_rating`, `price_tier`, or `cuisine` filter silently drops all 404
  (`pl.rating >= ?` / `pl.price_tier = ?` exclude NULLs; cuisine needs tags).
- Unfiltered search sorts NULL ratings last — Eater-only venues sink to the bottom.
- The only reliable path to them is exact-name lookup.

Related structural gap: **there is no Eater crawler in the repo.**
`crawler/src` handles Infatuation + Google Places only. The 126 Eater guides in
the dataset came from a one-off ingestion that was never committed, so this
can't be fixed by extending a pipeline — there isn't one.

## 2. Goals

- Eater-only venues become discoverable through search filters (cuisine at minimum).
- Venue pages show real editorial prose instead of an empty review field.
- Never invent data: no fabricated ratings, prices, or tags.

## 3. Non-goals

- Numeric ratings for Eater-only venues. The source has none; NULL is correct.
- Structured price tiers. Blurb price mentions stay prose.
- Hours. Eater has none; Google Places remains the gap-filler (separate work).
- Occasion tags. Eater has no occasion taxonomy; don't invent one.

## 4. Design

### 4.1 Committed Eater ingestion

New `crawler/src/eater/` module replacing the uncommitted one-off:

- Maps (`/maps/`) → entries → venue pages (`/venue/`).
- `source_key`: Eater's stable numeric venue IDs (observed live, e.g.
  `/venue/66473/bar-le-sparrow`), not slugs.
- Per entry capture: name, blurb, position, address, phone, website link,
  and the "Also featured in" cross-references (cheap guide-discovery signal).
- Reuse the existing `matchOrCreateRestaurant` in `crawler/src/store.ts`
  (already source-generic).

### 4.2 Blurb → venue prose

The blurbs are already in `guide_entries.blurb` — this is a read-path change,
no recrawl needed:

- Add an explicit `editorial_blurbs` array to the `get_restaurant` payload for
  Eater-only venues: `[{ guide_title, position, blurb }]`, attributed per guide.
- Prefer the explicit array over synthesising a fake "review": a stitched
  blurb implies a critic verdict that doesn't exist. Clients (and the card
  renderer) compose from it.
- `search_restaurants` cards for Eater-only venues may include the top blurb
  (highest-position entry) as the card's descriptive text.

### 4.3 Eater-scoped tags

`tags.source_slug` already exists — create `eater`-scoped rows:

- **Cuisine**: Eater maps are frequently cuisine-themed ("best Sichuan", "best
  Italian"). Maintain a small curated guide-theme → cuisine-tag map and apply
  it to entries. Curated, not inferred per-venue, so no invented data.
- **Neighborhood**: from the venue's address/locality (already captured).
- **Occasion**: skip — Eater has no occasion taxonomy.
- Backfill the existing 404 from data already in the DB (guide titles +
  addresses); no recrawl required for v1.

This is the change that makes cuisine filters match Eater-only venues.

### 4.4 Search semantics

- Keep `min_rating` / `price_tier` filter semantics (NULLs excluded). Document
  in tool descriptions that Eater-only venues are *unrated/unpriced*, not
  low-quality — the absence of a value is not a low value.
- With cuisine tags in place, Eater-only venues become reachable via
  cuisine + free-text search (blurb FTS already indexes entry text).
- Optional ranking tweak (deferred, needs a decision): unfiltered search
  currently buries all NULL-rating venues. Interleaving a few Eater-only
  results would improve discovery but is editorialising — flag for review.

### 4.5 Data model

- No migration required for v1: tags need no schema change, blurb surfacing
  is read-time. If a materialised `editorial_summary` is later wanted, add
  migration `014` then.
- Crawler upserts: extend `store.ts` with an Eater entry upsert path
  (venue keyed by numeric venue ID).

## 5. Backfill plan (no recrawl)

1. Script: apply the guide-theme → cuisine map to existing `guide_entries`,
   writing `eater`-scoped `listing_tags`.
2. Script: neighbourhood tags from existing listing addresses.
3. Verify: all 404 have ≥1 tag; spot-check 20 for correctness (no invented
   cuisines).
4. Ratings/prices remain NULL — assert this in the backfill (negative control).

## 6. Verification

- New eval checks: Eater-only recall under a cuisine filter (e.g.
  `cuisine=sichuan` returns Eater-only venues), venue-page prose presence for
  a sample of 20 Eater-only venues.
- Negative controls: assert no Eater-only venue gains a rating, price_tier,
  or occasion tag.
- Live verify post-deploy: `get_restaurant(name=...)` on an Eater-only venue
  shows `editorial_blurbs`; `search_restaurants(cuisine=...)` includes it.

## 7. Rollout

PR → automated AI review → merge → Railway auto-deploy → live verification
(same playbook as the schema quick-wins PR).

## 8. Open questions

1. Explicit `editorial_blurbs` array vs a composed `editorial_summary` string —
   which serves agent clients better?
2. Guide-theme → cuisine mapping: curated static map vs LLM classification at
   crawl time (cost/latency vs coverage)?
3. Should unfiltered ranking upweight Eater-only venues, or is burying NULLs
   the honest default?
