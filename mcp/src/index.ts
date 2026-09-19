#!/usr/bin/env node
// nycfoodie MCP server (stdio).
//
// Read-only access to the NYCfoodie database: structured editorial
// restaurant recommendations. City is a parameter on every tool.
// Database path: NYCFOODIE_DB env var, else nycfoodie.db at the repo root.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openReadDb } from "nycfoodie-db";
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

const dbPath =
  process.env.NYCFOODIE_DB ?? new URL("../../../nycfoodie.db", import.meta.url).pathname;
const db = openReadDb(dbPath);

const server = new McpServer({ name: "nycfoodie", version: "0.1.0" });

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const cityParam = z.string().describe("City slug, e.g. 'new-york'. City is always a parameter.");
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
  neighborhood: z.string().optional().describe("e.g. 'West Village'"),
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
      "Search restaurants by free text, cuisine, neighbourhood, occasion or price, optionally near a point. Known-closed venues are excluded by default.",
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
  async (args) =>
    json(
      searchRestaurants(
        db,
        filtersFrom(args),
        args.limit ?? 10,
        args.sort === "guides" ? "guides" : "rating"
      )
    )
);

server.registerTool(
  "get_restaurant",
  {
    description:
      "The full picture for one restaurant in one call: rating, price, address, reservation link, booking intel, review summary, tags and every guide it appears in.",
    inputSchema: {
      id: z.string().describe("Canonical restaurant id, or a name to resolve"),
      city: cityParam,
      include_prose: z
        .boolean()
        .optional()
        .describe("Include the full review text (default false: headline + summary only)"),
    },
  },
  async ({ id, city, include_prose }) => {
    const r = getRestaurant(db, city, id, include_prose ?? false);
    return r ? json(r) : json({ found: false, query: id });
  }
);

server.registerTool(
  "compare_restaurants",
  {
    description: "Head-to-head comparison of 2–3 restaurants as structured data.",
    inputSchema: {
      restaurants: z
        .array(z.string())
        .min(2)
        .max(3)
        .describe("Restaurant ids or names to compare"),
      city: cityParam,
    },
  },
  async ({ restaurants, city }) => json(compareRestaurants(db, city, restaurants))
);

server.registerTool(
  "find_guides",
  {
    description:
      "Find curated editorial guides (ranked lists) matching a theme. Returns each guide with its ranked entries, blurbs and linked restaurants.",
    inputSchema: {
      city: cityParam,
      query: z.string().optional().describe("Theme, e.g. 'best ramen', 'date night'"),
      limit: limitParam,
    },
  },
  async ({ city, query, limit }) => json(findGuides(db, city, query, limit ?? 5))
);

server.registerTool(
  "find_similar",
  {
    description:
      "Restaurants similar to one you name, scored by shared cuisine, occasion and neighbourhood tags plus guide co-occurrence.",
    inputSchema: {
      id: z.string().describe("Canonical restaurant id, or a name to resolve"),
      city: cityParam,
      limit: limitParam,
    },
  },
  async ({ id, city, limit }) => {
    const r = findSimilar(db, city, id, limit ?? 10);
    return r ? json(r) : json({ found: false, query: id });
  }
);

server.registerTool(
  "guide_consensus",
  {
    description:
      "Restaurants the guides agree on: ranked by how many distinct guides feature them, optionally filtered by theme.",
    inputSchema: {
      city: cityParam,
      theme: z.string().optional().describe("Guide theme, e.g. 'ramen', 'brunch'"),
      limit: limitParam,
    },
  },
  async ({ city, theme, limit }) => json(guideConsensus(db, city, theme, limit ?? 10))
);

server.registerTool(
  "top_rated",
  {
    description: "Highest-rated restaurants, with optional cuisine, neighbourhood and price filters.",
    inputSchema: { city: cityParam, ...filterShape, limit: limitParam },
  },
  async (args) => json(topRated(db, filtersFrom(args), args.limit ?? 10))
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
