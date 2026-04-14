#!/usr/bin/env node
/**
 * build-geojson-pct.js
 *
 * Converts Full_PCT_Simplified.geojson into the TrailTemps standard
 * trail.geojson format: a FeatureCollection of 5 section LineStrings,
 * each with { section, segment_type, name } properties.
 *
 * PCT geographic sections (official miles):
 *   Southern California   0    – 702
 *   Sierra Nevada         702  – 1,092
 *   Northern California   1,092 – 1,702
 *   Oregon                1,702 – 2,147
 *   Washington            2,147 – 2,653
 *
 * Usage:
 *   node trails/pacific-crest-trail/tools/build-geojson-pct.js
 *
 * Data source: Pacific Crest Trail Association (PCTA) — https://www.pcta.org
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const GEOJSON_IN  = path.join(__dirname, '../data/Full_PCT_Simplified.geojson');
const GEOJSON_OUT = path.join(__dirname, '../data/trail.geojson');
const OFFICIAL_MILES = 2653.0;

// ── Section definitions (official mile boundaries) ────────────────────────────
const SECTIONS = [
  { id: 'socal',      name: 'Southern California',  start:    0, end:  702 },
  { id: 'central-cal', name: 'Central California',   start:  702, end: 1092 },
  { id: 'norcal',     name: 'Northern California',   start: 1092, end: 1702 },
  { id: 'oregon',     name: 'Oregon',                start: 1702, end: 2147 },
  { id: 'washington', name: 'Washington',            start: 2147, end: 2653 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversine(a, b) {
  const R = 3958.8;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function interpolateCoord(a, b, frac) {
  return [
    parseFloat((a[0] + (b[0] - a[0]) * frac).toFixed(7)),
    parseFloat((a[1] + (b[1] - a[1]) * frac).toFixed(7)),
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('=== PCT build-geojson-pct.js ===\n');

  // 1. Read source
  console.log('Reading Full_PCT_Simplified.geojson...');
  const geojson = JSON.parse(fs.readFileSync(GEOJSON_IN, 'utf8'));
  const coords  = geojson.features[0].geometry.coordinates; // [lon, lat]
  console.log(`  ${coords.length.toLocaleString()} source coordinates`);

  // 2. Build cumulative measured distances
  let totalMeasured = 0;
  const cumDist = [0]; // cumDist[i] = measured miles from start to coords[i]
  for (let i = 1; i < coords.length; i++) {
    totalMeasured += haversine(coords[i - 1], coords[i]);
    cumDist.push(totalMeasured);
  }
  const scaleF = OFFICIAL_MILES / totalMeasured;
  console.log(`  Measured: ${totalMeasured.toFixed(2)} mi  |  Official: ${OFFICIAL_MILES} mi  |  Scale: ${scaleF.toFixed(6)}`);

  // 3. Find the coordinate index (and interpolated boundary point) for a given
  //    official mile position — binary search on cumDist.
  function coordAtOfficialMile(officialMile) {
    const targetRaw = officialMile / scaleF;
    if (targetRaw <= 0)              return { idx: 0, coord: coords[0], frac: 0 };
    if (targetRaw >= totalMeasured)  return { idx: coords.length - 1, coord: coords[coords.length - 1], frac: 1 };

    // Binary search for the segment containing targetRaw
    let lo = 0, hi = cumDist.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumDist[mid] <= targetRaw) lo = mid; else hi = mid - 1;
    }
    const segLen = cumDist[lo + 1] - cumDist[lo];
    const frac   = segLen > 0 ? (targetRaw - cumDist[lo]) / segLen : 0;
    const coord  = interpolateCoord(coords[lo], coords[lo + 1], frac);
    return { idx: lo, coord, frac };
  }

  // 4. Slice geometry into sections
  const features = [];

  for (const sec of SECTIONS) {
    const startInfo = coordAtOfficialMile(sec.start);
    const endInfo   = coordAtOfficialMile(sec.end);

    // Collect all raw coords strictly between the boundary indices,
    // then bookend with the interpolated boundary coords.
    const sectionCoords = [];

    // Add interpolated start boundary
    sectionCoords.push(startInfo.coord);

    // Add all whole coords that fall strictly inside [startIdx+1 … endIdx]
    const innerStart = startInfo.idx + 1;
    const innerEnd   = endInfo.idx;     // inclusive
    for (let i = innerStart; i <= innerEnd && i < coords.length; i++) {
      sectionCoords.push([
        parseFloat(coords[i][0].toFixed(7)),
        parseFloat(coords[i][1].toFixed(7)),
      ]);
    }

    // Add interpolated end boundary (avoid duplicate if frac==0 and already added)
    const lastAdded = sectionCoords[sectionCoords.length - 1];
    if (lastAdded[0] !== endInfo.coord[0] || lastAdded[1] !== endInfo.coord[1]) {
      sectionCoords.push(endInfo.coord);
    }

    console.log(`  ${sec.name.padEnd(22)}: ${sectionCoords.length.toLocaleString()} coords  (miles ${sec.start}–${sec.end})`);

    features.push({
      type: 'Feature',
      properties: {
        section:      sec.id,
        segment_type: 'trail',
        name:         sec.name,
        mile_start:   sec.start,
        mile_end:     sec.end,
      },
      geometry: {
        type:        'LineString',
        coordinates: sectionCoords,
      },
    });
  }

  // 5. Verify continuity — each section's last coord should match next section's first
  console.log('\nContinuity check:');
  for (let i = 0; i < features.length - 1; i++) {
    const a = features[i].geometry.coordinates;
    const b = features[i + 1].geometry.coordinates;
    const last  = a[a.length - 1];
    const first = b[0];
    const gap = haversine(last, first) * 5280; // feet
    console.log(`  ${SECTIONS[i].name} → ${SECTIONS[i+1].name}: gap = ${gap.toFixed(1)} ft`);
  }

  // 6. Write output
  const out = { type: 'FeatureCollection', features };
  fs.writeFileSync(GEOJSON_OUT, JSON.stringify(out, null, 2), 'utf8');

  const sizeMB = (fs.statSync(GEOJSON_OUT).size / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${features.length} features to ${path.relative(process.cwd(), GEOJSON_OUT)} (${sizeMB} MB)`);
}

main();
