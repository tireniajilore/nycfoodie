// Tests for the Eater crawler's polite fetcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FetchError, PoliteFetcher } from "../dist/eater/fetcher.js";

const UA = "nycfoodie-crawler/1.0 (+https://github.com/tireniajilore/nycfoodie)";
const BASE = "https://ny.eater.com";

function okResponse(body, headers = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });
}

test("/search is refused without any network traffic", async () => {
  let calls = 0;
  const f = new PoliteFetcher({
    fetchImpl: async () => {
      calls++;
      return okResponse("x");
    },
  });
  await assert.rejects(() => f.fetch("https://ny.eater.com/search?q=sushi"), /forbidden path/);
  await assert.rejects(() => f.fetch("https://ny.eater.com/search/"), /forbidden path/);
  assert.equal(calls, 0);
});

test("forbidden-path guard matches percent-encoded equivalents", async () => {
  let calls = 0;
  const f = new PoliteFetcher({
    fetchImpl: async () => {
      calls++;
      return okResponse("x");
    },
  });
  // %61 = 'a': many servers route /se%61rch identically to /search.
  await assert.rejects(() => f.fetch("https://ny.eater.com/se%61rch?q=sushi", "x"), /forbidden path/);
  await assert.rejects(() => f.fetch("https://ny.eater.com/%53earch/advanced", "x"), /forbidden path/);
  assert.equal(calls, 0);
});

test("redirect to a percent-encoded forbidden path is refused before following", async () => {
  const requested = [];
  const f = new PoliteFetcher({
    fetchImpl: async (url) => {
      requested.push(url);
      return redirectResponse("https://ny.eater.com/se%61rch?q=sushi");
    },
  });
  // Decoded, the target is /search: outside the maps area, so the area check
  // fires on the decoded path and the target is never requested.
  await assert.rejects(f.fetch(`${BASE}/maps/some-map`, "some-map"), /redirect leaves the maps area/);
  assert.deepEqual(requested, [`${BASE}/maps/some-map`]);
});

test("redirect to a percent-encoded maps path is still followed", async () => {
  const requested = [];
  const f = new PoliteFetcher({
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === `${BASE}/maps/some-map`) return redirectResponse(`${BASE}/%6Daps/target`);
      return okResponse("<html>map</html>");
    },
  });
  const res = await f.fetch(`${BASE}/maps/some-map`, "some-map");
  assert.equal(res.status, 200);
  assert.deepEqual(requested, [`${BASE}/maps/some-map`, `${BASE}/%6Daps/target`]);
});

test("a response that stalls after headers still trips the timeout", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<html><head><title>stall");
    // Never end the response: headers resolve, the body never completes.
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const f = new PoliteFetcher({
    userAgent: UA,
    minIntervalMs: 0,
    timeoutMs: 300,
    maxRetries: 1,
    snapshotDir: null,
    sleepImpl: () => Promise.resolve(),
  });
  try {
    await assert.rejects(() => f.fetch(`http://127.0.0.1:${port}/maps/a`, "a"), /body read failed/);
  } finally {
    server.close();
  }
});

test("the contact user agent is sent on every request", async () => {
  const seen = [];
  const f = new PoliteFetcher({
    fetchImpl: async (_url, init) => {
      seen.push(init.headers["User-Agent"]);
      return okResponse("hi");
    },
  });
  await f.fetch("https://ny.eater.com/maps/x");
  assert.deepEqual(seen, [UA]);
});

test("rate floor: request starts are spaced by minIntervalMs", async () => {
  const starts = [];
  const f = new PoliteFetcher({
    minIntervalMs: 120,
    fetchImpl: async () => {
      starts.push(Date.now());
      return okResponse("hi");
    },
  });
  await f.fetch("https://ny.eater.com/maps/a");
  await f.fetch("https://ny.eater.com/maps/b");
  await f.fetch("https://ny.eater.com/maps/c");
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 100, `gap1=${starts[1] - starts[0]}`);
  assert.ok(starts[2] - starts[1] >= 100, `gap2=${starts[2] - starts[1]}`);
});

test("concurrent fetch() calls never overlap in flight", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const f = new PoliteFetcher({
    minIntervalMs: 10,
    fetchImpl: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return okResponse("hi");
    },
  });
  await Promise.all([
    f.fetch("https://ny.eater.com/maps/a"),
    f.fetch("https://ny.eater.com/maps/b"),
    f.fetch("https://ny.eater.com/maps/c"),
    f.fetch("https://ny.eater.com/maps/d"),
  ]);
  assert.equal(maxInFlight, 1);
});

test("retries also observe the rate floor", async () => {
  const starts = [];
  let n = 0;
  const f = new PoliteFetcher({
    minIntervalMs: 150,
    maxRetries: 2,
    fetchImpl: async () => {
      starts.push(Date.now());
      n++;
      if (n === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
      return okResponse("recovered");
    },
  });
  const res = await f.fetch("https://ny.eater.com/maps/a");
  assert.equal(res.status, 200);
  assert.equal(starts.length, 2);
  // Retry-After: 0 must not let the retry jump the 150ms floor.
  assert.ok(starts[1] - starts[0] >= 130, `retry gap=${starts[1] - starts[0]}`);
});

test("429 with Retry-After is honoured, then succeeds", async () => {
  const sleeps = [];
  let n = 0;
  const f = new PoliteFetcher({
    minIntervalMs: 0,
    maxRetries: 3,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async () => {
      n++;
      if (n < 3) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      return okResponse("ok");
    },
  });
  const res = await f.fetch("https://ny.eater.com/maps/a");
  assert.equal(res.status, 200);
  assert.ok(sleeps.some((ms) => ms >= 2000), `sleeps=${sleeps}`);
});

test("persistent 503 exhausts retries and throws FetchError", async () => {
  const f = new PoliteFetcher({
    minIntervalMs: 0,
    maxRetries: 2,
    sleepImpl: async () => {},
    fetchImpl: async () => new Response("down", { status: 503 }),
  });
  await assert.rejects(() => f.fetch("https://ny.eater.com/maps/a"), (e) => {
    assert.ok(e instanceof FetchError);
    assert.equal(e.status, 503);
    return true;
  });
});

test("404 returns a gone result, not an exception", async () => {
  const f = new PoliteFetcher({
    fetchImpl: async () => new Response("nope", { status: 404 }),
  });
  const res = await f.fetch("https://ny.eater.com/maps/vanished");
  assert.equal(res.status, 404);
  assert.equal(res.body, null);
});

test("conditional request: ETag match returns not-modified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eater-fetch-"));
  const seenHeaders = [];
  let n = 0;
  const f = new PoliteFetcher({
    snapshotDir: dir,
    fetchImpl: async (_url, init) => {
      n++;
      seenHeaders.push({ ...init.headers });
      if (n === 1) return okResponse("<html>v1</html>", { etag: '"abc123"' });
      return new Response(null, { status: 304 });
    },
  });
  const first = await f.fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(first.status, 200);
  assert.ok(first.snapshotPath);
  f.commitCache("https://ny.eater.com/maps/a", first);
  const second = await f.fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(second.status, "not-modified");
  assert.equal(second.unchanged, true);
  assert.equal(second.snapshotPath, null);
  assert.equal(seenHeaders[1]["If-None-Match"], '"abc123"');
});

test("same content hash without 304 is recognised as unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eater-fetch-"));
  const f = new PoliteFetcher({
    snapshotDir: dir,
    fetchImpl: async () => okResponse("<html>same</html>"),
  });
  const first = await f.fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(first.unchanged, false);
  f.commitCache("https://ny.eater.com/maps/a", first);
  const second = await f.fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(second.status, 200);
  assert.equal(second.unchanged, true);
  assert.equal(second.snapshotPath, null);
  // Only one snapshot written — the unchanged re-fetch wrote none.
  assert.equal(readdirSync(join(dir, "a")).length, 1);
});

test("changed content writes a new snapshot and updates the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eater-fetch-"));
  let body = "<html>v1</html>";
  const f = new PoliteFetcher({
    snapshotDir: dir,
    fetchImpl: async () => okResponse(body),
  });
  const first = await f.fetch("https://ny.eater.com/maps/a", "a");
  body = "<html>v2</html>";
  const second = await f.fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(second.unchanged, false);
  assert.ok(second.snapshotPath);
  assert.notEqual(first.snapshotPath, second.snapshotPath);
  assert.equal(readdirSync(join(dir, "a")).length, 2);
  assert.equal(readFileSync(second.snapshotPath, "utf8"), "<html>v2</html>");
});

test("cache is committed explicitly, never as a fetch side effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eater-fetch-"));
  let conditionalServed = false;
  const mk = () =>
    new PoliteFetcher({
      snapshotDir: dir,
      fetchImpl: async (_url, init) => {
        if (init.headers["If-None-Match"] === '"persist1"') {
          conditionalServed = true;
          return new Response(null, { status: 304 });
        }
        return okResponse("<html>p</html>", { etag: '"persist1"' });
      },
    });
  // A bare fetch reads the cache but never writes it: no persistent side effects.
  const first = await mk().fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(first.status, 200);
  assert.ok(first.cacheState);
  const uncommitted = await mk().fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(uncommitted.status, 200); // no If-None-Match was sent
  assert.equal(conditionalServed, false);
  // After an explicit commit, a new instance sends conditional headers.
  const f = mk();
  const res = await f.fetch("https://ny.eater.com/maps/a", "a");
  f.commitCache("https://ny.eater.com/maps/a", res);
  const second = await mk().fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(conditionalServed, true);
  assert.equal(second.status, "not-modified");
});

test("conditional:false sends no conditional headers (index discovery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eater-fetch-"));
  const seen = [];
  const f = new PoliteFetcher({
    snapshotDir: dir,
    fetchImpl: async (_url, init) => {
      seen.push({ ...init.headers });
      return okResponse("<html>index</html>", { etag: '"idx1"' });
    },
  });
  const res = await f.fetch("https://ny.eater.com/maps", "index", { conditional: false });
  f.commitCache("https://ny.eater.com/maps", res);
  await f.fetch("https://ny.eater.com/maps", "index", { conditional: false });
  assert.ok(seen.every((h) => !("If-None-Match" in h) && !("If-Modified-Since" in h)));
});

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { location } });
}

test("redirect target is validated before any request goes to it", async () => {
  const requested = [];
  const f = new PoliteFetcher({
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === `${BASE}/maps/some-map`) return redirectResponse("https://evil.example/steal");
      return okResponse("<html>never</html>");
    },
  });
  await assert.rejects(f.fetch(`${BASE}/maps/some-map`, "some-map"), /redirect leaves origin/);
  assert.deepEqual(requested, [`${BASE}/maps/some-map`]); // the target got zero requests
});

test("redirect outside the maps area is refused before following", async () => {
  let calls = 0;
  const f = new PoliteFetcher({
    fetchImpl: async () => {
      calls++;
      return redirectResponse("https://ny.eater.com/nyc/best-pizza-katzs-deli");
    },
  });
  await assert.rejects(f.fetch(`${BASE}/maps/some-map`, "some-map"), /redirect leaves the maps area/);
  assert.equal(calls, 1);
});

test("redirect to a forbidden path is refused before following", async () => {
  const f = new PoliteFetcher({
    fetchImpl: async () => redirectResponse("https://ny.eater.com/search?q=sushi"),
  });
  // /search is outside the maps area, so the area check fires first; the
  // forbidden-path check in the redirect validator is belt-and-braces.
  await assert.rejects(f.fetch(`${BASE}/maps/some-map`, "some-map"), /redirect leaves the maps area/);
});

test("redirect within the maps area is followed after validation", async () => {
  const requested = [];
  const f = new PoliteFetcher({
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === `${BASE}/maps/some-map`) return redirectResponse(`${BASE}/maps/some-map/`);
      return okResponse("<html>map</html>");
    },
  });
  const res = await f.fetch(`${BASE}/maps/some-map`, "some-map");
  assert.equal(res.status, 200);
  assert.equal(res.body, "<html>map</html>");
  assert.deepEqual(requested, [`${BASE}/maps/some-map`, `${BASE}/maps/some-map/`]);
});

test("redirect without a Location header fails", async () => {
  const f = new PoliteFetcher({
    fetchImpl: async () => new Response(null, { status: 302 }),
  });
  await assert.rejects(f.fetch(`${BASE}/maps/some-map`, "some-map"), /without a Location header/);
});

test("redirect loops are bounded", async () => {
  let calls = 0;
  const f = new PoliteFetcher({
    minIntervalMs: 1,
    fetchImpl: async (url) => {
      calls++;
      const n = Number(new URL(url).searchParams.get("n") ?? "0");
      return redirectResponse(`${BASE}/maps/loop?n=${n + 1}`);
    },
  });
  await assert.rejects(f.fetch(`${BASE}/maps/loop`, "loop"), /too many redirects/);
  assert.ok(calls <= 7, `calls=${calls}`); // 1 initial + 5 hops + the throw
});

test("snapshot write failure throws instead of going silently snapshotless", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eater-snap-fail-"));
  const notADir = join(dir, "file");
  writeFileSync(notADir, "i am a file, not a directory");
  const f = new PoliteFetcher({ fetchImpl: async () => okResponse("v1"), snapshotDir: notADir });
  await assert.rejects(f.fetch(`${BASE}/maps/a`, "a"), /ENOTDIR|EACCES|EPERM/);
});

test("urlAllowed hook blocks a URL before any network traffic", async () => {
  let calls = 0;
  const f = new PoliteFetcher({
    fetchImpl: async () => {
      calls++;
      return okResponse("x");
    },
    urlAllowed: (url) => !url.includes("/maps/secret"),
    urlBlockedMessage: (url) => `blocked: ${url}`,
  });
  await assert.rejects(f.fetch(`${BASE}/maps/secret-map`), /blocked: .*secret-map/);
  assert.equal(calls, 0);
  const res = await f.fetch(`${BASE}/maps/public-map`);
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
});

test("snapshot writing is skipped without a snapshotDir", async () => {
  const f = new PoliteFetcher({
    fetchImpl: async () => okResponse("<html>x</html>"),
  });
  const res = await f.fetch("https://ny.eater.com/maps/a", "a");
  assert.equal(res.snapshotPath, null);
  assert.equal(res.unchanged, false);
});
