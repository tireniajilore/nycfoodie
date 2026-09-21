// robots.txt handling for the Eater crawler.
//
// The crawler fetches https://ny.eater.com/robots.txt with its own contact
// user agent and honours the result: /maps/ must be allowed for our UA,
// /search is disallowed by robots (and hard-blocked in the fetcher anyway),
// and any crawl-delay is respected on top of our own 1 req/s floor.

import { EATER_BASE_URL, EATER_FETCH_TIMEOUT_MS, EATER_USER_AGENT } from "./types.js";

export interface RobotsRule {
  allow: boolean;
  /** Original pattern text, for debugging. */
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
      if (value) current.rules.push({ allow: false, pattern: value, test: patternToTest(value) });
    } else if (field === "allow") {
      if (value) current.rules.push({ allow: true, pattern: value, test: patternToTest(value) });
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
    g.agents.some((a) => a !== "*" && (token === a || token.startsWith(a) || a.startsWith(token)))
  );
  if (specific.length > 0) return specific;
  return groups.filter((g) => g.agents.includes("*"));
}

/**
 * RFC 9309 §2.2.2: the longest matching rule wins; on a tie, Allow wins.
 * The tested path is pathname + search (so `/share?*`-style rules work).
 */
export function robotsAllows(groups: RobotsGroup[], userAgent: string, url: string): boolean {
  const applicable = groupsForAgent(groups, userAgent);
  if (applicable.length === 0) return true;
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/robots.txt`, {
      headers: { "User-Agent": userAgent },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // RFC 9309 §2.3: 5xx means "do not crawl"; other failures are treated
      // as "no robots.txt". Fail closed on 5xx only.
      if (res.status >= 500) throw new Error(`robots.txt fetch failed: HTTP ${res.status}`);
      return "";
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
