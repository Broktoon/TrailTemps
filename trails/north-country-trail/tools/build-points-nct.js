#!/usr/bin/env node
/**
 * build-points-nct.js
 *
 * Fetches the North Country Trail centerline from the NCTA ArcGIS FeatureServer (Layer 2),
 * supplements the Minnesota section with Superior Hiking Trail geometry from OpenStreetMap
 * (the NCTA source omits the lower SHT corridor, Duluth → Silver Bay, ~100 miles),
 * stitches ~4,000+ features into a continuous WEBO spine (VT/NY → ND),
 * interpolates at 5-mile intervals, and writes:
 *   - trails/north-country-trail/data/points.json
 *   - trails/north-country-trail/data/trail.geojson
 *   - trails/north-country-trail/data/nct_meta.json
 *
 * Run: node trails/north-country-trail/tools/build-points-nct.js
 *
 * Data sources:
 *   NCTA ArcGIS FeatureServer (Layer 2) — all states
 *     https://services2.arcgis.com/UfGVyqUm4GHa2zrj/arcgis/rest/services/nct_public/FeatureServer/2
 *   OpenStreetMap Overpass API — Superior Hiking Trail (MN only, OSM relation 1612587)
 *     https://overpass-api.de/api/interpreter
 *
 * trail_stat = "NCT"         → off-road trail (solid display)
 * trail_stat = "NCT (on-road)" → roadwalk connector (dashed display)
 *
 * Sections are organized by state in WEBO order (east → west):
 *   VT → NY → PA → OH → MI → WI → MN → ND
 *
 * After running, update NCT_STATES_BOOTSTRAP in trails/north-country-trail/index.html
 * with the axis_start / axis_end values reported in the summary.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── output paths ──────────────────────────────────────────────────────────────
const BASE       = path.resolve(__dirname, '../data');
const OUT_POINTS = path.join(BASE, 'points.json');
const OUT_GEO    = path.join(BASE, 'trail.geojson');
const OUT_META   = path.join(BASE, 'nct_meta.json');
const CACHE_FILE     = path.join(BASE, '_raw_nct.json');
const SHT_CACHE_FILE = path.join(BASE, '_raw_sht.json');

// OSM relation ID for the Superior Hiking Trail (Duluth → Grand Portage, MN)
const SHT_RELATION_ID = 1612587;
const OVERPASS_URL    = 'https://overpass-api.de/api/interpreter';

// ── state definitions in WEBO order (east → west) ────────────────────────────
const STATES = [
  { id: 'VT', name: 'Vermont'      },
  { id: 'NY', name: 'New York'     },
  { id: 'PA', name: 'Pennsylvania' },
  { id: 'OH', name: 'Ohio'         },
  { id: 'MI', name: 'Michigan'     },
  { id: 'WI', name: 'Wisconsin'    },
  { id: 'MN', name: 'Minnesota'    },
  { id: 'ND', name: 'North Dakota' },
];

const FEATURE_SERVER =
  'https://services2.arcgis.com/UfGVyqUm4GHa2zrj/arcgis/rest/services/nct_public/FeatureServer/2/query';

const FETCH_FIELDS   = 'seg_id,trail_stat,state';
const PAGE_SIZE      = 1000;

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

function coordsCentroid(coords) {
  if (!coords.length) return [0, 0];
  const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
  const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  return [lon, lat];
}

// ── fetch helpers ─────────────────────────────────────────────────────────────
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
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAllFeatures() {
  if (fs.existsSync(CACHE_FILE)) {
    console.log('Using cached NCT data:', CACHE_FILE);
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }

  const allFeatures = [];
  let offset = 0;

  console.log('Fetching NCT features from ArcGIS…');
  while (true) {
    const url = `${FEATURE_SERVER}?where=1%3D1` +
      `&outFields=${encodeURIComponent(FETCH_FIELDS)}` +
      `&returnGeometry=true&outSR=4326&f=json` +
      `&resultRecordCount=${PAGE_SIZE}&resultOffset=${offset}`;

    const data  = await fetchJSON(url);
    const feats = data.features || [];
    allFeatures.push(...feats);
    console.log(`  Page offset ${offset}: ${feats.length} features (total so far: ${allFeatures.length})`);
    if (feats.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`Total features fetched: ${allFeatures.length}`);
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(allFeatures));
  return allFeatures;
}

// ── SHT fetch from OpenStreetMap Overpass API ─────────────────────────────────

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
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Overpass timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Fetch the Superior Hiking Trail ways from OpenStreetMap (relation 1612587)
 * and return them as NCTA-compatible feature objects with state='MN' and
 * trail_stat='NCT'.  Results are cached in _raw_sht.json.
 */
async function fetchSHTFeatures() {
  if (fs.existsSync(SHT_CACHE_FILE)) {
    console.log('Using cached SHT data:', SHT_CACHE_FILE);
    return JSON.parse(fs.readFileSync(SHT_CACHE_FILE, 'utf8'));
  }

  console.log('Fetching Superior Hiking Trail from OpenStreetMap…');
  const ql   = `[out:json][timeout:120];relation(${SHT_RELATION_ID});way(r);out geom qt;`;
  const body = 'data=' + encodeURIComponent(ql);
  const data = await fetchPost(OVERPASS_URL, body);
  const ways  = (data.elements || []).filter(e => e.type === 'way' && Array.isArray(e.geometry));

  console.log(`  ${ways.length} SHT ways received`);

  // Convert OSM way geometry [{lat,lon},…] → NCTA feature format
  // Coordinates in NCTA format are [lon, lat] pairs stored in geometry.paths arrays.
  const features = ways
    .filter(w => w.geometry.length >= 2)
    .map(w => ({
      attributes: { trail_stat: 'NCT', state: 'MN' },
      geometry:   { paths: [ w.geometry.map(n => [n.lon, n.lat]) ] },
    }));

  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(SHT_CACHE_FILE, JSON.stringify(features));
  console.log(`  Cached ${features.length} SHT features → ${SHT_CACHE_FILE}`);
  return features;
}

// ── null-state assignment by nearest state centroid ───────────────────────────
function featureAllCoords(f) {
  return (f.geometry?.paths || []).flat();
}

function assignNullStates(features) {
  // Build centroid for each known state
  const stateCentroids = {};
  for (const s of STATES) {
    const coords = [];
    features.forEach(f => {
      if (f.attributes.state === s.id) coords.push(...featureAllCoords(f));
    });
    if (coords.length) stateCentroids[s.id] = coordsCentroid(coords);
  }

  let assigned = 0;
  features.forEach(f => {
    if (f.attributes.state) return;
    const fc = coordsCentroid(featureAllCoords(f));
    let best = null, bestDist = Infinity;
    for (const [sid, sc] of Object.entries(stateCentroids)) {
      const d = haversine(fc[1], fc[0], sc[1], sc[0]);
      if (d < bestDist) { bestDist = d; best = sid; }
    }
    f.attributes.state = best || 'NY';
    console.log(`  Null-state → ${best} (${bestDist.toFixed(1)} mi from centroid)`);
    assigned++;
  });
  if (assigned) console.log(`  Assigned ${assigned} null-state features`);
}

// ── segment chaining ──────────────────────────────────────────────────────────

// Maximum allowed gap between the tail of the current run and the start of the
// next segment before we start a new GeoJSON run rather than extending the
// current one.  Keeps the greedy algorithm from creating long straight-line
// jumps across the map when it can't find a close neighbor.
const MAX_MERGE_GAP_MI = 2.0;

// Maximum allowed distance between two consecutive coordinates WITHIN a single
// source path.  Paths whose coords "teleport" farther than this are almost
// certainly bad ArcGIS geometry and are dropped before stitching.
// Set to 8.0 rather than 3.0: real rural roadwalk segments (e.g. Red River
// Valley in MN, New Rockford → Lake Ashtabula in ND) have legitimate steps
// up to ~7 miles on flat county roads with sparse NCTA waypoints.
// Bad ArcGIS artifacts are 50–300 miles, so 8.0 still provides ample filtering.
const MAX_STEP_MI = 8.0;

/**
 * Chain all features for one state into an ordered sequence of
 * { coords: [[lon,lat],...], trail_stat: string } segments.
 *
 * Consecutive segments with the same trail_stat are merged into one
 * IF the gap between them is ≤ MAX_MERGE_GAP_MI; otherwise a new run
 * is started.  This prevents the greedy algorithm from producing long
 * straight-line artifacts when it bridges large gaps.
 *
 * If prevEnd is given, the chain starts nearest to that point;
 * otherwise it starts from the easternmost endpoint (max longitude).
 */
function chainStateFeatures(features, prevEnd) {
  // Flatten features into path segments, each carrying its trail_stat.
  // Drop any path whose coords contain a step > MAX_STEP_MI — these are
  // bad source-data features (e.g. two-point connector lines spanning
  // 30+ miles) that would appear as straight-line artifacts in the map.
  const segs = [];
  let droppedPaths = 0;
  features.forEach(f => {
    const ts = f.attributes.trail_stat || 'NCT';
    (f.geometry?.paths || []).forEach(p => {
      if (p.length < 2) return;
      let bad = false;
      for (let i = 1; i < p.length; i++) {
        if (haversine(p[i-1][1], p[i-1][0], p[i][1], p[i][0]) > MAX_STEP_MI) {
          bad = true;
          break;
        }
      }
      if (bad) { droppedPaths++; return; }
      segs.push({ coords: p.slice(), trail_stat: ts });
    });
  });
  if (droppedPaths) console.log(`    (dropped ${droppedPaths} path(s) with step > ${MAX_STEP_MI} mi)`);

  if (!segs.length) return [];

  // Find starting segment
  let startIdx = 0;
  let startFromEnd = false;

  if (prevEnd) {
    let bestDist = Infinity;
    segs.forEach((seg, i) => {
      const d1 = haversine(prevEnd[1], prevEnd[0], seg.coords[0][1],                      seg.coords[0][0]);
      const d2 = haversine(prevEnd[1], prevEnd[0], seg.coords[seg.coords.length-1][1], seg.coords[seg.coords.length-1][0]);
      if (d1 < bestDist) { bestDist = d1; startIdx = i; startFromEnd = false; }
      if (d2 < bestDist) { bestDist = d2; startIdx = i; startFromEnd = true;  }
    });
  } else {
    // First state: start from easternmost endpoint (max longitude)
    let maxLon = -Infinity;
    segs.forEach((seg, i) => {
      if (seg.coords[0][0] > maxLon)                        { maxLon = seg.coords[0][0];                        startIdx = i; startFromEnd = false; }
      if (seg.coords[seg.coords.length-1][0] > maxLon)      { maxLon = seg.coords[seg.coords.length-1][0];      startIdx = i; startFromEnd = true;  }
    });
  }

  // Build ordered chain of {coords, trail_stat} runs
  const used    = new Set();
  const startSeg = segs[startIdx];
  const startCoords = startFromEnd
    ? startSeg.coords.slice().reverse()
    : startSeg.coords.slice();

  const chain = [{ coords: startCoords, trail_stat: startSeg.trail_stat }];
  used.add(startIdx);

  while (used.size < segs.length) {
    const lastRun  = chain[chain.length - 1];
    const tail     = lastRun.coords[lastRun.coords.length - 1];

    let bestDist = Infinity, bestIdx = -1, bestRev = false;
    segs.forEach((seg, i) => {
      if (used.has(i)) return;
      const d1 = haversine(tail[1], tail[0], seg.coords[0][1],                    seg.coords[0][0]);
      const d2 = haversine(tail[1], tail[0], seg.coords[seg.coords.length-1][1], seg.coords[seg.coords.length-1][0]);
      if (d1 < bestDist) { bestDist = d1; bestIdx = i; bestRev = false; }
      if (d2 < bestDist) { bestDist = d2; bestIdx = i; bestRev = true;  }
    });

    if (bestIdx === -1) break;

    const seg       = segs[bestIdx];
    const segCoords = bestRev ? seg.coords.slice().reverse() : seg.coords.slice();
    const tailDist  = haversine(tail[1], tail[0], segCoords[0][1], segCoords[0][0]);
    used.add(bestIdx);

    if (seg.trail_stat === lastRun.trail_stat && tailDist <= MAX_MERGE_GAP_MI) {
      // Same trail_stat, small gap — extend current run; skip first coord to avoid counting gap distance
      lastRun.coords.push(...segCoords.slice(1));
    } else {
      // New run: either different trail_stat OR same trail_stat but gap too large.
      // Keep full segCoords so the run's internal pathLen is correct.
      if (!segCoords.length) continue;
      chain.push({ coords: segCoords, trail_stat: seg.trail_stat });
    }
  }

  return chain;
}

/**
 * Post-process a greedy chain to ensure it ends at the westernmost endpoint.
 * The greedy algorithm occasionally visits a few small "orphan" segments after
 * it has already reached the state's western terminus (e.g. short SHT spur tips
 * or isolated inland segments that were skipped over during the main traversal).
 * This moves those orphan runs to just before the terminal run so the chain
 * ends at the correct geographic western boundary.
 */
function reorderToWesternTerminus(runs) {
  if (runs.length < 2) return runs;

  // Find the run whose last coordinate is the most western (smallest lon)
  let termIdx = runs.length - 1;
  let westLon  = Infinity;
  runs.forEach((run, i) => {
    const endLon   = run.coords[run.coords.length - 1][0];
    const startLon = run.coords[0][0];
    const minLon   = Math.min(endLon, startLon);
    if (minLon < westLon) { westLon = minLon; termIdx = i; }
  });

  if (termIdx === runs.length - 1) return runs; // already terminal

  const orphans = runs.slice(termIdx + 1);
  if (!orphans.length) return runs;

  // Insert orphan runs just before the terminal run, preserving their relative
  // order.  They are geographically inside the main traversal zone so their
  // exact position doesn't need to be perfect — just not AFTER the terminus.
  const pre    = runs.slice(0, termIdx);
  const term   = runs[termIdx];
  return [...pre, ...orphans, term];
}

// ── interpolation ─────────────────────────────────────────────────────────────
function interpolateAt(coords, targetDist) {
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversine(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
    if (acc + seg >= targetDist) {
      const frac = (targetDist - acc) / seg;
      return [
        coords[i-1][0] + frac * (coords[i][0] - coords[i-1][0]),
        coords[i-1][1] + frac * (coords[i][1] - coords[i-1][1]),
      ];
    }
    acc += seg;
  }
  return coords[coords.length - 1];
}

/**
 * Interpolate across a sequence of runs, treating inter-run gaps as teleports
 * (i.e. bridge distances are NOT counted toward targetDist).  This matches
 * how stateMiles is computed (sum of run path lengths only) and correctly
 * places points in every run segment, even when runs are separated by large
 * geographic gaps.
 */
function interpolateAtAcrossRuns(runs, targetDist) {
  let acc = 0;
  for (const run of runs) {
    const runLen = pathLen(run.coords);
    if (acc + runLen >= targetDist) {
      return interpolateAt(run.coords, targetDist - acc);
    }
    acc += runLen;
  }
  // Past the end — return last coord of last run
  const last = runs[runs.length - 1];
  return last.coords[last.coords.length - 1];
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(BASE, { recursive: true });

  // 1. Fetch NCTA centerline
  const allFeatures = await fetchAllFeatures();
  console.log(`\nTotal NCTA features: ${allFeatures.length}`);

  // 1b. Fetch Superior Hiking Trail (supplements MN — lower SHT missing from NCTA source)
  console.log('');
  const shtFeatures = await fetchSHTFeatures();
  console.log(`  Injecting ${shtFeatures.length} SHT features into MN`);

  // 2. Assign null states
  console.log('\nAssigning null-state features…');
  assignNullStates(allFeatures);

  // 3. Group by state and inject SHT into MN
  console.log('\nFeatures per state:');
  const byState = {};
  STATES.forEach(s => { byState[s.id] = []; });
  allFeatures.forEach(f => {
    const sid = f.attributes.state;
    if (byState[sid]) byState[sid].push(f);
    else              console.warn(`  Unknown state value: "${sid}"`);
  });
  // Inject SHT ways — they are all MN off-road trail
  byState['MN'].push(...shtFeatures);
  STATES.forEach(s => {
    const onRoad = byState[s.id].filter(f => f.attributes.trail_stat === 'NCT (on-road)').length;
    const sht    = s.id === 'MN' ? ` (incl. ${shtFeatures.length} SHT ways)` : '';
    console.log(`  ${s.id} (${s.name}): ${byState[s.id].length} features, ${onRoad} on-road${sht}`);
  });

  // 4. Chain each state
  console.log('\nChaining states (east → west)…');
  const stateChains = []; // { stateId, stateName, runs: [{coords, trail_stat}], flatCoords, stateMiles }
  let prevEnd = null;

  for (const st of STATES) {
    console.log(`\n  ${st.name} (${st.id}):`);
    const rawRuns = chainStateFeatures(byState[st.id], prevEnd);
    const runs    = reorderToWesternTerminus(rawRuns);

    // stateMiles = sum of each run's internal path length (inter-run gaps not counted)
    const stateMiles = runs.reduce((sum, r) => sum + pathLen(r.coords), 0);
    const trailRuns  = runs.filter(r => r.trail_stat !== 'NCT (on-road)').length;
    const roadRuns   = runs.filter(r => r.trail_stat === 'NCT (on-road)').length;
    const totalCoords = runs.reduce((s, r) => s + r.coords.length, 0);

    console.log(`    ${runs.length} runs (${trailRuns} trail, ${roadRuns} roadwalk)`);
    console.log(`    ${totalCoords} coords, ${stateMiles.toFixed(2)} mi`);

    stateChains.push({ stateId: st.id, stateName: st.name, runs, stateMiles });
    if (runs.length) {
      const lastRun = runs[runs.length - 1];
      prevEnd = lastRun.coords[lastRun.coords.length - 1];
    }
  }

  // 5. Compute axis (spine) mile boundaries per state
  console.log('\nAxis mile ranges:');
  let axisCumul = 0;
  const axisRanges = {};
  stateChains.forEach(sc => {
    const start = axisCumul;
    const end   = axisCumul + sc.stateMiles;
    axisRanges[sc.stateId] = {
      axis_start: Math.round(start * 1000) / 1000,
      axis_end:   Math.round(end   * 1000) / 1000,
    };
    console.log(`  ${sc.stateId.padEnd(4)}: ${start.toFixed(2).padStart(8)} → ${end.toFixed(2).padStart(8)} mi`);
    axisCumul = end;
  });
  const totalMiles = Math.round(axisCumul * 100) / 100;
  console.log(`  Total: ${totalMiles} mi`);

  // 6. Build trail.geojson
  console.log('\nBuilding trail.geojson…');
  const geojsonFeatures = [];
  stateChains.forEach(sc => {
    sc.runs.forEach(run => {
      if (!run.coords.length) return;
      geojsonFeatures.push({
        type: 'Feature',
        properties: {
          state:        sc.stateId,
          trail_stat:   run.trail_stat,
          segment_type: run.trail_stat === 'NCT (on-road)' ? 'roadwalk' : 'trail',
        },
        geometry: { type: 'LineString', coordinates: run.coords },
      });
    });
  });
  fs.writeFileSync(OUT_GEO, JSON.stringify({ type: 'FeatureCollection', features: geojsonFeatures }));
  console.log(`  ${geojsonFeatures.length} features → ${OUT_GEO}`);

  // 7. Build points.json at 5-mile intervals
  console.log('\nBuilding points.json (5-mile intervals)…');
  const points = [];
  let cumulBase = 0;

  for (const sc of stateChains) {
    const stateEnd   = cumulBase + sc.stateMiles;
    const firstMark  = Math.ceil(cumulBase / 5) * 5;

    for (let m = firstMark; m <= stateEnd + 0.001; m += 5) {
      const axisMile  = Math.round(m * 1000) / 1000;
      const localDist = axisMile - cumulBase;
      if (localDist < 0 || localDist > sc.stateMiles + 0.001) continue;
      const coord   = interpolateAtAcrossRuns(sc.runs, Math.min(localDist, sc.stateMiles));
      const lon     = Math.round(coord[0] * 1e6) / 1e6;
      const lat     = Math.round(coord[1] * 1e6) / 1e6;
      const mileInt = Math.round(axisMile * 1000);
      const id      = `nct-${sc.stateId.toLowerCase()}-mi${String(mileInt).padStart(7, '0')}`;
      points.push({ id, mile: axisMile, state: sc.stateId, lat, lon });
    }

    cumulBase = stateEnd;
  }

  // Add western terminus if not already at a 5-mile mark
  const lastMark = points[points.length - 1]?.mile ?? 0;
  if (totalMiles - lastMark > 0.1) {
    const lastSC    = stateChains[stateChains.length - 1];
    const lastRun   = lastSC.runs[lastSC.runs.length - 1];
    const termCoord = lastRun.coords[lastRun.coords.length - 1];
    const mileInt   = Math.round(totalMiles * 1000);
    points.push({
      id:    `nct-nd-mi${String(mileInt).padStart(7, '0')}`,
      mile:  totalMiles,
      state: 'ND',
      lat:   Math.round(termCoord[1] * 1e6) / 1e6,
      lon:   Math.round(termCoord[0] * 1e6) / 1e6,
    });
  }

  console.log(`  ${points.length} points → ${OUT_POINTS}`);
  fs.writeFileSync(OUT_POINTS, JSON.stringify(points, null, 2));

  // 8. Build nct_meta.json
  console.log('\nBuilding nct_meta.json…');

  const sections = STATES.map(s => ({
    id:         s.id.toLowerCase(),
    name:       s.name,
    state:      s.id,
    axis_start: axisRanges[s.id].axis_start,
    axis_end:   axisRanges[s.id].axis_end,
  }));

  // Map center: average of bounding box
  const lats = points.map(p => p.lat);
  const lons = points.map(p => p.lon);
  const mapCenter = [
    Math.round((Math.min(...lats) + Math.max(...lats)) / 2 * 100) / 100,
    Math.round((Math.min(...lons) + Math.max(...lons)) / 2 * 100) / 100,
  ];

  const meta = {
    trail: {
      name:              'North Country Trail',
      total_trail_miles: totalMiles,
      map_center:        mapCenter,
      map_zoom:          5,
      termini: {
        east: 'Crown Point, NY (Lake Champlain) / Vermont',
        west: 'Lake Sakakawea State Park, ND',
      },
    },
    sections,
    direction_options: [
      {
        id:          'webo',
        label:       'Westbound — Crown Point, NY / Vermont \u2192 Lake Sakakawea, ND',
        total_miles: totalMiles,
        is_webo:     true,
      },
      {
        id:          'eabo',
        label:       'Eastbound — Lake Sakakawea, ND \u2192 Crown Point, NY / Vermont',
        total_miles: totalMiles,
        is_webo:     false,
      },
    ],
  };

  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2));
  console.log(`  Written: ${OUT_META}`);

  // 9. Summary
  console.log('\n=== Done ===');
  console.log(`Total trail miles : ${totalMiles}`);
  console.log(`Points generated  : ${points.length}`);
  console.log(`GeoJSON features  : ${geojsonFeatures.length}`);
  console.log('\nState axis ranges (copy into NCT_STATES_BOOTSTRAP in index.html):');
  STATES.forEach(s => {
    const r = axisRanges[s.id];
    console.log(`  { state: "${s.id}", name: "${s.name}", axis_start: ${r.axis_start}, axis_end: ${r.axis_end} },`);
  });
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
