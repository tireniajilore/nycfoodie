#!/usr/bin/env node
// nycfoodie MCP server (stdio).
//
// Tools are stubbed until the database exists: the schema proposal (step 3)
// and the crawler (step 4) come first. Tool shapes already reflect the
// differentiators — guides, one-call full picture, geoproximity, head-to-head
// comparison — and city is a parameter on every tool.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "nycfoodie", version: "0.1.0" });

const NOT_READY = "Not implemented yet — the database is empty until the crawler lands (step 4).";

function stub(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const cityParam = z.string().describe("City slug, e.g. 'new-york'. City is always a parameter.");
const geoParams = {
  lat: z.number().optional().describe("Latitude for proximity search"),
  lng: z.number().optional().describe("Longitude for proximity search"),
  radiusKm: z.number().positive().optional().describe("Search radius in kilometres"),
};

server.registerTool(
  "search_restaurants",
  {
    description:
      "Search restaurants by name, cuisine, neighbourhood, occasion or vibe, optionally near a point.",
    inputSchema: {
      query: z.string().describe("Free-text query, e.g. 'date-night Italian East Village'"),
      city: cityParam,
      ...geoParams,
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    },
  },
  async ({ query, city, limit }) =>
    stub(
      `${NOT_READY} Got search_restaurants(query=${JSON.stringify(query)}, city=${city}, limit=${limit ?? 10}).`
    )
);

server.registerTool(
  "get_restaurant",
  {
    description:
      "The full picture for one restaurant in a single call: review summary, hours, rating, reservation link.",
    inputSchema: {
      id: z.string().describe("Canonical restaurant id"),
    },
  },
  async ({ id }) => stub(`${NOT_READY} Got get_restaurant(id=${id}).`)
);

server.registerTool(
  "compare_restaurants",
  {
    description: "Head-to-head comparison of 2–3 restaurants as structured data.",
    inputSchema: {
      ids: z.array(z.string()).min(2).max(3).describe("Canonical restaurant ids to compare"),
      city: cityParam,
    },
  },
  async ({ ids }) => stub(`${NOT_READY} Got compare_restaurants(ids=${ids.join(", ")}).`)
);

server.registerTool(
  "find_guides",
  {
    description: "Find curated editorial guides (ranked lists) matching an occasion or vibe.",
    inputSchema: {
      city: cityParam,
      occasion: z.string().optional().describe("e.g. 'group dinner', 'date night'"),
    },
  },
  async ({ city, occasion }) =>
    stub(`${NOT_READY} Got find_guides(city=${city}, occasion=${occasion ?? "any"}).`)
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
