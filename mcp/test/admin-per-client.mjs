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

const iso = (d) => d.toISOString();
const daysAgo = (n, h = 12) => {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  d.setUTCHours(h, 0, 0, 0);
  return iso(d);
};

function seedUsage(db) {
  const ins = db.prepare(
    `INSERT INTO usage_log (ts, tool, city, client_hash, latency_ms, ok)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const A = "aaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbb";
  // Client A: 5 calls across 3 distinct days, two tools.
  ins.run(daysAgo(2), "search_restaurants", "new-york", A, 40, 1);
  ins.run(daysAgo(2, 13), "search_restaurants", "new-york", A, 42, 1);
  ins.run(daysAgo(1), "search_restaurants", "new-york", A, 38, 1);
  ins.run(daysAgo(1, 14), "get_restaurant", "new-york", A, 25, 1);
  ins.run(daysAgo(0), "get_restaurant", "new-york", A, 30, 1);
  // Client B: 2 calls, one day.
  ins.run(daysAgo(0), "top_rated", "new-york", B, 50, 1);
  ins.run(daysAgo(0, 13), "top_rated", "new-york", B, 55, 0);
  // Null fingerprint bucket: 1 call.
  ins.run(daysAgo(0), "find_guides", "new-york", null, 60, 1);
  // Outside a 30-day window: must be excluded.
  ins.run(daysAgo(60), "search_restaurants", "new-york", "cccccccccccccccc", 40, 1);
  return { A, B };
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
      child.kill();
      await new Promise((r) => child.on("exit", r));
      return;
    } catch (e) {
      child.kill();
      if (/EADDRINUSE/.test(stderr) && attempt < 4) continue;
      throw e;
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
    const { A, B } = seedUsage(db);
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
      assert.equal(a.days_active, 3);
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

      // The 60-day-old client is outside the window.
      assert.ok(!stats.per_client.some((c) => c.client_hash === "cccccccccccccccc"));

      // Recent rows carry the client hash.
      assert.ok(stats.recent.length > 0);
      assert.ok("client_hash" in stats.recent[0]);

      // Window narrowing: days=1 keeps only today's rows.
      const res1 = await fetch(`http://127.0.0.1:${port}/admin/usage.json?days=1`, {
        headers: auth,
      });
      const s1 = await res1.json();
      const a1 = s1.per_client.find((c) => c.client_hash === A);
      assert.equal(a1.total_calls, 1);
      assert.equal(a1.days_active, 1);
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
