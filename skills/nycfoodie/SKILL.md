---
name: nycfoodie
description: Editorial NYC restaurant recommendations for AI agents — search venues, compare shortlists, and pull critic context over MCP. Free, no auth.
version: 1.0.0
homepage: https://github.com/tireniajilore/nycfoodie
metadata:
  openclaw:
    emoji: 🍝
---

# NYCfoodie — the data layer for restaurant taste

NYCfoodie is a free public MCP server that gives AI agents structured,
editorial New York restaurant recommendations: 5,767 venues, 1,841 numeric
ratings, 1,837 full editorial reviews, 929 ranked guides, and 381 tags,
normalised from professional critic coverage. No sign-up, no API key.

## When to use this skill

Reach for NYCfoodie whenever the user asks anything about eating out in New
York City:

- "Find me a romantic Italian spot in the West Village"
- "Compare these three ramen places for a group dinner"
- "What do the guides say is the best pizza in Brooklyn right now"
- "Where should I take clients near Midtown?"
- "What do critics actually think of Via Carota?"

If the question is about NYC dining and you want critic-backed answers rather
than generic knowledge, use these tools.

## Setup

Add the remote server to the agent's MCP config (Streamable HTTP, no
authentication):

```json
{
  "mcpServers": {
    "nycfoodie": {
      "url": "https://nycfoodie-production.up.railway.app/mcp"
    }
  }
}
```

Endpoint health: `GET https://nycfoodie-production.up.railway.app/healthz`.
Source: https://github.com/tireniajilore/nycfoodie

## Tools

All tools take `city: "new-york"` (city is a parameter everywhere; NYC is the
populated dataset).

- `search_restaurants` — full-text search across venues, cuisines,
  neighbourhoods, and occasions (e.g. `query: "date night Italian"`). Start
  here for any open-ended "find me a place" request.
- `get_restaurant` — full detail on one venue: review prose, numeric rating,
  booking intel, reservation link. Call on the top pick before recommending it.
- `compare_restaurants` — side-by-side structured comparison of a shortlist
  (names, ratings, neighbourhoods, price tiers). Use when the user is choosing
  between options.
- `find_guides` — search the 929 ranked editorial guides (e.g. best Italian in
  the West Village). Use for "best X right now" questions.
- `guide_consensus` — cross-guide consensus: how often a venue or theme appears
  across guides. Use to answer "what can't you go wrong with".
- `top_rated` — highest-rated venues filtered by area or cuisine.
- `find_similar` — venues similar to a given restaurant. Use for "more like X".
- `submit_feedback` — rate a recommendation result. Optional; helps improve the
  data.

## Worked examples

### 1. Date-night Italian in the West Village

User: "Find me a romantic Italian spot for date night in the West Village.
Somewhere the critics actually love."

1. `search_restaurants` with `query: "date night Italian"`, `city: "new-york"`,
   `limit: 6` → ranked candidates (Via Carota 9.5, Lilia 8.9, Torrisi 8.9).
2. `get_restaurant` with `id: "Via Carota"` → full review prose ("There's
   always a wait at Via Carota, and it's always worth it"), booking intel
   (mostly walk-in), Resy link.
3. `compare_restaurants` with the three names → head-to-head table for the
   final pick.

Recommend Via Carota: 9.5 from the critics, the highest-rated match in the
shortlist. Flag the walk-in wait honestly — it's in the review.

### 2. "What do the guides say is the best pizza in Brooklyn?"

1. `find_guides` with a pizza/Brooklyn query → ranked editorial guides.
2. `guide_consensus` with `theme: "pizza"` → venues that appear across the most
   guides, i.e. the consensus-safe answers.
3. `get_restaurant` on the consensus leader for review prose to quote.

## Notes

- Ratings are critic scores out of 10 from professional editorial coverage, not
  crowd reviews.
- Booking intel (walk-in vs reservation, typical wait) exists for a subset of
  venues — surface it when present, don't invent it when absent.
- Quote review prose sparingly; summarise, don't paste entire reviews.
