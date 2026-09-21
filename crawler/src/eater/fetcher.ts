// Polite HTTP fetcher for the Eater crawler.
//
// Guarantees, by construction rather than convention:
// - at most 1 concurrent request (all fetches serialise through one queue)
// - at least `minIntervalMs` (default 1000) between request starts
// - the contact user agent on every request
// - honour for 429/503: Retry-After is respected, 5xx/network errors back off
// - conditional requests (ETag / Last-Modified) plus content-hash change
//   detection, so unchanged pages are recognised without re-parsing
// - raw HTML snapshots on disk for every changed fetch, for later reparsing
// - /search (and friends) can never be fetched, whatever the caller asks

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EATER_FETCH_TIMEOUT_MS,
  EATER_FORBIDDEN_PATH_PREFIXES,
  EATER_MAX_RETRIES,
  EATER_MIN_INTERVAL_MS,
  EATER_USER_AGENT,
} from "./types.js";

export class FetchError extends Error {
  readonly url: string;
  readonly status: number | null;
  constructor(url: string, status: number | null, message: string) {
    super(message);
    this.name = "FetchError";
    this.url = url;
    this.status = status;
  }
}

export interface FetchResult {
  url: string;
  /** 200 on fresh content, 304/"not-modified" when unchanged, 404 when gone. */
  status: number | "not-modified";
  body: string | null;
  /** True when the content hash matches the last snapshot (no change). */
  unchanged: boolean;
  /** Path of the snapshot written for this fetch, if any. */
  snapshotPath: string | null;
}

interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  sha256: string | null;
}

export interface PoliteFetcherOptions {
  userAgent?: string;
  /** Minimum ms between request starts. Default: 1000 (1 req/s). */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Directory for raw HTML snapshots and the conditional-request cache.
   * Snapshots land in `<snapshotDir>/<name>/<timestamp>.html`. When null,
   * nothing is written to disk (used by dry runs and tests).
   */
  snapshotDir?: string | null;
  /** Injectable fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Optional per-URL allowlist consulted on every fetch, after the built-in
   * forbidden-path check. The crawler wires its parsed robots.txt groups
   * here so a rule disallowing a specific map path is honoured even though
   * the /maps/ prefix probe passed.
   */
  urlAllowed?: (url: string) => boolean;
  /** Message for the FetchError thrown when urlAllowed returns false. */
  urlBlockedMessage?: (url: string) => string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function snapshotTimestamp(d = new Date()): string {
  // Filesystem-safe UTC timestamp: 2026-09-21T10-30-00-123Z
  return d.toISOString().replace(/[:.]/g, "-");
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms. */
function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 3600) * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), 3600_000));
  return null;
}

export class PoliteFetcher {
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly snapshotDir: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly urlAllowed: ((url: string) => boolean) | null;
  private readonly urlBlockedMessage: ((url: string) => string) | null;
  private readonly cachePath: string | null;
  private cache: Record<string, CacheEntry> = {};

  /** Serialises all fetches: at most 1 concurrent request, ever. */
  private queue: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(opts: PoliteFetcherOptions = {}) {
    this.userAgent = opts.userAgent ?? EATER_USER_AGENT;
    this.minIntervalMs = opts.minIntervalMs ?? EATER_MIN_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? EATER_FETCH_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? EATER_MAX_RETRIES;
    this.snapshotDir = opts.snapshotDir ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.urlAllowed = opts.urlAllowed ?? null;
    this.urlBlockedMessage = opts.urlBlockedMessage ?? null;
    this.cachePath = this.snapshotDir ? join(this.snapshotDir, ".fetch-cache.json") : null;
    if (this.cachePath) this.cache = this.loadCache();
  }

  private loadCache(): Record<string, CacheEntry> {
    try {
      const raw = readFileSync(this.cachePath!, "utf8");
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveCache(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(this.snapshotDir!, { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 1));
    } catch {
      // Cache persistence is best-effort; a failed write must not fail a crawl.
    }
  }

  private assertAllowed(url: string): void {
    let path: string;
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch {
      throw new FetchError(url, null, `refusing to fetch unparseable URL`);
    }
    for (const prefix of EATER_FORBIDDEN_PATH_PREFIXES) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        throw new FetchError(url, null, `refusing to fetch forbidden path ${path}`);
      }
    }
  }

  /**
   * Fetch a URL politely. Calls serialise: concurrent callers queue behind
   * each other, each waiting its turn plus the rate-limit interval.
   */
  async fetch(url: string, snapshotName?: string): Promise<FetchResult> {
    this.assertAllowed(url);
    if (this.urlAllowed && !this.urlAllowed(url)) {
      throw new FetchError(
        url,
        null,
        this.urlBlockedMessage ? this.urlBlockedMessage(url) : `refusing to fetch blocked URL ${url}`
      );
    }
    const run = this.queue.then(() => this.doFetch(url, snapshotName));
    // Keep the chain alive even if this fetch rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async doFetch(url: string, snapshotName?: string): Promise<FetchResult> {
    const cached = this.cache[url];
    let attempt = 0;
    for (;;) {
      attempt++;
      // The 1 req/s floor applies to every request start, including retries:
      // a backoff sleep shorter than the floor must not let a retry jump the queue.
      const wait = this.minIntervalMs - (Date.now() - this.lastStart);
      if (wait > 0) await this.sleepImpl(wait);
      this.lastStart = Date.now();

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response;
      try {
        const headers: Record<string, string> = { "User-Agent": this.userAgent };
        if (cached?.etag) headers["If-None-Match"] = cached.etag;
        if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
        res = await this.fetchImpl(url, { headers, signal: ctrl.signal });
      } catch (e) {
        clearTimeout(timer);
        if (attempt > this.maxRetries) {
          throw new FetchError(url, null, `network error after ${attempt} attempts: ${(e as Error).message}`);
        }
        await this.sleepImpl(this.backoffMs(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 304) {
        return { url, status: "not-modified", body: null, unchanged: true, snapshotPath: null };
      }
      if (res.status === 404) {
        return { url, status: 404, body: null, unchanged: false, snapshotPath: null };
      }
      // fetch() follows redirects silently. Refuse to land anywhere outside
      // the maps area: a redirect to a venue page, login wall, or another
      // host must never be parsed as a map.
      if (res.redirected) {
        const final = new URL(res.url);
        const orig = new URL(url);
        const sameOrigin = final.origin === orig.origin;
        const mapsPath = final.pathname === "/maps" || final.pathname.startsWith("/maps/");
        if (!sameOrigin || !mapsPath) {
          throw new FetchError(url, res.status, `redirected to disallowed URL ${res.url}`);
        }
      }
      if (res.status === 429) {
        if (attempt > this.maxRetries) {
          throw new FetchError(url, 429, `rate limited after ${attempt} attempts`);
        }
        const waitMs = retryAfterMs(res.headers.get("retry-after")) ?? this.backoffMs(attempt);
        await res.arrayBuffer().catch(() => undefined); // drain
        await this.sleepImpl(waitMs);
        continue;
      }
      if (res.status >= 500) {
        await res.arrayBuffer().catch(() => undefined); // drain
        if (attempt > this.maxRetries) {
          throw new FetchError(url, res.status, `server error after ${attempt} attempts`);
        }
        await this.sleepImpl(this.backoffMs(attempt));
        continue;
      }
      if (!res.ok) {
        throw new FetchError(url, res.status, `unexpected HTTP ${res.status}`);
      }

      const body = await res.text();
      const hash = sha256Hex(body);
      if (cached?.sha256 === hash) {
        return { url, status: 200, body, unchanged: true, snapshotPath: null };
      }
      // Snapshot first, cache second: a failed snapshot must not poison the
      // cache into believing this content was already preserved. When a
      // snapshotDir is configured, snapshots are a hard requirement — a
      // write failure throws and the map is counted as failed, never
      // silently snapshotless.
      let snapshotPath: string | null = null;
      if (this.snapshotDir && snapshotName) {
        snapshotPath = this.writeSnapshot(snapshotName, body);
      }
      const entry: CacheEntry = {
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        sha256: hash,
      };
      this.cache[url] = entry;
      this.saveCache();

      return { url, status: 200, body, unchanged: false, snapshotPath };
    }
  }

  /** Exponential backoff with jitter: 1s, 2s, 4s, … capped at 30s. */
  private backoffMs(attempt: number): number {
    const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  /**
   * Write a raw HTML snapshot. Throws on failure: when snapshots are
   * configured they are a provenance requirement, not best-effort.
   */
  private writeSnapshot(name: string, body: string): string {
    const safeName = name.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "page";
    const dir = join(this.snapshotDir!, safeName);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${snapshotTimestamp()}.html`);
    writeFileSync(path, body);
    return path;
  }
}
