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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const RPM = Number(process.env.RATE_LIMIT_RPM ?? 120);
const MAX_BODY_BYTES = 1_000_000;

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
  const server: McpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    const body = req.method === "POST" ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err).slice(0, 200) }));
    }
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NYCfoodie — MCP server</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.6; color: #1a1a1a; }
  code { background: #f3f3f3; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
  .tagline { color: #555; margin-top: 0; }
  ul.tools li { margin-bottom: 0.3rem; }
  footer { margin-top: 2.5rem; color: #888; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>NYCfoodie</h1>
<p class="tagline">The data layer for restaurant taste — structured editorial restaurant recommendations over MCP.</p>
<h2>Endpoints</h2>
<ul>
<li><code>POST /mcp</code> — Streamable HTTP MCP endpoint (JSON-RPC)</li>
<li><code>GET /healthz</code> — health check</li>
</ul>
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
<footer>5,767 NYC venues · 1,841 numeric ratings · 1,837 full editorial reviews</footer>
</body>
</html>`;

function handleLanding(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(LANDING_HTML);
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
