# NYCfoodie launch kit — drafts for review (2026-09-19)

## 1. Show HN

**Title:** Show HN: NYCfoodie – an MCP server of 1,800 professional NYC restaurant reviews

**First comment (post as tireniajilore):**

Hey HN — I built NYCfoodie, a public MCP server that gives AI agents structured, editorial restaurant recommendations for New York.

The problem: when you ask an agent "find me a great Italian spot in the West Village," it leans on generic web results or stale training data. NYCfoodie wraps ~1,800 full professional reviews (plus 929 ranked guides and 5,767 venues) into eight queryable tools: full-text restaurant search, side-by-side comparison, cross-guide consensus ("how many best-of lists name this place?"), top-rated by area/cuisine, and more.

It's free, no auth, Streamable HTTP: `https://nycfoodie-production.up.railway.app/mcp`. One-click install for Cursor in the README. Also listed in the Official MCP Registry as `io.github.tireniajilore/nycfoodie`.

Technical bits: TypeScript, SQLite database of crawled editorial data, stateless per-request transports so it scales horizontally. Feedback tool logs ratings so I can measure which recommendations land.

Curious what people think — especially whether "editorial data as MCP tools" is a pattern worth repeating for other cities/verticals. Happy to answer questions.

**Timing:** post Tuesday–Thursday morning US Eastern for best pickup. Don't post Saturday night.

---

## 2. r/mcp

**Title:** NYCfoodie — free public MCP server: 1,800 professional NYC restaurant reviews as tools

**Body:**

I turned professional NYC restaurant coverage into a public MCP server so agents can plan dinner properly.

**What it is:** 8 tools over Streamable HTTP — `search_restaurants`, `get_restaurant` (full review prose + rating + booking intel), `compare_restaurants`, `find_guides`, `find_similar`, `guide_consensus` (cross-guide consensus scoring), `top_rated`, `submit_feedback`.

**Data:** 5,767 venues, 1,841 numeric ratings, 1,837 full editorial reviews, 929 ranked guides.

**Try it:** endpoint `https://nycfoodie-production.up.railway.app/mcp` (no auth). One-click Cursor install + Claude Code config in the README: https://github.com/tireniajilore/nycfoodie. Also in the Official MCP Registry (`io.github.tireniajilore/nycfoodie`) and on Glama (pending review).

Built because agents recommending restaurants from generic search results felt wrong — this is the "data layer for restaurant taste" version. Feedback welcome, especially on the tool design.

---

## 3. awesome-remote-mcp-servers PR (blocked — needs Glama badge)

Once Glama approves, entry under the 🍽️ Food & Dining section (alphabetical by name):

`- [NYCfoodie](https://github.com/tireniajilore/nycfoodie)` `https://nycfoodie-production.up.railway.app/mcp` + Glama badge + `🔓 - Editorial NYC restaurant recommendations for AI agents: search, compare, guides, ratings.`

Requires the submitting GitHub account to have starred punkpeye/awesome-remote-mcp-servers first.

## Notes
- Nothing posted yet — drafts only. Posting needs Tireni's accounts (HN, Reddit); browser can post if he's logged in, with his go-ahead per post.
- mcpservers.org submission in review (2 weeks). PulseMCP auto-ingests from registry.
