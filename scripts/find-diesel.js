#!/usr/bin/env node
/**
 * find-diesel.js — Fuel finder for road trips
 *
 * Modes:
 *   Route (default):  best-value diesel stations along the corridor from the
 *                     current GPS position (or --from) to <destination>.
 *   Near place:       --near <destination> — all-grade fuel prices around a
 *                     place or specific station (e.g. "Costco, Fairview, SC").
 *   Near me:          --near with no destination, or destination of
 *                     "current location"/"here"/"gps" — stations around the
 *                     current OwnTracks GPS position.
 *
 * Usage:
 *   node find-diesel.js "Springfield, IL"
 *   node find-diesel.js "Costco, Fairview, SC" --near
 *   node find-diesel.js --near                      # around current GPS
 *   node find-diesel.js 39.7817,-89.6501 --pretty
 *   node find-diesel.js --help
 *
 * Env vars:
 *   HERE_API_KEY         — HERE API key (fuel prices, geocoding, discover)
 *   TANGO_LOCATION_FILE  — Path to OwnTracks latest.json
 *                          (default: <repo-root>/data/location/latest.json)
 *
 * Geocoding chain: Nominatim → HERE Discover (POI search anchored at current
 * GPS) → HERE Geocode. Nominatim alone fails on POI queries whose city is
 * postally different (e.g. the "Fairview" Costco is in Springfield, IL).
 *
 * Data sources: HERE Fuel Prices (primary when HERE_API_KEY is set), with
 * automatic GasBuddy fallback when the primary returns no priced stations.
 * Route mode corridor + drive time come from HERE Router v8 (traffic-aware)
 * when HERE_API_KEY is set, falling back to the public OSRM server (whose
 * ETAs run 20-50% high on rural highways).
 *
 * Dependencies: @mapbox/polyline, geolib (native fetch, Node 18+)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const polyline = require('@mapbox/polyline');
const geolib = require('geolib');

// ── Config ──────────────────────────────────────────────────────────────────
function normalizeOptionalString(value) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function expandHomePath(value) {
  if (value === '~') {
    return os.homedir();
  }
  if (value?.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveConfiguredPath(value) {
  return path.resolve(expandHomePath(value));
}

function resolveProfileLocationFile() {
  const explicitLocationFile = normalizeOptionalString(process.env.TANGO_LOCATION_FILE);
  if (explicitLocationFile) {
    return resolveConfiguredPath(explicitLocationFile);
  }

  const explicitLocationDir = normalizeOptionalString(process.env.TANGO_LOCATION_DIR);
  if (explicitLocationDir) {
    return path.join(resolveConfiguredPath(explicitLocationDir), 'latest.json');
  }

  const explicitHome = normalizeOptionalString(process.env.TANGO_HOME);
  const explicitProfile = normalizeOptionalString(process.env.TANGO_PROFILE);
  if (explicitHome || explicitProfile) {
    const tangoHome = explicitHome
      ? resolveConfiguredPath(explicitHome)
      : path.join(os.homedir(), '.tango');
    const profile = explicitProfile || 'default';
    return path.join(tangoHome, 'profiles', profile, 'data', 'location', 'latest.json');
  }

  return path.join(__dirname, '../data/location/latest.json');
}

const LOCATION_FILE = resolveProfileLocationFile();
const CORRIDOR_WIDTH = 5000; // meters from route centerline
const NEAR_RADIUS = 16000; // meters around a near-mode center
const TOP_N = 8;
const HERE_FUEL_TYPE_DIESEL = '1';
const HERE_FUEL_TYPE_NAMES = { 1: 'diesel', 2: 'regular', 3: 'midgrade', 4: 'premium' };
const GASBUDDY_FUEL_PRODUCT_NAMES = {
  diesel: 'diesel',
  regular_gas: 'regular',
  midgrade_gas: 'midgrade',
  premium_gas: 'premium',
};
const GASBUDDY_FUEL_TYPE_DIESEL = 4;
const GASBUDDY_GRAPHQL_URL = 'https://www.gasbuddy.com/graphql';
const GASBUDDY_STATION_URL = 'https://www.gasbuddy.com/station/10000';
const WAYPOINT_INTERVAL_MILES = 50;
const GASBUDDY_DELAY_MS = 800;
// Discover needs an anchor even when the query names its own locality.
const US_CENTER = { lat: 39.8283, lon: -98.5795 };
const GPS_KEYWORD = /^(current(\s+location)?|here|gps|me|my\s+location)$/iu;

// ── CLI parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));

const nearMode = flags.has('--near');

if (flags.has('--help') || (positional.length === 0 && !nearMode)) {
  console.log(`
find-diesel — Find best-value fuel stations along your route or nearby

Usage:
  node find-diesel.js <destination> [options]
  node find-diesel.js <place> --near
  node find-diesel.js --near

  <destination>   Address, place/POI name, or lat,lon pair
                  Examples: "Lakeport, OR", "Costco, Fairview, SC", 44.97,-93.26
                  "current location" / "here" / "gps" = current GPS position

Options:
  --pretty        Human-readable output instead of JSON
  --near          Search around <place> (or current GPS if omitted), no routing
  --from=PLACE    Override start location (e.g. --from="Mesa Junction, NV")
  --width=METERS  Corridor width in meters (default: ${CORRIDOR_WIDTH})
  --top=N         Number of results (default: ${TOP_N})
  --source=SOURCE Force data source: "gasbuddy" or "here" (default: auto with
                  fallback — HERE first when HERE_API_KEY is set, then GasBuddy)
  --help          Show this help

Environment:
  HERE_API_KEY         HERE API key (fuel prices + POI geocoding)
  TANGO_LOCATION_FILE  Path to OwnTracks latest.json
`);
  process.exit(0);
}

const destination = positional.join(' ');
const pretty = flags.has('--pretty');
const corridorWidth = parseInt([...flags].find(f => f.startsWith('--width='))?.split('=')[1]) || CORRIDOR_WIDTH;
const topN = parseInt([...flags].find(f => f.startsWith('--top='))?.split('=')[1]) || TOP_N;
const forceSource = [...flags].find(f => f.startsWith('--source='))?.split('=')[1] || null;
const fromOverride = [...flags].find(f => f.startsWith('--from='))?.split('=').slice(1).join('=') || null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getApiKey() {
  return process.env.HERE_API_KEY?.trim() || null;
}

function getCurrentPosition() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf-8'));
    if (!data.lat || !data.lon) throw new Error('Missing lat/lon');
    const ageSec = (Date.now() / 1000) - data.timestamp;
    return { lat: data.lat, lon: data.lon, ageSec };
  } catch (err) {
    throw new Error(`Cannot read GPS location from ${LOCATION_FILE}: ${err.message}`);
  }
}

function tryGetCurrentPosition() {
  try {
    return getCurrentPosition();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, attempts = 3, baseDelayMs = 800) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await sleep(baseDelayMs * (i + 1));
  }
  throw lastErr;
}

// ── Geocoding chain: Nominatim → HERE Discover → HERE Geocode ───────────────

async function geocodeNominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'find-diesel/1.0' } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const results = await res.json();
  if (!results.length) return null;
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), label: results[0].display_name };
}

async function discoverHere(query, apiKey, anchor) {
  const url = `https://discover.search.hereapi.com/v1/discover?at=${anchor.lat},${anchor.lon}&q=${encodeURIComponent(query)}&limit=1&apiKey=${apiKey}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HERE Discover HTTP ${res.status}`);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item?.position) return null;
  return { lat: item.position.lat, lon: item.position.lng, label: item.address?.label || item.title };
}

async function geocodeHere(query, apiKey) {
  const url = `https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(query)}&apiKey=${apiKey}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HERE Geocode HTTP ${res.status}`);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item?.position) return null;
  return { lat: item.position.lat, lon: item.position.lng, label: item.address?.label || item.title };
}

async function resolvePlace(query) {
  const match = query.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (match) {
    return { lat: parseFloat(match[1]), lon: parseFloat(match[2]), label: query, geocoder: 'coordinate' };
  }

  const apiKey = getApiKey();
  const failures = [];

  try {
    const result = await geocodeNominatim(query);
    if (result) return { ...result, geocoder: 'nominatim' };
    failures.push('Nominatim: no results');
  } catch (err) {
    failures.push(`Nominatim: ${err.message}`);
  }

  if (apiKey) {
    const anchor = tryGetCurrentPosition() || US_CENTER;
    try {
      const result = await discoverHere(query, apiKey, anchor);
      if (result) return { ...result, geocoder: 'here-discover' };
      failures.push('HERE Discover: no results');
    } catch (err) {
      failures.push(`HERE Discover: ${err.message}`);
    }
    try {
      const result = await geocodeHere(query, apiKey);
      if (result) return { ...result, geocoder: 'here-geocode' };
      failures.push('HERE Geocode: no results');
    } catch (err) {
      failures.push(`HERE Geocode: ${err.message}`);
    }
  }

  throw new Error(`Could not geocode "${query}" (${failures.join('; ')})`);
}

function distanceFromRoute(stationLat, stationLon, routeCoords) {
  let minDist = Infinity;
  const point = { latitude: stationLat, longitude: stationLon };
  const step = Math.max(1, Math.floor(routeCoords.length / 500));
  for (let i = 0; i < routeCoords.length; i += step) {
    const d = geolib.getDistance(point, { latitude: routeCoords[i][0], longitude: routeCoords[i][1] });
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// Downsampled route with cumulative along-route distance, so stations can be
// projected to "miles ahead" instead of leaving the model to estimate
// distances from mile markers (the failure class behind TGO-796).
function buildRouteIndex(routeCoords) {
  const step = Math.max(1, Math.floor(routeCoords.length / 1500));
  const points = [];
  let cumulativeM = 0;
  let prev = null;
  for (let i = 0; i < routeCoords.length; i += step) {
    const c = routeCoords[i];
    if (prev) {
      cumulativeM += geolib.getDistance(
        { latitude: prev[0], longitude: prev[1] },
        { latitude: c[0], longitude: c[1] },
      );
    }
    points.push({ lat: c[0], lon: c[1], alongM: cumulativeM });
    prev = c;
  }
  return points;
}

function projectOntoRoute(stationLat, stationLon, routeIndex) {
  let best = { detourM: Infinity, alongM: 0 };
  const point = { latitude: stationLat, longitude: stationLon };
  for (const p of routeIndex) {
    const d = geolib.getDistance(point, { latitude: p.lat, longitude: p.lon });
    if (d < best.detourM) best = { detourM: d, alongM: p.alongM };
  }
  return best;
}

// Cross-source dedupe: entries within 150 m are the same site. Keep the one
// with the fresher posted price; surface the other's price when it disagrees
// so stale crowd data and stale feed data cross-check each other.
function mergeStations(stations) {
  const kept = [];
  const sorted = [...stations].sort((a, b) => String(b.priceUpdatedAt || '').localeCompare(String(a.priceUpdatedAt || '')));
  for (const s of sorted) {
    const dup = kept.find(k => geolib.getDistance(
      { latitude: k.lat, longitude: k.lon },
      { latitude: s.lat, longitude: s.lon },
    ) < 150);
    if (!dup) { kept.push(s); continue; }
    if (dup.source !== s.source && Math.abs(dup.dieselPrice - s.dieselPrice) >= 0.05) {
      dup.otherSourcePrice = s.dieselPrice;
      dup.otherSource = s.source;
    }
  }
  return kept;
}

function scoreStation(price, detourMeters) {
  return price * (1 + (detourMeters / 1000) * 0.1);
}

function mapsLink(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

// HERE encodes route shapes with Flexible Polyline, not Google polyline.
// Decoder ported from HERE's reference implementation (MIT).
function decodeFlexPolyline(encoded) {
  const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const charValues = new Map();
  for (let i = 0; i < TABLE.length; i++) charValues.set(TABLE.charCodeAt(i), i);
  let index = 0;
  const nextUnsigned = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const value = charValues.get(encoded.charCodeAt(index++));
      if (value === undefined) throw new Error('invalid flexible polyline');
      result += (value & 0x1f) * 2 ** shift;
      shift += 5;
      if ((value & 0x20) === 0) return result;
    }
  };
  const nextSigned = () => {
    const value = nextUnsigned();
    return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
  };
  const version = nextUnsigned();
  if (version !== 1) throw new Error(`unsupported flexible polyline version ${version}`);
  const header = nextUnsigned();
  const factor = 10 ** (header & 15);
  const thirdDim = (header >> 4) & 7;
  const coords = [];
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    lat += nextSigned();
    lon += nextSigned();
    if (thirdDim) nextSigned();
    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

async function getRoute(from, to) {
  // HERE Router v8 first: traffic-aware duration (OSRM demo ETAs run 20-50%
  // high on rural highways) and radius= snapping for off-road destinations.
  const apiKey = getApiKey();
  if (apiKey) {
    try {
      const url = `https://router.hereapi.com/v8/routes?transportMode=car&routingMode=fast&origin=${from.lat},${from.lon};radius=10000&destination=${to.lat},${to.lon};radius=10000&return=summary,polyline&apiKey=${apiKey}`;
      const res = await fetchWithRetry(url);
      const data = await res.json();
      const sections = data.routes?.[0]?.sections;
      if (sections?.length) {
        const coords = sections.flatMap(s => (s.polyline ? decodeFlexPolyline(s.polyline) : []));
        const distanceM = sections.reduce((sum, s) => sum + (s.summary?.length || 0), 0);
        const durationS = sections.reduce((sum, s) => sum + (s.summary?.duration || 0), 0);
        if (coords.length && distanceM > 0) {
          return { coords, distanceM, durationS, router: 'here' };
        }
      }
    } catch (err) {
      console.error(`⚠️  HERE routing failed (${err.message}); falling back to OSRM`);
    }
  }
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=polyline`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(`OSRM routing failed: ${data.code || 'no route'}`);
  }
  const route = data.routes[0];
  const coords = polyline.decode(route.geometry);
  return { coords, distanceM: route.distance, durationS: route.duration, router: 'osrm' };
}

function sampleWaypoints(routeCoords, intervalMiles) {
  const intervalM = intervalMiles * 1609.34;
  const waypoints = [routeCoords[0]];
  let accumulated = 0;
  for (let i = 1; i < routeCoords.length; i++) {
    const d = geolib.getDistance(
      { latitude: routeCoords[i - 1][0], longitude: routeCoords[i - 1][1] },
      { latitude: routeCoords[i][0], longitude: routeCoords[i][1] },
    );
    accumulated += d;
    if (accumulated >= intervalM) { waypoints.push(routeCoords[i]); accumulated = 0; }
  }
  const last = routeCoords[routeCoords.length - 1];
  const lastWP = waypoints[waypoints.length - 1];
  if (last[0] !== lastWP[0] || last[1] !== lastWP[1]) waypoints.push(last);
  return waypoints;
}

// ── GasBuddy ─────────────────────────────────────────────────────────────────

const GASBUDDY_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Origin': 'https://www.gasbuddy.com',
  'Referer': 'https://www.gasbuddy.com/home',
  'apollo-require-preflight': 'true',
};

const GASBUDDY_QUERY = `query LocationBySearchTerm($brandId: Int, $cursor: String, $fuel: Int, $lat: Float, $lng: Float, $maxAge: Int, $search: String) {
  locationBySearchTerm(lat: $lat, lng: $lng, search: $search) {
    stations(brandId: $brandId cursor: $cursor fuel: $fuel lat: $lat lng: $lng maxAge: $maxAge) {
      results {
        id name
        address { line1 locality region postalCode country }
        latitude longitude
        prices { fuelProduct longName credit { price postedTime } cash { price postedTime } }
      }
    }
  }
}`;

async function getGasBuddyAuth() {
  const res = await fetchWithRetry(GASBUDDY_STATION_URL, { headers: { 'User-Agent': GASBUDDY_HEADERS['User-Agent'] } });
  if (!res.ok) throw new Error(`Failed to fetch GasBuddy station page: ${res.status}`);
  const html = await res.text();
  const csrfMatch = html.match(/window\.gbcsrf\s*=\s*"([^"]+)"/);
  if (!csrfMatch) throw new Error('Could not extract GasBuddy CSRF token');
  const cookies = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  return { csrf: csrfMatch[1], cookies };
}

async function queryGasBuddyNear(lat, lng, auth) {
  const res = await fetchWithRetry(GASBUDDY_GRAPHQL_URL, {
    method: 'POST',
    headers: { ...GASBUDDY_HEADERS, 'gbcsrf': auth.csrf, 'Cookie': auth.cookies },
    body: JSON.stringify({
      operationName: 'LocationBySearchTerm',
      variables: { fuel: GASBUDDY_FUEL_TYPE_DIESEL, maxAge: 0, lat, lng },
      query: GASBUDDY_QUERY,
    }),
  });
  if (!res.ok) throw new Error(`GasBuddy GraphQL ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`GasBuddy errors: ${JSON.stringify(data.errors).slice(0, 200)}`);
  return data.data?.locationBySearchTerm?.stations?.results || [];
}

function gasBuddyPrices(station) {
  const prices = {};
  let updatedAt = null;
  for (const p of (station.prices || [])) {
    const name = GASBUDDY_FUEL_PRODUCT_NAMES[p.fuelProduct];
    if (!name) continue;
    const source = p.credit?.price ? p.credit : p.cash;
    if (!source?.price || source.price <= 0) continue;
    prices[name] = source.price;
    if (name === 'diesel') updatedAt = source.postedTime || null;
  }
  return { prices, updatedAt };
}

function gasBuddyAddress(station) {
  const addr = station.address || {};
  return [addr.line1, addr.locality, addr.region, addr.postalCode].filter(Boolean).join(', ');
}

async function queryGasBuddyAlongRoute(routeCoords) {
  if (pretty) process.stderr.write('🔑 Getting GasBuddy auth token...\n');
  const auth = await getGasBuddyAuth();
  const waypoints = sampleWaypoints(routeCoords, WAYPOINT_INTERVAL_MILES);
  if (pretty) process.stderr.write(`📍 Querying ${waypoints.length} waypoints...\n`);
  const stationMap = new Map();
  for (let i = 0; i < waypoints.length; i++) {
    const [lat, lng] = waypoints[i];
    try {
      const stations = await queryGasBuddyNear(lat, lng, auth);
      for (const s of stations) { if (!stationMap.has(s.id)) stationMap.set(s.id, s); }
      if (pretty) process.stderr.write(`  ✓ Waypoint ${i + 1}/${waypoints.length}\n`);
    } catch (err) {
      if (pretty) process.stderr.write(`  ✗ Waypoint ${i + 1}/${waypoints.length}: ${err.message}\n`);
    }
    if (i < waypoints.length - 1) await sleep(GASBUDDY_DELAY_MS);
  }
  const allStations = [];
  for (const s of stationMap.values()) {
    const { prices, updatedAt } = gasBuddyPrices(s);
    if (!prices.diesel || !s.latitude || !s.longitude) continue;
    allStations.push({
      name: s.name || 'Unknown Station',
      address: gasBuddyAddress(s),
      lat: s.latitude,
      lon: s.longitude,
      dieselPrice: prices.diesel,
      priceUpdatedAt: updatedAt,
      fuelType: 'diesel',
      fuelTypeName: 'Diesel',
    });
  }
  return allStations;
}

async function searchNearGasBuddy(center, radiusM) {
  if (pretty) process.stderr.write('🔑 Getting GasBuddy auth token...\n');
  const auth = await getGasBuddyAuth();
  const results = await queryGasBuddyNear(center.lat, center.lon, auth);
  const stations = [];
  for (const s of results) {
    if (!s.latitude || !s.longitude) continue;
    const { prices, updatedAt } = gasBuddyPrices(s);
    if (Object.keys(prices).length === 0) continue;
    const distM = geolib.getDistance(
      { latitude: center.lat, longitude: center.lon },
      { latitude: s.latitude, longitude: s.longitude },
    );
    if (distM > radiusM) continue;
    stations.push({
      name: s.name || 'Unknown Station',
      address: gasBuddyAddress(s),
      lat: s.latitude,
      lon: s.longitude,
      prices,
      priceUpdatedAt: updatedAt,
      distanceM: distM,
    });
  }
  return stations;
}

// ── HERE Fuel Prices v3 ───────────────────────────────────────────────────────

// Inverse of decodeFlexPolyline, for corridor queries.
function encodeFlexPolyline(coords) {
  const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const encodeUnsigned = (value) => {
    let out = '';
    while (value > 0x1f) {
      out += TABLE[(value & 0x1f) | 0x20];
      value = Math.floor(value / 32);
    }
    return out + TABLE[value];
  };
  const encodeSigned = (value) => encodeUnsigned(value < 0 ? -value * 2 - 1 : value * 2);
  let out = encodeUnsigned(1) + encodeUnsigned(5);
  let prevLat = 0;
  let prevLon = 0;
  for (const [lat, lon] of coords) {
    const latQ = Math.round(lat * 1e5);
    const lonQ = Math.round(lon * 1e5);
    out += encodeSigned(latQ - prevLat) + encodeSigned(lonQ - prevLon);
    prevLat = latQ;
    prevLon = lonQ;
  }
  return out;
}

async function queryHereFuelCorridor(routeCoords, apiKey, width) {
  // One corridor query covers the ENTIRE route. The old per-waypoint circle
  // scheme (50-mile spacing, 5 km radius) left ~94% of the route unsearched
  // and missed the cheapest cluster on a real trip (a highway junction, TGO-796
  // follow-up). Downsample so the encoded polyline stays URL-safe.
  const totalM = routeCoords.reduce((sum, c, i) => (
    i === 0 ? 0 : sum + geolib.getDistance(
      { latitude: routeCoords[i - 1][0], longitude: routeCoords[i - 1][1] },
      { latitude: c[0], longitude: c[1] },
    )
  ), 0);
  const intervalM = Math.max(2000, Math.round(totalM / 250));
  const downsampled = sampleWaypoints(routeCoords, intervalM / 1609.34);
  const polyline = encodeURIComponent(encodeFlexPolyline(downsampled));

  const allStations = [];
  const seen = new Set();
  let offset = 0;
  for (let page = 0; page < 12; page++) {
    const url = `https://fuel.hereapi.com/v3/stations?in=corridor:${polyline};r=${width}` +
      `&limit=100&fuelType=${HERE_FUEL_TYPE_DIESEL}${offset ? `&offset=${offset}` : ''}&apiKey=${apiKey}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`HERE corridor HTTP ${res.status}`);
    const data = await res.json();
    for (const s of (data.stations || [])) {
      if (seen.has(s.id)) continue;
      seen.add(s.id); allStations.push(s);
    }
    if (pretty) process.stderr.write(`  ✓ Corridor page ${page + 1}: ${allStations.length}/${data.total ?? '?'} stations\n`);
    if (data.nextOffset == null || (data.stations || []).length === 0) break;
    offset = data.nextOffset;
  }
  return allStations;
}

async function queryHereFuelAlongRoute(routeCoords, apiKey, width) {
  try {
    return await queryHereFuelCorridor(routeCoords, apiKey, width);
  } catch (err) {
    if (pretty) process.stderr.write(`  ⚠ Corridor query failed (${err.message}); falling back to waypoint circles\n`);
  }
  // Legacy fallback: circles around sparse waypoints. Coverage is gappy —
  // corridor mode above is the real path.
  const waypoints = sampleWaypoints(routeCoords, WAYPOINT_INTERVAL_MILES);
  const seen = new Set();
  const allStations = [];
  for (let i = 0; i < waypoints.length; i++) {
    const [lat, lon] = waypoints[i];
    const url = `https://fuel.hereapi.com/v3/stations?in=circle:${lat},${lon};r=${width}&fuelType=${HERE_FUEL_TYPE_DIESEL}&apiKey=${apiKey}`;
    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) { if (pretty) process.stderr.write(`  ⚠ Waypoint ${i + 1}: HTTP ${res.status}\n`); continue; }
      const data = await res.json();
      let count = 0;
      for (const s of (data.stations || [])) {
        if (seen.has(s.id)) continue;
        seen.add(s.id); allStations.push(s); count++;
      }
      if (pretty) process.stderr.write(`  ✓ Waypoint ${i + 1}/${waypoints.length}: ${count} stations\n`);
    } catch (err) {
      if (pretty) process.stderr.write(`  ✗ Waypoint ${i + 1}: ${err.message}\n`);
    }
    if (i < waypoints.length - 1) await sleep(300);
  }
  return allStations;
}

function getDieselPrice(station) {
  for (const p of (station.prices || [])) {
    if (String(p.fuelType) === HERE_FUEL_TYPE_DIESEL) {
      return {
        price: p.price ?? null,
        modified: p.modified || null,
        fuelType: String(p.fuelType),
        fuelTypeName: 'Diesel',
        unit: p.unit || null,
        currency: p.currency || null,
      };
    }
  }
  return null;
}

function herePrices(station) {
  const prices = {};
  let updatedAt = null;
  for (const p of (station.prices || [])) {
    const name = HERE_FUEL_TYPE_NAMES[String(p.fuelType)];
    if (!name || !p.price || p.price <= 0) continue;
    prices[name] = p.price;
    if (name === 'diesel') updatedAt = p.modified || null;
  }
  return { prices, updatedAt };
}

async function searchNearHere(center, radiusM, apiKey) {
  // No fuelType filter: near mode reports all grades, not just diesel.
  const url = `https://fuel.hereapi.com/v3/stations?in=circle:${center.lat},${center.lon};r=${radiusM}&apiKey=${apiKey}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HERE API error: ${res.status}`);
  const data = await res.json();
  const stations = [];
  for (const s of (data.stations || [])) {
    const lat = s.position?.lat; const lon = s.position?.lng;
    if (!lat || !lon) continue;
    const { prices, updatedAt } = herePrices(s);
    if (Object.keys(prices).length === 0) continue;
    const distM = geolib.getDistance(
      { latitude: center.lat, longitude: center.lon },
      { latitude: lat, longitude: lon },
    );
    stations.push({
      name: s.name || s.brand || 'Unknown',
      address: s.address?.label || '',
      lat,
      lon,
      prices,
      priceUpdatedAt: updatedAt,
      distanceM: distM,
    });
  }
  return stations;
}

// ── Source selection with automatic fallback ────────────────────────────────

function sourceOrder(apiKey) {
  if (forceSource) return [forceSource];
  return apiKey ? ['here', 'gasbuddy'] : ['gasbuddy'];
}

async function searchWithFallback(order, runSource) {
  const tried = [];
  for (const src of order) {
    if (pretty) process.stderr.write(`⛽ Trying ${src === 'gasbuddy' ? 'GasBuddy' : 'HERE'} for fuel prices...\n`);
    try {
      const stations = await runSource(src);
      if (stations.length > 0) return { stations, source: src, tried: [...tried, src] };
      tried.push(src);
      if (pretty) process.stderr.write(`  ⚠ ${src}: no priced stations, ${order.indexOf(src) < order.length - 1 ? 'falling back' : 'giving up'}\n`);
    } catch (err) {
      tried.push(src);
      if (pretty) process.stderr.write(`  ✗ ${src}: ${err.message}\n`);
    }
  }
  return { stations: [], source: null, tried };
}

// ── Main ────────────────────────────────────────────────────────────────────

function shapeNearStations(stations, topCount) {
  return stations
    .map(s => ({
      name: s.name,
      address: s.address,
      prices: s.prices,
      dieselPrice: s.prices.diesel ?? null,
      priceUpdatedAt: s.priceUpdatedAt,
      distanceMiles: Math.round(s.distanceM / 1609.34 * 10) / 10,
      lat: s.lat,
      lon: s.lon,
      googleMapsLink: mapsLink(s.lat, s.lon),
    }))
    .sort((a, b) => {
      const aDiesel = a.dieselPrice ?? Infinity;
      const bDiesel = b.dieselPrice ?? Infinity;
      if (aDiesel !== bDiesel) return aDiesel - bDiesel;
      return (a.prices.regular ?? Infinity) - (b.prices.regular ?? Infinity);
    })
    .slice(0, topCount);
}

function formatPrices(prices) {
  return Object.entries(prices).map(([k, v]) => `${k} $${v.toFixed(3)}`).join('  ');
}

async function main() {
  const apiKey = getApiKey();
  if (forceSource && !['here', 'gasbuddy'].includes(forceSource)) {
    console.error(`❌ Unknown source "${forceSource}" — use "here" or "gasbuddy".`);
    process.exit(1);
  }
  if (forceSource === 'here' && !apiKey) {
    console.error('❌ HERE source requested but HERE_API_KEY not set.');
    process.exit(1);
  }

  // A GPS-keyword destination implies near-me even without --near;
  // routing from GPS to GPS is meaningless.
  const nearMe = !destination || GPS_KEYWORD.test(destination);

  if (nearMode || nearMe) {
    let center;
    let gps = null;
    if (nearMe) {
      const pos = getCurrentPosition();
      gps = { ageSec: Math.round(pos.ageSec) };
      if (pos.ageSec > 3600) process.stderr.write(`⚠️  GPS data is ${Math.round(pos.ageSec / 60)} minutes old\n`);
      center = { lat: pos.lat, lon: pos.lon, label: 'current location', geocoder: 'gps' };
    } else {
      center = await resolvePlace(destination);
    }

    const nearRadius = corridorWidth > CORRIDOR_WIDTH ? corridorWidth : NEAR_RADIUS;
    const { stations, source, tried } = await searchWithFallback(sourceOrder(apiKey), (src) =>
      src === 'here'
        ? searchNearHere(center, nearRadius, apiKey)
        : searchNearGasBuddy(center, nearRadius),
    );
    const scored = shapeNearStations(stations, topN);

    if (pretty) {
      console.log(`\n📍 Stations near ${center.label} (${center.geocoder})\n`);
      if (!scored.length) console.log('No stations with pricing found.');
      scored.forEach((s, i) => {
        console.log(`${i + 1}. ${s.name}\n   💰 ${formatPrices(s.prices)}\n   📏 ${s.distanceMiles} mi away  |  📍 ${s.address}\n   🗺️  ${s.googleMapsLink}\n`);
      });
    } else {
      console.log(JSON.stringify({
        mode: nearMe ? 'near-me' : 'near',
        center,
        source,
        sourcesTried: tried,
        ...(gps ? { gps } : {}),
        ...(gps && gps.ageSec > 3600 ? { warning: 'GPS location is stale; tell the user before relying on it.' } : {}),
        stations: scored,
      }));
    }
    return;
  }

  const dest = await resolvePlace(destination);

  let pos;
  if (fromOverride) {
    pos = await resolvePlace(fromOverride); pos.ageSec = 0;
  } else {
    pos = getCurrentPosition();
    if (pos.ageSec > 3600) console.error(`⚠️  GPS data is ${Math.round(pos.ageSec / 60)} minutes old`);
  }

  const route = await getRoute(pos, dest);
  const routeMiles = (route.distanceM / 1609.34).toFixed(1);
  const routeHours = (route.durationS / 3600).toFixed(1);

  const routeIndex = buildRouteIndex(route.coords);
  const mapGasBuddy = (found) => found.map(s => {
    const projected = projectOntoRoute(s.lat, s.lon, routeIndex);
    return { ...s, source: 'gasbuddy', detourM: projected.detourM, alongM: projected.alongM, score: scoreStation(s.dieselPrice, projected.detourM) };
  });
  const mapHere = (found) => found.map(s => {
    const lat = s.position?.lat; const lon = s.position?.lng;
    if (!lat || !lon) return null;
    const diesel = getDieselPrice(s);
    const price = diesel?.price;
    if (!price || price <= 0) return null;
    const projected = projectOntoRoute(lat, lon, routeIndex);
    return {
      name: s.name || s.brand || 'Unknown',
      address: s.address?.label || '',
      lat,
      lon,
      dieselPrice: price,
      priceUpdatedAt: diesel.modified,
      fuelType: diesel.fuelType,
      fuelTypeName: diesel.fuelTypeName,
      unit: diesel.unit,
      currency: diesel.currency,
      source: 'here',
      detourM: projected.detourM,
      alongM: projected.alongM,
      score: scoreStation(price, projected.detourM),
    };
  }).filter(Boolean);

  // Query EVERY available source concurrently and merge. Each source has real
  // coverage holes (HERE misses many independents; GasBuddy misses some
  // branded stations); the old first-non-empty-wins fallback hid the richer
  // source whenever the first returned anything at all.
  const order = sourceOrder(apiKey);
  const attempts = await Promise.allSettled(order.map(async (src) => (
    src === 'gasbuddy'
      ? mapGasBuddy(await queryGasBuddyAlongRoute(route.coords))
      : mapHere(await queryHereFuelAlongRoute(route.coords, apiKey, corridorWidth))
  )));
  const tried = order;
  const sourcesUsed = [];
  const sourceErrors = [];
  let stations = [];
  attempts.forEach((attempt, i) => {
    if (attempt.status === 'fulfilled' && attempt.value.length > 0) {
      sourcesUsed.push(order[i]);
      stations.push(...attempt.value);
    } else if (attempt.status === 'rejected') {
      sourceErrors.push(`${order[i]}: ${attempt.reason?.message || attempt.reason}`);
    }
  });
  stations = mergeStations(stations);
  const source = sourcesUsed.join('+') || null;

  if (pretty) process.stderr.write(`🔍 Found ${stations.length} diesel stations\n`);
  const scored = stations
    .map(s => ({
      name: s.name,
      address: s.address,
      dieselPrice: Math.round(s.dieselPrice * 1000) / 1000,
      priceUpdatedAt: s.priceUpdatedAt,
      fuelType: s.fuelType,
      fuelTypeName: s.fuelTypeName,
      ...(s.unit ? { unit: s.unit } : {}),
      ...(s.currency ? { currency: s.currency } : {}),
      detourMiles: Math.round(s.detourM / 1609.34 * 10) / 10,
      detourMeters: Math.round(s.detourM),
      milesAhead: Math.round(s.alongM / 1609.34 * 10) / 10,
      ...(route.durationS > 0 && route.distanceM > 0
        ? { etaMinutes: Math.round(route.durationS * (s.alongM / route.distanceM) / 60) }
        : {}),
      priceSource: s.source,
      ...(s.otherSourcePrice ? { otherSourcePrice: s.otherSourcePrice, otherSource: s.otherSource } : {}),
      score: Math.round(s.score * 1000) / 1000,
      lat: s.lat,
      lon: s.lon,
      googleMapsLink: mapsLink(s.lat, s.lon),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, topN);

  const output = {
    route: { from: { lat: pos.lat, lon: pos.lon }, to: { lat: dest.lat, lon: dest.lon, label: dest.label }, miles: parseFloat(routeMiles), hours: parseFloat(routeHours), router: route.router },
    source,
    sources: sourcesUsed,
    sourcesTried: tried,
    ...(sourceErrors.length ? { sourceErrors } : {}),
    stations: scored,
  };
  if (pretty) {
    console.log(`\n🛣️  Route: ${routeMiles} miles, ~${routeHours} hours\n`);
    if (!scored.length) { console.log('No diesel stations with pricing found along this route.'); }
    else scored.forEach((s, i) => { console.log(`${i + 1}. ${s.name}\n   💰 $${s.dieselPrice.toFixed(3)}/gal  |  ➡️  ${s.milesAhead} mi ahead${s.etaMinutes != null ? ` (~${s.etaMinutes} min)` : ''}  |  🔀 ${s.detourMiles} mi off route\n   📍 ${s.address}\n   🗺️  ${s.googleMapsLink}\n`); });
  } else {
    console.log(JSON.stringify(output));
  }
}

main().catch(err => { console.error(`❌ ${err.message}`); process.exit(1); });
