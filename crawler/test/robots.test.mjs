// Tests for the Eater crawler's robots.txt handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchRobotsTxt,
  groupsForAgent,
  parseRobotsTxt,
  robotsAllows,
  robotsCrawlDelayMs,
} from "../dist/eater/robots.js";

const UA = "nycfoodie-crawler/1.0 (+https://github.com/tireniajilore/nycfoodie)";
const BASE = "https://ny.eater.com";

const SAMPLE = `
User-agent: *
Disallow: /search
Allow: /maps/

User-agent: SomeBot
Disallow: /

User-agent: nycfoodie-crawler
Crawl-delay: 2
Disallow: /private
`;

test("parseRobotsTxt groups consecutive user-agent lines", () => {
  const groups = parseRobotsTxt("User-agent: a\nUser-agent: b\nDisallow: /x\n");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].agents, ["a", "b"]);
  assert.equal(groups[0].rules.length, 1);
});

test("a user-agent line after rules starts a new group", () => {
  const groups = parseRobotsTxt("User-agent: a\nDisallow: /x\nUser-agent: b\nDisallow: /y\n");
  assert.equal(groups.length, 2);
});

test("empty Disallow records no rule (allows everything)", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow:\n");
  assert.equal(groups[0].rules.length, 0);
  assert.equal(robotsAllows(groups, UA, `${BASE}/anything`), true);
});

test("wildcard group: /maps/ allowed, /search denied", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /search\nAllow: /maps/\n");
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/best-nyc`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/search?q=x`), false);
  assert.equal(robotsAllows(groups, UA, `${BASE}/search`), false);
});

test("specific UA group overrides the wildcard group", () => {
  const groups = parseRobotsTxt(SAMPLE);
  const applicable = groupsForAgent(groups, UA);
  assert.equal(applicable.length, 1);
  assert.deepEqual(applicable[0].agents, ["nycfoodie-crawler"]);
  // The specific group has no /maps rule, so the wildcard's Allow no longer
  // applies — but nothing disallows it either, so it stays allowed.
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/x`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/private`), false);
  // Another bot still sees the wildcard group.
  assert.equal(robotsAllows(groups, "OtherBot/1.0", `${BASE}/search`), false);
});

test("UA matching is precise: version suffix matches, unrelated suffix does not", () => {
  const groups = parseRobotsTxt(
    "User-agent: nycfoodie-crawler-bad\nDisallow: /maps/\n\n" +
      "User-agent: nycfoodie-crawler/1.0\nDisallow: /private\n\n" +
      "User-agent: *\nAllow: /maps/\n"
  );
  const applicable = groupsForAgent(groups, UA);
  // "nycfoodie-crawler-bad" must NOT match our "nycfoodie-crawler" token,
  // but the version-suffixed "nycfoodie-crawler/1.0" matches at the boundary.
  assert.equal(applicable.length, 1);
  assert.deepEqual(applicable[0].agents, ["nycfoodie-crawler/1.0"]);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/x`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/private`), false);
});

test("crawl-delay is read from the applicable group", () => {
  const groups = parseRobotsTxt(SAMPLE);
  assert.equal(robotsCrawlDelayMs(groups, UA), 2000);
  assert.equal(robotsCrawlDelayMs(groups, "OtherBot/1.0"), null);
});

test("longest matching rule wins", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /maps\nAllow: /maps/public\n");
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/public/x`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/secret`), false);
});

test("Allow wins on equal-length ties", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /abc\nAllow: /abc\n");
  assert.equal(robotsAllows(groups, UA, `${BASE}/abc`), true);
});

test("wildcard patterns and $ anchors", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /*?sort=\nAllow: /feed$\n");
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps?sort=pop`), false);
  assert.equal(robotsAllows(groups, UA, `${BASE}/feed`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/feed/extra`), true); // not anchored
});

test("no matching group allows everything", () => {
  assert.equal(robotsAllows([], UA, `${BASE}/maps/x`), true);
  assert.equal(robotsAllows(parseRobotsTxt("User-agent: SomeBot\nDisallow: /\n"), UA, `${BASE}/maps/x`), true);
});

test("robots rule matching decodes unreserved percent-encodings (RFC 9309)", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /maps/private\nAllow: /maps/\n");
  // %70 = 'p' (unreserved): the encoded equivalent of a disallowed path is denied.
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/private`), false);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%70rivate`), false);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%70%72ivate/sub`), false);
  // And an encoded allowed path stays allowed.
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%70ublic`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/public`), true);
});

test("robots matching keeps reserved encodings encoded (RFC 9309)", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /maps/private\nAllow: /maps/\n");
  // %2F is reserved: it must NOT decode to '/', so this is a different path
  // that the Disallow rule does not cover.
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%2Fprivate`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%2fprivate`), true); // hex case is folded
});

test("robots matching is case-sensitive (RFC 9309)", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /maps/private\nAllow: /maps/\n");
  // %50 = 'P': decoding applies, but 'P' is not 'p' under case-sensitive matching.
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%50rivate`), true);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/Private`), true);
});

test("encoded rule paths are normalized the same way as URLs", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /maps/%70rivate\nAllow: /maps/\n");
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/private`), false);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%70rivate`), false);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/public`), true);
});

test("non-ASCII rule text and URLs compare in percent-encoded space", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /caf\u00e9\nAllow: /\n");
  assert.equal(robotsAllows(groups, UA, `${BASE}/caf%C3%A9`), false);
  assert.equal(robotsAllows(groups, UA, `${BASE}/caf%C3%a9`), false); // hex case is folded
  assert.equal(robotsAllows(groups, UA, `${BASE}/other`), true);
});

test("malformed percent-encoding fails closed", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /x\n");
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%zz`), false);
  assert.equal(robotsAllows(groups, UA, `${BASE}/maps/%2`), false);
});

test("unparseable URL fails closed", () => {
  const groups = parseRobotsTxt("User-agent: *\nDisallow: /x\n");
  assert.equal(robotsAllows(groups, UA, ":::not a url:::"), false);
});

test("fetchRobotsTxt treats 404 as no robots file", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const text = await fetchRobotsTxt(`http://127.0.0.1:${port}`, UA, 5000);
    assert.equal(text, "");
  } finally {
    server.close();
  }
});

test("fetchRobotsTxt fails closed on 5xx", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await assert.rejects(() => fetchRobotsTxt(`http://127.0.0.1:${port}`, UA, 5000), /503/);
  } finally {
    server.close();
  }
});

test("fetchRobotsTxt follows same-origin robots redirects", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(302, { location: "/robots2.txt" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /search\n");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const text = await fetchRobotsTxt(`http://127.0.0.1:${port}`, UA, 5000);
    assert.match(text, /Disallow: \/search/);
  } finally {
    server.close();
  }
});

test("fetchRobotsTxt refuses a robots redirect that leaves the origin", async () => {
  const { createServer } = await import("node:http");
  const evil = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nDisallow: /\n");
  });
  await new Promise((r) => evil.listen(0, "127.0.0.1", r));
  const evilPort = evil.address().port;
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/robots.txt` });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => fetchRobotsTxt(`http://127.0.0.1:${port}`, UA, 5000),
      /leaves origin/
    );
  } finally {
    server.close();
    evil.close();
  }
});

test("fetchRobotsTxt gives up on a redirect loop", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: "/robots.txt" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => fetchRobotsTxt(`http://127.0.0.1:${port}`, UA, 5000),
      /too many redirects/
    );
  } finally {
    server.close();
  }
});
