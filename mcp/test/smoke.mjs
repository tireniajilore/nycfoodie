// Smoke test for the schema quick wins (name/ids aliases, compare cap 3 -> 5).
// Spawns the real stdio MCP server against a scratch copy of the dataset DB
// and asserts the tool contracts end-to-end. No test framework: node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbSrc = join(root, "..", "nycfoodie.db");

const VENUES = ["Lilia", "Via Carota", "Tatiana", "Semma", "Katz's Delicatessen"];

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nycfoodie-smoke-"));
  const db = join(dir, "test.db");
  copyFileSync(dbSrc, db);
  const child = spawn("node", [join(root, "dist", "index.js")], {
    env: {
      ...process.env,
      NYCFOODIE_DB: db,
      NYCFOODIE_LOG: join(dir, "calls.jsonl"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout.on("data", (d) => (buf += d));
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const pending = new Map();
  let nextId = 1;
  const lines = () => buf.split("\n").filter((l) => l.trim().startsWith("{"));
  const pump = () => {
    for (const l of lines()) {
      try {
        const m = JSON.parse(l);
        if (pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      } catch { /* partial line */ }
    }
  };
  const rpc = (method, params, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const timer = setInterval(pump, 50);
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    });
    // Drain the initialize response.
    await new Promise((r) => setTimeout(r, 800));
    pump();
    await fn(rpc);
  } finally {
    clearInterval(timer);
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (stderr.trim()) console.error("server stderr:", stderr.slice(0, 500));
    rmSync(dir, { recursive: true, force: true });
  }
}

const payloadText = (msg) => {
  assert.ok(msg.result, `expected result, got error: ${JSON.stringify(msg.error)}`);
  return msg.result.content[0].text;
};
const payloadJson = (msg) => JSON.parse(payloadText(msg));

await test("schema quick wins", async (t) => {
  await withServer(async (rpc) => {
    await t.test("get_restaurant accepts the name alias", async () => {
      const p = payloadJson(
        await rpc("tools/call", { name: "get_restaurant", arguments: { name: "Lilia", city: "new-york" } })
      );
      assert.equal(p.name, "Lilia");
      assert.equal(p.match_type, "exact");
    });

    await t.test("get_restaurant without id or name returns a descriptive error", async () => {
      const p = payloadJson(
        await rpc("tools/call", { name: "get_restaurant", arguments: { city: "new-york" } })
      );
      assert.ok(p.error.includes("'id'"), `unexpected error: ${p.error}`);
    });

    await t.test("find_similar accepts the name alias", async () => {
      const p = payloadJson(
        await rpc("tools/call", { name: "find_similar", arguments: { name: "Lilia", city: "new-york", limit: 2 } })
      );
      assert.ok(Array.isArray(p) && p.length > 0);
    });

    await t.test("compare_restaurants accepts the ids alias with 4 items", async () => {
      const p = payloadJson(
        await rpc("tools/call", {
          name: "compare_restaurants",
          arguments: { ids: VENUES.slice(0, 4), city: "new-york" },
        })
      );
      assert.equal(p.length, 4);
      assert.ok(p.every((r) => r.found));
    });

    await t.test("compare_restaurants accepts 5 items via restaurants", async () => {
      const p = payloadJson(
        await rpc("tools/call", {
          name: "compare_restaurants",
          arguments: { restaurants: VENUES.slice(0, 5), city: "new-york" },
        })
      );
      assert.equal(p.length, 5);
    });

    await t.test("compare_restaurants rejects 6 items at the schema boundary", async () => {
      const m = await rpc("tools/call", {
        name: "compare_restaurants",
        arguments: { restaurants: [...VENUES, "Extra Venue"], city: "new-york" },
      });
      // SDK 1.30 surfaces input-validation failures as an isError result,
      // not a JSON-RPC -32602.
      assert.ok(m.result?.isError === true, `expected isError result, got: ${JSON.stringify(m).slice(0, 200)}`);
      assert.match(m.result.content[0].text, /at most 5|Invalid arguments/);
    });

    await t.test("compare_restaurants without restaurants or ids returns a descriptive error", async () => {
      const p = payloadJson(
        await rpc("tools/call", { name: "compare_restaurants", arguments: { city: "new-york" } })
      );
      assert.ok(p.error.includes("'restaurants'"), `unexpected error: ${p.error}`);
    });
  });
});
