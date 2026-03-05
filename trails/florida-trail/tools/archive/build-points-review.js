#!/usr/bin/env node
/**
 * build-points-review.js
 *
 * Creates a mile-sorted review CSV sampled along the MAIN spine only:
 *  - MAIN spine is defined as raw features with Corridor === "Main"
 *  - Anything with Corridor !== "Main" is treated as ALT candidate geometry
 *
 * Inputs:
 *  - trails/florida-trail/data/trail_raw.geojson
 *
 * Output:
 *  - trails/florida-trail/data/points_review.csv
 *
 * Usage:
 *  node trails/florida-trail/tools/build-points-review.js --step 1
 *
 * Notes:
 *  - This script constructs a single ordered spine by greedily chaining Main corridor line parts.
 *  - It also reports the nearest ALT segment to each mile point (for split awareness).
 */

const fs = require("fs");
const path = require("path");

const RAW = "trails/florida-trail/data/trail_raw.geojson";
const OUT = "trails/florida-trail/data/points_review.csv";

function arg(name, defVal = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return defVal;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return defVal;
  return v;
}
const STEP_MILES = Number(arg("--step", "1")) || 1;

const M_PER_MILE = 1609.344;
const R_EARTH_M = 6371008.8;

// ---- geo helpers ----
function toRad(d) { return (d * Math.PI) / 180; }
function haversineMeters(a, b) {
  const lon1 = toRad(a[0]), lat1 = toRad(a[1]);
  const lon2 = toRad(b[0]), lat2 = toRad(b[1]);
  const dLat = lat2 - lat1, dLon = lon2 - lon1;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + haversineMeters(coords[i - 1], coords[i]);
  return cum;
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function csvEscape(s) {
  const v = String(s ?? "");
  if (v.includes('"') || v.includes(",") || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function geometriesToLineParts(geom) {
  if (!geom) return [];
  if (geom.type === "LineString" && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
    return [geom.coordinates];
  }
  if (geom.type === "MultiLineString" && Array.isArray(geom.coordinates)) {
    return geom.coordinates.filter(p => Array.isArray(p) && p.length >= 2);
  }
  if (geom.type === "GeometryCollection" && Array.isArray(geom.geometries)) {
    const out = [];
    for (const g of geom.geometries) out.push(...geometriesToLineParts(g));
    return out;
  }
  return [];
}

// ---- build MAIN spine by chaining line parts ----
//
// We take all line parts from Corridor==="Main" and connect them end-to-end by picking
// the nearest next part endpoint (greedy).
//
// This is robust enough for a centerline dataset like yours and avoids needing trail.geojson.
//
function buildMainSpineFromParts(parts) {
  if (!parts.length) throw new Error("No MAIN line parts found (Corridor==='Main').");

  // Each part: { coords, start, end }
  const items = parts
    .filter(p => p.length >= 2)
    .map(coords => ({
      coords,
      start: coords[0],
      end: coords[coords.length - 1],
      used: false
    }));

  // pick starting part: the part whose endpoints contain the southernmost latitude overall
  let startIdx = 0;
  let bestLat = Infinity;
  for (let i = 0; i < items.length; i++) {
    const aLat = items[i].start[1];
    const bLat = items[i].end[1];
    const minLat = Math.min(aLat, bLat);
    if (minLat < bestLat) { bestLat = minLat; startIdx = i; }
  }

  // orient starting part south->north (by endpoint latitude)
  let spine = [];
  {
    const it = items[startIdx];
    it.used = true;
    const sLat = it.start[1], eLat = it.end[1];
    spine = (eLat >= sLat) ? it.coords.slice() : it.coords.slice().reverse();
  }

  // greedy chaining: repeatedly append the unused part whose endpoint is nearest current end
  for (let k = 1; k < items.length; k++) {
    const tail = spine[spine.length - 1];

    let best = { i: -1, d: Infinity, reverse: false };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.used) continue;

      const dStart = haversineMeters(tail, it.start);
      const dEnd = haversineMeters(tail, it.end);

      if (dStart < best.d) best = { i, d: dStart, reverse: false };
      if (dEnd < best.d) best = { i, d: dEnd, reverse: true };
    }

    if (best.i === -1) break;

    const next = items[best.i];
    next.used = true;

    const coords = best.reverse ? next.coords.slice().reverse() : next.coords.slice();

    // If the first point duplicates the current tail, skip it
    const first = coords[0];
    if (first[0] === tail[0] && first[1] === tail[1]) {
      spine.push(...coords.slice(1));
    } else {
      spine.push(...coords);
    }
  }

  // final orientation check south->north
  if (spine[spine.length - 1][1] < spine[0][1]) spine.reverse();

  return spine;
}

// Sample the spine at fixed mile increments
function sampleSpineByMile(spineCoords, stepMiles) {
  const cum = cumulative(spineCoords);
  const totalM = cum[cum.length - 1];
  const stepM = stepMiles * M_PER_MILE;

  const targets = [];
  for (let d = 0; d <= totalM + 0.5; d += stepM) targets.push(d);
  if (targets[targets.length - 1] < totalM) targets.push(totalM);

  const pts = [];
  let seg = 1;
  for (const td of targets) {
    while (seg < cum.length && cum[seg] < td) seg++;
    if (seg >= cum.length) seg = cum.length - 1;

    const d1 = cum[seg - 1], d2 = cum[seg];
    const span = d2 - d1;
    const t = span > 0 ? (td - d1) / span : 0;

    const p = lerp(spineCoords[seg - 1], spineCoords[seg], Math.max(0, Math.min(1, t)));
    pts.push({ mile: td / M_PER_MILE, lon: p[0], lat: p[1] });
  }
  return pts;
}

// Nearest feature search (vertex scan). Fast enough at ~739 features and ~1k–1.5k mile points.
// For each feature we pre-flatten its vertices once.
function preFlattenVertices(features) {
  return features.map(f => {
    const verts = geometriesToLineParts(f.geometry).flat();
    return { f, verts };
  }).filter(x => x.verts && x.verts.length);
}

function nearestFeature(preFlat, ptLonLat) {
  let best = { d: Infinity, f: null };
  for (const item of preFlat) {
    const verts = item.verts;
    // scan vertices
    for (let i = 0; i < verts.length; i++) {
      const d = haversineMeters(ptLonLat, verts[i]);
      if (d < best.d) best = { d, f: item.f };
    }
  }
  return best;
}

// ---- main ----
const rawGeo = JSON.parse(fs.readFileSync(RAW, "utf8"));
const feats = rawGeo.features || [];

const mainFeats = feats.filter(f => String(f.properties?.Corridor || "").trim() === "Main");
const altFeats = feats.filter(f => String(f.properties?.Corridor || "").trim() !== "Main");

if (!mainFeats.length) {
  throw new Error(`No MAIN features found. Check that properties.Corridor uses exact "Main".`);
}

const mainParts = mainFeats.flatMap(f => geometriesToLineParts(f.geometry));
const spineCoords = buildMainSpineFromParts(mainParts);
const spinePts = sampleSpineByMile(spineCoords, STEP_MILES);

// pre-flatten for nearest queries
const mainFlat = preFlattenVertices(mainFeats);
const altFlat = preFlattenVertices(altFeats);

// CSV header: include both nearest MAIN and nearest ALT info
const header = [
  "mile",
  "lat",
  "lon",

  "nearest_main_m",
  "main_Trail_Name",
  "main_Corridor",
  "main_Trail_ID",
  "main_LandUnit_N",
  "main_Manager_Na",
  "main_Eng_Seg",
  "main_Start_Seg",

  "nearest_alt_m",
  "alt_Trail_Name",
  "alt_Corridor",
  "alt_Trail_ID",
  "alt_LandUnit_N",
  "alt_Manager_Na",
  "alt_Eng_Seg",
  "alt_Start_Seg",

  "canonical_section",
  "segment",
  "route"
];

const rows = [header.join(",")];

for (const p of spinePts) {
  const pt = [p.lon, p.lat];

  const nearMain = nearestFeature(mainFlat, pt);
  const mp = nearMain.f?.properties || {};

  const nearAlt = altFlat.length ? nearestFeature(altFlat, pt) : { d: Infinity, f: null };
  const ap = nearAlt.f?.properties || {};

  rows.push([
    p.mile.toFixed(3),
    p.lat.toFixed(6),
    p.lon.toFixed(6),

    isFinite(nearMain.d) ? nearMain.d.toFixed(1) : "",
    csvEscape(mp.Trail_Name),
    csvEscape(mp.Corridor),
    csvEscape(mp.Trail_ID),
    csvEscape(mp.LandUnit_N),
    csvEscape(mp.Manager_Na),
    csvEscape(mp.Eng_Seg),
    csvEscape(mp.Start_Seg),

    isFinite(nearAlt.d) ? nearAlt.d.toFixed(1) : "",
    csvEscape(ap.Trail_Name),
    csvEscape(ap.Corridor),
    csvEscape(ap.Trail_ID),
    csvEscape(ap.LandUnit_N),
    csvEscape(ap.Manager_Na),
    csvEscape(ap.Eng_Seg),
    csvEscape(ap.Start_Seg),

    "",
    "",
    ""
  ].join(","));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, rows.join("\n") + "\n", "utf8");

console.log(`MAIN features: ${mainFeats.length} | ALT features: ${altFeats.length}`);
console.log(`MAIN line parts: ${mainParts.length} | spine vertices: ${spineCoords.length}`);
console.log(`Wrote ${spinePts.length} review points -> ${OUT}`);
console.log(`Step: ${STEP_MILES} miles`);
console.log(`Tip: ALT columns help you detect split regions (nearest_alt_m small + alt_Corridor not empty).`);