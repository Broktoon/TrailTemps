#!/usr/bin/env node
/**
 * build-pnt-data.js
 * Builds trail.geojson, points.json, and pnt_meta.json for the Pacific Northwest Trail
 * from USFS ArcGIS FeatureServer data.
 *
 * Usage: node trails/pacific-northwest-trail/tools/build-pnt-data.js
 *
 * Data source:
 *   https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/
 *     Pacific_Northwest_National_Scenic_Trail/FeatureServer/0
 *
 * The USFS layer has 456 features / 1,217 geometry miles across 5 sections.
 * The MILES attribute is incomplete (~764 mi attributed); geometry distance
 * is used instead.
 *
 * Section mapping (USFS name → canonical slug):
 *   Rocky Mountains      → rocky-mountains    (MT, ID)  ~lon -117 to -113.7
 *   Northeast Washington → columbia-mountains  (WA)      ~lon -120 to -117
 *   North Cascades       → north-cascades      (WA)      ~lon -122 to -119.8
 *   Puget Sound          → puget-sound         (WA)      ~lon -122.8 to -121.9
 *   Olympic Peninsula    → olympic-peninsula   (WA)      ~lon -124.7 to -122.8
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── output paths ──────────────────────────────────────────────────────────────
const BASE = path.resolve(__dirname, '../data');
const OUT_GEOJSON = path.join(BASE, 'trail.geojson');
const OUT_POINTS  = path.join(BASE, 'points.json');
const OUT_META    = path.join(BASE, 'pnt_meta.json');
const CACHE_FILE  = path.join(BASE, '_raw_usfs.json');

// ── section definitions (USFS name → canonical) ───────────────────────────────
const SECTIONS = [
  { usfsName: 'Rocky Mountains',      id: 'rocky-mountains',    name: 'Rocky Mountains',    state: 'MT' },
  { usfsName: 'Northeast Washington', id: 'columbia-mountains',  name: 'Columbia Mountains', state: 'WA' },
  { usfsName: 'North Cascades',       id: 'north-cascades',      name: 'North Cascades',     state: 'WA' },
  { usfsName: 'Puget Sound',          id: 'puget-sound',         name: 'Puget Sound',        state: 'WA' },
  { usfsName: 'Olympic Peninsula',    id: 'olympic-peninsula',   name: 'Olympic Peninsula',  state: 'WA' },
];

// Ferry connector (Coupeville → Port Townsend, runs between Puget Sound and Olympic)
const FERRY = {
  from: [-122.6885, 48.2159],  // Coupeville, WA
  to:   [-122.7600, 48.1107],  // Port Townsend, WA
};

// ── haversine distance (miles) ────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) *
               Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function pathLen(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += haversine(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
  }
  return d;
}

// ── fetch with pagination ──────────────────────────────────────────────────────
async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAllFeatures() {
  if (fs.existsSync(CACHE_FILE)) {
    console.log('Using cached USFS data:', CACHE_FILE);
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }

  const BASE_URL = 'https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/' +
                   'Pacific_Northwest_National_Scenic_Trail/FeatureServer/0/query';
  const PARAMS   = '?where=1%3D1&outFields=FID,PNT_Sectio,State,MILES,RTE_NAME&' +
                   'returnGeometry=true&outSR=4326&f=json&resultRecordCount=500';

  console.log('Fetching USFS features…');
  const data = await fetchJSON(BASE_URL + PARAMS);
  console.log('  Got', data.features.length, 'features');

  // Write cache
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  return data;
}

// ── geometry helpers ───────────────────────────────────────────────────────────

/**
 * Given an array of ESRI polyline features (each with geometry.paths),
 * chain them into a single ordered sequence of [lon,lat] coordinates.
 *
 * Strategy: greedy nearest-endpoint chaining starting from the easternmost point.
 */
function chainSegments(features) {
  // Flatten each feature into a list of coordinate arrays (paths)
  const segments = [];
  features.forEach(f => {
    if (!f.geometry || !f.geometry.paths) return;
    f.geometry.paths.forEach(path => {
      if (path.length >= 2) segments.push(path.slice()); // [[lon,lat],...]
    });
  });

  if (segments.length === 0) return [];

  // Find the easternmost endpoint across all segments (max longitude = start of PNT, Chief Mtn)
  let startSegIdx = 0;
  let startFromEnd = false; // false = use segment[0], true = use segment[last]
  let maxLon = -999;

  segments.forEach((seg, i) => {
    const first = seg[0];
    const last  = seg[seg.length - 1];
    if (first[0] > maxLon) { maxLon = first[0]; startSegIdx = i; startFromEnd = false; }
    if (last[0]  > maxLon) { maxLon = last[0];  startSegIdx = i; startFromEnd = true;  }
  });

  // Orient starting segment east-first
  const used = new Set();
  let chain = startFromEnd ? segments[startSegIdx].slice().reverse() : segments[startSegIdx].slice();
  used.add(startSegIdx);

  const SNAP_THRESHOLD = 0.15; // miles — segments within this distance are considered connected

  let iterations = 0;
  while (used.size < segments.length) {
    iterations++;
    if (iterations > segments.length * 2) {
      console.warn('    Chain loop exceeded expected iterations — breaking');
      break;
    }

    const tail = chain[chain.length - 1];
    let   bestDist  = Infinity;
    let   bestIdx   = -1;
    let   bestReverse = false;

    segments.forEach((seg, i) => {
      if (used.has(i)) return;
      const dHead = haversine(tail[1], tail[0], seg[0][1], seg[0][0]);
      const dTail = haversine(tail[1], tail[0], seg[seg.length-1][1], seg[seg.length-1][0]);
      if (dHead < bestDist) { bestDist = dHead; bestIdx = i; bestReverse = false; }
      if (dTail < bestDist) { bestDist = dTail; bestIdx = i; bestReverse = true;  }
    });

    if (bestIdx === -1 || bestDist > 5.0) {
      // No close segment found — find next unconnected segment closest to current tail
      // This handles genuinely disconnected subsections
      let fallbackDist = Infinity;
      let fallbackIdx  = -1;
      let fallbackRev  = false;
      segments.forEach((seg, i) => {
        if (used.has(i)) return;
        const d1 = haversine(tail[1], tail[0], seg[0][1], seg[0][0]);
        const d2 = haversine(tail[1], tail[0], seg[seg.length-1][1], seg[seg.length-1][0]);
        if (d1 < fallbackDist) { fallbackDist = d1; fallbackIdx = i; fallbackRev = false; }
        if (d2 < fallbackDist) { fallbackDist = d2; fallbackIdx = i; fallbackRev = true;  }
      });
      if (fallbackIdx === -1) break;
      const seg = fallbackRev ? segments[fallbackIdx].slice().reverse() : segments[fallbackIdx].slice();
      chain = chain.concat(seg);
      used.add(fallbackIdx);
    } else {
      const seg = bestReverse ? segments[bestIdx].slice().reverse() : segments[bestIdx].slice();
      // Skip the first point if it's very close to current tail (avoid duplicates)
      if (haversine(tail[1], tail[0], seg[0][1], seg[0][0]) < 0.001) {
        chain = chain.concat(seg.slice(1));
      } else {
        chain = chain.concat(seg);
      }
      used.add(bestIdx);
    }
  }

  return chain;
}

/**
 * Interpolate a coordinate at a given distance along a polyline.
 */
function interpolateAt(coords, targetDist) {
  let accumulated = 0;
  for (let i = 1; i < coords.length; i++) {
    const segLen = haversine(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
    if (accumulated + segLen >= targetDist) {
      const frac = (targetDist - accumulated) / segLen;
      const lon  = coords[i-1][0] + frac * (coords[i][0] - coords[i-1][0]);
      const lat  = coords[i-1][1] + frac * (coords[i][1] - coords[i-1][1]);
      return [lon, lat];
    }
    accumulated += segLen;
  }
  // Past end — return last point
  return coords[coords.length - 1];
}

/**
 * Given the full chained trail (all sections merged east→west),
 * return the cumulative mile at which each section ends.
 */
function computeSectionMileBounds(sectionChains) {
  let cumulMile = 0;
  return sectionChains.map(chain => {
    const secMiles = pathLen(chain);
    const start    = cumulMile;
    cumulMile     += secMiles;
    return { start: Math.round(start * 1000) / 1000, end: Math.round(cumulMile * 1000) / 1000, miles: secMiles };
  });
}

// ── state lookup by longitude ─────────────────────────────────────────────────
// PNT states (east to west): MT, ID, WA
// Approximate borders:
//   MT/ID border near lon -116.05 (north Idaho panhandle / Glacier NP area)
//   ID/WA border near lon -117.04
function stateFromLon(lon) {
  if (lon > -116.1) return 'MT';
  if (lon > -117.05) return 'ID';
  return 'WA';
}

// Section from cumulative mile
function sectionFromMile(mile, bounds) {
  for (let i = 0; i < bounds.length; i++) {
    if (mile <= bounds[i].end + 0.001) return SECTIONS[i].id;
  }
  return SECTIONS[SECTIONS.length - 1].id;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(BASE, { recursive: true });

  // 1. Fetch data
  const raw = await fetchAllFeatures();
  const feats = raw.features;
  console.log(`Total features: ${feats.length}`);

  // 2. Split by section and chain each section
  console.log('\nChaining sections…');
  const sectionChains = [];
  SECTIONS.forEach(sec => {
    const secFeats = feats.filter(f => f.attributes.PNT_Sectio === sec.usfsName);
    console.log(`  ${sec.name}: ${secFeats.length} features`);
    const chain = chainSegments(secFeats);
    console.log(`    → ${chain.length} coords, ${pathLen(chain).toFixed(2)} miles`);
    sectionChains.push(chain);
  });

  // 3. Build full trail coordinate sequence (east → west, all sections)
  const fullTrail = sectionChains.reduce((acc, chain) => acc.concat(chain), []);
  const totalMiles = pathLen(fullTrail);
  console.log(`\nFull trail: ${fullTrail.length} coords, ${totalMiles.toFixed(2)} miles`);

  // 4. Compute section mile bounds
  const bounds = computeSectionMileBounds(sectionChains);
  SECTIONS.forEach((sec, i) => {
    console.log(`  ${sec.name}: miles ${bounds[i].start.toFixed(2)} – ${bounds[i].end.toFixed(2)} (${bounds[i].miles.toFixed(2)} mi)`);
  });

  // ── Build trail.geojson ────────────────────────────────────────────────────
  console.log('\nBuilding trail.geojson…');
  const geojsonFeatures = [];

  // One feature per section
  SECTIONS.forEach((sec, i) => {
    geojsonFeatures.push({
      type: 'Feature',
      properties: {
        section:      sec.id,
        segment_type: 'trail',
        name:         sec.name,
      },
      geometry: {
        type:        'LineString',
        coordinates: sectionChains[i],
      },
    });
  });

  // Ferry connector
  geojsonFeatures.push({
    type: 'Feature',
    properties: {
      segment_type: 'ferry',
      name:         'Puget Sound Ferry (Coupeville → Port Townsend)',
    },
    geometry: {
      type:        'LineString',
      coordinates: [FERRY.from, FERRY.to],
    },
  });

  const geojson = { type: 'FeatureCollection', features: geojsonFeatures };
  fs.writeFileSync(OUT_GEOJSON, JSON.stringify(geojson));
  console.log('  Written:', OUT_GEOJSON);

  // ── Build points.json ──────────────────────────────────────────────────────
  console.log('\nBuilding points.json (5-mile intervals)…');
  const points = [];

  // Build cumulative distance array for the full trail
  // We'll iterate through sections, tracking cumulative mile offset
  let cumulBase = 0;

  for (let si = 0; si < SECTIONS.length; si++) {
    const chain   = sectionChains[si];
    const secLen  = pathLen(chain);
    const secEnd  = cumulBase + secLen;

    // Which 5-mile marks fall in this section?
    const firstMark = Math.ceil(cumulBase / 5) * 5;
    const marks = [];
    for (let m = firstMark; m <= secEnd + 0.001; m += 5) {
      marks.push(Math.round(m * 1000) / 1000);
    }

    marks.forEach(axisMile => {
      const localDist = axisMile - cumulBase;
      if (localDist < 0 || localDist > secLen + 0.001) return;
      const coord = interpolateAt(chain, Math.min(localDist, secLen));
      const lon   = Math.round(coord[0] * 1e6) / 1e6;
      const lat   = Math.round(coord[1] * 1e6) / 1e6;
      const mileInt = Math.round(axisMile * 1000); // thousandths
      const id = `pnt-main-mi${String(mileInt).padStart(7, '0')}`;
      points.push({
        id,
        mile:    axisMile,
        section: SECTIONS[si].id,
        state:   stateFromLon(lon),
        lat,
        lon,
      });
    });

    cumulBase = secEnd;
  }

  // Add terminus point (actual trail end) if not already at a 5-mile mark
  const lastMark = points[points.length - 1].mile;
  const totalRounded = Math.round(totalMiles * 1000) / 1000;
  if (totalRounded - lastMark > 0.1) {
    const termCoord = fullTrail[fullTrail.length - 1];
    const mileInt   = Math.round(totalRounded * 1000);
    points.push({
      id:      `pnt-main-mi${String(mileInt).padStart(7, '0')}`,
      mile:    totalRounded,
      section: SECTIONS[SECTIONS.length - 1].id,
      state:   'WA',
      lat:     Math.round(termCoord[1] * 1e6) / 1e6,
      lon:     Math.round(termCoord[0] * 1e6) / 1e6,
    });
  }

  console.log(`  ${points.length} points generated`);
  fs.writeFileSync(OUT_POINTS, JSON.stringify(points, null, 2));
  console.log('  Written:', OUT_POINTS);

  // ── Build pnt_meta.json ────────────────────────────────────────────────────
  console.log('\nBuilding pnt_meta.json…');
  const totalMilesRounded = Math.round(totalMiles * 100) / 100;

  const sections = SECTIONS.map((sec, i) => ({
    id:        sec.id,
    name:      sec.name,
    state:     sec.state,
    mile_start: Math.round(bounds[i].start * 100) / 100,
    mile_end:   Math.round(bounds[i].end   * 100) / 100,
  }));

  const meta = {
    trail: {
      name:             'Pacific Northwest Trail',
      total_trail_miles: totalMilesRounded,
      map_center:       [48.2, -119.5],
      map_zoom:         6,
      termini: {
        east: 'Chief Mountain, MT (Glacier NP)',
        west: 'Cape Alava / Shi Shi Beach, WA',
      },
      ferry: {
        name:     'Puget Sound Ferry',
        crossing: 'Coupeville → Port Townsend',
        note:     '~30 min crossing; no hiking miles added',
      },
    },
    sections,
    direction_options: [
      {
        id:         'eabo',
        label:      'Eastbound — Chief Mountain, MT → Cape Alava, WA',
        total_miles: totalMilesRounded,
        is_eabo:    true,
      },
      {
        id:         'wabo',
        label:      'Westbound — Cape Alava, WA → Chief Mountain, MT',
        total_miles: totalMilesRounded,
        is_eabo:    false,
      },
    ],
  };

  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2));
  console.log('  Written:', OUT_META);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== Done ===');
  console.log(`Total trail miles (geometry): ${totalMilesRounded}`);
  console.log(`Points generated:             ${points.length}`);
  console.log(`GeoJSON features:             ${geojsonFeatures.length} (${SECTIONS.length} sections + 1 ferry)`);
  console.log('\nSection mile ranges:');
  SECTIONS.forEach((sec, i) => {
    console.log(`  ${sec.name.padEnd(22)}: ${bounds[i].start.toFixed(1).padStart(7)} – ${bounds[i].end.toFixed(1).padStart(7)} mi`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
