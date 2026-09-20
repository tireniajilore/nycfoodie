#!/usr/bin/env node
// nycfoodie MCP server (Streamable HTTP transport).
//
// Public endpoint: POST /mcp (JSON-RPC). Stateless: one server + transport
// per request, so it scales horizontally with no session affinity.
// GET /healthz answers host health checks.
//
// Env:
//   PORT            listen port (default 3000)
//   RATE_LIMIT_RPM  max requests per minute per IP (default 120, 0 disables)
//   FEEDBACK_ADMIN_TOKEN  bearer token for GET /admin/feedback (unset = disabled)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, readFeedback, readUsageStats } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const RPM = Number(process.env.RATE_LIMIT_RPM ?? 120);
const MAX_BODY_BYTES = 1_000_000;
// Admin token for GET /admin/feedback (read-back of submitted feedback).
// Never exposed as an MCP tool; set FEEDBACK_ADMIN_TOKEN on the host.
const ADMIN_TOKEN = process.env.FEEDBACK_ADMIN_TOKEN ?? "";

// --- tiny fixed-window rate limiter (per IP, in-memory) ---
const windows = new Map<string, { count: number; reset: number }>();
function rateLimited(ip: string): boolean {
  if (RPM <= 0) return false;
  const now = Date.now();
  const w = windows.get(ip);
  if (!w || now >= w.reset) {
    windows.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  w.count += 1;
  return w.count > RPM;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of windows) if (now >= w.reset) windows.delete(ip);
}, 60_000).unref();

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // One server + transport per request (stateless mode).
  // Client fingerprint inputs for privacy-respecting usage analytics
  // (hashed, never stored raw). Behind Railway's proxy the real client IP
  // arrives in X-Forwarded-For.
  const fwd = req.headers["x-forwarded-for"];
  const clientIp =
    (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") ||
    req.socket.remoteAddress ||
    "unknown";
  const userAgent = req.headers["user-agent"] ?? "";
  const server: McpServer = createMcpServer({ clientIp, userAgent });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  // Best-effort teardown of the per-request MCP server + transport.
  const teardown = () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  };
  res.on("close", teardown);
  try {
    await server.connect(transport);
    const body = req.method === "POST" ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err).slice(0, 200) }));
    }
    await teardown();
  }
}

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NYCfoodie — Editorial NYC restaurant recommendations for AI agents (MCP server)</title>
<meta name="description" content="NYCfoodie is a free public MCP server giving AI agents structured editorial NYC restaurant recommendations: 5,767 venues, 1,841 ratings, 929 ranked guides. Search, compare, and get trusted restaurant picks over the Model Context Protocol.">
<meta property="og:title" content="NYCfoodie — the data layer for restaurant taste">
<meta property="og:description" content="Structured editorial NYC restaurant recommendations for AI agents, over MCP. 5,767 venues · 929 guides · free, no auth.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://nycfoodie-production.up.railway.app/">
<link rel="canonical" href="https://nycfoodie-production.up.railway.app/">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SoftwareApplication","name":"NYCfoodie","applicationCategory":"DeveloperApplication","operatingSystem":"Web","description":"Free public MCP server: structured editorial NYC restaurant recommendations for AI agents — search, compare, guides, ratings.","url":"https://nycfoodie-production.up.railway.app/","codeRepository":"https://github.com/tireniajilore/nycfoodie","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"}}
</script>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 680px; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.6; color: #1a1a1a; }
  code { background: #f3f3f3; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
  pre { background: #f3f3f3; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.85em; }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
  .tagline { color: #555; margin-top: 0; }
  ul.tools li { margin-bottom: 0.3rem; }
  footer { margin-top: 2.5rem; color: #888; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>NYCfoodie</h1>
<p class="tagline">The data layer for restaurant taste — structured editorial New York restaurant recommendations for AI agents, served over the Model Context Protocol.</p>
<p>NYCfoodie wraps thousands of professional restaurant reviews into queryable tools: an AI assistant planning dinner in New York can search venues by cuisine, neighbourhood or occasion, compare shortlists side by side, and pull ranked editorial guides — all through one MCP endpoint. Free, no sign-up, no API key.</p>
<h2>Connect</h2>
<p>MCP endpoint (Streamable HTTP):</p>
<pre><code>https://nycfoodie-production.up.railway.app/mcp</code></pre>
<p>Cursor one-click install, Claude Code config, and source code: <a href="https://github.com/tireniajilore/nycfoodie">github.com/tireniajilore/nycfoodie</a>. Agent-readable summary: <a href="/llms.txt">llms.txt</a>.</p>
<h2>Tools</h2>
<ul class="tools">
<li><code>search_restaurants</code> — full-text search across venues, cuisines, neighbourhoods</li>
<li><code>get_restaurant</code> — full detail: reviews, ratings, booking intel</li>
<li><code>compare_restaurants</code> — side-by-side structured comparison</li>
<li><code>find_guides</code> — search editorial guides</li>
<li><code>find_similar</code> — venues similar to a given restaurant</li>
<li><code>guide_consensus</code> — cross-guide consensus on a venue</li>
<li><code>top_rated</code> — highest-rated venues by area or cuisine</li>
<li><code>submit_feedback</code> — rate a result</li>
</ul>
<h2>Data</h2>
<p>5,767 NYC venues · 1,841 numeric ratings · 1,837 full editorial reviews · 929 ranked guides · 381 tags, sourced from professional editorial coverage.</p>
<footer>NYCfoodie is a free public MCP server. Endpoint <code>POST /mcp</code> · health <code>GET /healthz</code></footer>
</body>
</html>`;

const LLMS_TXT = `# NYCfoodie

> The data layer for restaurant taste: structured editorial NYC restaurant recommendations for AI agents over MCP.

NYCfoodie is a free public MCP (Model Context Protocol) server. It exposes
5,767 New York City restaurant venues, 1,841 numeric ratings, 1,837 full
editorial reviews, 929 ranked guides, and 381 tags, sourced from professional
editorial coverage.

## Endpoint

- MCP (Streamable HTTP, no authentication): POST https://nycfoodie-production.up.railway.app/mcp
- Health check: GET https://nycfoodie-production.up.railway.app/healthz
- Source code and client setup: https://github.com/tireniajilore/nycfoodie
- Registered in the Official MCP Registry as io.github.tireniajilore/nycfoodie

## Tools

- search_restaurants: full-text search across venues, cuisines, neighbourhoods, occasions
- get_restaurant: full detail for one venue — review prose, numeric rating, booking intel
- compare_restaurants: side-by-side structured comparison of a shortlist
- find_guides: search ranked editorial guides (e.g. best Italian in the West Village)
- find_similar: venues similar to a given restaurant
- guide_consensus: how often a venue appears across guides (cross-guide consensus)
- top_rated: highest-rated venues by area or cuisine
- submit_feedback: rate a recommendation result

## Use cases

- "Find me a romantic Italian spot in the West Village under $70 a head"
- "Compare these three ramen places for a group dinner"
- "What do the guides say is the best pizza in Brooklyn right now"
`;

const ROBOTS_TXT = `User-agent: *
Allow: /
`;

// Glama connector ownership claim (HTTP challenge). Glama requires this file
// to stay in place so it can keep verifying ownership of the listing.
const GLAMA_JSON = JSON.stringify({
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  claim: "glama_claim_4pzowXEakxm1R2Vveqtx2Fmfhcow5q6e",
});

function handleLanding(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(LANDING_HTML);
}

/**
 * Admin-only endpoints. Token via ?token= or Authorization: Bearer.
 * Deliberately not MCP tools: feedback and usage data must not be visible
 * to every agent using the server.
 */
function adminAuthorized(req: IncomingMessage, url: URL): boolean {
  const header = req.headers.authorization ?? "";
  const token =
    url.searchParams.get("token") ??
    (header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(ADMIN_TOKEN);
  const actual = Buffer.from(token);
  return (
    !!ADMIN_TOKEN &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): boolean {
  if (!adminAuthorized(req, url)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

function handleAdminFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): void {
  if (!requireAdmin(req, res, url)) return;
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
    200
  );
  const since = url.searchParams.get("since") ?? undefined;
  const entries = readFeedback(limit, since);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ count: entries.length, entries }));
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Parse an integer query param: default when missing/unparseable, clamped to [min, max]. */
function clampQueryInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw ?? def) || def;
  return Math.min(Math.max(n, min), max);
}

/** Server-rendered usage dashboard (no JS, no external assets). */
function handleAdminUsage(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!requireAdmin(req, res, url)) return;
  const days = clampQueryInt(url.searchParams.get("days"), 30, 1, 180);
  const stats = readUsageStats(days);
  const maxDay = Math.max(1, ...stats.per_day.map((d) => d.calls));
  const maxTool = Math.max(1, ...stats.per_tool.map((t) => t.calls));
  const dayRows = stats.per_day
    .map(
      (d) => `<div class="brow"><span class="bday">${escHtml(d.day)}</span>
        <span class="bbar"><span style="width:${Math.round((d.calls / maxDay) * 100)}%"></span></span>
        <span class="bnum">${d.calls} calls · ${d.clients} clients</span></div>`
    )
    .join("");
  const toolRows = stats.per_tool
    .map(
      (t) => `<div class="brow"><span class="bday">${escHtml(t.tool)}</span>
        <span class="bbar"><span style="width:${Math.round((t.calls / maxTool) * 100)}%"></span></span>
        <span class="bnum">${t.calls}</span></div>`
    )
    .join("");
  const recentRows = stats.recent
    .map(
      (r) => `<tr><td>${escHtml(r.ts.replace("T", " ").slice(0, 19))}</td>
        <td>${escHtml(r.tool)}</td><td>${escHtml(r.city ?? "—")}</td>
        <td>${r.latency_ms ?? "—"} ms</td><td>${r.ok ? "ok" : "error"}</td></tr>`
    )
    .join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NYCfoodie usage</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0 0.5rem; }
  .card { border: 1px solid #e2e2e2; border-radius: 10px; padding: 0.8rem 1.1rem; min-width: 130px; }
  .card .v { font-size: 1.6rem; font-weight: 700; }
  .card .l { color: #666; font-size: 0.8rem; }
  .brow { display: flex; align-items: center; gap: 0.6rem; margin: 0.28rem 0; font-size: 0.85rem; }
  .bday { width: 150px; flex: none; color: #444; font-variant-numeric: tabular-nums; }
  .bbar { flex: 1; background: #f0f0f0; border-radius: 4px; height: 14px; overflow: hidden; }
  .bbar span { display: block; height: 100%; background: #2f7de1; border-radius: 4px; }
  .bnum { width: 170px; flex: none; text-align: right; color: #444; font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #eee; }
  th { color: #666; font-weight: 600; }
  .note { color: #777; font-size: 0.82rem; margin-top: 2rem; }
</style>
</head>
<body>
<h1>NYCfoodie usage</h1>
<div class="cards">
  <div class="card"><div class="v">${stats.total_calls}</div><div class="l">tool calls, last ${stats.days} days</div></div>
  <div class="card"><div class="v">${stats.distinct_clients}</div><div class="l">distinct clients, last ${stats.days} days</div></div>
  <div class="card"><div class="v">${stats.calls_today}</div><div class="l">calls today</div></div>
</div>
<h2>Calls per day</h2>
${dayRows || "<p>No usage recorded yet.</p>"}
<h2>Calls per tool</h2>
${toolRows || "<p>No usage recorded yet.</p>"}
<h2>Recent calls</h2>
<table><thead><tr><th>Time (UTC)</th><th>Tool</th><th>City</th><th>Latency</th><th>Status</th></tr></thead>
<tbody>${recentRows || '<tr><td colspan="5">No usage recorded yet.</td></tr>'}</tbody></table>
<p class="note">Clients are counted by an anonymised fingerprint (a truncated hash of IP + user agent), so the
client count is an approximation of people, not an exact headcount — MCP clients don't identify users.
No query text, IPs or user agents are stored.</p>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** JSON form of the usage stats, for scripting. */
function handleAdminUsageJson(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): void {
  if (!requireAdmin(req, res, url)) return;
  const days = clampQueryInt(url.searchParams.get("days"), 30, 1, 180);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(readUsageStats(days)));
}

const httpServer = createServer((req, res) => {
  cors(res);
  const ip = req.socket.remoteAddress ?? "unknown";
  if (rateLimited(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate limit exceeded" }));
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/" && req.method === "GET") {
    handleLanding(res);
    return;
  }
  if (url.pathname === "/llms.txt" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(LLMS_TXT);
    return;
  }
  if (url.pathname === "/robots.txt" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(ROBOTS_TXT);
    return;
  }
  if (url.pathname === "/.well-known/glama.json" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(GLAMA_JSON);
    return;
  }
  if (url.pathname === "/admin/feedback" && req.method === "GET") {
    handleAdminFeedback(req, res, url);
    return;
  }
  if (url.pathname === "/admin/usage" && req.method === "GET") {
    handleAdminUsage(req, res, url);
    return;
  }
  if (url.pathname === "/admin/usage.json" && req.method === "GET") {
    handleAdminUsageJson(req, res, url);
    return;
  }
  if (url.pathname === "/mcp" && (req.method === "POST" || req.method === "GET")) {
    void handleMcp(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

httpServer.listen(PORT, () => {
  console.log(`nycfoodie MCP (streamable HTTP) listening on :${PORT}/mcp`);
});
