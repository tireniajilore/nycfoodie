// Tests for the Eater enrichment read path (editorial_blurbs) and tag recall.
// Spawns the real stdio MCP server against a scratch copy of the dataset DB
// with migration 015 + the backfill write run applied. Fixtures are picked
// from the DB itself so the test doesn't depend on specific venue names.
// No test framework: node:test only, following test/smoke.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { migrate } from "../../db/dist/migrate.js";
import { closeDb } from "../../db/dist/index.js";
import { runBackfill } from "../../db/dist/backfill-eater-tags.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbSrc = join(root, "..", "nycfoodie.db");

const OPEN = "(sl.is_closed IS NULL OR sl.is_closed = 0)";

function pickFixtures(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const one = (sql) => db.prepare(sql).get();
    // Eater-only venue that gained an eater cuisine tag, and is open. Picks the
    // rarest cuisine label so the limit-bounded cuisine search is a meaningful
    // assertion (a broad label like 'Bar' matches hundreds of venues and the
    // NULL-rated eater-only venue sorts past the limit).
    const eaterOnly = one(
      `SELECT r.name AS name, t.label AS cuisine FROM restaurants r
       JOIN source_listings sl ON sl.restaurant_id = r.id
       JOIN listing_tags lt ON lt.source_listing_id = sl.id
       JOIN tags t ON t.id = lt.tag_id
       WHERE lt.assigned_by = 'guide-theme-map:v1' AND t.kind = 'cuisine' AND ${OPEN}
       ORDER BY (SELECT COUNT(DISTINCT slx.restaurant_id)
                 FROM listing_tags ltx
                 JOIN tags tx ON tx.id = ltx.tag_id
                 JOIN source_listings slx ON slx.id = ltx.source_listing_id
                 WHERE tx.kind = 'cuisine' AND tx.label = t.label) ASC,
                r.name LIMIT 1`
    );
    // Eater-only venue that gained an eater neighbourhood tag, and is open.
    // Skip borough-level labels: neighbourhood='Brooklyn' expands to ~46
    // labels and matches hundreds of venues, so a limit-bounded search is
    // a poor assertion target. A specific label keeps the match set small.
    const eaterHood = one(
      `SELECT r.name AS name, t.label AS neighbourhood FROM restaurants r
       JOIN source_listings sl ON sl.restaurant_id = r.id
       JOIN listing_tags lt ON lt.source_listing_id = sl.id
       JOIN tags t ON t.id = lt.tag_id
       WHERE lt.assigned_by = 'backfill:neighborhood:v1'
         AND t.label NOT IN ('Brooklyn', 'Queens', 'Staten Island', 'The Bronx')
         AND ${OPEN}
       ORDER BY r.name LIMIT 1`
    );
    // Cross-source venue (infatuation + eater) with eater guide blurbs.
    const crossSource = one(
      `SELECT r.name AS name FROM restaurants r
       WHERE EXISTS (SELECT 1 FROM source_listings sl WHERE sl.restaurant_id = r.id AND sl.source_slug = 'infatuation')
         AND EXISTS (SELECT 1 FROM source_listings sl WHERE sl.restaurant_id = r.id AND sl.source_slug = 'eater')
         AND EXISTS (SELECT 1 FROM guide_entries ge
                     JOIN source_listings sl ON sl.id = ge.source_listing_id
                     JOIN guides g ON g.id = ge.guide_id
                     WHERE sl.restaurant_id = r.id AND g.source_slug = 'eater' AND ge.blurb IS NOT NULL)
       ORDER BY r.name LIMIT 1`
    );
    // Infatuation-only venue: no eater entries, blurbs must be empty.
    const infatuationOnly = one(
      `SELECT r.name AS name FROM restaurants r
       WHERE EXISTS (SELECT 1 FROM source_listings sl WHERE sl.restaurant_id = r.id AND sl.source_slug = 'infatuation')
         AND NOT EXISTS (SELECT 1 FROM source_listings sl WHERE sl.restaurant_id = r.id AND sl.source_slug = 'eater')
       ORDER BY r.name LIMIT 1`
    );
    return { eaterOnly, eaterHood, crossSource, infatuationOnly };
  } finally {
    db.close();
  }
}

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nycfoodie-eater-"));
  const db = join(dir, "test.db");
  copyFileSync(dbSrc, db);
  migrate(db);
  closeDb();
  const report = runBackfill(db, "write");
  assert.ok(report.cuisine.venuesGained > 0, "backfill tagged venues in the fixture DB");
  const fx = pickFixtures(db);
  assert.ok(fx.eaterOnly, "fixture: eater-only venue with a cuisine tag");
  assert.ok(fx.eaterHood, "fixture: eater-only venue with a neighbourhood tag");
  assert.ok(fx.crossSource, "fixture: cross-source venue with eater blurbs");
  assert.ok(fx.infatuationOnly, "fixture: infatuation-only venue");
  const child = spawn("node", [join(root, "dist", "index.js")], {
    env: { ...process.env, NYCFOODIE_DB: db, NYCFOODIE_LOG: join(dir, "calls.jsonl") },
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
      clientInfo: { name: "eater-enrichment", version: "1" },
    });
    await new Promise((r) => setTimeout(r, 800));
    pump();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await fn(rpc, fx);
  } finally {
    clearInterval(timer);
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (stderr.trim()) console.error("server stderr:", stderr.slice(0, 500));
    rmSync(dir, { recursive: true, force: true });
  }
}

const toolText = (msg) => {
  assert.ok(msg.result, `expected result, got error: ${JSON.stringify(msg.error)}`);
  assert.ok(!msg.result.isError, `unexpected tool error: ${msg.result.content?.[0]?.text}`);
  return msg.result.content[0].text;
};

function assertBlurbShape(b) {
  assert.equal(b.source, "eater");
  assert.ok(typeof b.guide_title === "string" && b.guide_title.length > 0, "guide_title");
  assert.ok(typeof b.guide_url === "string" && b.guide_url.startsWith("http"), "guide_url");
  assert.ok(typeof b.position === "number", "position is a number");
  assert.ok(typeof b.blurb === "string" && b.blurb.length > 0, "blurb is non-empty prose");
  assert.ok(typeof b.captured_at === "string" && !Number.isNaN(Date.parse(b.captured_at)), "captured_at is ISO");
}

await test("eater enrichment read path", async (t) => {
  await withServer(async (rpc, fx) => {
    await t.test("eater-only venue carries editorial_blurbs and its eater tags", async () => {
      const p = JSON.parse(
        toolText(await rpc("tools/call", { name: "get_restaurant", arguments: { name: fx.eaterOnly.name, city: "new-york" } }))
      );
      assert.equal(p.name, fx.eaterOnly.name);
      assert.ok(Array.isArray(p.editorial_blurbs) && p.editorial_blurbs.length > 0, "editorial_blurbs present");
      for (const b of p.editorial_blurbs) assertBlurbShape(b);
      assert.ok(
        (p.tags.cuisine ?? []).includes(fx.eaterOnly.cuisine),
        `eater cuisine tag '${fx.eaterOnly.cuisine}' shown`
      );
      assert.equal(p.rating, null, "eater-only venue stays unrated");
      assert.equal(p.price_tier, null, "eater-only venue stays unpriced");
    });

    await t.test("cross-source venue also gets editorial_blurbs", async () => {
      const p = JSON.parse(
        toolText(await rpc("tools/call", { name: "get_restaurant", arguments: { name: fx.crossSource.name, city: "new-york" } }))
      );
      assert.ok(Array.isArray(p.editorial_blurbs) && p.editorial_blurbs.length > 0, "blurbs for cross-source venue");
      for (const b of p.editorial_blurbs) assertBlurbShape(b);
    });

    await t.test("infatuation-only venue has empty editorial_blurbs", async () => {
      const p = JSON.parse(
        toolText(
          await rpc("tools/call", { name: "get_restaurant", arguments: { name: fx.infatuationOnly.name, city: "new-york" } })
        )
      );
      assert.deepEqual(p.editorial_blurbs, [], "no eater entries means no blurbs");
    });

    await t.test("cuisine filter finds the eater-only venue through its eater tag", async () => {
      const p = JSON.parse(
        toolText(
          await rpc("tools/call", {
            name: "search_restaurants",
            arguments: { cuisine: fx.eaterOnly.cuisine, city: "new-york", limit: 50 },
          })
        )
      );
      const names = p.map((c) => c.name);
      assert.ok(names.includes(fx.eaterOnly.name), `cuisine='${fx.eaterOnly.cuisine}' includes ${fx.eaterOnly.name}`);
    });

    await t.test("neighbourhood filter finds the eater-only venue through its eater tag", async () => {
      const p = JSON.parse(
        toolText(
          await rpc("tools/call", {
            name: "search_restaurants",
            arguments: { neighborhood: fx.eaterHood.neighbourhood, city: "new-york", limit: 50 },
          })
        )
      );
      const names = p.map((c) => c.name);
      assert.ok(
        names.includes(fx.eaterHood.name),
        `neighborhood='${fx.eaterHood.neighbourhood}' includes ${fx.eaterHood.name}`
      );
    });
  });
});
