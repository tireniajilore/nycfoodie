// Admin per-client usage breakdown (feature/admin-per-client-usage).
// Spins up the real HTTP server against a scratch DB seeded with synthetic
// usage rows and asserts the per_client section of /admin/usage.json plus
// the client table on the /admin/usage HTML dashboard. No test framework:
// node:test only.
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

// All seed timestamps derive from one base clock as fixed hour offsets, so
// window assertions hold no matter when the test runs: rows 1h ago are
// inside any days>=1 window, rows 25h+ ago are outside a 24h window, and
// rows 61d ago are outside a 30d window.
const SEED_BASE = Date.now();
const agoHours = (h) => new Date(SEED_BASE - h * 3600 * 1000).toISOString();
const agoDays = (d) => agoHours(d * 24);
const utcDay = (ts) => ts.slice(0, 10);

function seedUsage(db) {
  const ins = db.prepare(
    `INSERT INTO usage_log (ts, tool, city, client_hash, latency_ms, ok)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const A = "aaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbb";
  // Client A: 5 calls, two tools, spread over 25h+ so at least two UTC
  // days are always covered; exact day count derived from the seed.
  const aTimes = [agoHours(50), agoHours(49), agoHours(26), agoHours(25), agoHours(1)];
  const aTools = ["search_restaurants", "search_restaurants", "search_restaurants", "get_restaurant", "get_restaurant"];
  aTimes.forEach((ts, i) => ins.run(ts, aTools[i], "new-york", A, 40, 1));
  // Client B: 2 calls sharing one timestamp — deterministically one day.
  const bTime = agoHours(2);
  ins.run(bTime, "top_rated", "new-york", B, 50, 1);
  ins.run(bTime, "top_rated", "new-york", B, 55, 0);
  // Null fingerprint bucket: 1 call.
  ins.run(agoHours(1), "find_guides", "new-york", null, 60, 1);
  // Outside a 30-day window: must be excluded.
  ins.run(agoDays(61), "search_restaurants", "new-york", "cccccccccccccccc", 40, 1);
  return { A, B, aDays: new Set(aTimes.map(utcDay)).size };
}

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
      if (/EADDRINUSE/.test(stderr) && attempt < 4) continue;
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
        if (res.ok) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() - t0 > 30000) return reject(new Error("server did not start in time"));
      setTimeout(tick, 250);
    };
    tick();
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

test("per_client breakdown in /admin/usage.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nycfoodie-admin-"));
  try {
    const dbPath = join(dir, "test.db");
    copyFileSync(dbSrc, dbPath);
    const db = new Database(dbPath);
    // Wipe the fixture's own telemetry rows so the assertions below are
    // deterministic regardless of what the copied DB contains.
    db.exec("DELETE FROM usage_log");
    const { A, B, aDays } = seedUsage(db);
    db.close();

    await withHttpServer(dbPath, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/admin/usage.json?days=30`, {
        headers: auth,
      });
      assert.equal(res.status, 200);
      const stats = await res.json();

      // Old aggregate keys still present (backward compatible).
      // distinct_clients counts non-null fingerprints only (COUNT DISTINCT
      // ignores NULL), so A and B = 2; the null-hash bucket still appears
      // in per_client below.
      assert.equal(stats.total_calls, 8);
      assert.equal(stats.distinct_clients, 2);

      assert.ok(Array.isArray(stats.per_client));
      assert.equal(stats.per_client.length, 3);
      // Ordered by total calls desc.
      const [a, b, n] = stats.per_client;
      assert.equal(a.client_hash, A);
      assert.equal(a.total_calls, 5);
      assert.equal(a.days_active, aDays);
      assert.ok(aDays >= 2, "seed must span multiple UTC days");
      assert.ok(a.first_seen < a.last_seen);
      assert.deepEqual(a.per_tool, [
        { tool: "search_restaurants", calls: 3 },
        { tool: "get_restaurant", calls: 2 },
      ]);
      assert.equal(b.client_hash, B);
      assert.equal(b.total_calls, 2);
      assert.equal(b.days_active, 1);
      assert.deepEqual(b.per_tool, [{ tool: "top_rated", calls: 2 }]);
      assert.equal(n.client_hash, null);
      assert.equal(n.total_calls, 1);

      // The 61-day-old client is outside the window.
      assert.ok(!stats.per_client.some((c) => c.client_hash === "cccccccccccccccc"));

      // Recent rows carry the client hash.
      assert.ok(stats.recent.length > 0);
      assert.ok("client_hash" in stats.recent[0]);

      // Window narrowing: days=1 keeps only rows from the last 24h.
      // Expected set: A keeps just its 1h-ago call; B keeps both (2h ago);
      // the null bucket keeps its 1h-ago call. Tie order between the two
      // 1-call clients is not deterministic, so assert by client key.
      const res1 = await fetch(`http://127.0.0.1:${port}/admin/usage.json?days=1`, {
        headers: auth,
      });
      const s1 = await res1.json();
      assert.equal(s1.per_client.length, 3);
      const byHash1 = new Map(s1.per_client.map((c) => [c.client_hash ?? "\0", c]));
      const a1 = byHash1.get(A);
      assert.equal(a1.total_calls, 1);
      assert.equal(a1.days_active, 1);
      assert.deepEqual(a1.per_tool, [{ tool: "get_restaurant", calls: 1 }]);
      const b1 = byHash1.get(B);
      assert.equal(b1.total_calls, 2);
      assert.equal(b1.days_active, 1);
      assert.deepEqual(b1.per_tool, [{ tool: "top_rated", calls: 2 }]);
      const n1 = byHash1.get("\0");
      assert.equal(n1.total_calls, 1);
      assert.deepEqual(n1.per_tool, [{ tool: "find_guides", calls: 1 }]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin usage endpoints stay token-gated; HTML shows client table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nycfoodie-admin-"));
  try {
    const dbPath = join(dir, "test.db");
    copyFileSync(dbSrc, dbPath);
    const db = new Database(dbPath);
    seedUsage(db);
    db.close();

    await withHttpServer(dbPath, async (port) => {
      const noAuth = await fetch(`http://127.0.0.1:${port}/admin/usage.json`);
      assert.equal(noAuth.status, 401);
      const noAuthHtml = await fetch(`http://127.0.0.1:${port}/admin/usage`);
      assert.equal(noAuthHtml.status, 401);

      const html = await fetch(`http://127.0.0.1:${port}/admin/usage`, { headers: auth });
      assert.equal(html.status, 200);
      const body = await html.text();
      assert.ok(body.includes("Calls per client"));
      assert.ok(body.includes("aaaaaaaaaaaaaaaa"));
      assert.ok(body.includes("Days active"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
