#!/usr/bin/env node
/* =============================================================================
   fetch-points-azt.js
   Fetches the AZT polyline from ArcGIS, interpolates at 0.5-mile intervals,
   and writes data/points.json. No Open-Meteo calls.

   Run BEFORE generate-normals-azt.js.

   Usage:  node trails/arizona-trail/tools/fetch-points-azt.js
   ============================================================================= */

import { writeFileSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dir     = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.resolve(__dir, "../data");
const META_PATH = path.join(DATA_DIR, "azt_meta.json");
const PTS_OUT   = path.join(DATA_DIR, "points.json");

const POINTS_INTERVAL_MI = 0.5;
const METERS_PER_MI      = 1609.344;
const MI_PER_METER       = 0.000621371;
const PAGE_SIZE          = 1000;

const ARCGIS_BASE =
  "https://services3.arcgis.com/IKBBLZOXy58PXgpl/arcgis/rest/services/" +
  "Arizona_National_Scenic_Trail_Feature_Layers_view/FeatureServer";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* --- Passage lookup -------------------------------------------------------- */

const aztMeta  = JSON.parse(readFileSync(META_PATH, "utf8"));
const passages = aztMeta.passages.filter(p => !p.alt_variant || p.alt_variant === "main");

function passageIdForMile(spineMile) {
  for (const p of passages) {
    if (spineMile >= p.mile_start && spineMile <= p.mile_end) return p.id;
  }
  if (spineMile < passages[0].mile_start) return passages[0].id;
  return passages[passages.length - 1].id;
}

/* --- ArcGIS fetch ---------------------------------------------------------- */

async function fetchPolylineFeatures() {
  console.log("Fetching AZT polyline from ArcGIS (Layer 3) …");
  let all = [], offset = 0;
  while (true) {
    const url =
      `${ARCGIS_BASE}/3/query?where=1%3D1&f=geojson&outFields=Passage,Miles` +
      `&returnZ=true&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`ArcGIS fetch failed: ${res.status}`);
    const gj   = await res.json();
    const feats = gj.features || [];
    all = all.concat(feats);
    console.log(`  …${all.length} features fetched`);
    if (feats.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(300);
  }
  return all;
}

/* --- Geometry helpers ------------------------------------------------------ */

function passageNumericKey(passageStr) {
  // "11e" → 11.5 so it sorts between 11 and 12
  const s = String(passageStr ?? "").trim();
  if (/^\d+e$/i.test(s)) return parseInt(s) + 0.5;
  return parseFloat(s) || 0;
}

function buildOrderedCoords(features) {
  // Sort by passage number (the `passage` field is the passage number, not cumulative miles)
  features.sort((a, b) =>
    passageNumericKey(a.properties?.passage ?? a.properties?.Passage) -
    passageNumericKey(b.properties?.passage ?? b.properties?.Passage)
  );

  const coords = [];
  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom) continue;
    const rings = geom.type === "LineString"      ? [geom.coordinates]
                : geom.type === "MultiLineString"  ? geom.coordinates
                : [];
    for (const ring of rings) {
      if (!coords.length) coords.push(...ring);
      else                coords.push(...ring.slice(1));
    }
  }
  console.log(`Assembled ${coords.length} coordinate vertices.`);
  return coords;
}

function haversineMeters(lon1, lat1, lon2, lat2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const dφ = (lat2 - lat1) * Math.PI / 180;
  const dλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function interpolate(c1, c2, t) {
  return {
    lon:    c1[0] + t * (c2[0] - c1[0]),
    lat:    c1[1] + t * (c2[1] - c1[1]),
    elev_m: (c1[2] != null && c2[2] != null) ? c1[2] + t * (c2[2] - c1[2]) : null,
  };
}

function sampleAlongPolyline(coords, intervalMi) {
  const intervalM    = intervalMi * METERS_PER_MI;
  const samples      = [];
  let cumDist        = 0;
  let nextSampleDist = 0;

  for (let i = 1; i < coords.length; i++) {
    const prev   = coords[i - 1];
    const curr   = coords[i];
    const segLen = haversineMeters(prev[0], prev[1], curr[0], curr[1]);
    if (segLen === 0) continue;

    while (nextSampleDist <= cumDist + segLen) {
      const t  = (nextSampleDist - cumDist) / segLen;
      const pt = interpolate(prev, curr, Math.max(0, Math.min(1, t)));
      samples.push({ ...pt, spine_mile: nextSampleDist * MI_PER_METER });
      nextSampleDist += intervalM;
    }
    cumDist += segLen;
  }

  // Ensure the final terminus is included
  const last     = coords[coords.length - 1];
  const totalMi  = cumDist * MI_PER_METER;
  if (!samples.length || totalMi - samples[samples.length - 1].spine_mile > intervalMi * 0.5) {
    samples.push({ lon: last[0], lat: last[1], elev_m: last[2] ?? null, spine_mile: totalMi });
  }

  console.log(`Sampled ${samples.length} points at ${intervalMi}-mile intervals.`);
  console.log(`Total trail length from geometry: ${totalMi.toFixed(1)} miles.`);
  return samples;
}

/* --- Build points.json ----------------------------------------------------- */

function buildPointsJson(samples) {
  return samples.map(s => {
    const mile       = Math.round(s.spine_mile * 10) / 10;
    const id         = `azt-main-mi${String(Math.round(mile * 10)).padStart(5, "0")}`;
    const passageId  = passageIdForMile(mile);
    // Z coordinates from this ArcGIS service are already in feet
    const trailElevFt = s.elev_m != null ? Math.round(s.elev_m) : null;

    const pt = {
      id,
      mile,
      lat:        Math.round(s.lat * 1e6) / 1e6,
      lon:        Math.round(s.lon * 1e6) / 1e6,
      passage_id: passageId,
    };
    if (trailElevFt != null) pt.trail_elev = trailElevFt;
    return pt;
  });
}

/* --- Main ------------------------------------------------------------------ */

async function main() {
  const features = await fetchPolylineFeatures();
  const coords   = buildOrderedCoords(features);
  const samples  = sampleAlongPolyline(coords, POINTS_INTERVAL_MI);
  const points   = buildPointsJson(samples);

  writeFileSync(PTS_OUT, JSON.stringify(points, null, 2), "utf8");
  console.log(`\nWrote ${points.length} points to ${PTS_OUT}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
