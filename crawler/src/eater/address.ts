// Best-effort parsing of Eater's single-line venue addresses.
//
// Eater map entries carry one address string, e.g.
// "226 7th Avenue, Brooklyn, New York 11215, United States"
// "2135 Broadway, New York, NY 10023, USA"
// This splits it into the structured columns the dataset uses. Anything it
// cannot confidently parse keeps the full string as address_line1 with the
// rest NULL — an honest partial parse beats a confident wrong one.

import type { EaterAddress } from "./types.js";

const EMPTY: EaterAddress = {
  address_line1: null,
  locality: null,
  region: null,
  postal_code: null,
};

const US_STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};
const US_STATE_CODES = new Set(Object.values(US_STATE_NAMES));

export function parseAddress(raw: string | null | undefined): EaterAddress {
  if (!raw || !raw.trim()) return { ...EMPTY };
  const s = raw.trim().replace(/\s+/g, " ");
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ...EMPTY };
  if (parts.length === 1) return { ...EMPTY, address_line1: parts[0] };

  // Strip a trailing country token; the dataset is US-only and stores none.
  // Canada is included defensively: Eater's NYC data occasionally carries a
  // stray country token, and dropping it beats storing it as an address part.
  const tail = parts[parts.length - 1];
  const body =
    /^(USA|U\.S\.A\.?|United States|US|Canada)$/i.test(tail) ? parts.slice(0, -1) : parts;
  if (body.length === 0) return { ...EMPTY };
  if (body.length === 1) return { ...EMPTY, address_line1: body[0] };

  const parsed = parseTail(body);
  if (!parsed) return { ...EMPTY, address_line1: s };
  const { head, region, postal } = parsed;
  if (head.length === 0) return { ...EMPTY, region, postal_code: postal };
  if (head.length === 1)
    return { ...EMPTY, address_line1: head[0], region, postal_code: postal };
  return {
    address_line1: head.slice(0, -1).join(", "),
    locality: head[head.length - 1],
    region,
    postal_code: postal,
  };
}

interface TailParse {
  head: string[];
  region: string | null;
  postal: string | null;
}

/**
 * Parse the trailing segment(s) of a comma-split address into region/postal.
 * Returns null when the tail is not a recognisable US state/ZIP form.
 */
function parseTail(parts: string[]): TailParse | null {
  const last = parts[parts.length - 1];

  // "NY 10023" — state code + ZIP in one segment. Case-insensitive like the
  // split-state and bare-state branches below; the code is normalised above.
  let m = /^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i.exec(last);
  if (m && US_STATE_CODES.has(m[1].toUpperCase())) {
    return { head: parts.slice(0, -1), region: m[1].toUpperCase(), postal: m[2] };
  }
  // "Bronx, NY, 10455" — ZIP split from the state code by a comma.
  if (
    parts.length >= 3 &&
    /^\d{5}(?:-\d{4})?$/.test(last) &&
    /^[A-Z]{2}$/i.test(parts[parts.length - 2]) &&
    US_STATE_CODES.has(parts[parts.length - 2].toUpperCase())
  ) {
    return {
      head: parts.slice(0, -2),
      region: parts[parts.length - 2].toUpperCase(),
      postal: last,
    };
  }
  // "New York 11215" — full state name with ZIP. The ZIP is required: a bare
  // "Washington" is far more likely a city than the state.
  m = /^([A-Za-z][A-Za-z .]+?)\s+(\d{5}(?:-\d{4})?)$/.exec(last);
  if (m) {
    const code = US_STATE_NAMES[m[1].toLowerCase()];
    if (code) {
      return { head: parts.slice(0, -1), region: code, postal: m[2] };
    }
  }
  // Bare "NY" — region only.
  if (/^[A-Z]{2}$/i.test(last) && US_STATE_CODES.has(last.toUpperCase())) {
    return { head: parts.slice(0, -1), region: last.toUpperCase(), postal: null };
  }
  return null;
}
