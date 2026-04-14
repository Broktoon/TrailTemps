#!/usr/bin/env node
/**
 * build-points-pct.js
 *
 * Builds points.json for the Pacific Crest Trail.
 *
 * Steps:
 *   1. Read Full_PCT_Simplified.geojson (single LineString, south→north)
 *   2. Interpolate waypoints at 5-mile intervals, scaled to official 2,653.0 miles
 *   3. Assign state (CA / OR / WA) from latitude
 *   4. Batch-fetch trail elevation from OpenTopoData (SRTM 90m) — 100 pts/req
 *   5. Write data/points.json
 *
 * Usage:
 *   node trails/pacific-crest-trail/tools/build-points-pct.js
 *
 * Data source:
 *   Pacific Crest Trail Association (PCTA) — https://www.pcta.org
 *   Elevation: OpenTopoData SRTM 90m — https://www.opentopodata.org
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Configuration ─────────────────────────────────────────────────────────────

const GEOJSON_PATH  = path.join(__dirname, '../data/Full_PCT_Simplified.geojson');
const OUTPUT_PATH   = path.join(__dirname, '../data/points.json');

const OFFICIAL_MILES  = 2653.0;   // PCTA official trail length
const INTERVAL_MILES  = 5.0;      // waypoint spacing
const ELEV_BATCH_SIZE = 100;      // OpenTopoData max locations per request
const ELEV_DELAY_MS   = 1100;     // ms between elevation batches (1 req/sec limit)

// Approximate latitude thresholds for state boundaries
// CA/OR border ~42.0°N (Siskiyou Summit area)
// OR/WA border ~45.65°N (Columbia River / Bridge of the Gods)
const LAT_CA_OR = 42.0;
const LAT_OR_WA = 45.65;

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversine(a, b) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function interpolateCoord(a, b, frac) {
  return [
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
  ];
}

function getState(lat) {
  if (lat < LAT_CA_OR) return 'CA';
  if (lat < LAT_OR_WA) return 'OR';
  return 'WA';
}

function padMile(mile) {
  // e.g. 1234.5 → "1234500" (thousandth-mile, 7 digits)
  return String(Math.round(mile * 1000)).padStart(7, '0');
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}\nBody: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Interpolation ─────────────────────────────────────────────────────────────

function interpolateWaypoints(coords, officialMiles, intervalMiles) {
  // Build cumulative segment distances along the raw geometry
  const segDists = [];
  let totalMeasured = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i]);
    segDists.push(d);
    totalMeasured += d;
  }

  const scaleF = officialMiles / totalMeasured;
  console.log(`  Measured distance : ${totalMeasured.toFixed(2)} miles`);
  console.log(`  Official distance : ${officialMiles} miles`);
  console.log(`  Scale factor      : ${scaleF.toFixed(6)}`);

  // Build list of target official miles
  const targetMiles = [];
  for (let m = 0; m <= officialMiles; m += intervalMiles) {
    targetMiles.push(parseFloat(m.toFixed(4)));
  }
  // Always include the exact terminus
  if (targetMiles[targetMiles.length - 1] < officialMiles) {
    targetMiles.push(officialMiles);
  }

  // Single forward-pass interpolation
  const waypoints = [];
  let segIdx  = 0;
  let accumulated = 0; // measured miles accumulated up to start of segIdx

  for (const targetMile of targetMiles) {
    const targetRaw = targetMile / scaleF; // convert official mile → measured mile

    // Advance segments until the current segment contains targetRaw
    while (segIdx < segDists.length - 1 && accumulated + segDists[segIdx] < targetRaw) {
      accumulated += segDists[segIdx];
      segIdx++;
    }

    let coord;
    if (segIdx >= segDists.length) {
      coord = coords[coords.length - 1];
    } else {
      const remaining = targetRaw - accumulated;
      const frac = segDists[segIdx] > 0
        ? Math.min(remaining / segDists[segIdx], 1.0)
        : 0;
      coord = interpolateCoord(coords[segIdx], coords[segIdx + 1] || coords[segIdx], frac);
    }

    waypoints.push({ mile: targetMile, coord });
  }

  return waypoints;
}

// ── Elevation fetch ───────────────────────────────────────────────────────────

async function fetchElevations(waypoints) {
  const elevations = new Array(waypoints.length).fill(null);
  const totalBatches = Math.ceil(waypoints.length / ELEV_BATCH_SIZE);

  for (let b = 0; b < totalBatches; b++) {
    const start = b * ELEV_BATCH_SIZE;
    const batch = waypoints.slice(start, start + ELEV_BATCH_SIZE);

    // OpenTopoData expects lat,lon order
    const locations = batch.map(w => `${w.coord[1].toFixed(6)},${w.coord[0].toFixed(6)}`).join('|');
    const url = `https://api.opentopodata.org/v1/srtm90m?locations=${locations}`;

    let attempt = 0;
    let result;
    while (attempt < 3) {
      try {
        result = await httpsGet(url);
        break;
      } catch (e) {
        attempt++;
        console.warn(`  Batch ${b + 1} attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await sleep(3000);
      }
    }

    if (!result || !result.results) {
      console.error(`  Batch ${b + 1} failed after 3 attempts — elevations will be null`);
    } else {
      for (let i = 0; i < result.results.length; i++) {
        const raw = result.results[i].elevation;
        // SRTM returns meters — convert to feet, round to nearest foot
        elevations[start + i] = raw != null ? Math.round(raw * 3.28084) : null;
      }
      const sample = result.results[0];
      console.log(`  Batch ${b + 1}/${totalBatches}: ${batch.length} pts — ` +
        `first point elev ${Math.round((sample.elevation || 0) * 3.28084)} ft ` +
        `(mile ${waypoints[start].mile})`);
    }

    if (b < totalBatches - 1) await sleep(ELEV_DELAY_MS);
  }

  return elevations;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== PCT build-points-pct.js ===\n');

  // 1. Read GeoJSON
  console.log('Reading Full_PCT_Simplified.geojson...');
  const geojson = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));
  const feature  = geojson.features[0];
  if (feature.geometry.type !== 'LineString') {
    throw new Error(`Expected LineString, got ${feature.geometry.type}`);
  }
  const coords = feature.geometry.coordinates; // [lon, lat]
  console.log(`  Loaded ${coords.length.toLocaleString()} coordinates`);
  console.log(`  Start: ${coords[0][1].toFixed(5)}°N, ${coords[0][0].toFixed(5)}°E (should be ~32.59 CA)`);
  console.log(`  End  : ${coords[coords.length-1][1].toFixed(5)}°N, ${coords[coords.length-1][0].toFixed(5)}°E (should be ~49.00 BC)`);

  // 2. Interpolate waypoints
  console.log(`\nInterpolating at ${INTERVAL_MILES}-mile intervals (official ${OFFICIAL_MILES} mi)...`);
  const waypoints = interpolateWaypoints(coords, OFFICIAL_MILES, INTERVAL_MILES);
  console.log(`  Generated ${waypoints.length} waypoints`);

  // Quick state count summary
  const stateCounts = { CA: 0, OR: 0, WA: 0 };
  for (const w of waypoints) stateCounts[getState(w.coord[1])]++;
  console.log(`  State distribution: CA=${stateCounts.CA}, OR=${stateCounts.OR}, WA=${stateCounts.WA}`);

  // 3. Fetch elevations from OpenTopoData
  console.log(`\nFetching elevations (OpenTopoData SRTM 90m, ${ELEV_BATCH_SIZE} pts/batch)...`);
  const elevations = await fetchElevations(waypoints);

  const nullCount = elevations.filter(e => e === null).length;
  if (nullCount > 0) console.warn(`  Warning: ${nullCount} points have null elevation`);

  const elevFt = elevations.filter(e => e !== null);
  console.log(`  Elevation range: ${Math.min(...elevFt)} ft – ${Math.max(...elevFt)} ft`);

  // 4. Build points array
  const points = waypoints.map((w, i) => ({
    id        : `pct-main-mi${padMile(w.mile)}`,
    mile      : w.mile,
    lat       : parseFloat(w.coord[1].toFixed(6)),
    lon       : parseFloat(w.coord[0].toFixed(6)),
    state     : getState(w.coord[1]),
    trail_elev: elevations[i],
  }));

  // 5. Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(points, null, 2), 'utf8');
  console.log(`\nWrote ${points.length} points to ${path.relative(process.cwd(), OUTPUT_PATH)}`);

  // Summary table
  console.log('\n── Sample points ──────────────────────────────────────────────────');
  const samples = [0, 10, 50, 100, Math.floor(points.length/2), points.length-2, points.length-1];
  for (const i of samples) {
    if (i < 0 || i >= points.length) continue;
    const p = points[i];
    console.log(`  Mile ${String(p.mile).padStart(7)}: ${p.state}  ${p.lat.toFixed(4)}°N  ${p.lon.toFixed(4)}°E  elev=${p.trail_elev ?? 'null'} ft`);
  }
  console.log('───────────────────────────────────────────────────────────────────');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
