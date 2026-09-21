// End-to-end test for crawlEaterMaps against a local HTTP server:
// robots check -> index discovery -> polite fetch -> parse -> (dry run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "nycfoodie-db";
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

test("assertMapsCrawlable refuses when robots disallows /maps/", async () => {
  await assert.rejects(
    () =>
      assertMapsCrawlable("https://ny.eater.com", "x", async () => "User-agent: *\nDisallow: /maps/\n"),
    /disallows/
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
