#!/usr/bin/env node
/**
 * build-points-cdt.js
 *
 * Builds trail.geojson, points.json, and cdt_meta.json for the Continental Divide Trail.
 *
 * Data sources:
 *   USFS ArcGIS FeatureServer — main route + RMNP Loop + Chief Mountain alternates
 *     https://services1.arcgis.com/gGHDlz6USftL5Pau/.../ContinentalDivideNST/FeatureServer/0
 *   OpenStreetMap Overpass API — Gila River (7917427), Anaconda Cutoff (8107272), Spotted Bear (8034122)
 *   OpenTopoData SRTM 90m — trail elevation for all points
 *
 * Direction convention: NOBO = Antelope Wells, NM (mile 0) → Waterton Lake, MT/AB
 * States assigned by latitude: NM (<37°) → CO (<41°) → WY (<45°) → MT
 *
 * Usage: node trails/continental-divide-trail/tools/build-points-cdt.js
 *
 * After running, copy CDT_STATES_BOOTSTRAP values printed to console into index.html.
 * Cache files (_raw_arcgis.json, _raw_osm_*.json) are saved in data/ — delete to force re-fetch.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Output paths ───────────────────────────────────────────────────────────────
const BASE          = path.resolve(__dirname, '../data');
const OUT_POINTS    = path.join(BASE, 'points.json');
const OUT_GEOJSON   = path.join(BASE, 'trail.geojson');       // thinned (20m), used by site
const OUT_GEOJSON_HIRES = path.join(BASE, 'trail_hires.geojson'); // full resolution, for future use
const OUT_META      = path.join(BASE, 'cdt_meta.json');
const ARCGIS_CACHE  = path.join(BASE, '_raw_arcgis.json');

// ── ArcGIS source ──────────────────────────────────────────────────────────────
const ARCGIS_URL =
  'https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/' +
  'ContinentalDivideNST/FeatureServer/0/query' +
  '?where=1%3D1&outFields=Label&returnGeometry=true&outSR=4326&f=json';

// ArcGIS feature Label values
const LABEL_MAIN      = 'CDT Primary Route';
const LABEL_RMNP      = 'Rocky Mountain National Park Loop Alternate';
const LABEL_CHIEF_MTN = 'Chief Mountain Border Crossing Alternate';

// ── OSM Overpass alternates ────────────────────────────────────────────────────
// Multiple endpoints tried in order if one is overloaded.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const OSM_ALTS = [
  // maxGapMi:   stop stitching when the next OSM way endpoint is farther than this.
  // trimStepMi: after stitching, split on any step > this distance and keep the
  //             longest continuous segment. Removes errant straight-line artifacts
  //             caused by badly-ordered ways in a relation.
  // splitStepMi: after stitching, split the chain at any step > this distance and write each
  //              valid segment as a separate GeoJSON Feature. Use this (instead of trimStepMi)
  //              when you want to preserve all legitimate segments rather than keep only the longest.
  { id: 'gila',         label: 'Gila River Route',                       relation: 7917427, state: 'NM', maxGapMi: 1.0,  trimStepMi: null, splitStepMi: null },
  { id: 'rmnp',         label: 'RMNP Loop (North Inlet / Tonahutu Cr)', relation: 6747529, state: 'CO', maxGapMi: 2.0,  trimStepMi: null, splitStepMi: 0.5  },
  { id: 'anaconda',     label: 'Anaconda Cutoff',                        relation: 8107272, state: 'MT', maxGapMi: 5.0,  trimStepMi: null, splitStepMi: null },
  { id: 'spotted-bear', label: 'Spotted Bear Route',                     relation: 8034122, state: 'MT', maxGapMi: 10.0, trimStepMi: null, splitStepMi: 0.5  },
];

// ── State boundaries (NOBO, south→north, by latitude) ─────────────────────────
// Idaho (near Yellowstone) is absorbed into WY for weather-planner purposes.
const STATES = [
  { id: 'NM', name: 'New Mexico', maxLat: 37.0 },
  { id: 'CO', name: 'Colorado',   maxLat: 41.0 },
  { id: 'WY', name: 'Wyoming',    maxLat: 45.0 },
  { id: 'MT', name: 'Montana',    maxLat: 99.0 },
];

// Southern terminus — used to orient the main chain S→N
const ANTELOPE_WELLS = { lat: 31.335, lon: -108.534 };

// ── Elevation config ───────────────────────────────────────────────────────────
const ELEV_BATCH = 100;  // OpenTopoData max locations per request
const ELEV_DELAY = 1100; // ms between batches (1 req/sec limit)

// ── Max step filter for path chaining (drops ArcGIS teleport artifacts) ────────
const MAX_STEP_MI = 20.0;

// ── Haversine distance (miles) ─────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
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

// ── Network helpers ────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'TrailTemps-build/1.0 (trail weather planner)',
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (raw.trimStart().startsWith('<')) {
          // HTML response = server overloaded / rate-limited
          const err = new Error('Overpass returned HTML (server overloaded)');
          err.overloaded = true;
          return reject(err);
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Overpass timeout')); });
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── ArcGIS fetch ───────────────────────────────────────────────────────────────
async function fetchArcGIS() {
  if (fs.existsSync(ARCGIS_CACHE)) {
    console.log('Using cached ArcGIS data:', ARCGIS_CACHE);
    return JSON.parse(fs.readFileSync(ARCGIS_CACHE, 'utf8'));
  }
  console.log('Fetching CDT features from ArcGIS…');
  const data = await fetchJSON(ARCGIS_URL);
  console.log(`  Got ${data.features.length} features`);
  data.features.forEach(f => console.log(`    Label: "${f.attributes.Label}"`));
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(ARCGIS_CACHE, JSON.stringify(data));
  return data;
}

// ── OSM Overpass fetch (with retry across multiple endpoints) ──────────────────
async function fetchOSMRelation(alt) {
  const cacheFile = path.join(BASE, `_raw_osm_${alt.id}.json`);
  if (fs.existsSync(cacheFile)) {
    console.log(`  Using cached OSM data: ${cacheFile}`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  console.log(`  Fetching OSM relation ${alt.relation} (${alt.label})…`);
  // Use >>; to recurse into sub-relations (some CDT alternates are structured as nested relations).
  const ql   = `[out:json][timeout:180];relation(${alt.relation});>>;out geom qt;`;
  const body = 'data=' + encodeURIComponent(ql);

  for (let attempt = 0; attempt < OVERPASS_URLS.length * 2; attempt++) {
    const endpoint = OVERPASS_URLS[attempt % OVERPASS_URLS.length];
    try {
      console.log(`    Trying ${endpoint} (attempt ${attempt + 1})…`);
      const data = await fetchPost(endpoint, body);
      const ways = (data.elements || []).filter(e => e.type === 'way' && Array.isArray(e.geometry));
      console.log(`    ${ways.length} ways received from ${endpoint}`);
      fs.mkdirSync(BASE, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(ways));
      return ways;
    } catch (err) {
      if (err.overloaded) {
        const delaySec = attempt < 3 ? 30 : 60;
        console.warn(`    Server overloaded — waiting ${delaySec}s before retry…`);
        await sleep(delaySec * 1000);
      } else {
        console.warn(`    Error: ${err.message}`);
        if (attempt < OVERPASS_URLS.length * 2 - 1) {
          await sleep(10000);
        } else {
          throw err;
        }
      }
    }
  }
  throw new Error(`Failed to fetch OSM relation ${alt.relation} after all retries`);
}

// ── Chain an array of [lon,lat] paths into one continuous polyline ─────────────
// Drops paths with internal steps > MAX_STEP_MI (ArcGIS artifact filter).
// Uses greedy nearest-endpoint stitching.
// maxGapMi: stop stitching if the nearest unused segment endpoint is farther than
//   this distance. Prevents distant errant ways from being dragged in and creating
//   straight-line artifacts. Use Infinity (default) for ArcGIS spine chains;
//   use a small value (e.g. 0.5) for OSM alternate ways.
function chainPaths(allPaths, maxGapMi = Infinity) {
  const segs = [];
  let dropped = 0;
  allPaths.forEach(p => {
    if (!p || p.length < 2) return;
    let bad = false;
    for (let i = 1; i < p.length; i++) {
      if (haversine(p[i-1][1], p[i-1][0], p[i][1], p[i][0]) > MAX_STEP_MI) {
        bad = true; break;
      }
    }
    if (bad) { dropped++; return; }
    segs.push(p.slice());
  });
  if (dropped) console.log(`    (dropped ${dropped} paths with step > ${MAX_STEP_MI} mi)`);
  if (!segs.length) return [];

  const used  = new Set([0]);
  let chain   = segs[0].slice();

  while (used.size < segs.length) {
    const tail = chain[chain.length - 1];
    let bestDist = Infinity, bestIdx = -1, bestRev = false;
    segs.forEach((seg, i) => {
      if (used.has(i)) return;
      const d1 = haversine(tail[1], tail[0], seg[0][1],               seg[0][0]);
      const d2 = haversine(tail[1], tail[0], seg[seg.length-1][1], seg[seg.length-1][0]);
      if (d1 < bestDist) { bestDist = d1; bestIdx = i; bestRev = false; }
      if (d2 < bestDist) { bestDist = d2; bestIdx = i; bestRev = true;  }
    });
    if (bestIdx === -1) break;
    if (bestDist > maxGapMi) {
      console.log(`    (stopped stitching: next segment is ${bestDist.toFixed(2)} mi away, maxGapMi=${maxGapMi})`);
      break;
    }
    const seg = bestRev ? segs[bestIdx].slice().reverse() : segs[bestIdx].slice();
    const gap = haversine(tail[1], tail[0], seg[0][1], seg[0][0]);
    chain = gap < 0.001 ? chain.concat(seg.slice(1)) : chain.concat(seg);
    used.add(bestIdx);
  }

  return chain;
}

// Split a chain on any step > maxStepMi; return the longest continuous segment.
// Used to remove errant straight-line artifacts from poorly-ordered OSM relations.
function longestContinuousSegment(chain, maxStepMi) {
  const segments = [];
  let current = [chain[0]];
  for (let i = 1; i < chain.length; i++) {
    const step = haversine(chain[i-1][1], chain[i-1][0], chain[i][1], chain[i][0]);
    if (step > maxStepMi) {
      if (current.length >= 2) segments.push(current);
      current = [chain[i]];
    } else {
      current.push(chain[i]);
    }
  }
  if (current.length >= 2) segments.push(current);
  if (!segments.length) return chain;
  segments.sort((a, b) => pathLen(b) - pathLen(a));
  const kept = segments[0];
  if (segments.length > 1) {
    console.log(`    (trimStepMi: kept longest segment ${pathLen(kept).toFixed(1)} mi, discarded ${segments.length - 1} shorter segment(s))`);
  }
  return kept;
}

// Thin a coordinate array to a minimum spacing (in meters) by skipping vertices
// that are closer than minDistM to the last kept vertex. Always keeps first and last.
// Applied to main spine only — alternate routes are already at OSM resolution.
function thinCoords(coords, minDistM) {
  if (coords.length <= 2) return coords;
  const minDistMi = minDistM / 1609.34;
  const kept = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const last = kept[kept.length - 1];
    if (haversine(last[1], last[0], coords[i][1], coords[i][0]) >= minDistMi) {
      kept.push(coords[i]);
    }
  }
  kept.push(coords[coords.length - 1]);
  return kept;
}

// Split a chain at any step > maxStepMi and return ALL valid segments (unlike
// longestContinuousSegment which discards all but the longest). Used for RMNP where
// OSM coverage has gaps but all legitimate segments should appear on the map.
function splitContinuousSegments(chain, maxStepMi) {
  const segments = [];
  let current = [chain[0]];
  for (let i = 1; i < chain.length; i++) {
    const step = haversine(chain[i-1][1], chain[i-1][0], chain[i][1], chain[i][0]);
    if (step > maxStepMi) {
      if (current.length >= 2) segments.push(current);
      current = [chain[i]];
    } else {
      current.push(chain[i]);
    }
  }
  if (current.length >= 2) segments.push(current);
  const totalMi = segments.reduce((s, seg) => s + pathLen(seg), 0);
  console.log(`    (splitStepMi: split into ${segments.length} segment(s), total ${totalMi.toFixed(1)} mi)`);
  return segments.length ? segments : [chain];
}

// Convert OSM way array to chainPaths-compatible paths then chain.
// maxGapMi controls when to stop stitching (see OSM_ALTS entries for per-alternate values).
// trimStepMi, if set, removes errant artifact segments after stitching.
function chainOSMWays(ways, maxGapMi = 0.5, trimStepMi = null) {
  const allPaths = ways
    .filter(w => w.geometry && w.geometry.length >= 2)
    .map(w => w.geometry.map(n => [n.lon, n.lat]));
  let chain = chainPaths(allPaths, maxGapMi);
  if (trimStepMi != null && chain.length >= 2) {
    chain = longestContinuousSegment(chain, trimStepMi);
  }
  return chain;
}

// Orient a chain so the end closest to the southern terminus comes first (NOBO).
function orientNOBO(chain) {
  const dFirst = haversine(ANTELOPE_WELLS.lat, ANTELOPE_WELLS.lon, chain[0][1],               chain[0][0]);
  const dLast  = haversine(ANTELOPE_WELLS.lat, ANTELOPE_WELLS.lon, chain[chain.length-1][1], chain[chain.length-1][0]);
  return dFirst <= dLast ? chain : chain.slice().reverse();
}

// ── Interpolate a coordinate at targetDist miles along a polyline ──────────────
function interpolateAt(coords, targetDist) {
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversine(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
    if (acc + seg >= targetDist) {
      const frac = seg > 0 ? (targetDist - acc) / seg : 0;
      return [
        coords[i-1][0] + frac * (coords[i][0] - coords[i-1][0]),
        coords[i-1][1] + frac * (coords[i][1] - coords[i-1][1]),
      ];
    }
    acc += seg;
  }
  return coords[coords.length - 1].slice();
}

// ── State from latitude ────────────────────────────────────────────────────────
function stateFromLat(lat) {
  for (const s of STATES) { if (lat < s.maxLat) return s.id; }
  return 'MT';
}

// ── Find the spine mile nearest to a given lat/lon ────────────────────────────
function nearestSpineMile(spinePoints, lat, lon) {
  let bestDist = Infinity, bestMile = 0;
  for (const p of spinePoints) {
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < bestDist) { bestDist = d; bestMile = p.mile; }
  }
  return bestMile;
}

// ── SRTM elevation fetch (OpenTopoData) ───────────────────────────────────────
async function fetchElevations(coords) {
  const elevs       = new Array(coords.length).fill(null);
  const totalBatches = Math.ceil(coords.length / ELEV_BATCH);

  for (let b = 0; b < totalBatches; b++) {
    const start = b * ELEV_BATCH;
    const batch = coords.slice(start, start + ELEV_BATCH);
    const locs  = batch.map(c => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`).join('|');
    const url   = `https://api.opentopodata.org/v1/srtm90m?locations=${locs}`;

    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await fetchJSON(url); break; }
      catch (e) {
        console.warn(`    Batch ${b+1} attempt ${attempt+1} failed: ${e.message}`);
        if (attempt < 2) await sleep(3000);
      }
    }
    if (result?.results) {
      result.results.forEach((r, i) => {
        elevs[start + i] = r.elevation != null ? Math.round(r.elevation * 3.28084) : null;
      });
      const firstElev = Math.round((result.results[0]?.elevation ?? 0) * 3.28084);
      console.log(`  Elev batch ${b+1}/${totalBatches}: done (first=${firstElev} ft, coord ${start})`);
    } else {
      console.warn(`  Elev batch ${b+1} FAILED — elevations null for coords ${start}–${start + batch.length - 1}`);
    }
    if (b < totalBatches - 1) await sleep(ELEV_DELAY);
  }
  return elevs;
}

// ── Build alt points at 5-mile intervals ──────────────────────────────────────
function buildAltPoints(altId, chain, altLen) {
  const points = [];
  for (let m = 0; m <= altLen + 0.001; m += 5) {
    const altMile = Math.round(m * 1000) / 1000;
    if (altMile > altLen + 0.001) break;
    const coord   = interpolateAt(chain, Math.min(altMile, altLen));
    const mileInt = Math.round(altMile * 1000);
    points.push({
      id:       `cdt-${altId}-mi${String(mileInt).padStart(7, '0')}`,
      alt_id:   altId,
      alt_mile: altMile,
      lat:      Math.round(coord[1] * 1e6) / 1e6,
      lon:      Math.round(coord[0] * 1e6) / 1e6,
    });
  }
  return points;
}

// ── Process one alternate: chain, orient, measure, detect branch/rejoin ────────
function processAlt(altId, label, chain, spinePoints) {
  const altLen     = pathLen(chain);
  const ep1        = chain[0];
  const ep2        = chain[chain.length - 1];
  const m1         = nearestSpineMile(spinePoints, ep1[1], ep1[0]);
  const m2         = nearestSpineMile(spinePoints, ep2[1], ep2[0]);
  const branchMile = Math.min(m1, m2);
  const rejoinMile = Math.max(m1, m2);
  const mainSegLen = rejoinMile - branchMile;
  const deltaMiles = Math.round((altLen - mainSegLen) * 10) / 10;

  // Orient chain so it starts at the branch end
  const oriented = Math.abs(m1 - branchMile) <= Math.abs(m2 - branchMile)
    ? chain
    : chain.slice().reverse();

  const altPoints = buildAltPoints(altId, oriented, altLen);

  console.log(`  ${label}: ${altLen.toFixed(1)} mi, branch=${branchMile}, rejoin=${rejoinMile}, Δ=${deltaMiles > 0 ? '+' : ''}${deltaMiles} mi, ${altPoints.length} pts`);
  return { altId, label, chain: oriented, altLen, branchMile, rejoinMile, deltaMiles, altPoints };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(BASE, { recursive: true });

  // ── 1. Fetch ArcGIS features ───────────────────────────────────────────────
  console.log('=== Step 1: ArcGIS ===');
  const arcgis   = await fetchArcGIS();
  const features = arcgis.features;

  const mainFeat    = features.find(f => f.attributes.Label === LABEL_MAIN);
  const rmnpFeat    = features.find(f => f.attributes.Label === LABEL_RMNP);
  const chiefFeat   = features.find(f => f.attributes.Label === LABEL_CHIEF_MTN);

  if (!mainFeat) throw new Error(`"${LABEL_MAIN}" not found in ArcGIS data`);
  console.log(`Main route:    found (${mainFeat.geometry.paths.length} paths)`);
  console.log(`RMNP alternate: ${rmnpFeat   ? `found (${rmnpFeat.geometry.paths.length} paths)` : 'NOT FOUND'}`);
  console.log(`Chief Mountain: ${chiefFeat  ? `found (${chiefFeat.geometry.paths.length} paths)` : 'NOT FOUND'}`);

  // ── 2. Build main spine ────────────────────────────────────────────────────
  console.log('\n=== Step 2: Main Spine ===');
  const mainChain  = orientNOBO(chainPaths(mainFeat.geometry.paths));
  const totalMiles = pathLen(mainChain);
  const firstPt    = mainChain[0];
  const lastPt     = mainChain[mainChain.length - 1];
  const distAW     = haversine(ANTELOPE_WELLS.lat, ANTELOPE_WELLS.lon, firstPt[1], firstPt[0]);
  console.log(`  ${mainChain.length} coords, ${totalMiles.toFixed(2)} mi`);
  console.log(`  South end: ${firstPt[1].toFixed(3)}°N ${firstPt[0].toFixed(3)}°E (${distAW.toFixed(1)} mi from Antelope Wells)`);
  console.log(`  North end: ${lastPt[1].toFixed(3)}°N ${lastPt[0].toFixed(3)}°E`);
  if (distAW > 30) console.warn('  WARNING: southern end seems far from Antelope Wells — check orientation');

  // ── 3. Build spine points at 5-mile intervals ──────────────────────────────
  console.log('\n=== Step 3: Spine Points ===');
  const spinePoints = [];
  for (let m = 0; m <= totalMiles + 0.001; m += 5) {
    const mile  = Math.round(m * 1000) / 1000;
    if (mile > totalMiles + 0.001) break;
    const coord = interpolateAt(mainChain, Math.min(mile, totalMiles));
    const lat   = Math.round(coord[1] * 1e6) / 1e6;
    const lon   = Math.round(coord[0] * 1e6) / 1e6;
    spinePoints.push({
      id:    `cdt-main-mi${String(Math.round(mile * 1000)).padStart(7, '0')}`,
      mile,
      lat,
      lon,
      state: stateFromLat(lat),
    });
  }
  // Ensure northern terminus is included
  const lastMark = spinePoints[spinePoints.length - 1].mile;
  if (totalMiles - lastMark > 0.1) {
    const termCoord = lastPt;
    spinePoints.push({
      id:    `cdt-main-mi${String(Math.round(totalMiles * 1000)).padStart(7, '0')}`,
      mile:  Math.round(totalMiles * 1000) / 1000,
      lat:   Math.round(termCoord[1] * 1e6) / 1e6,
      lon:   Math.round(termCoord[0] * 1e6) / 1e6,
      state: 'MT',
    });
  }

  // State distribution from spine points
  const stateCounts = {};
  STATES.forEach(s => { stateCounts[s.id] = 0; });
  spinePoints.forEach(p => { stateCounts[p.state] = (stateCounts[p.state] || 0) + 1; });
  console.log(`  ${spinePoints.length} points  [${STATES.map(s => `${s.id}=${stateCounts[s.id]}`).join(', ')}]`);

  // State mile ranges (for meta)
  const stateMileRanges = {};
  STATES.forEach(s => { stateMileRanges[s.id] = { start: Infinity, end: -Infinity }; });
  spinePoints.forEach(p => {
    const r = stateMileRanges[p.state];
    if (p.mile < r.start) r.start = p.mile;
    if (p.mile > r.end)   r.end   = p.mile;
  });

  // ── 4. Process ArcGIS alternates ──────────────────────────────────────────
  console.log('\n=== Step 4: ArcGIS Alternates ===');
  const arcgisAltResults = [];

  if (rmnpFeat) {
    const chain   = chainPaths(rmnpFeat.geometry.paths);
    const chainKm = pathLen(chain);
    if (chainKm < 15) {
      console.warn(`  RMNP alternate: ArcGIS geometry is only ${chainKm.toFixed(1)} mi — incomplete connector segment, not the full loop.`);
      console.warn('  Skipping RMNP. To add it, source the full loop geometry from an OSM relation and add to OSM_ALTS.');
    } else {
      arcgisAltResults.push(processAlt('rmnp', 'RMNP Loop Alternate', chain, spinePoints));
    }
  } else {
    console.log('  RMNP alternate: skipped (not in ArcGIS data)');
  }

  // Chief Mountain: stored in meta as direction option, not as an alt_group with alt_points.
  // We just measure its length for the direction options total_miles calculation.
  let chiefMtnLen = 0;
  let chiefMtnChain = null;
  if (chiefFeat) {
    chiefMtnChain = chainPaths(chiefFeat.geometry.paths);
    chiefMtnLen   = pathLen(chiefMtnChain);
    console.log(`  Chief Mountain: ${chiefMtnLen.toFixed(2)} mi (direction option, no alt points)`);
  }

  // ── 5. Fetch and process OSM alternates ───────────────────────────────────
  console.log('\n=== Step 5: OSM Alternates ===');
  const osmAltResults = [];
  for (const alt of OSM_ALTS) {
    const ways  = await fetchOSMRelation(alt);
    const chain = chainOSMWays(ways, alt.maxGapMi, alt.trimStepMi);
    if (chain.length < 2) {
      console.warn(`  ${alt.label}: chaining produced < 2 coords — skipped`);
      continue;
    }
    const result = processAlt(alt.id, alt.label, chain, spinePoints);
    result.splitStepMi = alt.splitStepMi ?? null;
    osmAltResults.push(result);
  }

  // ── 6. Fetch SRTM elevations for all points ────────────────────────────────
  console.log('\n=== Step 6: SRTM Elevations ===');
  const allAltPoints = [
    ...arcgisAltResults.flatMap(a => a.altPoints),
    ...osmAltResults.flatMap(a => a.altPoints),
  ];
  const allCoords = [
    ...spinePoints.map(p => ({ lat: p.lat, lon: p.lon })),
    ...allAltPoints.map(p => ({ lat: p.lat, lon: p.lon })),
  ];
  console.log(`  Fetching ${allCoords.length} elevations (${spinePoints.length} spine + ${allAltPoints.length} alt)…`);
  const elevations = await fetchElevations(allCoords);

  spinePoints.forEach((p, i)   => { p.trail_elev = elevations[i]; });
  allAltPoints.forEach((p, i)  => { p.trail_elev = elevations[spinePoints.length + i]; });

  const elFt = elevations.filter(e => e !== null);
  if (elFt.length) {
    console.log(`  Elevation range: ${Math.min(...elFt)} – ${Math.max(...elFt)} ft`);
  }

  // ── 7. Build trail.geojson ─────────────────────────────────────────────────
  console.log('\n=== Step 7: trail.geojson ===');
  const THIN_METERS = 20; // target vertex spacing for main spine (alternates kept at native OSM resolution)
  // Build spine segments (full resolution) — thinning applied only when writing trail.geojson
  const spineSegments = []; // [{ state, coords }]
  let curState   = stateFromLat(mainChain[0][1]);
  let curCoords  = [mainChain[0]];
  for (let i = 1; i < mainChain.length; i++) {
    const st = stateFromLat(mainChain[i][1]);
    if (st !== curState) {
      if (curCoords.length >= 2) {
        curCoords.push(mainChain[i]); // include transition point in both features
        spineSegments.push({ state: curState, coords: curCoords });
      }
      curState  = st;
      curCoords = [mainChain[i]];
    } else {
      curCoords.push(mainChain[i]);
    }
  }
  if (curCoords.length >= 2) spineSegments.push({ state: curState, coords: curCoords });

  // Build alternate features (split logic removes artifact straight lines in both outputs)
  const altFeatures = [];
  [...arcgisAltResults, ...osmAltResults].forEach(alt => {
    if (alt.chain.length < 2) return;
    const props = { segment_type: 'alternate', alt_id: alt.altId, label: alt.label };
    if (alt.splitStepMi) {
      splitContinuousSegments(alt.chain, alt.splitStepMi).forEach(seg => {
        altFeatures.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: seg } });
      });
    } else {
      altFeatures.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: alt.chain } });
    }
  });

  // Chief Mountain (direction-option alternate, map display only)
  if (chiefMtnChain && chiefMtnChain.length >= 2) {
    altFeatures.push({
      type: 'Feature',
      properties: { segment_type: 'alternate', alt_id: 'chief-mtn', label: 'Chief Mountain Border Crossing' },
      geometry: { type: 'LineString', coordinates: chiefMtnChain },
    });
  }

  // Write trail.geojson — main spine thinned to THIN_METERS; alternates at native resolution
  const thinFeatures = [
    ...spineSegments.map(s => ({
      type: 'Feature',
      properties: { segment_type: 'trail', state: s.state },
      geometry: { type: 'LineString', coordinates: thinCoords(s.coords, THIN_METERS) },
    })),
    ...altFeatures,
  ];
  fs.writeFileSync(OUT_GEOJSON, JSON.stringify({ type: 'FeatureCollection', features: thinFeatures }));
  console.log(`  ${thinFeatures.length} features (thinned ${THIN_METERS}m) → ${OUT_GEOJSON}`);

  // Write trail_hires.geojson — full resolution, artifacts removed; for future high-detail use
  const hiresFeatures = [
    ...spineSegments.map(s => ({
      type: 'Feature',
      properties: { segment_type: 'trail', state: s.state },
      geometry: { type: 'LineString', coordinates: s.coords },
    })),
    ...altFeatures,
  ];
  fs.writeFileSync(OUT_GEOJSON_HIRES, JSON.stringify({ type: 'FeatureCollection', features: hiresFeatures }));
  console.log(`  ${hiresFeatures.length} features (full res) → ${OUT_GEOJSON_HIRES}`);

  // ── 8. Build points.json ───────────────────────────────────────────────────
  const allPoints = [
    ...spinePoints,
    ...arcgisAltResults.flatMap(a => a.altPoints),
    ...osmAltResults.flatMap(a => a.altPoints),
  ];
  fs.writeFileSync(OUT_POINTS, JSON.stringify(allPoints, null, 2));
  console.log(`  ${allPoints.length} points → ${OUT_POINTS}`);

  // ── 9. Build cdt_meta.json ─────────────────────────────────────────────────
  console.log('\n=== Step 9: cdt_meta.json ===');
  const totalMilesRounded = Math.round(totalMiles * 100) / 100;

  const sections = STATES
    .filter(s => stateMileRanges[s.id].start !== Infinity)
    .map(s => ({
      id:         s.id.toLowerCase(),
      name:       s.name,
      state:      s.id,
      axis_start: Math.round(stateMileRanges[s.id].start * 100) / 100,
      axis_end:   Math.round(stateMileRanges[s.id].end   * 100) / 100,
    }));

  const altGroups = [...arcgisAltResults, ...osmAltResults].map(alt => ({
    id:          alt.altId,
    label:       alt.label,
    branch_mile: alt.branchMile,
    rejoin_mile: alt.rejoinMile,
    main: {
      id:          'main',
      label:       'Main CDT Route',
      total_miles: Math.round((alt.rejoinMile - alt.branchMile) * 10) / 10,
    },
    alt: {
      id:          alt.altId,
      label:       alt.label,
      total_miles: Math.round(alt.altLen * 10) / 10,
      delta_miles: alt.deltaMiles,
    },
  }));

  // Chief Mountain option: total miles = main spine miles - final Waterton segment + Chief Mtn route
  // Approximation: subtract the direct-line distance from Chief Mtn junction to Waterton
  // and add the Chief Mountain alternate length. delta ≈ chiefMtnLen - (totalMiles - chiefMtnBranchMile)
  // Since we don't have the exact branch, use the reported -8 mi savings as a fallback.
  const chiefMtnDelta  = chiefFeat ? Math.round(chiefMtnLen * 10) / 10 : -8;
  const chiefMtnTotal  = chiefFeat
    ? Math.round((totalMilesRounded + arcgisAltResults[0]?.deltaMiles ?? chiefMtnDelta) * 100) / 100
    : Math.round((totalMilesRounded - 8) * 100) / 100;

  // Recompute Chief Mountain total properly if we have the chain:
  // The Chief Mtn alternate replaces the last X miles to Waterton.
  // branchMile is where Waterton route and Chief Mtn route diverge.
  let chiefBranch = totalMilesRounded;
  if (chiefFeat && chiefMtnChain) {
    // Nearest spine point to the Chief Mtn alternate endpoints
    const ep1    = chiefMtnChain[0];
    const ep2    = chiefMtnChain[chiefMtnChain.length - 1];
    const m1     = nearestSpineMile(spinePoints, ep1[1], ep1[0]);
    const m2     = nearestSpineMile(spinePoints, ep2[1], ep2[0]);
    chiefBranch  = Math.min(m1, m2);
    const chiefEnd = Math.max(m1, m2);
    console.log(`  Chief Mountain: branch=${chiefBranch}, end=${chiefEnd}, altLen=${chiefMtnLen.toFixed(2)}`);
  }
  const chiefMtnTotalFinal = Math.round((chiefBranch + chiefMtnLen) * 100) / 100;

  const meta = {
    trail: {
      name:              'Continental Divide Trail',
      total_trail_miles: totalMilesRounded,
      map_center:        [40.0, -109.5],
      map_zoom:          5,
      termini: {
        south:           'Antelope Wells, NM (US/Mexico Border)',
        north_waterton:  'Waterton Lake, MT/AB (US/Canada Border)',
        north_chief_mtn: 'Chief Mountain, MT (US/Canada Border)',
      },
    },
    sections,
    alt_groups: altGroups,
    direction_options: [
      {
        id:          'nobo_waterton',
        label:       'Northbound \u2014 Antelope Wells \u2192 Waterton Lake',
        total_miles: totalMilesRounded,
        is_nobo:     true,
        terminus:    'waterton',
      },
      {
        id:          'nobo_chief_mtn',
        label:       'Northbound \u2014 Antelope Wells \u2192 Chief Mountain (\u22128 mi)',
        total_miles: chiefMtnTotalFinal,
        is_nobo:     true,
        terminus:    'chief_mtn',
      },
      {
        id:          'sobo_waterton',
        label:       'Southbound \u2014 Waterton Lake \u2192 Antelope Wells',
        total_miles: totalMilesRounded,
        is_nobo:     false,
        terminus:    'waterton',
      },
      {
        id:          'sobo_chief_mtn',
        label:       'Southbound \u2014 Chief Mountain \u2192 Antelope Wells (\u22128 mi)',
        total_miles: chiefMtnTotalFinal,
        is_nobo:     false,
        terminus:    'chief_mtn',
      },
    ],
  };

  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2));
  console.log(`  Written: ${OUT_META}`);

  // ── 10. Summary ────────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.log(`Main trail miles : ${totalMilesRounded}`);
  console.log(`Spine points     : ${spinePoints.length}`);
  console.log(`Alt points       : ${allAltPoints.length}`);
  console.log(`GeoJSON features : ${thinFeatures.length}`);

  console.log('\nState ranges (copy into CDT_STATES_BOOTSTRAP in index.html):');
  sections.forEach(s => {
    console.log(`  { state: "${s.state}", name: "${s.name}", axis_start: ${s.axis_start}, axis_end: ${s.axis_end} },`);
  });

  console.log('\nAlt groups:');
  altGroups.forEach(ag => {
    console.log(`  ${ag.id.padEnd(14)}: branch=${ag.branch_mile}, rejoin=${ag.rejoin_mile}, delta=${ag.alt.delta_miles >= 0 ? '+' : ''}${ag.alt.delta_miles} mi`);
  });
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
