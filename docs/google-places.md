# Google Places verification

Layer 4 of closure detection: cross-check canonical restaurants against
Google's `businessStatus` (OPERATIONAL / CLOSED_TEMPORARILY /
CLOSED_PERMANENTLY).

## API

- Places API (New): `POST https://places.googleapis.com/v1/places:searchText`
- Auth: `X-Goog-Api-Key` header (server key, restricted to Places API).
- Field mask (single call, no Place Details needed for status):
  `places.id,places.displayName,places.businessStatus,places.formattedAddress,places.location`
- Pricing observed 2026-09-19: Text Search ~$17–32 per 1,000 calls depending
  on tier; Google includes a $200/month Maps Platform credit that may cover
  most or all of a full sweep. Confirm current pricing in the GCP console.

## Matching rule

`textQuery` = restaurant name, `locationBias` = 500m circle around our
coordinates, `pageSize` 3. The closest candidate wins but is accepted only
within 200m of our coordinates (≤75m = high confidence, else low).
Venues without coordinates are skipped, never guessed. Ambiguous results
are left unmatched (NULL) rather than risking a wrong-venue verdict.

## Storage

`restaurants.google_place_id` (unique), `google_business_status`,
`google_match_confidence` (high/low), `google_last_checked_at`.
Results are cached and re-checked after 90 days.

## CLI

```
GOOGLE_PLACES_API_KEY=... node dist/index.js google-verify \
  --city new-york --limit 50 --db nycfoodie.db
```

Highest-rated unchecked venues first. Stops on API errors to avoid burn.
