// Tests for Eater map discovery (index parsing + pagination walk).
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverMaps, parseMapIndex } from "../dist/eater/maps.js";

const PAGE = "https://ny.eater.com/maps";

test("parseMapIndex extracts map links, dedupes, ignores non-map links", () => {
  const html = `
    <a href="/maps/best-nyc">Best</a>
    <a href="https://ny.eater.com/maps/sushi-guide">Sushi</a>
    <a href="/maps/best-nyc">Best again</a>
    <a href="/maps">index itself</a>
    <a href="/maps?page=2">pagination</a>
    <a href="/archives/2024">archive</a>
    <a href="/maps/best-nyc/venue-slug">a venue page, not a map</a>
    <link rel="next" href="maps?page=2">`;
  const { mapUrls, nextPageUrl } = parseMapIndex(html, PAGE);
  assert.deepEqual(mapUrls, [
    "https://ny.eater.com/maps/best-nyc",
    "https://ny.eater.com/maps/sushi-guide",
  ]);
  assert.equal(nextPageUrl, "https://ny.eater.com/maps?page=2");
});

test("parseMapIndex finds rel=next regardless of attribute order", () => {
  const html = `<link href="/maps?page=3" rel="next">`;
  assert.equal(parseMapIndex(html, PAGE).nextPageUrl, "https://ny.eater.com/maps?page=3");
});

test("parseMapIndex returns null next when there is none", () => {
  const { nextPageUrl } = parseMapIndex(`<a href="/maps/a">A</a>`, PAGE);
  assert.equal(nextPageUrl, null);
});

function stubSource(pages) {
  // pages: Map from URL -> { mapLinks: string[], next: string | null }
  return {
    calls: [],
    async fetch(url, _label) {
      this.calls.push(url);
      const p = pages.get(url);
      if (!p) return { url, status: 404, body: null, unchanged: false, snapshotPath: null };
      const links = p.mapLinks.map((s) => `<a href="/maps/${s}">${s}</a>`).join("\n");
      const next = p.next ? `<link rel="next" href="${p.next}">` : "";
      return {
        url,
        status: 200,
        body: `<html>${links}${next}</html>`,
        unchanged: false,
        snapshotPath: null,
      };
    },
  };
}

test("discoverMaps walks pagination until no next link", async () => {
  const pages = new Map([
    ["https://ny.eater.com/maps", { mapLinks: ["a", "b"], next: "maps?page=2" }],
    ["https://ny.eater.com/maps?page=2", { mapLinks: ["c", "a"], next: null }],
  ]);
  const src = stubSource(pages);
  const found = await discoverMaps(src, { baseUrl: "https://ny.eater.com" });
  assert.deepEqual(found, [
    "https://ny.eater.com/maps/a",
    "https://ny.eater.com/maps/b",
    "https://ny.eater.com/maps/c",
  ]);
  assert.deepEqual(src.calls, ["https://ny.eater.com/maps", "https://ny.eater.com/maps?page=2"]);
});

test("discoverMaps stops at maxPages", async () => {
  const pages = new Map([
    ["https://ny.eater.com/maps", { mapLinks: ["a"], next: "maps?page=2" }],
    ["https://ny.eater.com/maps?page=2", { mapLinks: ["b"], next: "maps?page=3" }],
    ["https://ny.eater.com/maps?page=3", { mapLinks: ["c"], next: null }],
  ]);
  const found = await discoverMaps(stubSource(pages), {
    baseUrl: "https://ny.eater.com",
    maxPages: 2,
  });
  assert.deepEqual(found, ["https://ny.eater.com/maps/a", "https://ny.eater.com/maps/b"]);
});

test("discoverMaps does not loop on a self-referential next link", async () => {
  const pages = new Map([
    ["https://ny.eater.com/maps", { mapLinks: ["a"], next: "maps?page=2" }],
    ["https://ny.eater.com/maps?page=2", { mapLinks: ["b"], next: "maps?page=2" }],
  ]);
  const src = stubSource(pages);
  const found = await discoverMaps(src, { baseUrl: "https://ny.eater.com" });
  assert.deepEqual(found, ["https://ny.eater.com/maps/a", "https://ny.eater.com/maps/b"]);
  assert.equal(src.calls.length, 2);
});

test("discoverMaps stops quietly when the index 404s", async () => {
  const found = await discoverMaps(stubSource(new Map()), { baseUrl: "https://ny.eater.com" });
  assert.deepEqual(found, []);
});

test("discoverMaps ignores off-origin map links and next pages", async () => {
  const fetched = [];
  const src = {
    async fetch(url, _label) {
      fetched.push(url);
      return {
        url,
        status: 200,
        body:
          `<a href="/maps/ok">ok</a>` +
          `<a href="https://evil.example/maps/stolen">evil</a>` +
          `<link rel="next" href="https://evil.example/maps?page=2">`,
        unchanged: false,
        snapshotPath: null,
      };
    },
  };
  const found = await discoverMaps(src, { baseUrl: "https://ny.eater.com" });
  assert.deepEqual(found, ["https://ny.eater.com/maps/ok"]);
  assert.deepEqual(fetched, ["https://ny.eater.com/maps"]); // evil next page not followed
});
