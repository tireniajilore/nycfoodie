// Capture a real dinner-planning trace against the live NYCfoodie endpoint.
// Run: node trace.mjs  → writes demo-trace.json
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";

const ENDPOINT = "https://nycfoodie-production.up.railway.app/mcp";
const trace = [];

async function main() {
  const client = new Client({ name: "hype-demo", version: "0.1.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)));

  async function call(tool, label, args) {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = res.content.map((c) => c.text ?? "").join("\n");
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    trace.push({ tool, label, args, result: parsed });
    console.log("ok:", label);
  }

  await call("search_restaurants", "Search: date night Italian",
    { query: "date night Italian", city: "new-york", limit: 6 });
  const first = trace[0].result;
  const venues = Array.isArray(first) ? first : first.venues ?? first.results ?? [];
  const ids = venues.slice(0, 3).map((v) => v.id ?? v.venue_id ?? v.slug).filter(Boolean);

  if (ids[0]) await call("get_restaurant", "Deep dive on top pick", { id: ids[0], city: "new-york" });
  if (ids.length >= 2) await call("compare_restaurants", "Compare the shortlist", { restaurants: ids.slice(0, 3), city: "new-york" });
  await call("guide_consensus", "Cross-guide consensus: Italian", { city: "new-york", theme: "Italian", limit: 5 });

  await client.close();
  writeFileSync("demo-trace.json", JSON.stringify(trace, null, 2));
  console.log("wrote demo-trace.json with", trace.length, "tool calls");
}

main().catch((e) => { console.error("TRACE FAILED:", e.message); process.exit(1); });
