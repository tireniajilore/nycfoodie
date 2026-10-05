// Legal pages (feature/legal-pages): GET /privacy and GET /terms serve
// server-rendered HTML with the approved draft copy, linked from the
// landing footer. No test framework: node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

test("legal pages serve the draft copy and are linked from the landing page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nycfoodie-legal-"));
  try {
    const dbPath = join(dir, "test.db");
    copyFileSync(dbSrc, dbPath);

    await withHttpServer(dbPath, async (port) => {
      const base = `http://127.0.0.1:${port}`;

      const privacy = await fetch(`${base}/privacy`);
      assert.equal(privacy.status, 200);
      assert.match(privacy.headers.get("content-type"), /text\/html/);
      const pBody = await privacy.text();
      assert.ok(pBody.includes("<title>Privacy Policy — NYCfoodie</title>"));
      assert.ok(pBody.includes("tireniajilore1@gmail.com"));
      // Key disclosures from the approved draft.
      assert.ok(pBody.includes("automatically deleted after 180 days"));
      assert.ok(pBody.includes("no query text and no raw IP addresses"));
      assert.ok(pBody.includes("Data licensing is currently unresolved"));

      const terms = await fetch(`${base}/terms`);
      assert.equal(terms.status, 200);
      assert.match(terms.headers.get("content-type"), /text\/html/);
      const tBody = await terms.text();
      assert.ok(tBody.includes("<title>Terms of Service — NYCfoodie</title>"));
      assert.ok(tBody.includes("Acceptable use"));
      assert.ok(tBody.includes("provided &quot;as is&quot;") || tBody.includes('provided "as is"'));
      assert.ok(tBody.includes("/privacy"));

      const landing = await fetch(`${base}/`);
      assert.equal(landing.status, 200);
      const lBody = await landing.text();
      assert.ok(lBody.includes('href="/privacy"'), "landing footer links /privacy");
      assert.ok(lBody.includes('href="/terms"'), "landing footer links /terms");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
