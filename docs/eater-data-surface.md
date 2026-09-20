# Eater — Data Surface Map

Researched 2026-09-20. Read-only evidence only: ~8 search queries, no logins,
no page fetches. **Constraint this round:** the page-text fetch tool
(`browser.open`) failed during this research, so no Eater page was sampled
directly — page-structure claims are derived from search-indexed content and
public platform knowledge, marked [UNVERIFIED-LIVE] where a live check is
owed. Nothing in this report required bypassing any protection.

## 1. What Eater is, data-wise (how it differs from Infatuation)

Eater is editorial content on Vox Media's proprietary **Chorus** CMS — no
public GraphQL layer like Infatuation's post-search API. Three content types
matter to us:

- **Maps** (`/maps/`): ranked, ordered restaurant lists — the direct
  equivalent of our `guides`. Flagship: the "Eater 38" (38 essential NYC
  restaurants, re-ranked quarterly), plus neighbourhood maps (Hell's Kitchen,
  Chelsea, Upper West Side…) and cuisine maps (best Sichuan, best Italian…).
  Each entry carries: name, editorial blurb, street address, phone, website
  link, an "Open in Google Maps" link, and an **"Also featured in"**
  cross-reference listing other Eater maps featuring the venue.
- **Venue pages** (`/venue/`): a first-class venue entity system with **stable
  numeric IDs** — e.g. `https://montreal.eater.com/venue/66473/bar-le-sparrow`
  (observed live in search results). Each page carries name, address, phone,
  website. This is a better `source_key` than a slug: numeric, stable,
  resolvable.
- **Reviews** (`/reviews` index; articles at
  `/{YYYY}/{M}/{D}/{numeric-id}/{slug}` — e.g.
  `https://ny.eater.com/2022/9/19/23361287/laser-wolf-review-williamsburg-rooftop-meat-skewer-israeli-nyc-restaurants`).
  **Critical:** Eater abolished star ratings site-wide in September 2021
  ("Eater Is Getting Rid of Restaurant Review Stars" —
  `https://ny.eater.com/2021/9/1/22651234/eater-drops-restaurant-stars-reviews`).
  Reviews are prose critic verdicts with **no numeric rating**. Pre-2021
  articles carried stars (historical backfill is possible but the old scale
  was 0–4 stars, not our 0–10).

What Eater does **not** have: numeric ratings (post-2021), opening hours,
price tiers, dishes-to-order rundowns, booking/reservation intel, occasion
taxonomies (no equivalent of Infatuation's perfect-for tags). Google Places
remains the gap-filler for hours/price/closure status.

## 2. robots.txt + terms of service

- `ny.eater.com/robots.txt` could not be fetched directly this round
  (tool failure, not a block). A third-party usage-license audit of
  **vox.com** (same Vox Media platform, checked 2026-06-24) reports: 18
  named AI agents disallowed on `/` (ChatGPT-User, CCBot, Google-Extended,
  anthropic-ai, ClaudeBot, Claude-Web, PerplexityBot, Perplexity-User,
  Applebot-Extended, Bytespider, Meta-ExternalAgent, FacebookBot, cohereai,
  Diffbot, ImagesiftBot, Omgilibot, Timpibot, YouBot); generic crawlers
  allowed; text-and-data-mining, AI training, redistribution and derivative
  works prohibited. Treat as **indicative for eater.com**, not confirmed —
  fetch `https://ny.eater.com/robots.txt` directly during the build before
  any crawling.
- Terms posture: Vox Media's ToS are standard publisher terms prohibiting
  automated access without permission. Same standing decision as
  Infatuation applies: licensing explicitly deferred ("we are fine").
- Practical rules carried over from the Infatuation build: honest
  user-agent, never masquerade as a named AI agent, polite rate (seconds
  between requests), modest concurrency, no login circumvention.

## 3. URL patterns (from search-indexed evidence)

- City hub: `https://ny.eater.com/`
- Map (guide): `{city}.eater.com/maps/{slug}` —
  `ny.eater.com/maps/the-38-essential-new-york-restaurants`,
  `ny.eater.com/maps/best-restaurants-hells-kitchen-nyc`,
  `ny.eater.com/maps/best-italian-restaurants-nyc`
- Reviews index: `https://ny.eater.com/reviews`
- Review article: `{city}.eater.com/{YYYY}/{M}/{D}/{numeric-id}/{slug}`
- Venue: `{city}.eater.com/venue/{numeric-id}/{slug}`
- [UNVERIFIED-LIVE]: sitemap location (Vox sites historically expose
  `/sitemap.xml`); RSS feed; AMP variant at `/platform/amp/…` as a lighter
  fetch path. Confirm all three with one polite fetch each during the build.

## 4. Data accessibility

- **No public API found.** Chorus is proprietary; no GraphQL, no
  `_next/data` JSON route, no public JSON feed documented.
- **No page sampled** (see constraint above). Expected, from platform
  norms: articles carry schema.org JSON-LD (`NewsArticle`) with headline,
  datePublished, author; map entries are server-rendered HTML (Eater's maps
  are SEO-critical, so content is in the initial HTML, not behind XHR).
  **Do not rely on this expectation** — the build's first step should be
  one Firecrawl scrape of a maps page in `rawHtml` to confirm the DOM
  structure (entry containers, venue links, "Also featured in" blocks).
- The practical consequence of no API: extraction is DOM/LLM-based, not
  schema-based. This is exactly the slot Firecrawl's `/extract` with a JSON
  schema fills — schema-first extraction over rendered HTML, no custom
  parser to maintain against Chorus markup changes.

## 5. Bot protection (observed + inferred)

- **No direct observation** — no page was loaded this round, so no
  block/403/challenge was encountered or cleared.
- Vox Media serves through the Fastly CDN with standard publisher bot
  hygiene; no public evidence ties Eater to PerimeterX/HUMAN, Cloudflare
  Bot Management or DataDome specifically — do not assert a vendor.
- **This is where the Firecrawl/Exa access changes the calculus.**
  No Firecrawl or Exa skills exist in the skill catalog, but **both
  `FIRECRAWL_API_KEY` and `EXA_API_KEY` are configured in the environment**,
  so integration is direct REST calls:
  - Firecrawl v2 `POST https://api.firecrawl.dev/v2/scrape` with
    `proxy: "stealth"` (residential Chrome proxy tier, ~5 credits/page)
    clears JS challenges and datacenter-IP filtering without us running a
    headless stack. `formats: [{type:"json", schema}]` gives schema-first
    extraction; `changeTracking: {modes:["gitDiff"]}` gives cheap
    change detection on re-crawls (returns `new`/`same`/`changed`).
  - Exa covers discovery (search for new/updated maps) and is the fallback
    extraction path if a page resists Firecrawl.
- Recommended build-time probe: 3–5 maps pages + 1 venue page through
  Firecrawl `proxy:"auto"` (basic first, stealth on failure). If stealth
  clears them, no custom browser infrastructure is ever needed.

## 6. Schema fit

Existing tables: `restaurants`, `source_listings`, `reviews`, `dishes`,
`tags`, `listing_tags`, `guides`, `guide_entries`, `crawl_state`
(+ `sources` registry, Google verification columns on `restaurants`).

| Eater field | Target | Notes |
|---|---|---|
| New source | `sources` row `'eater'` | Same as `'infatuation'` |
| Map → guide | `guides` | `guide_type='eater-map'`; title, author, publish/update dates (maps carry "updated" dates — good for the tiered-refresh diff) |
| Ordered map entries | `guide_entries` | Position = DOM order (1-based); blurb → entry text; venue link → listing linkage |
| Eater venue ID | `source_listings.source_key` | Numeric ID is stable — better join key than Infatuation slugs |
| Venue page address/phone/website | `source_listings` | Direct enrichment of existing restaurants |
| Review prose + critic + date | `reviews` | `rating` stays NULL (no stars post-2021); optional: backfill pre-2021 stars on a 0–4 scale, kept separate from 0–10 ratings |
| "Also featured in" | `guide_entries` cross-links | Guide consensus nearly for free — each entry self-reports other guides featuring it |
| Map membership (neighbourhood/cuisine) | `tags`/`listing_tags` | No perfect-for taxonomy on Eater's side; derive from map themes |
| Closure signal | `restaurants.closed` | Eater 38 updates drop closed venues; closure language in blurbs → same audit approach as Round 4 |

**Schema work needed:** minimal — a `sources` row, `guide_type` value,
nullable-rating reviews (already nullable), and a decision on whether
Eater venue IDs become canonical `source_key`s. No new tables. What Eater
cannot fill (hours, price tiers, dishes, booking intel) stays as known
gaps for Google Places.

## 7. Verdict: crawlable at reasonable effort

With Firecrawl + Exa in hand, this is **crawlable at reasonable effort** —
not fragile, not blocked. The cheapest viable approach:

1. **Discovery:** enumerate maps from the Eater 38 hub + Exa search for
   new/updated `ny.eater.com/maps/…` pages; confirm sitemap with one fetch.
2. **Extraction:** Firecrawl `/v2/scrape` with `proxy:"auto"` and a JSON
   schema for `{guide meta, entries[]: {position, name, blurb, address,
   phone, website, venue_url, also_featured_in[]}}`. Venue pages scraped
   the same way for address/phone/website.
3. **Entity resolution:** join on Eater numeric venue ID where present,
   else name+address match (existing dedup machinery applies).
4. **Change detection:** Firecrawl `changeTracking` (or Eater's own map
   "updated" dates) drives the tiered refresh — maps are the cheap
   leading indicator here too.
5. **Reviews:** ingest prose-only into `reviews` with `rating=NULL`;
   pre-2021 star backfill optional and explicitly out of the 0–10 scale.

Caveats: no page was directly sampled this round (marked
[UNVERIFIED-LIVE]) — the build's first hour should be one rawHtml
scrape to confirm DOM shape and one robots.txt read. Keep request
volume low, use stealth only where basic fails, and keep the standing
licensing decision in view.
