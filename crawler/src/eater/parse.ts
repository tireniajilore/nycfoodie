// Parser for Eater NY map pages.
//
// Eater's map pages are Next.js apps embedding their content as JSON in
// `__NEXT_DATA__`. The `MapLayoutQuery` payload carries a `mapPoints` array
// with everything the spec needs per entry: name, blurb (plaintext),
// address, phone, website, and the venue's other map appearances
// ("Also featured in").
//
// The parser is strict by design: if the expected structure is absent the
// page was probably redesigned, so it throws EaterParseError instead of
// silently producing nothing. The raw HTML snapshot (written by the
// fetcher) is preserved for re-parsing after a parser fix.

import { parseAddress } from "./address.js";
import type { EaterMapEntry, EaterMapPage } from "./types.js";

export class EaterParseError extends Error {
  readonly url: string;
  constructor(url: string, reason: string) {
    super(`cannot parse Eater map page ${url}: ${reason}`);
    this.name = "EaterParseError";
    this.url = url;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Extract the __NEXT_DATA__ JSON payload, or throw. */
function nextData(html: string, url: string): Record<string, unknown> {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new EaterParseError(url, "no __NEXT_DATA__ payload (page structure changed?)");
  try {
    const parsed: unknown = JSON.parse(m[1]);
    const rec = asRecord(parsed);
    if (!rec) throw new Error("top level is not an object");
    return rec;
  } catch (e) {
    throw new EaterParseError(url, `__NEXT_DATA__ is not valid JSON: ${(e as Error).message}`);
  }
}

function mapNode(data: Record<string, unknown>, url: string): Record<string, unknown> {
  const props = asRecord(data["props"]);
  const pageProps = asRecord(props?.["pageProps"]);
  const hydration = asRecord(pageProps?.["hydration"]);
  const responses = hydration?.["responses"];
  if (!Array.isArray(responses)) {
    throw new EaterParseError(url, "no hydration responses in page props");
  }
  for (const r of responses) {
    const rec = asRecord(r);
    if (rec?.["operationName"] !== "MapLayoutQuery") continue;
    const node = asRecord(asRecord(rec["data"])?.["node"]);
    if (node) return node;
  }
  throw new EaterParseError(url, "no MapLayoutQuery node in hydration responses");
}

/** Strip HTML tags; used only when the plaintext blurb is missing. */
function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function blurbText(point: Record<string, unknown>): string | null {
  const desc = point["description"];
  const first = Array.isArray(desc) ? asRecord(desc[0]) : null;
  const plaintext = asString(first?.["plaintext"]);
  if (plaintext) return plaintext;
  const html = asString(first?.["html"]);
  if (html) return stripTags(html) || null;
  return null;
}

function alsoFeaturedIn(point: Record<string, unknown>): string[] {
  const venue = asRecord(point["venue"]);
  const posts = asRecord(venue?.["posts"]);
  const nodes = posts?.["nodes"];
  if (!Array.isArray(nodes)) return [];
  const out: string[] = [];
  for (const n of nodes) {
    const permalink = asString(asRecord(n)?.["permalink"]);
    if (permalink && !out.includes(permalink)) out.push(permalink);
  }
  return out;
}

function parseEntry(point: unknown, position: number): EaterMapEntry | null {
  const p = asRecord(point);
  if (!p) return null;
  const name = asString(p["name"]);
  // Nameless points are chrome/sponsored insertions, not venues.
  if (!name) return null;
  const addr = parseAddress(asString(p["address"]));
  const loc = asRecord(p["location"]);
  const lat = loc?.["latitude"];
  const lng = loc?.["longitude"];
  return {
    position,
    name,
    blurb: blurbText(p),
    phone: asString(p["phone"]),
    website: asString(p["url"]),
    address_line1: addr.address_line1,
    locality: addr.locality,
    region: addr.region,
    postal_code: addr.postal_code,
    latitude: typeof lat === "number" && Number.isFinite(lat) ? lat : null,
    longitude: typeof lng === "number" && Number.isFinite(lng) ? lng : null,
    alsoFeaturedIn: alsoFeaturedIn(p),
  };
}

function slugFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const seg = path.split("/").filter(Boolean).pop() ?? "";
    if (seg) return seg;
  } catch {
    // fall through to the error below
  }
  throw new EaterParseError(url, "cannot derive map slug from URL");
}

/**
 * Parse a fetched Eater map page into structured entries. Positions are
 * 1-based in document order. Throws EaterParseError on structural mismatch.
 */
export function parseMapPage(html: string, url: string): EaterMapPage {
  const node = mapNode(nextData(html, url), url);
  const title = asString(node["title"]);
  if (!title) throw new EaterParseError(url, "map node has no title");
  const points = node["mapPoints"];
  if (!Array.isArray(points) || points.length === 0) {
    throw new EaterParseError(url, "map node has no mapPoints (page structure changed?)");
  }
  const entries: EaterMapEntry[] = [];
  for (const point of points) {
    const entry = parseEntry(point, entries.length + 1);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new EaterParseError(url, "mapPoints present but no named entries parsed");
  }
  const permalink = asString(node["permalink"]);
  return {
    slug: slugFromUrl(permalink ?? url),
    title,
    url: permalink ?? url,
    publishedAt: asString(node["publishedAt"]),
    updatedAt: asString(node["updatedAt"]),
    entries,
  };
}
