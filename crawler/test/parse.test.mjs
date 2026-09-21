// Tests for the Eater map-page parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EaterParseError, parseMapPage } from "../dist/eater/parse.js";

const URL = "https://ny.eater.com/maps/test-map";

function point(over = {}) {
  return {
    name: "La Piraña Lechonera",
    description: [{ plaintext: "Great roast pork.", html: "<p>Great roast pork.</p>" }],
    address: "226 7th Avenue, Brooklyn, New York 11215, United States",
    phone: "(718) 555-0100",
    url: "https://example.com/la-pirana",
    location: { latitude: 40.815576, longitude: -73.90649 },
    venue: { posts: { nodes: [{ permalink: "https://ny.eater.com/maps/other-map" }] } },
    ...over,
  };
}

function htmlWithPoints(points, nodeOver = {}) {
  const payload = {
    props: {
      pageProps: {
        hydration: {
          responses: [
            {
              operationName: "MapLayoutQuery",
              data: {
                node: {
                  title: "The Test Map",
                  permalink: URL,
                  publishedAt: "2026-07-09T20:20:16+00:00",
                  updatedAt: "2026-08-13T14:15:09+00:00",
                  mapPoints: points,
                  ...nodeOver,
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
  )}</script></head><body></body></html>`;
}

test("parses a full entry: name, blurb, address parts, phone, website, cross-refs", () => {
  const page = parseMapPage(htmlWithPoints([point()]), URL);
  assert.equal(page.slug, "test-map");
  assert.equal(page.title, "The Test Map");
  assert.equal(page.publishedAt, "2026-07-09T20:20:16+00:00");
  assert.equal(page.updatedAt, "2026-08-13T14:15:09+00:00");
  assert.equal(page.entries.length, 1);
  const e = page.entries[0];
  assert.equal(e.position, 1);
  assert.equal(e.name, "La Piraña Lechonera");
  assert.equal(e.blurb, "Great roast pork.");
  assert.equal(e.phone, "(718) 555-0100");
  assert.equal(e.website, "https://example.com/la-pirana");
  assert.equal(e.address_line1, "226 7th Avenue");
  assert.equal(e.locality, "Brooklyn");
  assert.equal(e.region, "NY");
  assert.equal(e.postal_code, "11215");
  assert.equal(e.latitude, 40.815576);
  assert.equal(e.longitude, -73.90649);
  assert.deepEqual(e.alsoFeaturedIn, ["https://ny.eater.com/maps/other-map"]);
});

test("missing or non-numeric location yields null coordinates", () => {
  const page = parseMapPage(
    htmlWithPoints([
      point({ name: "No Location", location: undefined }),
      point({ name: "Bad Location", location: { latitude: "north", longitude: null } }),
    ]),
    URL
  );
  assert.equal(page.entries[0].latitude, null);
  assert.equal(page.entries[0].longitude, null);
  assert.equal(page.entries[1].latitude, null);
  assert.equal(page.entries[1].longitude, null);
});

test("plaintext blurb wins; stripped HTML is the fallback", () => {
  const page = parseMapPage(
    htmlWithPoints([
      point({ description: [{ plaintext: "Plain wins.", html: "<p>HTML loses.</p>" }] }),
      point({
        name: "HTML Only",
        description: [{ html: "<p>Only <b>html</b> &amp; entities</p>" }],
      }),
      point({ name: "No Blurb", description: [] }),
    ]),
    URL
  );
  assert.equal(page.entries[0].blurb, "Plain wins.");
  assert.equal(page.entries[1].blurb, "Only html & entities");
  assert.equal(page.entries[2].blurb, null);
});

test("nameless points are skipped and positions compress", () => {
  const page = parseMapPage(
    htmlWithPoints([
      point({ name: "First" }),
      { description: [{ plaintext: "sponsored insertion, no name" }] },
      point({ name: "Third" }),
    ]),
    URL
  );
  assert.deepEqual(
    page.entries.map((e) => [e.position, e.name]),
    [
      [1, "First"],
      [2, "Third"],
    ]
  );
});

test("a nameless point at the top does not renumber the venues below it", () => {
  // Positions are ranks among named entries, not raw mapPoints indices: a
  // chrome/sponsored slot appearing or disappearing never shifts venues.
  const page = parseMapPage(
    htmlWithPoints([
      { description: [{ plaintext: "chrome, no name" }] },
      point({ name: "First" }),
      point({ name: "Second" }),
    ]),
    URL
  );
  assert.deepEqual(
    page.entries.map((e) => [e.position, e.name]),
    [
      [1, "First"],
      [2, "Second"],
    ]
  );
});

test("missing __NEXT_DATA__ throws EaterParseError", () => {
  assert.throws(() => parseMapPage("<html><body>redesigned</body></html>", URL), (e) => {
    assert.ok(e instanceof EaterParseError);
    assert.match(e.message, /no __NEXT_DATA__/);
    return true;
  });
});

test("missing MapLayoutQuery throws EaterParseError", () => {
  const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { hydration: { responses: [{ operationName: "OtherQuery", data: {} }] } } },
  })}</script></head></html>`;
  assert.throws(() => parseMapPage(html, URL), (e) => {
    assert.ok(e instanceof EaterParseError);
    assert.match(e.message, /no MapLayoutQuery/);
    return true;
  });
});

test("empty mapPoints throws instead of silently producing nothing", () => {
  assert.throws(() => parseMapPage(htmlWithPoints([]), URL), EaterParseError);
});

test("all-nameless mapPoints throws", () => {
  assert.throws(
    () => parseMapPage(htmlWithPoints([{ description: [] }, { name: "  " }]), URL),
    /no named entries/
  );
});

test("invalid JSON in __NEXT_DATA__ throws EaterParseError", () => {
  const html = `<html><head><script id="__NEXT_DATA__" type="application/json">{oops</script></head></html>`;
  assert.throws(() => parseMapPage(html, URL), EaterParseError);
});

test("slug falls back to the fetch URL when permalink is absent", () => {
  const page = parseMapPage(htmlWithPoints([point()], { permalink: null }), URL);
  assert.equal(page.slug, "test-map");
  assert.equal(page.url, URL);
});
