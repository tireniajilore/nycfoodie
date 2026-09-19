// nycfoodie MCP server factory (shared by stdio and HTTP transports).
// nycfoodie MCP server (stdio).
//
// Read-only access to the NYCfoodie database: structured editorial
// restaurant recommendations. City is a parameter on every tool.
// Database path: NYCFOODIE_DB env var, else nycfoodie.db at the repo root.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, join } from "node:path";
import { copyFileSync, existsSync } from "node:fs";
import { getDb, openDb, openReadDb } from "nycfoodie-db";
import { migrate } from "nycfoodie-db/dist/migrate.js";
import { z } from "zod";
import {
  compareRestaurants,
  findGuides,
  findSimilar,
  getRestaurant,
  guideConsensus,
  searchRestaurants,
  suggestRestaurants,
  topRated,
  type Filters,
} from "./queries.js";
import { createCallLogger, hashClient, recordUsage, saveFeedback, type CallLogger } from "./telemetry.js";

const dbPath =
  process.env.NYCFOODIE_DB ?? new URL("../../nycfoodie.db", import.meta.url).pathname;
const seedPath = new URL("../../nycfoodie.db", import.meta.url).pathname;

// First boot on a fresh volume: seed the database from the copy baked into
// the image, so feedback and call logs written afterwards persist on the volume.
if (!existsSync(dbPath) && seedPath !== dbPath && existsSync(seedPath)) {
  copyFileSync(seedPath, dbPath);
  console.log(JSON.stringify({ event: "db_seed", from: seedPath, to: dbPath }));
}
const logPath =
  process.env.NYCFOODIE_LOG ?? join(dirname(dbPath), "nycfoodie-mcp-calls.jsonl");

// The server migrates on startup (feedback table lives here), queries
// read-only, and feedback writes go through a separate writable handle.
migrate(dbPath);
openDb(dbPath);
const writeDb = getDb();
const db = openReadDb(dbPath);

// Bounded retention for usage analytics: keep 180 days.
try {
  const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  writeDb.prepare("DELETE FROM usage_log WHERE ts < ?").run(cutoff);
} catch {
  // Table may not exist on very old databases before migration runs; migrate()
  // already ran above, so this is just defensive.
}

const log: CallLogger = createCallLogger(logPath);
log({
  ts: new Date().toISOString(),
  tool: "<server_start>",
  args: { dbPath },
  duration_ms: 0,
  ok: true,
});

/** Request-scoped context for the MCP server (HTTP transport). */
export interface McpServerOptions {
  /** Client IP as seen by the HTTP layer (never stored raw). */
  clientIp?: string;
  /** Client user-agent as seen by the HTTP layer (never stored raw). */
  userAgent?: string;
}

/** Build a fully-registered MCP server. One instance per transport. */
export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "nycfoodie", version: "0.1.0" });
  const clientHash =
    opts.clientIp != null ? hashClient(opts.clientIp, opts.userAgent ?? "") : null;

  function json(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  /** Wrap a tool handler with call logging (timing, args, errors) plus a
   *  privacy-respecting usage row (tool, city, client fingerprint — no args). */
  function logged<TArgs extends Record<string, unknown>, TResult>(
    name: string,
    fn: (args: TArgs) => Promise<TResult>
  ): (args: TArgs) => Promise<TResult> {
    return async (args: TArgs) => {
      const start = Date.now();
      const city =
        typeof (args as Record<string, unknown>).city === "string"
          ? ((args as Record<string, unknown>).city as string)
          : null;
      const usage = (ok: boolean) =>
        recordUsage(writeDb, {
          ts: new Date().toISOString(),
          tool: name,
          city,
          clientHash,
          latencyMs: Date.now() - start,
          ok,
        });
      try {
        const result = await fn(args);
        log({
          ts: new Date().toISOString(),
          tool: name,
          args,
          duration_ms: Date.now() - start,
          ok: true,
          result_bytes: JSON.stringify(result).length,
        });
        usage(true);
        return result;
      } catch (e) {
        log({
          ts: new Date().toISOString(),
          tool: name,
          args,
          duration_ms: Date.now() - start,
          ok: false,
          error: String(e).slice(0, 500),
        });
        usage(false);
        throw e;
      }
    };
  }

  const cityParam = z
    .string()
    .describe(
      "City slug, always required. Currently 'new-york', covering the five boroughs plus the immediate metro (within 30 km of Manhattan)."
    );

  const READ_ONLY = { readOnlyHint: true } as const;
  const limitParam = z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max results (default 10)");

  function filtersFrom(args: {
    city: string;
    query?: string;
    cuisine?: string;
    neighborhood?: string;
    occasion?: string;
    min_rating?: number;
    price_tier?: number;
    include_closed?: boolean;
    lat?: number;
    lng?: number;
    radius_km?: number;
  }): Filters {
    return {
      city: args.city,
      query: args.query,
      cuisine: args.cuisine,
      neighborhood: args.neighborhood,
      occasion: args.occasion,
      minRating: args.min_rating,
      priceTier: args.price_tier,
      includeClosed: args.include_closed,
      lat: args.lat,
      lng: args.lng,
      radiusKm: args.radius_km,
    };
  }

  const filterShape = {
    cuisine: z.string().optional().describe("e.g. 'Italian', 'ramen'"),
    neighborhood: z.string().optional().describe("e.g. 'West Village', or a borough like 'Brooklyn'"),
    occasion: z
      .string()
      .optional()
      .describe(
        "Occasion tag. Allowed: 'Date Nights', 'Happy Hours', 'Pre-Theater', 'See & Be Seen', 'Serious Takeout Operation', 'Unique Dining Experiences', 'Wasting Your Time & Money'. Hyphens and spaces are flexible ('date-night' works)."
      ),
    min_rating: z.number().min(0).max(10).optional().describe("Minimum Infatuation rating"),
    price_tier: z.number().int().min(1).max(4).optional().describe("1 ($) to 4 ($$$$)"),
    include_closed: z
      .boolean()
      .optional()
      .describe("Include known-closed venues (default false)"),
    lat: z
      .number()
      .optional()
      .describe(
        "Latitude for proximity search. Must be given together with lng; " +
          "radius_km defaults to 5 km when omitted. A location outside the " +
          "NYC coverage area is rejected with an error."
      ),
    lng: z
      .number()
      .optional()
      .describe(
        "Longitude for proximity search. Must be given together with lat; " +
          "radius_km defaults to 5 km when omitted."
      ),
    radius_km: z
      .number()
      .positive()
      .optional()
      .describe(
        "Search radius in kilometres (default 5 when lat/lng are given without it). Requires lat and lng."
      ),
  };

  server.registerTool(
    "search_restaurants",
    {
      description:
        "Search restaurants by free text, cuisine, neighbourhood, occasion or price, optionally near a point. Use when the user describes what they want (e.g. 'Italian date night in the West Village', 'ramen near me') rather than naming a specific restaurant. Free text matches names, tags, review prose and guide blurbs (e.g. 'cacio e pepe'). Returns compact matches with Infatuation rating (0–10), price tier, address and tags. Known-closed venues are excluded by default. Coverage for city='new-york' is the five boroughs plus the immediate metro (within 30 km of Manhattan). With no query or filters, returns the highest-rated venues.",
      annotations: READ_ONLY,
      inputSchema: {
        query: z.string().optional().describe("Free text, e.g. 'date-night Italian'"),
        city: cityParam,
        ...filterShape,
        sort: z
          .enum(["rating", "guides"])
          .optional()
          .describe("Sort by rating (default) or guide appearances"),
        limit: limitParam,
      },
    },
    logged("search_restaurants", async (args) =>
      json(
        searchRestaurants(
          db,
          filtersFrom(args),
          args.limit ?? 10,
          args.sort === "guides" ? "guides" : "rating"
        )
      )
    )
  );

  server.registerTool(
    "get_restaurant",
    {
      description:
        "Get the full picture for one restaurant in one call: Infatuation rating (0–10), price tier, address, reservation link, booking intel, review summary, tags and every guide it appears in. Use when the user names a specific restaurant. Full review prose is opt-in via include_prose (default: headline and summary only). review.headline is the source's actual headline when one exists, otherwise null — use review.summary for the descriptive text.",
      annotations: READ_ONLY,
      inputSchema: {
        id: z.string().describe("Canonical restaurant id, or a name to resolve"),
        city: cityParam,
        include_prose: z
          .boolean()
          .optional()
          .describe("Include the full review text (default false: headline + summary only)"),
      },
    },
    logged("get_restaurant", async ({ id, city, include_prose }) => {
      const r = getRestaurant(db, city, id, include_prose ?? false);
      if (r) return json(r);
      return json({
        found: false,
        query: id,
        suggestions: suggestRestaurants(db, city, id).map((s) => s.name),
      });
    })
  );

  server.registerTool(
    "compare_restaurants",
    {
      description:
        "Compare 2–3 named restaurants head-to-head as structured data (rating, price, tags, review summary). Use when the user asks to choose between specific places, e.g. 'should I go to X or Y?'.",
      annotations: READ_ONLY,
      inputSchema: {
        restaurants: z
          .array(z.string())
          .min(2)
          .max(3)
          .describe("Restaurant ids or names to compare"),
        city: cityParam,
      },
    },
    logged("compare_restaurants", async ({ restaurants, city }) => json(compareRestaurants(db, city, restaurants)))
  );

  server.registerTool(
    "find_guides",
    {
      description:
        "Find curated editorial guides (ranked lists) matching a theme, e.g. 'best ramen'. Returns each guide with its ranked entries, blurbs and linked restaurants. Use when the user wants the editorial lists themselves rather than individual restaurant picks. Set include_entries=false to list guide titles and metadata without pulling every entry blurb.",
      annotations: READ_ONLY,
      inputSchema: {
        city: cityParam,
        query: z.string().optional().describe("Theme, e.g. 'best ramen', 'date night'"),
        limit: limitParam,
        include_entries: z
          .boolean()
          .optional()
          .describe("Set false to return guide metadata without the ranked entry blurbs (default true)"),
      },
    },
    logged("find_guides", async ({ city, query, limit, include_entries }) =>
      json(findGuides(db, city, query, limit ?? 5, include_entries ?? true))
    )
  );

  server.registerTool(
    "find_similar",
    {
      description:
        "Find restaurants similar to a named one, scored by shared cuisine, occasion and neighbourhood tags plus guide co-occurrence. Use for 'like X' or 'alternatives to X' requests.",
      annotations: READ_ONLY,
      inputSchema: {
        id: z.string().describe("Canonical restaurant id, or a name to resolve"),
        city: cityParam,
        limit: limitParam,
      },
    },
    logged("find_similar", async ({ id, city, limit }) => {
      const r = findSimilar(db, city, id, limit ?? 10);
      if (r) return json(r);
      return json({
        found: false,
        query: id,
        suggestions: suggestRestaurants(db, city, id).map((s) => s.name),
      });
    })
  );

  server.registerTool(
    "guide_consensus",
    {
      description:
        "Rank restaurants by how many distinct guides feature them, optionally filtered by theme. Use for 'where can't I go wrong' or safest-bet picks. Differs from find_guides: this returns ranked restaurants, not the guides themselves.",
      annotations: READ_ONLY,
      inputSchema: {
        city: cityParam,
        theme: z.string().optional().describe("Guide theme, e.g. 'ramen', 'brunch'"),
        limit: limitParam,
      },
    },
    logged("guide_consensus", async ({ city, theme, limit }) => json(guideConsensus(db, city, theme, limit ?? 10)))
  );

  server.registerTool(
    "top_rated",
    {
      description:
        "List the highest-rated restaurants (Infatuation 0–10 scale), with optional cuisine, neighbourhood and price filters. Use for 'best in the city' requests. Differs from search_restaurants: no free-text query, strictly rating-ordered.",
      annotations: READ_ONLY,
      inputSchema: { city: cityParam, ...filterShape, limit: limitParam },
    },
    logged("top_rated", async (args) => json(topRated(db, filtersFrom(args), args.limit ?? 10)))
  );

  server.registerTool(
    "submit_feedback",
    {
      description:
        "Record feedback on a tool result: a 1–5 rating, a comment, or both (at least one is required). Use after showing the user a recommendation to log what was good or wrong. Each call stores a new feedback entry; it changes nothing the user sees.",
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        tool: z
          .string()
          .optional()
          .describe("Which tool the feedback is about, e.g. 'search_restaurants'"),
        rating: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("1 (poor) to 5 (excellent)"),
        comment: z.string().optional().describe("What was good or wrong"),
      },
    },
    logged("submit_feedback", async ({ tool, rating, comment }) => {
      try {
        const id = saveFeedback(writeDb, { tool_name: tool, rating, comment });
        return json({ received: true, id });
      } catch (e) {
        return json({ received: false, error: String(e).slice(0, 200) });
      }
    })
  );
  return server;
}

/**
 * Admin-only read-back of submitted feedback. Deliberately NOT an MCP tool:
 * feedback must not be visible to every agent using the server. Served over
 * HTTP at GET /admin/feedback, behind FEEDBACK_ADMIN_TOKEN.
 */
export function readFeedback(limit = 50, since?: string): Record<string, unknown>[] {
  const lim = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
  const rows =
    since !== undefined
      ? db
          .prepare(
            `SELECT id, created_at, tool_name, rating, comment FROM feedback
             WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`
          )
          .all(since, lim)
      : db
          .prepare(
            `SELECT id, created_at, tool_name, rating, comment FROM feedback
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(lim);
  return rows as Record<string, unknown>[];
}

export interface UsageStats {
  days: number;
  since: string;
  total_calls: number;
  distinct_clients: number;
  calls_today: number;
  per_day: { day: string; calls: number; clients: number }[];
  per_tool: { tool: string; calls: number }[];
  recent: { ts: string; tool: string; city: string | null; latency_ms: number | null; ok: number }[];
}

/**
 * Admin-only usage analytics. Deliberately NOT an MCP tool: usage data must
 * not be visible to every agent using the server. Served over HTTP at
 * GET /admin/usage(.json), behind FEEDBACK_ADMIN_TOKEN.
 *
 * "Distinct clients" counts distinct anonymised client fingerprints — an
 * approximation of people, not an exact headcount (MCP clients don't
 * identify users).
 */
export function readUsageStats(days = 30): UsageStats {
  const d = Math.min(Math.max(Math.floor(days) || 30, 1), 180);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const total = db
    .prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT client_hash) AS u FROM usage_log WHERE ts >= ?")
    .get(since) as { c: number; u: number };
  const callsToday = (
    db.prepare("SELECT COUNT(*) AS c FROM usage_log WHERE substr(ts, 1, 10) = ?").get(today) as {
      c: number;
    }
  ).c;
  const perDay = db
    .prepare(
      `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS calls, COUNT(DISTINCT client_hash) AS clients
       FROM usage_log WHERE ts >= ? GROUP BY day ORDER BY day`
    )
    .all(since) as { day: string; calls: number; clients: number }[];
  const perTool = db
    .prepare(
      `SELECT tool, COUNT(*) AS calls FROM usage_log WHERE ts >= ?
       GROUP BY tool ORDER BY calls DESC`
    )
    .all(since) as { tool: string; calls: number }[];
  const recent = db
    .prepare(
      `SELECT ts, tool, city, latency_ms, ok FROM usage_log
       ORDER BY id DESC LIMIT 50`
    )
    .all() as UsageStats["recent"];
  return {
    days: d,
    since,
    total_calls: total.c,
    distinct_clients: total.u,
    calls_today: callsToday,
    per_day: perDay,
    per_tool: perTool,
    recent,
  };
}
