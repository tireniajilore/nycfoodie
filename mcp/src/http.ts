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
<footer>NYCfoodie is a free public MCP server. Endpoint <code>POST /mcp</code> · health <code>GET /healthz</code> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
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

// Legal pages: Privacy Policy and Terms of Service, required for connector
// directory submissions. Server-rendered, no JS, same visual style as the
// landing page. Copy: docs/privacy-draft.md and docs/terms-draft.md — keep
// the substance identical to the reviewed drafts.
const LEGAL_CONTACT_EMAIL = "tireniajilore1@gmail.com";
const LEGAL_EFFECTIVE_DATE = "2026-10-04";

const LEGAL_STYLE = `body { font-family: system-ui, -apple-system, sans-serif; max-width: 680px; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.6; color: #1a1a1a; }
  code { background: #f3f3f3; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.2rem; margin-top: 2rem; }
  ul { padding-left: 1.4rem; } li { margin-bottom: 0.4rem; }
  .meta { color: #555; }
  footer { margin-top: 2.5rem; color: #888; font-size: 0.85rem; }
  footer a { color: #888; }`;

const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — NYCfoodie</title>
<style>${LEGAL_STYLE}</style>
</head>
<body>
<h1>Privacy Policy — NYCfoodie</h1>
<p class="meta"><strong>Effective date:</strong> ${LEGAL_EFFECTIVE_DATE}<br><strong>Contact:</strong> ${LEGAL_CONTACT_EMAIL}</p>
<p>NYCfoodie is a free, public MCP (Model Context Protocol) server that gives AI agents structured editorial restaurant recommendations for New York City. There are no user accounts, no sign-up, no cookies, and we do not ask for any personal information.</p>
<h2>What we collect</h2>
<p><strong>1. Anonymous usage analytics</strong> — stored in a database table, automatically deleted after 180 days:</p>
<ul>
<li>timestamp of the call</li>
<li>tool name (e.g. <code>search_restaurants</code>)</li>
<li>coarse city parameter passed to the tool</li>
<li>request latency and whether it succeeded</li>
<li>a 16-character truncated SHA-256 hash of your IP address plus user-agent string. This lets us count distinct clients without storing IPs — the hash cannot be reversed into an IP address or device.</li>
<li>the connecting client's self-reported software name and version (from the MCP handshake), and a reduced user-agent string with platform details stripped (e.g. <code>Mozilla/5.0</code> without OS/version detail).</li>
</ul>
<p>This analytics data contains <strong>no query text and no raw IP addresses</strong>.</p>
<p><strong>2. Operational server logs</strong> — one line per tool call, kept on the server:</p>
<ul>
<li>tool name, the arguments sent to the tool, duration, success or error, and result size.</li>
</ul>
<p>These logs exist for debugging, reliability monitoring and abuse prevention. They are not shared, not sold, and not exposed through any public endpoint. Unlike the analytics above, they do include the parameters your agent sent (e.g. a cuisine or neighbourhood search) — but they never include anything beyond what your agent itself transmitted to the server.</p>
<p><strong>3. Feedback you choose to send</strong> — if your agent calls <code>submit_feedback</code>:</p>
<ul>
<li>the tool name, a 1–5 rating, and the comment text your agent wrote.</li>
</ul>
<p>Feedback is voluntary, stored indefinitely so we can improve the service, and never linked to an identity — we have no accounts to link it to.</p>
<h2>What we do not do</h2>
<ul>
<li>No raw IP addresses are stored.</li>
<li>No personal data is requested or required.</li>
<li>Data is not sold, rented, or shared with third parties.</li>
<li>The admin analytics endpoints are protected and visible only to the operator.</li>
</ul>
<h2>Data provenance note (for transparency)</h2>
<p>NYCfoodie's restaurant data is derived from The Infatuation's published restaurant guides, transformed into structured data (ratings, tags, booking intel). Data licensing is currently unresolved — see the project repository.</p>
<h2>Hosting</h2>
<p>The service runs on Railway (United States). Standard server infrastructure (Railway) may process requests in the course of hosting.</p>
<h2>Changes</h2>
<p>If this policy changes materially, the updated version will be published at this URL with a new effective date.</p>
<footer><a href="/">NYCfoodie</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</body>
</html>`;

const TERMS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms of Service — NYCfoodie</title>
<style>${LEGAL_STYLE}</style>
</head>
<body>
<h1>Terms of Service — NYCfoodie</h1>
<p class="meta"><strong>Effective date:</strong> ${LEGAL_EFFECTIVE_DATE}<br><strong>Contact:</strong> ${LEGAL_CONTACT_EMAIL}</p>
<h2>1. The service</h2>
<p>NYCfoodie is a free, public MCP (Model Context Protocol) server providing structured editorial restaurant recommendations for New York City. It is a personal project, provided as-is, with no guarantee of availability, accuracy, or continuity. The operator may modify, rate-limit, suspend, or discontinue the service at any time without notice.</p>
<h2>2. Acceptable use</h2>
<p>You agree not to:</p>
<ul>
<li>use the service for any unlawful purpose;</li>
<li>attempt to disrupt, overload, or degrade the service (including aggressive automated scraping of the underlying dataset);</li>
<li>misrepresent the service as your own, or imply endorsement by the operator;</li>
<li>attempt to gain unauthorised access to the service's infrastructure or admin endpoints.</li>
</ul>
<h2>3. Data and intellectual property</h2>
<p>Restaurant data is derived from The Infatuation's published restaurant guides, transformed into structured data. Data licensing is currently unresolved. Nothing in these terms grants you rights over the underlying editorial sources. The NYCfoodie software is published as open source at <a href="https://github.com/tireniajilore/nycfoodie">github.com/tireniajilore/nycfoodie</a> under its repository licence.</p>
<h2>4. Feedback</h2>
<p>If you or your agent submit feedback via the <code>submit_feedback</code> tool, you grant the operator a perpetual, irrevocable, worldwide licence to use that feedback to operate and improve the service.</p>
<h2>5. No warranty; limitation of liability</h2>
<p>The service is provided "as is" without warranties of any kind. Restaurant information (hours, closures, prices, availability) may be out of date — verify before making plans. To the maximum extent permitted by law, the operator is not liable for any damages arising from use of the service.</p>
<h2>6. Privacy</h2>
<p>Use of the service is also governed by the Privacy Policy at <a href="https://nycfoodie-production.up.railway.app/privacy">nycfoodie-production.up.railway.app/privacy</a>. There are no accounts; we collect only anonymous usage analytics and operational logs as described there.</p>
<h2>7. Changes</h2>
<p>These terms may be updated at any time; the current version will always be published at <a href="https://nycfoodie-production.up.railway.app/terms">nycfoodie-production.up.railway.app/terms</a>. Continued use of the service after changes take effect constitutes acceptance.</p>
<footer><a href="/">NYCfoodie</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</body>
</html>`;

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
        <td><code>${escHtml(r.client_hash ?? "—")}</code></td>
        <td>${r.latency_ms ?? "—"} ms</td><td>${r.ok ? "ok" : "error"}</td></tr>`
    )
    .join("");
  const clientRows = stats.per_client
    .map(
      (c) => `<tr><td><code>${escHtml(c.client_hash ?? "—")}</code></td>
        <td>${c.total_calls}</td><td>${c.days_active}</td>
        <td>${escHtml(c.first_seen.replace("T", " ").slice(0, 19))}</td>
        <td>${escHtml(c.last_seen.replace("T", " ").slice(0, 19))}</td>
        <td>${escHtml(c.per_tool.map((t) => `${t.tool} ×${t.calls}`).join(", ") || "—")}</td></tr>`
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
<h2>Calls per client</h2>
<table><thead><tr><th>Client</th><th>Calls</th><th>Days active</th><th>First seen (UTC)</th><th>Last seen (UTC)</th><th>Tools</th></tr></thead>
<tbody>${clientRows || '<tr><td colspan="6">No usage recorded yet.</td></tr>'}</tbody></table>
<h2>Recent calls</h2>
<table><thead><tr><th>Time (UTC)</th><th>Tool</th><th>City</th><th>Client</th><th>Latency</th><th>Status</th></tr></thead>
<tbody>${recentRows || '<tr><td colspan="6">No usage recorded yet.</td></tr>'}</tbody></table>
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
  if (url.pathname === "/privacy" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PRIVACY_HTML);
    return;
  }
  if (url.pathname === "/terms" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(TERMS_HTML);
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
