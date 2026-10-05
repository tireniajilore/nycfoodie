// Client software identity in usage analytics (feature/client-identity).
// Spins up the real HTTP server against a scratch DB, performs MCP
// initialize handshakes with clientInfo over Streamable HTTP, makes tool
// calls, and asserts client_name/client_version/user_agent land on usage
// rows and in /admin/usage.json (per_client modes + recent rows).
// No test framework: node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbSrc = join(root, "..", "nycfoodie.db");
const TOKEN = "test-admin-token";

function killAndWait(child) {
  child.kill();
  return new Promise((r) => {
    if (child.exitCode != null || child.signalCode != null) return r();
    child.on("exit", r);
  });
}

async function withHttpServer(dbPath, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 18000 + Math.floor(Math.random() * 2000);
    const child = spawn("node", [join(root, "dist", "http.js")], {
      env: {
        ...process.env,
        PORT: String(port),
        NYCFOODIE_DB: dbPath,
        NYCFOODIE_LOG: join(dirname(dbPath), "calls.jsonl"),
        FEEDBACK_ADMIN_TOKEN: TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    try {
      await waitForPort(port, child);
      await fn(port);
      return;
    } catch (e) {
      const collision = /EADDRINUSE/.test(stderr) || /EADDRINUSE/.test(e.message);
      if (collision && attempt < 4) continue;
      throw e;
    } finally {
      await killAndWait(child);
    }
  }
  throw new Error("could not bind a free port");
}

function waitForPort(port, child) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      if (child.exitCode != null) return reject(new Error("server exited early"));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) {
          await new Promise((r) => setTimeout(r, 500));
          if (child.exitCode != null || child.signalCode != null) {
            return reject(new Error("EADDRINUSE: port answered but server child exited"));
          }
          return resolve();
        }
      } catch (e) {
        if (/EADDRINUSE/.test(e.message)) return reject(e);
        /* not up yet */
      }
      if (Date.now() - t0 > 30000) return reject(new Error("server did not start in time"));
      setTimeout(tick, 250);
    };
    tick();
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const mcpHeaders = (ua) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "User-Agent": ua,
});

async function mcp(port, ua, message, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...mcpHeaders(ua), ...extraHeaders },
    body: JSON.stringify(message),
  });
  assert.equal(res.status, 200, `expected 200 from /mcp, got ${res.status}`);
  return res;
}

const initialize = (clientInfo) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    ...(clientInfo ? { clientInfo } : {}),
  },
});

const toolCall = (id, tool, args) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: tool, arguments: args },
});

async function usageStats(port) {
  const res = await fetch(`http://127.0.0.1:${port}/admin/usage.json?days=30`, {
    headers: auth,
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("client identity from initialize lands on usage rows and admin stats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nycfoodie-clientid-"));
  try {
    const dbPath = join(dir, "test.db");
    copyFileSync(dbSrc, dbPath);
    const db = new Database(dbPath);
    db.exec("DELETE FROM usage_log");
    db.close();

    await withHttpServer(dbPath, async (port) => {
      // Scenario A: full clientInfo + a user agent with platform details.
      const UA_A = "TestAgent/1.0 (Secret Platform 9000)";
      await mcp(port, UA_A, initialize({ name: "test-client", version: "9.9.9" }));
      await mcp(port, UA_A, toolCall(2, "search_restaurants", { city: "new-york", limit: 1 }));

      // Scenario B: initialize WITHOUT clientInfo -> identity stays null.
      const UA_B = "NoInit/2.0";
      await mcp(port, UA_B, initialize(null));
      await mcp(port, UA_B, toolCall(2, "top_rated", { city: "new-york", limit: 1 }));

      // Scenario C: tool call with no initialize at all -> nulls.
      const UA_C = "Bare/3.0";
      await mcp(port, UA_C, toolCall(1, "top_rated", { city: "new-york", limit: 1 }));

      // Scenario D: initialize and tool call arrive with different client
      // IPs (different fingerprints) but the same user agent — the
      // user-agent fallback must still attach the identity. This is the
      // rotating-egress-IP case observed live.
      const UA_D = "Fallback/4.0 (Test)";
      await mcp(port, UA_D, initialize({ name: "fallback-client", version: "4.0" }), {
        "X-Forwarded-For": "1.1.1.1",
      });
      await mcp(port, UA_D, toolCall(2, "search_restaurants", { city: "new-york", limit: 1 }), {
        "X-Forwarded-For": "2.2.2.2",
      });

      const stats = await usageStats(port);
      const byUa = new Map(stats.recent.map((r) => [r.user_agent, r]));

      // A: name/version recorded; user agent stripped of "(...)".
      const a = byUa.get("TestAgent/1.0");
      assert.ok(a, "expected a recent row for scenario A");
      assert.equal(a.tool, "search_restaurants");
      assert.equal(a.client_name, "test-client");
      assert.equal(a.client_version, "9.9.9");
      assert.ok(!a.user_agent.includes("("), "platform details must be stripped");

      // B and C: no identity -> nulls, UA still recorded in reduced form.
      const b = byUa.get("NoInit/2.0");
      assert.ok(b, "expected a recent row for scenario B");
      assert.equal(b.client_name, null);
      assert.equal(b.client_version, null);
      const c = byUa.get("Bare/3.0");
      assert.ok(c, "expected a recent row for scenario C");
      assert.equal(c.client_name, null);
      assert.equal(c.client_version, null);

      // D: identity attached via the user-agent fallback even though the
      // tool call hashed to a different fingerprint than the initialize.
      const d = byUa.get("Fallback/4.0");
      assert.ok(d, "expected a recent row for scenario D");
      assert.equal(d.tool, "search_restaurants");
      assert.equal(d.client_name, "fallback-client");
      assert.equal(d.client_version, "4.0");

      // per_client carries the most common name/version per fingerprint.
      const pcA = stats.per_client.find((p) => p.client_name === "test-client");
      assert.ok(pcA, "expected a per_client entry for test-client");
      assert.equal(pcA.client_version, "9.9.9");
      assert.equal(pcA.total_calls, 1);
      assert.deepEqual(pcA.per_tool, [{ tool: "search_restaurants", calls: 1 }]);
      const pcNull = stats.per_client.filter((p) => p.client_name === null);
      assert.equal(pcNull.length, 2, "scenarios B and C are distinct null fingerprints");
      const pcD = stats.per_client.find((p) => p.client_name === "fallback-client");
      assert.ok(pcD, "expected a per_client entry for fallback-client");
      assert.equal(pcD.client_version, "4.0");

      // Raw platform details must not appear anywhere in the admin payload.
      assert.ok(!JSON.stringify(stats).includes("Secret Platform"));

      // HTML dashboard shows the software column.
      const html = await fetch(`http://127.0.0.1:${port}/admin/usage`, { headers: auth });
      assert.equal(html.status, 200);
      const body = await html.text();
      assert.ok(body.includes("<th>Software</th>"));
      assert.ok(body.includes("test-client 9.9.9"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
