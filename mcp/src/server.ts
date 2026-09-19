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
  topRated,
  type Filters,
} from "./queries.js";
import { createCallLogger, saveFeedback, type CallLogger } from "./telemetry.js";

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

const log: CallLogger = createCallLogger(logPath);
log({
  ts: new Date().toISOString(),
  tool: "<server_start>",
  args: { dbPath },
  duration_ms: 0,
  ok: true,
});

/** Build a fully-registered MCP server. One instance per transport. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "nycfoodie", version: "0.1.0" });

  function json(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  /** Wrap a tool handler with call logging (timing, args, errors). */
  function logged<TArgs extends Record<string, unknown>, TResult>(
    name: string,
    fn: (args: TArgs) => Promise<TResult>
  ): (args: TArgs) => Promise<TResult> {
    return async (args: TArgs) => {
      const start = Date.now();
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
        throw e;
      }
    };
  }

  const cityParam = z.string().describe("City slug, always required. Currently 'new-york'.");

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
    occasion: z.string().optional().describe("e.g. 'date night', 'group dinner'"),
    min_rating: z.number().min(0).max(10).optional().describe("Minimum Infatuation rating"),
    price_tier: z.number().int().min(1).max(4).optional().describe("1 ($) to 4 ($$$$)"),
    include_closed: z
      .boolean()
      .optional()
      .describe("Include known-closed venues (default false)"),
    lat: z.number().optional().describe("Latitude for proximity search"),
    lng: z.number().optional().describe("Longitude for proximity search"),
    radius_km: z.number().positive().optional().describe("Search radius in kilometres"),
  };

  server.registerTool(
    "search_restaurants",
    {
      description:
        "Search restaurants by free text, cuisine, neighbourhood, occasion or price, optionally near a point. Use when the user describes what they want (e.g. 'Italian date night in the West Village', 'ramen near me') rather than naming a specific restaurant. Returns compact matches with Infatuation rating (0–10), price tier, address and tags. Known-closed venues are excluded by default.",
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
        "Get the full picture for one restaurant in one call: Infatuation rating (0–10), price tier, address, reservation link, booking intel, review summary, tags and every guide it appears in. Use when the user names a specific restaurant. Full review prose is opt-in via include_prose (default: headline and summary only).",
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
      return r ? json(r) : json({ found: false, query: id });
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
        "Find curated editorial guides (ranked lists) matching a theme, e.g. 'best ramen'. Returns each guide with its ranked entries, blurbs and linked restaurants. Use when the user wants the editorial lists themselves rather than individual restaurant picks.",
      annotations: READ_ONLY,
      inputSchema: {
        city: cityParam,
        query: z.string().optional().describe("Theme, e.g. 'best ramen', 'date night'"),
        limit: limitParam,
      },
    },
    logged("find_guides", async ({ city, query, limit }) => json(findGuides(db, city, query, limit ?? 5)))
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
      return r ? json(r) : json({ found: false, query: id });
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
