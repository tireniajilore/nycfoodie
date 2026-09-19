# NYCfoodie

The data layer for restaurant taste: structured, editorial restaurant recommendations served to AI agents over MCP. Not another review scraper — curated guides and reviews normalised into one schema, queryable by tools.

MVP city: New York. The city is a parameter everywhere; nothing NYC-specific is hardcoded.

## Use it

Hosted endpoint (Streamable HTTP): `https://nycfoodie-production.up.railway.app/mcp`

- **Cursor** — [one-click install](cursor://anysphere.cursor-deeplink/mcp/install?name=nycfoodie&config=eyJ1cmwiOiAiaHR0cHM6Ly9ueWNmb29kaWUtcHJvZHVjdGlvbi51cC5yYWlsd2F5LmFwcC9tY3AifQ==)
- **Claude Code / any MCP client** — add the URL above as a remote MCP server (Streamable HTTP). No auth, no install.
- **Claude (app)** — Settings → Connectors → Add custom connector → paste the URL.

### Tools

`search_restaurants` · `get_restaurant` · `compare_restaurants` · `find_guides` · `find_similar` · `guide_consensus` · `top_rated` · `submit_feedback`

## Layout

- `db/` — SQLite storage (better-sqlite3) with numbered SQL migrations written in Postgres-compatible DDL. The migration runner is dialect-agnostic by convention, so a Postgres adapter can replace better-sqlite3 later without touching the migrations.
- `crawler/` — source adapters (starting with The Infatuation) that normalise into the db schema. Endpoint/field mapping: `docs/infatuation-data-surface.md` (step 2).
- `mcp/` — stdio MCP server (`@modelcontextprotocol/sdk`) exposing search, detail, comparison and guide tools.

## Quickstart

```bash
npm install
npm run typecheck
npm run build
node db/dist/migrate.js ./nycfoodie.db   # creates/opens the SQLite db, applies migrations
node mcp/dist/index.js                   # starts the MCP server on stdio
```

## Roadmap

1. Scaffold (done) — repo, packages, migration runner, stub MCP tools.
2. Map The Infatuation's data surface — Next.js pages + GraphQL endpoints → `docs/infatuation-data-surface.md`.
3. Database schema proposal — shown for approval before any crawler code is written.
4. Crawler — only after schema sign-off.

## Conventions

- British English in docs and user-facing text.
- Migrations: numbered `NNN_name.sql`, applied once in order; see `db/migrations/README.md` for the Postgres-compatibility rules.
- Never commit `*.db` files or credentials.
