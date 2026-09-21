// End-to-end test for crawlEaterMaps against a local HTTP server:
// robots check -> index discovery -> polite fetch -> parse -> (dry run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDb, getDb } from "nycfoodie-db";
import { assertMapsCrawlable, crawlEaterMaps } from "../dist/eater/crawl.js";

function mapHtml(title, slug, points) {
  const payload = {
    props: {
      pageProps: {
        hydration: {
          responses: [
            {
              operationName: "MapLayoutQuery",
              data: {
                node: {
                  title,
                  permalink: `http://127.0.0.1:PORT/maps/${slug}`,
                  updatedAt: "2026-08-13T14:15:09+00:00",
                  mapPoints: points,
                },
              },
            },
          ],
        },
      },
    },
  };
  return `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    payload
  )}</script></head></html>`;
}

function pt(name, address) {
  return { name, description: [{ plaintext: `${name} is great.` }], address };
}

const INDEX = `<html>
<a href="/maps/map-a">A</a>
<a href="/maps/map-b">B</a>
</html>`;

function routesFor(port) {
  const fix = (s) => s.replaceAll("PORT", String(port));
  return {
    "/robots.txt": "User-agent: *\nAllow: /maps/\nDisallow: /search\n",
    "/maps": INDEX,
    "/maps/map-a": fix(mapHtml("Map A", "map-a", [pt("Alpha", "1 Main St, New York, NY 10001")])),
    "/maps/map-b": fix(
      mapHtml("Map B", "map-b", [
        pt("Beta", "2 Main St, Brooklyn, New York 11215, United States"),
        pt("Gamma", null),
      ])
    ),
  };
}

test("dry run discovers, fetches, and parses without writing", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const stats = await crawlEaterMaps({ baseUrl, write: false });
    assert.equal(stats.mapsDiscovered, 2);
    assert.equal(stats.mapsFetched, 2);
    assert.equal(stats.mapsFailed, 0);
    assert.equal(stats.entries, 3);
    assert.equal(stats.listingsUpserted, 0); // dry run writes nothing
  } finally {
    server.close();
  }
});

test("write mode persists guides, listings, entries, and a crawl watermark", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  const snapshotDir = join(dir, "snapshots");
  try {
    const stats = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir });
    assert.equal(stats.mapsFetched, 2);
    assert.equal(stats.entries, 3);
    assert.equal(stats.listingsUpserted, 3);
    // Reopen read-only to verify (crawlEaterMaps closes the singleton).
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM guides WHERE source_slug='eater'`).get().c, 2);
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM source_listings WHERE source_slug='eater'`).get().c, 3);
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM guide_entries`).get().c, 3);
      const keys = db
        .prepare(`SELECT source_key FROM source_listings ORDER BY source_key`)
        .all()
        .map((r) => r.source_key);
      assert.deepEqual(keys, ["map-a/alpha", "map-b/beta", "map-b/gamma"]);
      assert.ok(
        db.prepare(`SELECT COUNT(*) c FROM source_listings WHERE rating IS NULL`).get().c === 3
      );
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM crawl_state WHERE source_slug='eater'`).get().c, 1);
      const gamma = db.prepare(`SELECT restaurant_id FROM source_listings WHERE source_key='map-b/gamma'`).get();
      assert.equal(gamma.restaurant_id, null); // no address -> unlinked, flagged
    } finally {
      db.close();
    }
    assert.ok(stats.flags.some((f) => f.includes("Gamma")));
  } finally {
    server.close();
    closeDb();
  }
});

test("one unparseable map is counted and does not abort the crawl", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const port = server.address().port;
    const routes = {
      ...routesFor(port),
      "/maps/map-b": "<html><body>redesigned, no __NEXT_DATA__</body></html>",
    };
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const stats = await crawlEaterMaps({ baseUrl, write: false });
    assert.equal(stats.mapsDiscovered, 2);
    assert.equal(stats.mapsFetched, 2);
    assert.equal(stats.mapsFailed, 1);
    assert.equal(stats.entries, 1); // only map-a's entry
  } finally {
    server.close();
  }
});
test("per-request robots check skips a disallowed map without aborting", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const port = server.address().port;
    const routes = {
      ...routesFor(port),
      "/robots.txt": "User-agent: *\nAllow: /maps/\nDisallow: /maps/map-b\n",
    };
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const stats = await crawlEaterMaps({ baseUrl, write: false });
    assert.equal(stats.mapsDiscovered, 2);
    assert.equal(stats.mapsFetched, 1); // map-a only
    assert.equal(stats.mapsFailed, 1); // map-b blocked by robots
    assert.equal(stats.entries, 1);
  } finally {
    server.close();
  }
});

test("a dry run never poisons the cache for a later --write run", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  const snapshotDir = join(dir, "snapshots");
  try {
    const dry = await crawlEaterMaps({ baseUrl, write: false, snapshotDir });
    assert.equal(dry.mapsFetched, 2);
    assert.equal(dry.listingsUpserted, 0);
    // The write run must refetch everything: the dry run committed no cache.
    const written = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir });
    assert.equal(written.mapsNotModified, 0);
    assert.equal(written.mapsFetched, 2);
    assert.equal(written.listingsUpserted, 3);
  } finally {
    server.close();
    closeDb();
  }
});

test("a map whose store failed is refetched, not 304-skipped, on the next run", async () => {
  const { createServer: cs } = await import("node:http");
  const conditionalHits = [];
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers["if-none-match"] || req.headers["if-modified-since"]) {
      conditionalHits.push(req.url);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  const snapshotDir = join(dir, "snapshots");
  const { default: Database } = await import("better-sqlite3");
  const { initEaterStore } = await import("../dist/eater/store.js");
  try {
    // Sabotage: migrate, then drop source_listings so every store fails.
    // Migrations are IF NOT EXISTS, so the table stays dropped on re-run.
    initEaterStore(dbPath);
    const setup = new Database(dbPath);
    const ddl = setup.prepare(`SELECT sql FROM sqlite_master WHERE name='source_listings'`).get().sql;
    setup.exec(`DROP TABLE source_listings`);
    setup.close();
    closeDb();

    const failed = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir });
    assert.equal(failed.mapsFailed, 2);
    assert.equal(failed.listingsUpserted, 0);
    assert.deepEqual(conditionalHits, []);

    // Repair the table. The retry must fetch unconditionally: the failed run
    // committed no cache, so "not modified" can only mean "already ingested".
    const repair = new Database(dbPath);
    repair.exec(ddl);
    repair.close();

    const retried = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir });
    assert.deepEqual(conditionalHits, []);
    assert.equal(retried.mapsFailed, 0);
    assert.equal(retried.mapsFetched, 2);
    assert.equal(retried.listingsUpserted, 3);
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM source_listings WHERE source_slug='eater'`).get().c, 3);
    } finally {
      db.close();
    }
  } finally {
    server.close();
    closeDb();
  }
});

test("a 304 on the /maps index does not silently discover zero maps", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    // A stale cached index entry would make a conditional fetch 304 here.
    if (req.url === "/maps" && req.headers["if-none-match"]) {
      res.writeHead(304);
      res.end();
      return;
    }
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  const snapshotDir = join(dir, "snapshots");
  // Warm the cache the way a previous successful write run would have. The
  // cache file is scoped to the resolved --db path.
  mkdirSync(snapshotDir, { recursive: true });
  const scopeHash = createHash("sha1").update(resolve(dbPath), "utf8").digest("hex").slice(0, 12);
  writeFileSync(
    join(snapshotDir, `.fetch-cache-${scopeHash}.json`),
    JSON.stringify({ [`${baseUrl}/maps`]: { etag: '"stale-idx"', lastModified: null, sha256: "deadbeef" } })
  );
  try {
    const stats = await crawlEaterMaps({ baseUrl, write: false, dbPath, snapshotDir });
    assert.equal(stats.mapsDiscovered, 2);
    assert.equal(stats.mapsFetched, 2);
  } finally {
    server.close();
  }
});

test("dry runs ignore the fetch cache: warm cache still fetches and parses", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers["if-none-match"]) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html", etag: '"v1"' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  const snapshotDir = join(dir, "snapshots");
  // Warm the cache for both map pages, as a previous write run would have.
  mkdirSync(snapshotDir, { recursive: true });
  const scopeHash = createHash("sha1").update(resolve(dbPath), "utf8").digest("hex").slice(0, 12);
  const warm = {};
  for (const slug of ["best-sushi", "best-ramen"]) {
    warm[`${baseUrl}/maps/${slug}`] = { etag: '"v1"', lastModified: null, sha256: "deadbeef" };
  }
  writeFileSync(join(snapshotDir, `.fetch-cache-${scopeHash}.json`), JSON.stringify(warm));
  try {
    // A dry run validates fetching + parsing: it must fetch unconditionally
    // so parser changes can be checked against unchanged pages.
    const dry = await crawlEaterMaps({ baseUrl, write: false, dbPath, snapshotDir });
    assert.equal(dry.mapsNotModified, 0);
    assert.equal(dry.mapsFetched, 2);
    assert.equal(dry.entries, 3);
    assert.equal(dry.listingsUpserted, 0);
  } finally {
    server.close();
  }
});

test("a warm cache with a fresh database at the same path still ingests everything", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    // Behave like a real conditional server: 304 when the client has state.
    if (req.headers["if-none-match"]) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html", etag: '"v1"' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  const snapshotDir = join(dir, "snapshots");
  try {
    // First write run ingests everything and warms the cache.
    const first = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir });
    assert.equal(first.mapsNotModified, 0);
    assert.equal(first.listingsUpserted, 3);
    // Fresh database at the same path, warm snapshot dir kept. Without the
    // crawl-state gate the second run would 304-skip every map and ingest
    // nothing — "not modified" must mean "already ingested by THIS db".
    closeDb();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        /* already gone */
      }
    }
    const second = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir });
    assert.equal(second.mapsNotModified, 0);
    assert.equal(second.mapsFetched, 2);
    assert.equal(second.listingsUpserted, 3);
  } finally {
    server.close();
    closeDb();
  }
});

test("assertMapsCrawlable refuses when robots disallows /maps/", async () => {
  await assert.rejects(
    () =>
      assertMapsCrawlable("https://ny.eater.com", "x", async () => "User-agent: *\nDisallow: /maps/\n"),
    /disallows/
  );
});

test("assertMapsCrawlable probes the real /maps index URL, not just map pages", async () => {
  // `Disallow: /maps$` blocks the discovery start page while allowing map
  // pages. The preflight must fail loudly here, not mid-discovery.
  await assert.rejects(
    () =>
      assertMapsCrawlable(
        "https://ny.eater.com",
        "x",
        async () => "User-agent: *\nDisallow: /maps$\n"
      ),
    /disallows https:\/\/ny\.eater\.com\/maps for/
  );
});

test("assertMapsCrawlable passes when /maps/ is allowed", async () => {
  const r = await assertMapsCrawlable(
    "https://ny.eater.com",
    "x",
    async () => "User-agent: *\nAllow: /maps/\nCrawl-delay: 5\n"
  );
  assert.equal(r.crawlDelayMs, 5000);
});

test("--map rejects path traversal before any network request", async () => {
  const { createServer: cs } = await import("node:http");
  let requests = 0;
  const server = cs((_req, res) => {
    requests++;
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    // Plain traversal, backslash traversal, encoded traversal, query
    // strings, multi-segment paths, empties, and spaces all fail closed.
    for (const bad of [
      "../about",
      "..\\about",
      "%2e%2e/about",
      "%2E%2E/about",
      "maps?page=2",
      "/maps/map-a/",
      "map-a/map-b",
      "",
      "map a",
      "..",
    ]) {
      await assert.rejects(() => crawlEaterMaps({ baseUrl, write: false, map: bad }), /--map must be a single map slug/);
    }
    // Slug validation runs before robots preflight: not even /robots.txt
    // was requested for any of the rejected values.
    assert.equal(requests, 0);
  } finally {
    server.close();
  }
});

test("--map with a valid slug crawls just that map", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const stats = await crawlEaterMaps({ baseUrl, write: false, map: "map-a" });
    assert.equal(stats.mapsDiscovered, 1);
    assert.equal(stats.mapsFetched, 1);
    assert.equal(stats.entries, 1);
  } finally {
    server.close();
  }
});

test("write run refreshes rotated validators on hash-unchanged 200", async () => {
  const { createServer: cs } = await import("node:http");
  // The server rotates its ETag between runs while serving a byte-identical
  // body and ignoring conditional headers: the second run must learn the
  // new validator through the not-modified skip path.
  let etag = '"v1"';
  const server = cs((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /maps/\nDisallow: /search\n");
      return;
    }
    const port = server.address().port;
    const fix = (s) => s.replaceAll("PORT", String(port));
    if (req.url === "/maps/map-a") {
      res.writeHead(200, { "content-type": "text/html", etag });
      res.end(fix(mapHtml("Map A", "map-a", [pt("Alpha", "1 Main St, New York, NY 10001")])));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  const snapshotDir = join(dir, "snapshots");
  const cachePath = join(
    snapshotDir,
    `.fetch-cache-${createHash("sha1").update(resolve(dbPath), "utf8").digest("hex").slice(0, 12)}.json`
  );
  try {
    const first = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir, map: "map-a" });
    assert.equal(first.mapsFetched, 1);
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8"))[`${baseUrl}/maps/map-a`].etag, '"v1"');
    etag = '"v2"';
    const second = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir, map: "map-a" });
    assert.equal(second.mapsNotModified, 1);
    assert.equal(second.mapsFetched, 0);
    // The skip path committed the refreshed validators: the cache now
    // carries the rotated ETag instead of the stale v1 one.
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8"))[`${baseUrl}/maps/map-a`].etag, '"v2"');
  } finally {
    server.close();
    closeDb();
  }
});

test("write mode closes the DB when map discovery fails", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /maps/\nDisallow: /search\n");
      return;
    }
    // Non-retryable failure on the index: discovery throws immediately.
    res.writeHead(403);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  try {
    await assert.rejects(() => crawlEaterMaps({ baseUrl, write: true, dbPath }), /unexpected HTTP 403/);
    // The DB was opened before discovery ran: it must be closed even
    // though the failure happened before the crawl loop's try/finally.
    assert.throws(() => getDb(), /Database not open/);
  } finally {
    server.close();
    closeDb();
  }
});

test("a fresh-DB write run that stores nothing records no crawl state and drops the stale cache", async () => {
  const { createServer: cs } = await import("node:http");
  const server = cs((req, res) => {
    const routes = routesFor(server.address().port);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    // Behave like a real conditional server: 304 when the client has state.
    if (req.headers["if-none-match"]) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html", etag: '"v1"' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "eater-crawl-"));
  const dbPath = join(dir, "test.db");
  const snapshotDir = join(dir, "snapshots");
  mkdirSync(snapshotDir, { recursive: true });
  // Plant a stale cache file from a previous database era at the same path:
  // its ETags match the server, so a run that trusted it would 304-skip
  // every map and ingest nothing.
  const cachePath = join(
    snapshotDir,
    `.fetch-cache-${createHash("sha1").update(resolve(dbPath), "utf8").digest("hex").slice(0, 12)}.json`
  );
  const staleEntry = { etag: '"v1"', lastModified: null, sha256: "deadbeef" };
  writeFileSync(
    cachePath,
    JSON.stringify({ [`${baseUrl}/maps/map-a`]: staleEntry, [`${baseUrl}/maps/map-b`]: staleEntry })
  );
  try {
    // Run 1: fresh DB, but stores nothing (--maxMaps 0).
    const first = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir, maxMaps: 0 });
    assert.equal(first.mapsDiscovered, 2);
    assert.equal(first.mapsFetched, 0);
    assert.equal(first.listingsUpserted, 0);
    // Nothing ingested, so no crawl state: the next run must treat this DB
    // as fresh and ignore the fetch cache again.
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM crawl_state WHERE source_slug='eater'`).get().c, 0);
    } finally {
      db.close();
    }
    // The stale cache file was dropped when the fresh-DB run ignored it.
    assert.throws(() => readFileSync(cachePath), /ENOENT/);
    // Run 2: still a fresh DB — everything is fetched and ingested, never
    // 304-skipped on the back of the stale cache.
    const second = await crawlEaterMaps({ baseUrl, write: true, dbPath, snapshotDir });
    assert.equal(second.mapsNotModified, 0);
    assert.equal(second.mapsFetched, 2);
    assert.equal(second.listingsUpserted, 3);
  } finally {
    server.close();
    closeDb();
  }
});
