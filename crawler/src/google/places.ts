/**
 * Google Places verification (layer 4 of closure detection).
 *
 * Uses the Places API (New) Text Search endpoint with a field mask, so a
 * single call returns the place ID plus businessStatus — no separate
 * Place Details call is needed for closure checks.
 *
 * Matching rule: the top candidate is accepted only if it is within
 * MATCH_RADIUS_M of the coordinates we already hold. Anything further out
 * is left unmatched (NULL) rather than risking a wrong-venue verdict.
 * Venues without coordinates are skipped, not guessed.
 *
 * Cost control: results are cached on restaurants.google_last_checked_at
 * and only re-checked after RECHECK_DAYS. The CLI takes --limit.
 */

const PLACES_API = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.businessStatus,places.formattedAddress,places.location";

export const MATCH_RADIUS_M = 200;
export const RECHECK_DAYS = 90;

export interface GooglePlaceMatch {
  placeId: string;
  displayName: string;
  businessStatus: string | null;
  formattedAddress: string | null;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  confidence: "high" | "low";
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

interface PlacesResponse {
  places?: Array<{
    id: string;
    displayName?: { text: string };
    businessStatus?: string;
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
  }>;
}

/** Look up one venue by name, biased toward our coordinates. Returns null when no safe match. */
export async function verifyPlace(
  apiKey: string,
  name: string,
  lat: number | null,
  lng: number | null
): Promise<GooglePlaceMatch | null> {
  if (lat == null || lng == null) return null;

  const body: Record<string, unknown> = {
    textQuery: name,
    pageSize: 3,
    languageCode: "en",
    regionCode: "US",
    locationBias: {
      circle: { center: { latitude: lat, longitude: lng }, radius: 500.0 },
    },
  };

  const res = await fetch(PLACES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().then((t) => t.slice(0, 200));
    const err = new Error(`Places API ${res.status}: ${detail}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }

  const data = (await res.json()) as PlacesResponse;
  const places = data.places ?? [];
  if (places.length === 0) return null;

  // Best candidate = closest to our coordinates.
  type Place = NonNullable<PlacesResponse["places"]>[number];
  let best: Place | undefined;
  let bestDist = Infinity;
  for (const p of places) {
    if (p.location == null) continue;
    const d = haversineM(lat, lng, p.location.latitude, p.location.longitude);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (!best || bestDist > MATCH_RADIUS_M) return null;
  const winner = best;

  return {
    placeId: winner.id,
    displayName: winner.displayName?.text ?? name,
    businessStatus: winner.businessStatus ?? null,
    formattedAddress: winner.formattedAddress ?? null,
    lat: winner.location?.latitude ?? null,
    lng: winner.location?.longitude ?? null,
    distanceM: Math.round(bestDist),
    confidence: bestDist <= 75 ? "high" : "low",
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
