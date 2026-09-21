# Spec: Eater-only venue enrichment ("Half 2")

Status: proposal, rev 2 — revised against GPT-5.5 spec review (2026-09-21).
Fixes the skeleton-record problem for the 404 Eater-only restaurants (of
6,159 total) that have no Infatuation listing.

## 1. Problem

Eater-only venues resolve (the merge works) but arrive as skeletons:

| Field | State for Eater-only venues | Why |
|---|---|---|
| rating | NULL, always | Eater abolished star ratings site-wide in Sept 2021 — no numeric rating exists in the current captured Eater guide data |
| price_tier / price_label | NULL, all 404 | Eater publishes no price tiers; prices appear only incidentally in blurb prose ("$12 cocktails") |
| tags | zero, all 404 | The tag pipeline is Infatuation-only; Eater entries carry no cuisine/occasion taxonomy |
| reviews | zero, all 404 | Eater's captured content unit is the guide-entry blurb, stored in `guide_entries.blurb` — present, but not surfaced as venue review text |

Consequences (confirmed in `mcp/src/queries.ts`):

- Any `min_rating`, `price_tier`, or `cuisine` filter silently drops all 404
  (`pl.rating >= ?` / `pl.price_tier = ?` exclude NULLs; cuisine needs tags).
- Unfiltered search sorts NULL ratings last — Eater-only venues sink.
- The only reliable path to them is exact-name lookup.

Related structural gap: **there is no Eater crawler in the repo.**
`crawler/src` handles Infatuation + Google Places only. The 126 Eater guides in
the dataset came from a one-off ingestion that was never committed.

## 2. Goals

- Eater-only venues become discoverable through search filters (cuisine at
  minimum) — with honest, partial coverage (see §4.3).
- Venue pages show real editorial prose instead of an empty review field.
- Never invent data: no fabricated ratings, prices, or tags. Ratings and
  prices stay NULL; absence of a value is not a low value.

## 3. Non-goals

- Numeric ratings or structured price tiers for Eater-only venues.
- Hours (Eater has none; Google Places remains the gap-filler, separate work).
- Occasion tags (Eater has no occasion taxonomy).
- LLM classification at crawl time for v1 (offline suggestion tool with human
  approval is acceptable later; see §4.3).

## 4. Design

### 4.1 Committed Eater ingestion — gated on a feasibility spike

New `crawler/src/eater/` module replacing the uncommitted one-off. Before
building it, a read-only spike must verify:

- Eater numeric venue IDs are stable and consistently exposed across all 126
  captured guides (they are the proposed `source_key`).
- `ny.eater.com/robots.txt` posture for our crawler's user-agent, Vox Media
  ToS stance, polite rate limits, and anti-bot behaviour.
- Page-structure change handling: snapshot raw HTML per crawl so a Chorus
  CMS change is detectable and re-parseable.

Only if the spike passes does crawler construction proceed. Per entry capture:
name, blurb, position, address, phone, website, and the "Also featured in"
cross-references (cheap guide-discovery signal). Reuse the existing
`matchOrCreateRestaurant` in `crawler/src/store.ts` (already source-generic),
subject to the merge rules in §4.5.

### 4.2 Blurb → venue prose: explicit structured array

The blurbs are already in `guide_entries.blurb` — this is a read-path change,
no recrawl needed. Verified: the `listing_text_fts_*` triggers already index
guide blurbs, so free-text search covers them today.

Add `editorial_blurbs` to the `get_restaurant` payload for **any venue with
Eater guide entries** (not only Eater-only — cross-source venues benefit too,
since Eater blurbs carry intel Infatuation lacks, e.g. happy-hour prices):

```ts
interface EditorialBlurb {
  source: "eater";
  guide_title: string;
  guide_url: string;
  position: number;      // rank within the guide
  blurb: string;        // verbatim, attributed
  captured_at: string;  // ISO timestamp
}
```

`search_restaurants` cards for venues without review prose may include the
highest-position blurb as the card's descriptive text, marked as an Eater
excerpt. No synthesised "review" — a stitched blurb would imply a critic
verdict that doesn't exist. Tool descriptions gain one line documenting the
field; the change is additive and backwards-compatible.

Attribution: blurbs are surfaced verbatim with source name, guide title and
guide URL alongside. They are short editorial excerpts as captured; no
additional excerpt truncation is imposed. Licensing posture is explicitly
deferred per the standing project decision.

### 4.3 Eater-scoped tags — allowlist only, partial coverage expected

`tags.source_slug` already exists; zero Eater-scoped rows exist today. Create
`eater`-scoped rows under a strict allowlist principle:

- **Cuisine**: a small curated guide-theme → cuisine map, applied only to
  unambiguous cuisine-themed guides ("best Sichuan" → Sichuan). Broader guides
  ("best restaurants in Queens", "hottest tables", date-night lists,
  neighbourhood roundups) are **never** mapped — their venues stay untagged
  rather than risk invented cuisines. Curated static map for v1; an LLM may
  later *suggest* mappings offline, with human approval before any row is
  written.
- **Neighbourhood**: reuse the exact canonical 175-label `neighborhood`
  vocabulary already in `tags`. Assign only on unambiguous 1:1
  locality/address matches; never coin new labels. Neighbourhood tags are a
  distinct `kind` from cuisine and flow through the existing filter join.
- **Occasion**: skip entirely.

Expect honest partial coverage: a meaningful share of the 404 will remain
tagless after v1, and that is preferable to invented tags. The backfill
reports coverage numbers; it does not chase 100%.

The existing tag join in `search_restaurants` is kind-filtered and joins
`listing_tags` → `tags` without a source restriction, so eater-scoped tags
flow through once created (to be re-verified in implementation, with a test).

### 4.4 Search semantics

- Keep `min_rating` / `price_tier` filter semantics (NULLs excluded). Document
  in tool descriptions that Eater-only venues are *unrated/unpriced*, not
  low-quality.
- No ranking upweight for Eater-only venues: keep NULL ratings honest.
  Discoverability improves through explicit cuisine/neighbourhood/text
  matches, not editorialised ordering.

### 4.5 Data model and integrity

- **Provenance**: every eater-scoped tag row records the rule that assigned it
  (`assigned_by`: e.g. `guide-theme-map:v1`, `backfill:neighborhood:v1`).
  Backfill writes are idempotent (re-runnable), auditable (rule + timestamp
  per row), and reversible (delete by `assigned_by` prefix).
- **No clobbering**: the backfill never writes, modifies, or deletes
  Infatuation-scoped tags. Eater tags are additive.
- **Uniqueness**: `UNIQUE(source_slug, source_key)` on `source_listings`.
  Historical Eater rows lacking numeric venue IDs fall back to normalised
  name + address matching; if unmatched rows exceed a 5% threshold the
  backfill stops for manual review instead of creating duplicates.
- **Negative controls** (asserted by the backfill and the test suite): no
  Eater-only venue gains a rating, a price_tier, or an occasion tag.

No numbered migration is required for v1 (tags need no schema change; blurb
surfacing is read-time). If a materialised summary is wanted later, add it
then.

## 5. Backfill plan (no recrawl)

1. Dry run: apply the curated map + neighbourhood matcher to the existing
   404; report counts (tagged vs untagged, per rule) without writing.
2. Human review of the dry-run mapping table, especially cuisine assignments.
3. Write run (idempotent); re-run to prove idempotence.
4. Spot-check 20 venues for correctness; assert the negative controls.
5. Publish coverage honestly: N of 404 gained cuisine tags, M gained
   neighbourhood tags.

## 6. Verification

- New eval checks: Eater-only recall under a cuisine filter; venue-page prose
  presence for a sample of Eater-only venues.
- Negative controls: ratings/prices/occasion tags remain NULL/absent.
- Before/after recall metrics on a fixed query set (recorded in the rollout).

## 7. Rollout

1. Feasibility spike (§4.1) — go/no-go for the crawler.
2. PR with backfill script + read-path changes → automated AI review → merge.
3. Backfill dry-run → review → write run (production data change, off-peak).
4. Railway auto-deploy → live verification: `get_restaurant(name=...)` on an
   Eater-only venue shows `editorial_blurbs`; `search_restaurants(cuisine=...)`
   includes it; before/after recall metrics compared.
5. Rollback: delete eater-scoped tags by `assigned_by` prefix; read-path
   change reverts with the deploy. Monitor query latency (new joins) for one
   deploy cycle.

## 8. Open questions — resolved

Per GPT-5.5 review (2026-09-21), decided as follows:

1. **Explicit structured `editorial_blurbs`** (with source, guide title/URL,
   position, blurb, capture date) — not a composed summary.
2. **Curated static guide-theme map for v1** — no LLM classification at crawl
   time; LLM suggestions offline with human approval only.
3. **No ranking upweight** for Eater-only venues — discoverability via
   explicit matches, NULLs stay honest.

## Appendix: review log

- 2026-09-21: GPT-5.5 spec review (11 issues) — all addressed in rev 2:
  softened absolute claims; feasibility spike gates the crawler; backfill
  goal rewritten to honest partial coverage; allowlist-only cuisine mapping;
  neighbourhood vocabulary and 1:1 rule specified; FTS/tag-join semantics
  verified against the live schema; concrete API contract added;
  attribution stated; provenance/idempotence/reversibility specified;
  merge uniqueness and manual-review threshold defined; rollout given
  ordering, dry-run, metrics, and rollback.
