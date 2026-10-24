# osrm_routing

OSRM (Open Source Routing Machine) — free driving distance and duration API. No API key required.

Tango agents should normally call the `driving_route` MCP tool instead of hand-building
OSRM URLs — the tool routes through HERE Router v8 (traffic-aware ETAs, `via` roads,
`passesThrough` towns) and only falls back to OSRM itself. Use the direct API format
below only when that tool is unavailable.

## Why use this

**Never estimate driving distances from coordinates.** Lat/lon math gives straight-line distance which underestimates mountain and winding routes by 20-40%. Always use a router for actual road distances.

**Known bias:** the public OSRM server has no traffic data and its rural-highway ETAs
run 20-50% high (measured 2026-06-10 vs HERE/Google). Treat raw OSRM durations as an
upper bound and say so when reporting them.

## API

### Point-to-point route
```
https://router.project-osrm.org/route/v1/driving/{from_lon},{from_lat};{to_lon},{to_lat}?overview=false
```

**Parameter order is `lon,lat`** (not lat,lon).

### Response
```json
{
  "routes": [{
    "distance": 142350.5,
    "duration": 5823.2
  }]
}
```
- `distance` — meters (divide by 1609.34 for miles)
- `duration` — seconds (divide by 3600 for hours)

### Multi-waypoint route
Chain coordinates with semicolons:
```
https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2};{lon3},{lat3}?overview=false
```
Returns total distance/duration for the full route through all waypoints in order.

## Usage rules

- Always use a router (the `driving_route` tool, or raw OSRM as last resort) when reporting distances or ETAs — no exceptions.
- When comparing route options, run each through the router separately.
- Pair with `location_read` for current-position routing.
- For fuel range calculations, use routed distance (not estimates) against tank capacity.
- Raw OSRM gives no route geometry context — do not name towns or stops as "on the route" from memory; use the `driving_route` tool's `passesThrough`/`via` output for that.
