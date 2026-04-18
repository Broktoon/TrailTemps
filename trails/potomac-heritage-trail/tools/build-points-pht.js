#!/usr/bin/env node
/**
 * build-points-pht.js
 *
 * Fetches the Potomac Heritage NST centerline from the NPS ArcGIS FeatureServer,
 * classifies features into through-hike spine vs. Weather-Planner-only sections,
 * stitches chains using greedy nearest-endpoint algorithm,
 * interpolates at 0.1-mile intervals, and writes:
 *   - trails/potomac-heritage-trail/data/points.json
 *   - trails/potomac-heritage-trail/data/trail.geojson
 *   - trails/potomac-heritage-trail/data/pht_meta.json
 *
 * Run: node trails/potomac-heritage-trail/tools/build-points-pht.js
 *
 * Data source:
 *   NPS POHE Trail Centerline FeatureServer (Layer 0)
 *   https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/POHE_Trail_Centerline_FTDS_view/FeatureServer/0
 *
 * Through-hike spine (east → west, Westbound direction):
 *   Point Lookout, MD  →  Tidewater Potomac On-Road Bicycle Route (Southern MD)
 *   →  DC alternate branch (Anacostia / South Capitol St Bridge)
 *       Main: DC River Trail  (Anacostia Riverwalk → Potomac River Trail → Georgetown)
 *       Alt:  DC City Park Trail  (Civil War Defenses → Fort Circle → Georgetown)
 *   →  C&O Canal Towpath  →  Great Allegheny Passage  →  Laurel Highlands
 *   →  Laurel Ridge, PA
 *
 * Weather-Planner-only sections (no through-hike axis_mile):
 *   Northern Virginia (per named trail)  |  Northern Neck of Virginia
 *   Eastern Continental Divide Loop
 *
 * Point schema:
 *   Spine:    { id, mile, lat, lon, region, section_id, section_mile [, alt_id] }
 *   WP-only:  { id, lat, lon, region, section_id, section_mile, on_spine: false }
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── output paths ──────────────────────────────────────────────────────────────
const BASE       = path.resolve(__dirname, '../data');
const OUT_POINTS = path.join(BASE, 'points.json');
const OUT_GEO    = path.join(BASE, 'trail.geojson');
const OUT_META   = path.join(BASE, 'pht_meta.json');
const CACHE_FILE = path.join(BASE, '_raw_pht.json');

// ── ArcGIS source ─────────────────────────────────────────────────────────────
const FEATURE_SERVER =
  'https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/' +
  'POHE_Trail_Centerline_FTDS_view/FeatureServer/0/query';
const FETCH_FIELDS = 'OBJECTID,TRNAME,TRALTNAME,MAPLABEL,TRSTATUS,TYPEOFROUTE,STATE,REGION';
const PAGE_SIZE    = 1000;

// ── interpolation interval ────────────────────────────────────────────────────
const INTERVAL_MILES = 0.1;

// ── DC River Trail feature seeds ──────────────────────────────────────────────
// Features that definitively belong to the DC River Trail alternate.
// Matched case-insensitively against MAPLABEL first, then TRNAME.
const DC_RIVER_MAPLABELS = new Set([
  'anacostia riverwalk trail',
  'potomac river trail',
  'waterfront park',
]);
// Street/bridge names the user confirmed are on the River Trail route.
const DC_RIVER_TRNAMES = new Set([
  'half st sw',
  'v st sw',
  '2nd st sw',
  'p st sw',
  'maine ave sw',
  "l'enfant prom sw",
  'francis case memorial bridge',
  'buckeye dr sw sidewalk',
  'south capitol street trail',
  'frederick douglass memorial bridge trail',
]);

// ── DC City Park Trail feature seeds ─────────────────────────────────────────
const DC_CITY_MAPLABELS = new Set([
  'civil war defenses of washington',
  'civil war defenses of washington trail',
  'fort circle hiker-biker trail',
  'metropolitan branch trail',
  'malcolm x trail',
  'anacostia riverwalk trail',   // some segments overlap; spatial stitching resolves final split
]);

// Features classified as River Trail take priority over City Park.
// DC_CITY is applied only to features NOT already matched as DC_RIVER.

// ── maximum stitching gap ─────────────────────────────────────────────────────
// Segments farther apart than this start a new run rather than bridge a gap.
const MAX_MERGE_GAP_MI = 1.0;   // tighter than NCT; PHT features are denser

// DC chains use a much tighter gap threshold.  Civil War fort features are
// genuinely disconnected across the city; bridging gaps > ~100 ft produces
// long straight-line artefacts in the GeoJSON.  Any gap larger than this
// becomes a new run (separate LineString), which is visually correct.
const DC_MAX_GAP_MI = 0.02;     // ~100 feet

// Max step within a single source path before the path is dropped as bad geometry.
const MAX_STEP_MI = 5.0;

// ── haversine / path math ─────────────────────────────────────────────────────
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
  for (let i = 1; i < coords.length; i++)
    d += haversine(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
  return d;
}

function centroid(coords) {
  const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
  const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  return [lon, lat];
}

function featureCoords(f) {
  return (f.geometry?.paths || []).flat();
}

// ── fetch helpers ─────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse: ' + e.message + '\n' + raw.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAllFeatures() {
  if (fs.existsSync(CACHE_FILE)) {
    console.log('Using cached PHT data:', CACHE_FILE);
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }

  const all = [];
  let offset = 0;
  console.log('Fetching PHT features from NPS ArcGIS…');
  while (true) {
    const url = `${FEATURE_SERVER}?where=1%3D1` +
      `&outFields=${encodeURIComponent(FETCH_FIELDS)}` +
      `&returnGeometry=true&outSR=4326&f=json` +
      `&resultRecordCount=${PAGE_SIZE}&resultOffset=${offset}`;
    const data  = await fetchJSON(url);
    const feats = data.features || [];
    all.push(...feats);
    console.log(`  offset ${offset}: ${feats.length} features (total: ${all.length})`);
    if (feats.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  console.log(`Total features: ${all.length}`);
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(all));
  return all;
}

// ── feature classification ────────────────────────────────────────────────────
function classifyFeatures(features) {
  const chains = {
    spine_smd:  [],   // Southern Maryland (through-hike)
    dc_river:   [],   // DC River Trail (through-hike, main alt)
    dc_city:    [],   // DC City Park Trail (through-hike, secondary alt)
    dc_other:   [],   // DC features not matched to either seed; assigned spatially later
    spine_cho:  [],   // C&O Canal (through-hike)
    spine_gap:  [],   // Great Allegheny Passage (through-hike)
    spine_lht:  [],   // Laurel Highlands (through-hike)
    wp_nva:     [],   // Northern Virginia (Weather Planner only)
    wp_nn:      [],   // Northern Neck of Virginia (Weather Planner only)
    wp_ecd:     [],   // Eastern Continental Divide (Weather Planner only)
  };

  for (const f of features) {
    const region = (f.attributes.REGION || '').trim();
    const maplab = (f.attributes.MAPLABEL || '').trim().toLowerCase();
    const trname = (f.attributes.TRNAME  || '').trim().toLowerCase();

    switch (region) {
      case 'Southern Maryland':
        chains.spine_smd.push(f); break;
      case 'Chesapeake and Ohio Canal National Historical Park':
        chains.spine_cho.push(f); break;
      case 'Great Allegheny Passage':
        chains.spine_gap.push(f); break;
      case 'Laurel Highlands':
        chains.spine_lht.push(f); break;
      case 'Northern Virginia':
        chains.wp_nva.push(f); break;
      case 'Northern Neck of Virginia':
        chains.wp_nn.push(f); break;
      case 'Eastern Continental Divide':
        chains.wp_ecd.push(f); break;
      case 'Washington D.C.': {
        // River Trail seeds take priority
        if (DC_RIVER_MAPLABELS.has(maplab) || DC_RIVER_TRNAMES.has(trname)) {
          chains.dc_river.push(f);
        } else if (DC_CITY_MAPLABELS.has(maplab)) {
          chains.dc_city.push(f);
        } else {
          chains.dc_other.push(f);
        }
        break;
      }
      default:
        // null region or unexpected — will be assigned spatially below
        chains.dc_other.push(f);
    }
  }

  console.log('\nFeature classification:');
  for (const [k, v] of Object.entries(chains))
    console.log(`  ${k.padEnd(12)}: ${v.length}`);

  return chains;
}

// ── assign unclassified DC features to river or city ─────────────────────────
// After seeding each chain, find each unassigned DC feature's nearest
// endpoint in either chain and assign it to whichever is closer.
function assignDcOther(chains) {
  if (!chains.dc_other.length) return;

  const riverCoords = chains.dc_river.flatMap(featureCoords);
  const cityCoords  = chains.dc_city.flatMap(featureCoords);

  if (!riverCoords.length || !cityCoords.length) {
    // Can't distinguish — push all to river
    chains.dc_river.push(...chains.dc_other);
    chains.dc_other = [];
    return;
  }

  let rAssigned = 0, cAssigned = 0;
  for (const f of chains.dc_other) {
    const fc = centroid(featureCoords(f));
    if (!fc) continue;

    // Find nearest point in each chain
    const nearRiver = riverCoords.reduce((best, c) => {
      const d = haversine(fc[1], fc[0], c[1], c[0]);
      return d < best ? d : best;
    }, Infinity);
    const nearCity = cityCoords.reduce((best, c) => {
      const d = haversine(fc[1], fc[0], c[1], c[0]);
      return d < best ? d : best;
    }, Infinity);

    if (nearRiver <= nearCity) { chains.dc_river.push(f); rAssigned++; }
    else                       { chains.dc_city.push(f);  cAssigned++; }
  }
  chains.dc_other = [];
  console.log(`  DC unassigned: ${rAssigned} → river, ${cAssigned} → city`);
}

// ── greedy chain stitcher ─────────────────────────────────────────────────────
/**
 * Given a flat array of ArcGIS features (each with geometry.paths),
 * build an ordered list of {coords, segment_type} runs using a greedy
 * nearest-endpoint algorithm.
 *
 * startHint: [lon, lat] of a geographic anchor to begin stitching near,
 *            or null to start from the most-eastern endpoint.
 */
function stitchChain(features, startHint = null, maxGap = MAX_MERGE_GAP_MI) {
  // Flatten all paths into segments with their TYPEOFROUTE
  const segs = [];
  let droppedPaths = 0;

  for (const f of features) {
    const typeOfRoute = (f.attributes.TYPEOFROUTE || 'Trail').trim();
    const segType     = typeOfRoute === 'Road' ? 'road' : 'trail';

    for (const p of (f.geometry?.paths || [])) {
      if (p.length < 2) continue;
      let bad = false;
      for (let i = 1; i < p.length; i++) {
        if (haversine(p[i-1][1], p[i-1][0], p[i][1], p[i][0]) > MAX_STEP_MI) {
          bad = true; break;
        }
      }
      if (bad) { droppedPaths++; continue; }
      segs.push({ coords: p.slice(), segType });
    }
  }
  if (droppedPaths) console.log(`    (dropped ${droppedPaths} bad path(s))`);
  if (!segs.length) return [];

  // Find starting segment
  let startIdx  = 0;
  let startFromEnd = false;

  if (startHint) {
    let best = Infinity;
    segs.forEach((s, i) => {
      const d1 = haversine(startHint[1], startHint[0], s.coords[0][1],                        s.coords[0][0]);
      const d2 = haversine(startHint[1], startHint[0], s.coords[s.coords.length-1][1], s.coords[s.coords.length-1][0]);
      if (d1 < best) { best = d1; startIdx = i; startFromEnd = false; }
      if (d2 < best) { best = d2; startIdx = i; startFromEnd = true;  }
    });
  } else {
    // Start from most-eastern endpoint (max longitude)
    let maxLon = -Infinity;
    segs.forEach((s, i) => {
      if (s.coords[0][0] > maxLon)                       { maxLon = s.coords[0][0];                       startIdx = i; startFromEnd = false; }
      if (s.coords[s.coords.length-1][0] > maxLon)       { maxLon = s.coords[s.coords.length-1][0];       startIdx = i; startFromEnd = true;  }
    });
  }

  const used      = new Set([startIdx]);
  const startSeg  = segs[startIdx];
  const initCoords = startFromEnd ? startSeg.coords.slice().reverse() : startSeg.coords.slice();
  const chain      = [{ coords: initCoords, segType: startSeg.segType }];

  while (used.size < segs.length) {
    const lastRun = chain[chain.length - 1];
    const tail    = lastRun.coords[lastRun.coords.length - 1];

    let bestDist = Infinity, bestIdx = -1, bestRev = false;
    segs.forEach((s, i) => {
      if (used.has(i)) return;
      const d1 = haversine(tail[1], tail[0], s.coords[0][1],                        s.coords[0][0]);
      const d2 = haversine(tail[1], tail[0], s.coords[s.coords.length-1][1], s.coords[s.coords.length-1][0]);
      if (d1 < bestDist) { bestDist = d1; bestIdx = i; bestRev = false; }
      if (d2 < bestDist) { bestDist = d2; bestIdx = i; bestRev = true;  }
    });

    if (bestIdx === -1) break;
    used.add(bestIdx);

    const seg       = segs[bestIdx];
    const segCoords = bestRev ? seg.coords.slice().reverse() : seg.coords.slice();

    if (seg.segType === lastRun.segType && bestDist <= maxGap) {
      // Features are essentially touching — extend the current run.
      // Include all coords of the next segment (not slice(1)) so that even a
      // tiny gap is represented faithfully rather than silently dropped.
      lastRun.coords.push(...segCoords);
    } else {
      // Gap is too large, or different segType — start a new run.
      chain.push({ coords: segCoords, segType: seg.segType });
    }
  }

  return chain;
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

function interpolateAtAcrossRuns(runs, targetDist) {
  let acc = 0;
  for (const run of runs) {
    const len = pathLen(run.coords);
    if (acc + len >= targetDist) return interpolateAt(run.coords, targetDist - acc);
    acc += len;
  }
  const last = runs[runs.length - 1];
  return last.coords[last.coords.length - 1];
}

function totalRunLength(runs) {
  return runs.reduce((s, r) => s + pathLen(r.coords), 0);
}

function lastCoord(runs) {
  const last = runs[runs.length - 1];
  return last.coords[last.coords.length - 1];
}

function firstCoord(runs) {
  return runs[0].coords[0];
}

// ── build points for a stitched chain ─────────────────────────────────────────
function buildChainPoints(runs, axisOffset, sectionId, regionId, altId = null) {
  const len    = totalRunLength(runs);
  const points = [];
  const firstM = Math.round(axisOffset * 10) / 10;  // first 0.1-mile mark at/after axisOffset
  const firstLocal = 0;

  for (let localDist = 0; localDist <= len + 0.001; localDist = Math.round((localDist + INTERVAL_MILES) * 1000) / 1000) {
    const axisMile   = Math.round((axisOffset + localDist) * 1000) / 1000;
    const sectMile   = Math.round(localDist * 1000) / 1000;
    const coord      = interpolateAtAcrossRuns(runs, Math.min(localDist, len));
    const lon        = Math.round(coord[0] * 1e6) / 1e6;
    const lat        = Math.round(coord[1] * 1e6) / 1e6;
    const mileInt    = Math.round(axisMile * 10000);
    const idSuffix   = altId ? `-${altId}` : '';
    const id         = `pht-${sectionId}${idSuffix}-mi${String(mileInt).padStart(8, '0')}`;
    const pt         = { id, mile: axisMile, lat, lon, region: regionId, section_id: sectionId, section_mile: sectMile };
    if (altId) pt.alt_id = altId;
    points.push(pt);
  }

  // Ensure endpoint is included
  const endLocal = len;
  const endAxis  = Math.round((axisOffset + endLocal) * 1000) / 1000;
  if (!points.length || Math.abs(points[points.length - 1].mile - endAxis) > 0.05) {
    const coord   = lastCoord(runs);
    const mileInt = Math.round(endAxis * 10000);
    const idSuffix = altId ? `-${altId}` : '';
    points.push({
      id:          `pht-${sectionId}${idSuffix}-mi${String(mileInt).padStart(8, '0')}`,
      mile:        endAxis,
      lat:         Math.round(coord[1] * 1e6) / 1e6,
      lon:         Math.round(coord[0] * 1e6) / 1e6,
      region:      regionId,
      section_id:  sectionId,
      section_mile: Math.round(endLocal * 1000) / 1000,
      ...(altId ? { alt_id: altId } : {}),
    });
  }

  return { points, miles: len };
}

// ── build WP-only section points ──────────────────────────────────────────────
function buildWpPoints(runs, sectionId, regionId) {
  const len    = totalRunLength(runs);
  const points = [];
  for (let localDist = 0; localDist <= len + 0.001; localDist = Math.round((localDist + INTERVAL_MILES) * 1000) / 1000) {
    const sectMile = Math.round(localDist * 1000) / 1000;
    const coord    = interpolateAtAcrossRuns(runs, Math.min(localDist, len));
    const mileInt  = Math.round(sectMile * 10000);
    points.push({
      id:          `pht-${sectionId}-mi${String(mileInt).padStart(8, '0')}`,
      lat:         Math.round(coord[1] * 1e6) / 1e6,
      lon:         Math.round(coord[0] * 1e6) / 1e6,
      region:      regionId,
      section_id:  sectionId,
      section_mile: sectMile,
      on_spine:    false,
    });
  }
  return { points, miles: len };
}

// ── slugify a MAPLABEL into a section_id ──────────────────────────────────────
function toSlug(label) {
  return label.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── group Northern Virginia features by named section ────────────────────────
function groupNvaBySection(features) {
  const groups = {};
  for (const f of features) {
    const maplab = (f.attributes.MAPLABEL || '').trim();
    const trname = (f.attributes.TRNAME  || '').trim();
    const key    = maplab || trname || 'northern-virginia-unnamed';
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  }
  return groups;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(BASE, { recursive: true });

  // 1. Fetch all features
  const allFeatures = await fetchAllFeatures();

  // 2. Classify by region / DC role
  console.log('\nClassifying features…');
  const chains = classifyFeatures(allFeatures);

  // 3. Assign unclassified DC features spatially
  console.log('\nAssigning unclassified DC features…');
  assignDcOther(chains);

  // 4. Stitch each spine section (east → west)
  console.log('\nStitching spine sections…');

  // 4a. Southern Maryland — start from most-eastern point (near Point Lookout)
  console.log('  Southern Maryland…');
  const smdRuns = stitchChain(chains.spine_smd, null);
  const smdLen  = totalRunLength(smdRuns);
  console.log(`    ${smdRuns.length} runs, ${smdLen.toFixed(2)} mi`);

  // 4b. DC River Trail — start from the end of the SMD chain (SE DC)
  // DC_MAX_GAP_MI prevents straight-line bridges across city blocks.
  const smdEnd = lastCoord(smdRuns);
  console.log('  DC River Trail…');
  const dcRiverRuns = stitchChain(chains.dc_river, smdEnd, DC_MAX_GAP_MI);
  const dcRiverLen  = totalRunLength(dcRiverRuns);
  console.log(`    ${dcRiverRuns.length} runs, ${dcRiverLen.toFixed(2)} mi`);

  // 4c. DC City Park Trail — also start from end of SMD chain
  console.log('  DC City Park Trail…');
  const dcCityRuns = stitchChain(chains.dc_city, smdEnd, DC_MAX_GAP_MI);
  const dcCityLen  = totalRunLength(dcCityRuns);
  console.log(`    ${dcCityRuns.length} runs, ${dcCityLen.toFixed(2)} mi`);

  // The rejoin point is the Georgetown / C&O Canal start.
  // Use the end of the River Trail (main alt) as the anchor for C&O stitching.
  const dcRiverEnd = lastCoord(dcRiverRuns);

  // 4d. C&O Canal — start from Georgetown (≈ end of River Trail)
  console.log('  C&O Canal…');
  const choRuns = stitchChain(chains.spine_cho, dcRiverEnd);
  const choLen  = totalRunLength(choRuns);
  console.log(`    ${choRuns.length} runs, ${choLen.toFixed(2)} mi`);

  // 4e. GAP — start from end of C&O (Cumberland, MD)
  const choEnd = lastCoord(choRuns);
  console.log('  Great Allegheny Passage…');
  const gapRuns = stitchChain(chains.spine_gap, choEnd);
  const gapLen  = totalRunLength(gapRuns);
  console.log(`    ${gapRuns.length} runs, ${gapLen.toFixed(2)} mi`);

  // 4f. Laurel Highlands — start from end of GAP (Ohiopyle, PA)
  const gapEnd = lastCoord(gapRuns);
  console.log('  Laurel Highlands…');
  const lhtRuns = stitchChain(chains.spine_lht, gapEnd);
  const lhtLen  = totalRunLength(lhtRuns);
  console.log(`    ${lhtRuns.length} runs, ${lhtLen.toFixed(2)} mi`);

  // 5. Compute axis-mile boundaries
  const branchMile = Math.round(smdLen * 1000) / 1000;
  const rejoinMile = Math.round((smdLen + dcRiverLen) * 1000) / 1000;  // based on main alt
  const choStart   = rejoinMile;
  const choEnd2    = Math.round((rejoinMile + choLen) * 1000) / 1000;
  const gapStart   = choEnd2;
  const gapEnd2    = Math.round((gapStart + gapLen) * 1000) / 1000;
  const lhtStart   = gapEnd2;
  const lhtEnd2    = Math.round((lhtStart + lhtLen) * 1000) / 1000;
  const totalSpineMiles = lhtEnd2;

  console.log('\nAxis-mile summary:');
  console.log(`  Southern Maryland    : 0 → ${branchMile.toFixed(2)}`);
  console.log(`  DC River Trail (main): ${branchMile.toFixed(2)} → ${rejoinMile.toFixed(2)} (${dcRiverLen.toFixed(2)} mi)`);
  console.log(`  DC City Park (alt)   : ${branchMile.toFixed(2)} → ${(branchMile + dcCityLen).toFixed(2)} (${dcCityLen.toFixed(2)} mi)`);
  console.log(`  C&O Canal            : ${choStart.toFixed(2)} → ${choEnd2.toFixed(2)}`);
  console.log(`  Great Allegheny Pass.: ${gapStart.toFixed(2)} → ${gapEnd2.toFixed(2)}`);
  console.log(`  Laurel Highlands     : ${lhtStart.toFixed(2)} → ${lhtEnd2.toFixed(2)}`);
  console.log(`  Total spine          : ${totalSpineMiles.toFixed(2)} mi`);

  // 6. Build spine points
  console.log('\nBuilding spine points…');
  const allPoints = [];

  const smdResult     = buildChainPoints(smdRuns,     0,          'southern-maryland',  'southern-maryland');
  const riverResult   = buildChainPoints(dcRiverRuns, branchMile, 'dc-river-trail',     'washington-dc', 'river-trail');
  const cityResult    = buildChainPoints(dcCityRuns,  branchMile, 'dc-city-park-trail', 'washington-dc', 'city-park-trail');
  const choResult     = buildChainPoints(choRuns,     choStart,   'co-canal',           'co-canal-nhp');
  const gapResult     = buildChainPoints(gapRuns,     gapStart,   'great-allegheny-passage', 'great-allegheny-passage');
  const lhtResult     = buildChainPoints(lhtRuns,     lhtStart,   'laurel-highlands',   'laurel-highlands');

  allPoints.push(...smdResult.points);
  allPoints.push(...riverResult.points);
  allPoints.push(...cityResult.points);
  allPoints.push(...choResult.points);
  allPoints.push(...gapResult.points);
  allPoints.push(...lhtResult.points);

  console.log(`  Spine points: ${allPoints.length}`);

  // 7. Build Weather-Planner-only points
  // Also accumulate stitched runs so they can be added to trail.geojson below.
  console.log('\nBuilding Weather-Planner-only points…');

  // wpRunSets collects { sectionId, regionId, runs } for every WP-only section
  // so step 8 can emit them into the GeoJSON alongside the spine sections.
  const wpRunSets = [];

  // 7a. Northern Neck of Virginia — treat as a single section
  const nnRuns   = stitchChain(chains.wp_nn, null);
  const nnResult = buildWpPoints(nnRuns, 'northern-neck', 'northern-neck-virginia');
  allPoints.push(...nnResult.points);
  wpRunSets.push({ sectionId: 'northern-neck', regionId: 'northern-neck-virginia', runs: nnRuns });
  console.log(`  Northern Neck: ${nnResult.points.length} pts, ${nnResult.miles.toFixed(2)} mi`);

  // 7b. Northern Virginia — one section per named trail (MAPLABEL)
  const nvaGroups  = groupNvaBySection(chains.wp_nva);
  const nvaSections = [];
  let nvaTotalPts   = 0;

  for (const [label, feats] of Object.entries(nvaGroups)) {
    const slug = toSlug(label);
    const runs = stitchChain(feats, null);
    if (!runs.length) continue;
    const result = buildWpPoints(runs, slug, 'northern-virginia');
    allPoints.push(...result.points);
    nvaSections.push({ id: slug, name: label, miles: result.miles });
    wpRunSets.push({ sectionId: slug, regionId: 'northern-virginia', runs });
    nvaTotalPts += result.points.length;
  }
  console.log(`  Northern Virginia: ${nvaTotalPts} pts across ${nvaSections.length} sections`);

  // 7c. Eastern Continental Divide — one section per named trail (MAPLABEL)
  const ecdGroups  = groupNvaBySection(chains.wp_ecd);
  const ecdSections = [];
  let ecdTotalPts   = 0;
  for (const [label, feats] of Object.entries(ecdGroups)) {
    const slug = toSlug(label);
    const runs = stitchChain(feats, null);
    if (!runs.length) continue;
    const result = buildWpPoints(runs, slug, 'eastern-continental-divide');
    allPoints.push(...result.points);
    ecdSections.push({ id: slug, name: label, miles: result.miles });
    wpRunSets.push({ sectionId: slug, regionId: 'eastern-continental-divide', runs });
    ecdTotalPts += result.points.length;
  }
  console.log(`  Eastern Continental Divide: ${ecdTotalPts} pts across ${ecdSections.length} sections`);

  console.log(`\nTotal points: ${allPoints.length}`);

  // 8. Build trail.geojson — spine + all WP-only sections
  console.log('\nBuilding trail.geojson…');
  const geojsonFeatures = [];

  function runsToGeojson(runs, props) {
    for (const run of runs) {
      if (run.coords.length < 2) continue;
      geojsonFeatures.push({
        type: 'Feature',
        properties: props,
        geometry: { type: 'LineString', coordinates: run.coords },
      });
    }
  }

  // Spine sections
  runsToGeojson(smdRuns,     { section: 'southern-maryland',       segment_type: 'trail', on_spine: true,  alt_id: null });
  runsToGeojson(dcRiverRuns, { section: 'dc-river-trail',          segment_type: 'trail', on_spine: true,  alt_id: 'river-trail' });
  runsToGeojson(dcCityRuns,  { section: 'dc-city-park-trail',      segment_type: 'trail', on_spine: true,  alt_id: 'city-park-trail' });
  runsToGeojson(choRuns,     { section: 'co-canal',                segment_type: 'trail', on_spine: true,  alt_id: null });
  runsToGeojson(gapRuns,     { section: 'great-allegheny-passage', segment_type: 'trail', on_spine: true,  alt_id: null });
  runsToGeojson(lhtRuns,     { section: 'laurel-highlands',        segment_type: 'trail', on_spine: true,  alt_id: null });

  // Weather-Planner-only sections (Virginia + ECD)
  for (const { sectionId, regionId, runs } of wpRunSets) {
    runsToGeojson(runs, { section: sectionId, region: regionId, segment_type: 'trail', on_spine: false, alt_id: null });
  }

  fs.writeFileSync(OUT_GEO, JSON.stringify({ type: 'FeatureCollection', features: geojsonFeatures }));
  console.log(`  ${geojsonFeatures.length} features → ${OUT_GEO}`);

  // 9. Write points.json
  fs.writeFileSync(OUT_POINTS, JSON.stringify(allPoints, null, 2));
  console.log(`  ${allPoints.length} points → ${OUT_POINTS}`);

  // 10. Build pht_meta.json
  console.log('\nBuilding pht_meta.json…');

  // Map center from spine points bounding box
  const spinePts = allPoints.filter(p => p.mile !== undefined);
  const lats = spinePts.map(p => p.lat);
  const lons = spinePts.map(p => p.lon);
  const mapCenter = [
    Math.round(((Math.min(...lats) + Math.max(...lats)) / 2) * 100) / 100,
    Math.round(((Math.min(...lons) + Math.max(...lons)) / 2) * 100) / 100,
  ];

  const meta = {
    trail: {
      name:              'Potomac Heritage National Scenic Trail',
      spine_miles:       Math.round(totalSpineMiles * 100) / 100,
      map_center:        mapCenter,
      map_zoom:          7,
      termini: {
        east: 'Point Lookout, MD',
        west: 'Laurel Ridge, PA',
      },
    },
    regions: [
      { id: 'southern-maryland',        name: 'Southern Maryland',                    on_spine: true  },
      { id: 'washington-dc',            name: 'Washington D.C.',                      on_spine: true  },
      { id: 'co-canal-nhp',             name: 'Chesapeake and Ohio Canal',             on_spine: true  },
      { id: 'great-allegheny-passage',  name: 'Great Allegheny Passage',              on_spine: true  },
      { id: 'laurel-highlands',         name: 'Laurel Highlands',                     on_spine: true  },
      { id: 'northern-virginia',        name: 'Northern Virginia',                    on_spine: false },
      { id: 'northern-neck-virginia',   name: 'Northern Neck of Virginia',            on_spine: false },
      { id: 'eastern-continental-divide', name: 'Eastern Continental Divide',         on_spine: false },
    ],
    sections: [
      { id: 'southern-maryland',        name: 'Southern Maryland',        region: 'southern-maryland',       on_spine: true,  mile_start: 0,        mile_end: branchMile  },
      { id: 'dc-river-trail',           name: 'DC River Trail',           region: 'washington-dc',           on_spine: true,  mile_start: branchMile, mile_end: rejoinMile, alt_id: 'river-trail'    },
      { id: 'dc-city-park-trail',       name: 'DC City Park Trail',       region: 'washington-dc',           on_spine: true,  mile_start: branchMile, mile_end: Math.round((branchMile + dcCityLen) * 1000) / 1000, alt_id: 'city-park-trail' },
      { id: 'co-canal',                 name: 'C&O Canal Towpath',        region: 'co-canal-nhp',            on_spine: true,  mile_start: choStart,  mile_end: choEnd2     },
      { id: 'great-allegheny-passage',  name: 'Great Allegheny Passage',  region: 'great-allegheny-passage', on_spine: true,  mile_start: gapStart,  mile_end: gapEnd2     },
      { id: 'laurel-highlands',         name: 'Laurel Highlands Trail',   region: 'laurel-highlands',        on_spine: true,  mile_start: lhtStart,  mile_end: lhtEnd2     },
      { id: 'northern-neck',            name: 'Northern Neck of Virginia',region: 'northern-neck-virginia',  on_spine: false, mile_start: 0, mile_end: Math.round(nnResult.miles * 100) / 100 },
      ...nvaSections.map(s => ({
        id: s.id, name: s.name, region: 'northern-virginia', on_spine: false,
        mile_start: 0, mile_end: Math.round(s.miles * 100) / 100,
      })),
      ...ecdSections.map(s => ({
        id: s.id, name: s.name, region: 'eastern-continental-divide', on_spine: false,
        mile_start: 0, mile_end: Math.round(s.miles * 100) / 100,
      })),
    ],
    alt_groups: [
      {
        id:              'dc-route',
        label:           'Washington D.C. Route',
        branch_mile:     branchMile,
        rejoin_mile:     rejoinMile,
        main: {
          id:          'river-trail',
          label:       'DC River Trail',
          total_miles: Math.round(dcRiverLen * 100) / 100,
          note:        'Anacostia Riverwalk → Potomac River Trail → Georgetown waterfront',
        },
        alt: {
          id:          'city-park-trail',
          label:       'DC City Park Trail',
          total_miles: Math.round(dcCityLen * 100) / 100,
          delta_miles: Math.round((dcCityLen - dcRiverLen) * 100) / 100,
          note:        'Civil War Defenses of Washington → Fort Circle → Georgetown',
        },
      },
    ],
    direction_options: [
      {
        id:          'westbound',
        label:       'Westbound \u2014 Point Lookout, MD \u2192 Laurel Ridge, PA',
        total_miles: Math.round(totalSpineMiles * 100) / 100,
        is_westbound: true,
      },
      {
        id:          'eastbound',
        label:       'Eastbound \u2014 Laurel Ridge, PA \u2192 Point Lookout, MD',
        total_miles: Math.round(totalSpineMiles * 100) / 100,
        is_westbound: false,
      },
    ],
  };

  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2));
  console.log(`  Written: ${OUT_META}`);

  // 11. Summary
  console.log('\n=== Done ===');
  console.log(`Spine miles       : ${totalSpineMiles.toFixed(2)}`);
  console.log(`Total points      : ${allPoints.length}`);
  console.log(`GeoJSON features  : ${geojsonFeatures.length}`);
  console.log(`Branch mile (DC)  : ${branchMile.toFixed(3)}`);
  console.log(`Rejoin mile (DC)  : ${rejoinMile.toFixed(3)}`);
  console.log('\nNorthern Virginia sections:');
  nvaSections.forEach(s => console.log(`  ${s.id.padEnd(40)} ${s.miles.toFixed(2)} mi`));
  console.log('\nEastern Continental Divide sections:');
  ecdSections.forEach(s => console.log(`  ${s.id.padEnd(40)} ${s.miles.toFixed(2)} mi`));
  console.log('\nDelete _raw_pht.json to force a fresh fetch from NPS ArcGIS.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
