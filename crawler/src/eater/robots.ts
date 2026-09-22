// robots.txt handling for the Eater crawler.
//
// The crawler fetches https://ny.eater.com/robots.txt with its own contact
// user agent and honours the result: /maps/ must be allowed for our UA,
// /search is disallowed by robots (and hard-blocked in the fetcher anyway),
// and any crawl-delay is respected on top of our own 1 req/s floor.

import { EATER_BASE_URL, EATER_FETCH_TIMEOUT_MS, EATER_USER_AGENT } from "./types.js";

export interface RobotsRule {
  allow: boolean;
  /** Normalized pattern text (RFC 9309 §2.2.2), for debugging and longest-match comparison. */
  pattern: string;
  test: (path: string) => boolean;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

/** Escape regex syntax, then translate robots `*` wildcards and `$` anchors. */
function patternToTest(pattern: string): (path: string) => boolean {
  let anchored = false;
  let p = pattern;
  if (p.endsWith("$")) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const src = p
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const re = new RegExp("^" + src + (anchored ? "$" : ""));
  return (path: string) => re.test(path);
}

function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i === -1 ? line : line.slice(0, i)).trim();
}

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

/**
 * RFC 9309 §2.2.2 path normalization for robots matching.
 *
 * A percent-encoded ASCII octet is decoded before comparison when it is
 * unreserved (`%70` → `p`), so `Disallow: /maps/private` also covers
 * `/maps/%70rivate`. Encoded reserved characters (`%2F`) and non-ASCII
 * octets (`%E3%83%84`) stay encoded — decoding them would move component
 * boundaries the rule author never wrote. Non-ASCII characters in rule
 * text are percent-encoded (UTF-8, uppercase hex) so both sides compare
 * in the same space, and hex digits are uppercased so `%2f` and `%2F`
 * compare equal. Matching stays case-sensitive per RFC.
 *
 * Returns null on a malformed `%` sequence; callers fail closed on null.
 * This gate honors the site's stated policy per the RFC. The fetcher's own
 * forbidden-path blocklist is a separate, deliberately coarser safety rail
 * (full decode, case-insensitive) with its own helper — the two are not
 * required to agree.
 */
function normalizeRobotsPath(path: string): string | null {
  let out = "";
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === "%") {
      const hex = path.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      const decoded = String.fromCharCode(parseInt(hex, 16));
      out += UNRESERVED.test(decoded) ? decoded : "%" + hex.toUpperCase();
      i += 3;
      continue;
    }
    const cp = path.codePointAt(i)!;
    if (cp > 127) {
      // Lone surrogates make encodeURIComponent throw; treat as malformed.
      if (cp >= 0xd800 && cp <= 0xdfff) return null;
      out += encodeURIComponent(String.fromCodePoint(cp));
    } else {
      out += c;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

/**
 * Parse robots.txt into groups. Consecutive `User-agent:` lines belong to one
 * group; a `User-agent:` line after any rule line starts a new group.
 * Malformed lines are ignored rather than aborting the whole file.
 */
export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let inAgents = true; // still reading the agent lines of the current group

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!value) continue;
      if (!inAgents || !current) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
        inAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue; // rule before any user-agent line: ignore
    inAgents = false;

    if (field === "disallow") {
      // Empty Disallow means "allow everything"; record nothing.
      // Rule paths are normalized exactly like URL paths (RFC 9309 §2.2.2);
      // a rule with a malformed `%` sequence falls back to literal matching.
      if (value) {
        const pattern = normalizeRobotsPath(value) ?? value;
        current.rules.push({ allow: false, pattern, test: patternToTest(pattern) });
      }
    } else if (field === "allow") {
      if (value) {
        const pattern = normalizeRobotsPath(value) ?? value;
        current.rules.push({ allow: true, pattern, test: patternToTest(pattern) });
      }
    } else if (field === "crawl-delay") {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs >= 0) {
        const ms = Math.round(secs * 1000);
        current.crawlDelayMs =
          current.crawlDelayMs === null ? ms : Math.max(current.crawlDelayMs, ms);
      }
    }
    // Sitemap: and unknown fields are intentionally ignored.
  }
  return groups;
}

/** Product token of a UA string, e.g. "nycfoodie-crawler" from "nycfoodie-crawler/1.0 (...)". */
function uaToken(ua: string): string {
  return ua.split(/[\s/]/)[0].toLowerCase();
}

/**
 * Groups applying to `userAgent`: non-wildcard matches win over `*`; when
 * several groups match, their rules merge (most specific pattern wins at
 * match time). No matching group means "allow all".
 */
export function groupsForAgent(groups: RobotsGroup[], userAgent: string): RobotsGroup[] {
  const token = uaToken(userAgent);
  const specific = groups.filter((g) =>
    g.agents.some((a) => {
      if (a === "*") return false;
      if (token === a) return true;
      // A shorter group name conventionally names the bot family
      // ("nycfoodie" covers our "nycfoodie-crawler").
      if (token.startsWith(a)) return true;
      // A version-suffixed group ("nycfoodie-crawler/1.0") matches at a "/"
      // boundary — but a longer unrelated name ("nycfoodie-crawler-bad")
      // must never match.
      return a.startsWith(token) && a[token.length] === "/";
    })
  );
  if (specific.length > 0) return specific;
  return groups.filter((g) => g.agents.includes("*"));
}

/**
 * RFC 9309 §2.2.2: the longest matching rule wins; on a tie, Allow wins.
 * The tested path is pathname + search (so `/share?*`-style rules work).
 * Rule paths and the URL pathname are both normalized per RFC 9309 §2.2.2
 * (unreserved percent-encodings decoded, reserved/non-ASCII kept encoded,
 * case-sensitive), so `Disallow: /maps/private` covers `/maps/%70rivate`
 * but not `/maps/%2Fprivate` or `/maps/Private`.
 */
export function robotsAllows(groups: RobotsGroup[], userAgent: string, url: string): boolean {
  const applicable = groupsForAgent(groups, userAgent);
  if (applicable.length === 0) return true;
  let path: string;
  try {
    const u = new URL(url);
    const normalized = normalizeRobotsPath(u.pathname);
    if (normalized === null) return false; // malformed percent-encoding: fail closed
    path = normalized + u.search;
  } catch {
    return false; // unparseable URL: fail closed
  }
  let best: RobotsRule | null = null;
  for (const g of applicable) {
    for (const rule of g.rules) {
      if (!rule.test(path)) continue;
      if (
        !best ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
  }
  return best ? best.allow : true;
}

/** Largest crawl-delay (ms) across applicable groups, if any. */
export function robotsCrawlDelayMs(groups: RobotsGroup[], userAgent: string): number | null {
  const applicable = groupsForAgent(groups, userAgent);
  let max: number | null = null;
  for (const g of applicable) {
    if (g.crawlDelayMs !== null) max = max === null ? g.crawlDelayMs : Math.max(max, g.crawlDelayMs);
  }
  return max;
}

export async function fetchRobotsTxt(
  baseUrl: string = EATER_BASE_URL,
  userAgent: string = EATER_USER_AGENT,
  timeoutMs: number = EATER_FETCH_TIMEOUT_MS
): Promise<string> {
  const root = baseUrl.replace(/\/+$/, "");
  const origin = new URL(root).origin;
  let current = `${root}/robots.txt`;
  // Manual redirect handling: a robots.txt redirect is followed only within
  // the same origin, so a hostile redirect can never pull a request
  // off-origin before the crawler's stricter checks apply.
  for (let hop = 0; hop < 3; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        headers: { "User-Agent": userAgent },
        redirect: "manual",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.arrayBuffer().catch(() => undefined);
      if (!location) throw new Error("robots.txt redirect without a Location header");
      const next = new URL(location, current);
      if (next.origin !== origin) {
        throw new Error(`robots.txt redirect leaves origin: ${next.origin}`);
      }
      current = next.href;
      continue;
    }
    if (!res.ok) {
      // RFC 9309 §2.3: 5xx means "do not crawl"; other failures are treated
      // as "no robots.txt". Fail closed on 5xx only.
      if (res.status >= 500) throw new Error(`robots.txt fetch failed: HTTP ${res.status}`);
      return "";
    }
    return await res.text();
  }
  throw new Error("robots.txt: too many redirects");
}
