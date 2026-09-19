---
title: "I turned 1,837 restaurant reviews into an MCP server so agents can taste"
published: false
tags: mcp, ai, typescript, opensource
---

Most MCP servers are thin wrappers around an existing API. You point an agent at them and it gets the same JSON a human would get from a dashboard — pagination, raw fields, no judgement. That is fine for doing things in the world. It is poor for answering questions that need taste.

"Find me a romantic Italian spot in the West Village that the critics actually love" is a taste question. An agent with a Google wrapper returns a dump of star ratings and sponsored listings. An agent needs structured editorial judgement: which venues do professional critics rate highly, what do the reviews actually say, how do the shortlisted places compare, and do the ranked guides agree?

NYCfoodie is my attempt at the other kind of MCP server: agent-native data. I took thousands of professional restaurant reviews and guides, normalised them into one schema, and exposed them as eight queryable tools. Free, hosted, no auth, no signup.

## The data

- 5,767 NYC venues
- 1,841 numeric critic ratings
- 1,837 full editorial reviews
- 929 ranked guides
- 381 tags (cuisine, neighbourhood, occasion)

The point of normalising is that the agent never has to parse prose to compare. Ratings, neighbourhoods, price tiers, booking intel and guide appearances are all first-class fields.

## A worked example

The agent gets: "romantic Italian in the West Village, somewhere the critics actually love."

**1. Search.** `search_restaurants` with `query: "date night Italian"` returns candidates ranked by critic rating: Via Carota (9.5), Lilia (8.9), Torrisi Bar & Restaurant (8.9).

**2. Deep dive.** `get_restaurant` on Via Carota returns the full review prose ("There's always a wait at Via Carota, and it's always worth it"), the 9.5 rating, booking intel, and a Resy link.

**3. Compare.** `compare_restaurants` on the shortlist returns a side-by-side structure — rating, neighbourhood, price tier — so the agent can reason over the options rather than summarise three blobs of text.

**4. Consensus.** `guide_consensus` on the Italian theme shows which venues appear across the ranked guides, so the recommendation carries the weight of many critics, not one.

The full toolset: `search_restaurants`, `get_restaurant`, `compare_restaurants`, `find_guides`, `find_similar`, `guide_consensus`, `top_rated`, and `submit_feedback` (rate a result so the data can improve).

## Connect in thirty seconds

The hosted endpoint is Streamable HTTP:

```
https://nycfoodie-production.up.railway.app/mcp
```

Claude Code:

```
claude mcp add --transport http nycfoodie https://nycfoodie-production.up.railway.app/mcp
```

Anything else that takes an `mcpServers` block:

```json
{
  "mcpServers": {
    "nycfoodie": {
      "url": "https://nycfoodie-production.up.railway.app/mcp"
    }
  }
}
```

It is also registered in the Official MCP Registry as `io.github.tireniajilore/nycfoodie`, and listed on Glama and Smithery. Source: https://github.com/tireniajilore/nycfoodie

## What I want from you

Try it with a real dinner-planning question and tell me where the data lets you down. Use the `submit_feedback` tool on a result, or open a GitHub issue. The schema was designed with city as a parameter everywhere — New York is the first city, not the last. If you want your city covered, say so; that is the clearest signal for what gets built next.
