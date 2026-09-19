# The Infatuation — Data Surface Map

Researched 2026-09-19. Two sources: live-site inspection (read-only, ~11 polite
page loads, no logins) and the community project `jmangan415/infatuation-mcp`
(its GraphQL reference doc and source code). Anything marked [VERIFY] needs one
live check during the crawler build (step 4).

## 1. Two data layers, not one

**A. Post-search GraphQL — public, no auth.** This is what the site's search UI calls.

```
POST https://www.theinfatuation.com/direct/api/post-search/public/graphql
```

Required headers: `Origin: https://www.theinfatuation.com`,
`Referer: https://www.theinfatuation.com/`, plus a non-empty browser-like
User-Agent. No API key, no cookies. Full introspection is enabled
(`__schema` / `__type` queries work), so the schema is self-documenting.

Top-level queries: `searchPosts` (main), `searchPostsV2`, `trending`, `post`
(by slug), `postById`. Key `PostSearchInput` fields:

| Field | Notes |
|---|---|
| `attributePathText` | Primary filter. Single path only: `/new-york`, `/new-york/neighborhoods/east-village`, `/new-york/cuisines/italian`, `/new-york/perfect-for/date-night` |
| `searchText` | Free text; combines with `attributePathText` for compound filtering |
| `postCategoryTypeText` | `[POST_REVIEW]`, `[POST_GUIDE]`, `[POST_FEATURE]`, `[POST_COLLECTION]`, `[POST_GUIDEBOOK]` |
| `cityTypeCode` | Works for US cities (`"new-york"`); returns 0 rows for London — use `attributePathText` there |
| `geoBounds` / `placeLocation` / `distanceRangeName` | Native geo filtering (default radius `"3km"`) |
| `placeRatingNumberList` | Exact-match list, not a range — min-rating must be applied client-side |
| `placePriceIndicatorCode` | `INEXPENSIVE`, `MODERATELY_EXPENSIVE`, `EXPENSIVE` (confirm full enum via introspection) |
| `paginationContextualText` | Cursor = previous response's `pageInfo.endpageDirectionCode` (`moreDataIndicator` is unreliable — returns null) |
| `includeUnratedSpots` | Default false |

Post types: `PostReview`, `PostGuide`, `PostFeature`, `PostCollection`,
`PostGuidebook` (inline fragments). `PostReview` fields worth storing:
`placeName`, `placeRatingNumber` (float, 0 = unrated), `placePriceIndicatorCode`,
`placeStreetName/CityName/StateName/CountryName/AddressPostalCode`,
`placeKnownTelephoneNumber`, `placeUrl`, `placeLocation { lat lng }`,
`placeTimezoneName`, `headline`, `shortDescriptionText`, `contents`,
`cuisines[]`, `neighborhoods[]`, `categories[]` (the perfect-for tags),
`placeVenueTypes[]`, `openTableReservationUrl`, `placeReservationUrl`,
`placeReservationPlatformName`, `reservationTipsText`,
`instagramSocialMediaIdentifier`, `xSocialMediaIdentifier`,
`foodRundownItems` (**always null here — see layer B**),
`url`, `slugName`, `canonicalPathText`, `documentIdentifier`,
`publishedTimestamp`, `updateTimestamp`, `pageViewCount`.

Quirks: ratings arrive as floats like `9.300000190734863` (round to 1dp);
`cuisineDisplayName` is often `""` (fall back to `cuisineName` or the path slug);
the lowest real rating is ~5, so `0` reliably means unrated.

**B. Contentful-backed page data — server-rendered.** The CMS is Contentful
(space `by2j1x5pxisp`, env `master`), queried server-side at build time
(Next.js pages-router SSG). No client-observable GraphQL endpoint exists —
the raw endpoint is not in any JS bundle, and pages load with zero content XHR.

The full page dataset ships two ways:
1. Embedded: `<script id="__NEXT_DATA__">` → `props.pageProps.initialApolloState`
   (normalised Apollo cache, Contentful rich-text documents).
2. Clean JSON: `/_next/data/<buildId>/{city}/reviews|guides/{slug}.json`
   (what client-side navigation fetches — no HTML parsing needed).

This layer holds everything layer A lacks: full review prose (Contentful rich
text), the dishes-to-order **food rundown** (`name` + `description` items),
**perfect-for** occasion tags (via `sectionsCollection` paths), photo galleries
(Cloudinary), contributor info, and venue detail
(`latlong`, integer `price`, `closed`/`closedStatus`, `phone`, `instagram`,
`reservation { … }`, `chaseSapphireReservationUrl`).

Pages also carry schema.org JSON-LD (`Review` + `FoodEstablishment`: reviewBody,
address, geo, priceRange, servesCuisine) as a third fallback.

## 2. URL patterns (verified live)

- City hub: `/{city}` — e.g. `/new-york`
- Review: `/{city}/reviews/{slug}` — e.g. `/new-york/reviews/rye-by-martin-auer`
- Guide: `/{city}/guides/{slug}` — e.g. `/new-york/guides/best-birthday-restaurants-nyc`
- Indexes: `/{city}/reviews`, `/{city}/guides`
- Taxonomy: `/{city}/neighborhoods/{slug}`, `/{city}/cuisines/{slug}`, `/{city}/perfect-for/{slug}`, `/{city}/features/{slug}`

## 3. Guide enumeration (our key differentiator)

- Index pages: `/{city}/guides` lists guides; the sitemap enumerates review/guide/taxonomy URLs site-wide.
- Sitemaps (all referenced from robots.txt): `/sitemap.xml` (index),
  `/sitemap-0.xml`, `/sitemap-1.xml`, `/sitemap-latest.xml`, `/sitemap-news.xml`.
  The community project harvests `/{city}/(neighborhoods|cuisines|perfect-for)/…`
  links from the sitemap to discover ~190 cities — structurally tamper-proof.
- Guide page data (`PostGuide`): `title`, `slug`, `preview`, `publishDate`,
  `guideType` (`"Modular"`), `tableOfContents`, header galleries, contributor /
  section / tag collections; site-wide `coreGuidesCollection` exposes `top25`,
  `newOpenings`, `hitList`.
- [VERIFY] The exact ranked-entry → review linkage inside a guide's Apollo state
  (which collection holds the ordered entries and how each resolves to a
  `PostReview`/venue). Fetch one guide's `/_next/data/…/guides/{slug}.json`
  during the crawler build and confirm before finalising the schema.

## 4. Taxonomy = occasions/vibes source

- `/{city}/perfect-for/{slug}` pages are the occasion/vibe taxonomy
  (`date-night`, `big-groups`, `cheap-eats`, `brunch`, …).
- Discover slugs by regexing taxonomy links out of the city landing page HTML
  (`/{city}/(neighborhoods|cuisines|perfect-for)/([a-z0-9-]+)`), or from review
  pages' `sectionsCollection` paths in layer B.
- Compound filtering: `attributePathText` takes one path; put the second facet
  in `searchText`. Priority: neighbourhood > cuisine > vibe. Price-ish vibes
  (`cheap-eats`, `corporate-cards`) work better as `placePriceIndicatorCode`
  than as search text.

## 5. Freshness signals (for staleness tracking)

- Layer A: `publishedTimestamp`, `updateTimestamp` per post.
- Layer B: `sys.firstPublishedAt` / `sys.publishedAt` per Contentful entry.
- Both are usable as `last_crawled_at` companions / change detection.

## 6. Hours — open question

Neither layer has yet shown a dedicated opening-hours field. [VERIFY] during the
crawler build: check the venue object and JSON-LD `openingHours` on a few
review pages. If absent, hours become a known gap (fallback: reservation
platform links), not a silent null.

## 7. Access posture (observed 2026-09-19)

- No CAPTCHA, bot wall, rate limiting, or access-denied pages across all loads.
  Site sits behind Akamai; infra on AWS.
- robots.txt: named AI crawlers (`GPTBot`, `ClaudeBot`, `CCBot`, `anthropic-ai`,
  `Claude-Web`, `Google-Extended`, …) are disallowed from `/`. Generic `*` is
  allowed except `/preview/*`, `/login`, `/signup`, `/forgot-password`,
  `/reset-password`, `/profile*`, `/*?source*`. Sitemaps are explicitly
  referenced (crawlable).
- Factual note for the project: licensing is deferred per plan, but the
  crawler should identify honestly, stay polite (seconds between requests,
  modest concurrency), and respect the AI-crawler disallow by not masquerading
  as those agents.

## 8. Implications for the crawler (step 4)

1. **Listing/discovery:** layer A `searchPosts` with `attributePathText` sweeps
   per taxonomy path + `/{city}` baseline; paginate via `endpageDirectionCode`.
2. **Enrichment:** layer B page JSON per review slug for prose, food rundown,
   perfect-for tags, venue detail. One fetch per restaurant, cacheable.
3. **Guides:** enumerate via sitemap + `/{city}/guides`; fetch each guide's page
   JSON; resolve the [VERIFY] entry linkage, then upsert ranked entries.
4. **Geo:** layer A already supports `placeLocation`/`geoBounds` — no need to
   bolt on post-hoc distance math for the MVP.
5. Honest UA, polite rate, ETag/`updateTimestamp` change detection to avoid
   refetching unchanged pages.
