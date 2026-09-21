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
