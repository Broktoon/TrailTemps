/**
 * build-points-at.js
 *
 * Extracts true 5-mile GPS coordinates from trail.geojson and merges them
 * with the existing 10-mile points.json, producing a combined file with
 * points at every 5 miles (0, 5, 10, ..., 2185, 2190).
 *
 * Usage:
 *   node trails/appalachian-trail/tools/build-points-at.js
 *
 * Output:
 *   trails/appalachian-trail/data/points.json  (overwritten)
 *
 * State assignment for new 5-mile points uses the two surrounding 10-mile
 * anchor points (e.g. mile-5 inherits the state of mile-0 and mile-10;
 * if they match it uses that state; if they differ it uses the lower anchor).
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const POINTS_FILE = path.join(DATA_DIR, "points.json");
const GEOJSON_FILE = path.join(DATA_DIR, "trail.geojson");

// ─── Haversine distance (miles) ───────────────────────────────────────────────
function haversineMiles(lon1, lat1, lon2, lat2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ─── Load and flatten GeoJSON MultiLineString ─────────────────────────────────
function loadTrailCoords() {
  const geo = JSON.parse(fs.readFileSync(GEOJSON_FILE, "utf8"));
  const feature = geo.features?.[0] ?? geo;
  const segments = feature.geometry.type === "MultiLineString"
    ? feature.geometry.coordinates
    : [feature.geometry.coordinates];

  // Skip degenerate segments (< 10 points or zero-distance junction markers).
  // For the AT GeoJSON, segments 2 and 3 are 6-point and 8-point artifacts
  // at junction locations that cause phantom back-and-forth distance if included.
  const meaningful = segments.filter(seg => seg.length >= 10);

  // Flatten: join segments end-to-end, dropping the duplicate junction point
  // at the start of each subsequent segment (it equals the previous end point).
  const flat = [];
  for (let s = 0; s < meaningful.length; s++) {
    const seg = meaningful[s];
    const startIdx = s === 0 ? 0 : 1; // skip first coord on joining segments
    for (let i = startIdx; i < seg.length; i++) {
      flat.push({ lon: seg[i][0], lat: seg[i][1] });
    }
  }
  return flat;
}

// ─── Build cumulative distance array ──────────────────────────────────────────
function buildCumDist(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const d = haversineMiles(
      coords[i - 1].lon, coords[i - 1].lat,
      coords[i].lon,     coords[i].lat
    );
    cum.push(cum[i - 1] + d);
  }
  return cum;
}

// ─── Interpolate a point at a given distance along the trail ──────────────────
function interpolateAt(coords, cumDist, targetMiles) {
  const total = cumDist[cumDist.length - 1];
  if (targetMiles <= 0) return coords[0];
  if (targetMiles >= total) return coords[coords.length - 1];

  // Binary search for the segment containing targetMiles
  let lo = 0;
  let hi = cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= targetMiles) lo = mid;
    else hi = mid;
  }

  const segLen = cumDist[hi] - cumDist[lo];
  const t = segLen > 0 ? (targetMiles - cumDist[lo]) / segLen : 0;

  return {
    lat: coords[lo].lat + t * (coords[hi].lat - coords[lo].lat),
    lon: coords[lo].lon + t * (coords[hi].lon - coords[lo].lon),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  console.log("Loading trail geometry...");
  const trailCoords = loadTrailCoords();
  const cumDist     = buildCumDist(trailCoords);
  const geoTotalMiles = cumDist[cumDist.length - 1];
  console.log(`Trail GeoJSON total length: ${geoTotalMiles.toFixed(1)} miles`);
  console.log(`Coordinate points: ${trailCoords.length}`);

  console.log("\nLoading existing points.json...");
  const existing = JSON.parse(fs.readFileSync(POINTS_FILE, "utf8"));

  // Build a map of existing points by mile for fast lookup
  const existingByMile = new Map();
  for (const p of existing) {
    existingByMile.set(Number(p.mile), p);
  }

  // Build state map from existing 10-mile points (mile → state)
  const stateByMile = new Map();
  for (const p of existing) {
    stateByMile.set(Number(p.mile), p.state);
  }

  // The GeoJSON geometry may be longer than 2190 trail miles because it
  // includes approach trails or overlapping segments. Scale so that the
  // GeoJSON distance maps to the 2190-mile official trail length.
  const TRAIL_MILES = 2190;
  const scale = geoTotalMiles / TRAIL_MILES;
  console.log(`Scale factor (geo / trail): ${scale.toFixed(4)}`);

  // Generate all 5-mile interval miles
  const targetMiles = [];
  for (let m = 0; m <= TRAIL_MILES; m += 5) {
    targetMiles.push(m);
  }

  console.log(`\nGenerating ${targetMiles.length} points at 5-mile intervals...`);

  const allPoints = [];

  for (const mile of targetMiles) {
    // Use existing 10-mile point if available (accurate anchor)
    if (existingByMile.has(mile)) {
      allPoints.push(existingByMile.get(mile));
      continue;
    }

    // Interpolate new 5-mile point from GeoJSON geometry
    const geoMile = mile * scale;
    const coord   = interpolateAt(trailCoords, cumDist, geoMile);

    // Determine state: use lower anchor's state (mile-5 → state of mile-0)
    const lowerMile = mile - 5;
    const upperMile = mile + 5;
    const lowerState = stateByMile.get(lowerMile) ?? null;
    const upperState = stateByMile.get(upperMile) ?? null;
    const state = lowerState ?? upperState ?? "??";

    // Generate ID in standard format: at-main-mi0050000 for mile 5
    const mileInt = Math.round(mile * 1000);
    const id = `at-main-mi${String(mileInt).padStart(7, "0")}`;

    // Derive section from existing surrounding points
    const lowerPoint = existingByMile.get(lowerMile);
    const section = lowerPoint?.section ?? "";

    allPoints.push({
      id,
      state,
      section,
      lat: Math.round(coord.lat * 1e6) / 1e6,
      lon: Math.round(coord.lon * 1e6) / 1e6,
      mile,
    });
  }

  // Sort by mile
  allPoints.sort((a, b) => Number(a.mile) - Number(b.mile));

  console.log(`\nTotal points after merge: ${allPoints.length}`);
  console.log("Sample new 5-mile points:");
  allPoints
    .filter(p => Number(p.mile) % 10 !== 0)
    .slice(0, 5)
    .forEach(p => console.log(`  Mile ${p.mile}: ${p.lat}, ${p.lon}  state=${p.state}`));

  // Write output
  fs.writeFileSync(POINTS_FILE, JSON.stringify(allPoints, null, 2));
  console.log(`\nWrote ${allPoints.length} points to ${POINTS_FILE}`);
  console.log("Done.");
}

main();
