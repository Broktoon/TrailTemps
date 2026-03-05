#!/usr/bin/env node
/**
 * trails/florida-trail/tools/build-points.js
 *
 * Builds trails/florida-trail/data/points.json from:
 *  - trails/florida-trail/data/trail_raw.geojson (USFS ArcGIS export, 739 features w/ attributes)
 *  - trails/florida-trail/data/trail.geojson     (mapshaper dissolved overlay; may be GeometryCollection)
 *
 * Output schema (per your Florida notes):
 *  - id:      ft-{route}-mi{mile*1000 padded to 7 digits}
 *  - state:   "FL"
 *  - segment: "Southern" | "Central" | "Northern" | "Panhandle"
 *  - section: EXACT strings from your lists
 *  - route:   EXACT route scheme IDs
 *  - lat/lon: numbers
 *  - mile:    spine-referenced, south→north
 *  - cell_id: 0.1° rounding dedupe key
 *
 * Usage:
 *   node trails/florida-trail/tools/build-points.js --step 10
 */

const fs = require("fs");
const path = require("path");

const RAW = "trails/florida-trail/data/trail_raw.geojson";
const SPINE = "trails/florida-trail/data/trail.geojson";
const OUT = "trails/florida-trail/data/points.json";

function arg(name, defVal = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return defVal;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return defVal;
  return v;
}
const STEP_MILES = Number(arg("--step", "10")) || 10;

// ArcGIS field names (confirmed via mapshaper -info)
const SECTION_FIELD = "Trail_Name"; // e.g., 'Okeechobee North'
const ENG_SEG_FIELD = "Eng_Seg";    // optional, used for blackwater extension heuristic

// ------------------ Canonical segment/section/route spec ------------------

// Segment identifiers (EXACT)
const SEGMENTS = ["Southern", "Central", "Northern", "Panhandle"];

// Section identifiers (EXACT)
const SECTIONS = [
  // Southern (7)
  "Okeechobee North",
  "Okeechobee West",
  "Okeechobee East",
  "Okeechobee South",
  "Seminole Tribe Reservation",
  "Big Cypress North",
  "Big Cypress South",

  // Central (11)
  "Lake Jesup",
  "Tosohatchee",
  "Richloam/Green Swamp West",
  "Green Swamp East",
  "Reedy Creek",
  "Upper Kissimmee",
  "Three Lakes",
  "Bull Creek",
  "Kissimmee Prairie Preserve State Park",
  "Kissimmee Island Cattle Company (KICCO)",
  "Kissimmee River",

  // Northern (12)
  "Suwannee River",
  "Osceola National Forest",
  "Lake Butler Forest",
  "Camp Blanding",
  "Rice Creek/Etoniah/Gold Head",
  "Ocala North",
  "Ocala South",
  "Cross Florida Greenway East and Ocala West",
  "Cross Florida Greenway West",
  "Citrus",
  "Croom",
  "Cassia",

  // Panhandle (13)
  "Seashore",
  "Blackwater",
  "Eglin West",
  "Eglin North",
  "Eglin East",
  "Nokuse",
  "Pine Log",
  "Econfina Creek",
  "Econfina River",
  "Chipola",
  "Apalachicola East",
  "Apalachicola West",
  "Byrd Hammock",
];

// section->segment map
const southernSet = new Set([
  "Okeechobee North",
  "Okeechobee West",
  "Okeechobee East",
  "Okeechobee South",
  "Seminole Tribe Reservation",
  "Big Cypress North",
  "Big Cypress South",
]);
const centralSet = new Set([
  "Lake Jesup",
  "Tosohatchee",
  "Richloam/Green Swamp West",
  "Green Swamp East",
  "Reedy Creek",
  "Upper Kissimmee",
  "Three Lakes",
  "Bull Creek",
  "Kissimmee Prairie Preserve State Park",
  "Kissimmee Island Cattle Company (KICCO)",
  "Kissimmee River",
]);
const northernSet = new Set([
  "Suwannee River",
  "Osceola National Forest",
  "Lake Butler Forest",
  "Camp Blanding",
  "Rice Creek/Etoniah/Gold Head",
  "Ocala North",
  "Ocala South",
  "Cross Florida Greenway East and Ocala West",
  "Cross Florida Greenway West",
  "Citrus",
  "Croom",
  "Cassia",
]);
const panhandleSet = new Set([
  "Seashore",
  "Blackwater",
  "Eglin West",
  "Eglin North",
  "Eglin East",
  "Nokuse",
  "Pine Log",
  "Econfina Creek",
  "Econfina River",
  "Chipola",
  "Apalachicola East",
  "Apalachicola West",
  "Byrd Hammock",
]);

const sectionToSegment = new Map();
for (const s of SECTIONS) {
  if (southernSet.has(s)) sectionToSegment.set(s, "Southern");
  else if (centralSet.has(s)) sectionToSegment.set(s, "Central");
  else if (northernSet.has(s)) sectionToSegment.set(s, "Northern");
  else if (panhandleSet.has(s)) sectionToSegment.set(s, "Panhandle");
}

// Route variants (EXACT IDs you specified)
function routeForSection(section, props) {
  if (section === "Okeechobee East") return "main2-okee-east";
  if (section === "Okeechobee West") return "alt2-okee-west";

  if (section === "Cross Florida Greenway East and Ocala West") return "main3-east-corr";
  if (section === "Cross Florida Greenway West") return "alt3-west-corr";

  if (section === "Seashore") return "alt1-oceanlake";

  if (section === "Blackwater") {
    // If the dataset marks the extension in Eng_Seg, detect it.
    const eng = String(props?.[ENG_SEG_FIELD] ?? "").toLowerCase();
    if (eng.includes("ext") || eng.includes("extension")) return "alt4-blackwater-ext";
    // Otherwise treat as baseline (you can refine later if you have a better discriminator)
    return "main";
  }

  return "main";
}

// ------------------ Geometry / sampling helpers ------------------

const M_PER_MILE = 1609.344;
const R_EARTH_M = 6371008.8;

function toRad(d) { return (d * Math.PI) / 180; }

function haversineMeters(a, b) {
  const lon1 = toRad(a[0]), lat1 = toRad(a[1]);
  const lon2 = toRad(b[0]), lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + haversineMeters(coords[i - 1], coords[i]);
  }
  return cum;
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function sampleAlongLine(coords, stepMiles) {
  const stepM = stepMiles * M_PER_MILE;
  const cum = cumulative(coords);
  const total = cum[cum.length - 1];
  if (total <= 0) return [];

  const targets = [];
  for (let d = 0; d <= total + 0.5; d += stepM) targets.push(d);
  if (targets[targets.length - 1] < total) targets.push(total);

  const pts = [];
  let seg = 1;
  for (const td of targets) {
    while (seg < cum.length && cum[seg] < td) seg++;
    if (seg >= cum.length) seg = cum.length - 1;
    const d1 = cum[seg - 1];
    const d2 = cum[seg];
    const span = d2 - d1;
    const t = span > 0 ? (td - d1) / span : 0;
    const p = lerp(coords[seg - 1], coords[seg], Math.max(0, Math.min(1, t)));
    pts.push({ lon: p[0], lat: p[1] });
  }
  return pts;
}

function roundTo(x, dec) {
  const m = Math.pow(10, dec);
  return Math.round(x * m) / m;
}

function cellId(lat, lon) {
  return `${roundTo(lat, 1).toFixed(1)}_${roundTo(lon, 1).toFixed(1)}`;
}

function pad7(n) {
  const s = String(n);
  return s.length >= 7 ? s : "0".repeat(7 - s.length) + s;
}

function makeId(route, mile) {
  const mi1000 = Math.round(mile * 1000);
  return `ft-${route}-mi${pad7(mi1000)}`;
}

// ---- GeoJSON extraction for spine (handles GeometryCollection, FeatureCollection, Feature, bare geometry) ----

function geometriesToLineParts(geom) {
  // Returns array of LineString coordinate arrays (each is [[lon,lat],...])
  if (!geom) return [];

  if (geom.type === "LineString" && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
    return [geom.coordinates];
  }

  if (geom.type === "MultiLineString" && Array.isArray(geom.coordinates)) {
    return geom.coordinates.filter(part => Array.isArray(part) && part.length >= 2);
  }

  if (geom.type === "GeometryCollection" && Array.isArray(geom.geometries)) {
    const out = [];
    for (const g of geom.geometries) out.push(...geometriesToLineParts(g));
    return out;
  }

  return [];
}

function extractLinePartsFromAnyGeoJSON(geo) {
  if (!geo) return [];

  if (geo.type === "FeatureCollection" && Array.isArray(geo.features)) {
    const out = [];
    for (const f of geo.features) {
      if (f && f.type === "Feature") out.push(...geometriesToLineParts(f.geometry));
    }
    return out;
  }

  if (geo.type === "Feature") {
    return geometriesToLineParts(geo.geometry);
  }

  if (typeof geo.type === "string") {
    return geometriesToLineParts(geo);
  }

  if (geo.geometry && geo.geometry.type) {
    return geometriesToLineParts(geo.geometry);
  }

  return [];
}

function buildSpine(spineGeo) {
  const parts = extractLinePartsFromAnyGeoJSON(spineGeo);
  if (!parts.length) throw new Error("trail.geojson missing usable line geometry (no LineString/MultiLineString parts found)");

  // Concatenate parts into one vertex list (sufficient for nearest-vertex mile referencing)
  let spine = [];
  for (const part of parts) {
    if (!part?.length) continue;
    if (!spine.length) spine.push(...part);
    else {
      const prev = spine[spine.length - 1];
      const first = part[0];
      if (prev[0] === first[0] && prev[1] === first[1]) spine.push(...part.slice(1));
      else spine.push(...part);
    }
  }

  if (spine.length < 2) throw new Error("spine too short after concatenation");

  // Orient south->north by endpoint latitude
  if (spine[spine.length - 1][1] < spine[0][1]) spine.reverse();

  const cum = cumulative(spine);
  return { spine, cum };
}

function spineMileNearestVertex(spineIndex, lonlat) {
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < spineIndex.spine.length; i++) {
    const d = haversineMeters(lonlat, spineIndex.spine[i]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return spineIndex.cum[bestI] / M_PER_MILE;
}

// ---- Section canonicalization ----

const sectionLookup = new Map();
for (const s of SECTIONS) sectionLookup.set(s.toLowerCase(), s);

// You can add aliases here if the ArcGIS names differ slightly.
// Example:
// const SECTION_ALIASES = new Map([
//   ["richloam green swamp west", "Richloam/Green Swamp West"],
// ]);
const SECTION_ALIASES = new Map();

function canonicalSectionFromProps(props) {
  const raw = String(props?.[SECTION_FIELD] ?? "").trim();
  if (!raw) return null;

  const key = raw.toLowerCase();
  if (sectionLookup.has(key)) return sectionLookup.get(key);

  // try alias
  if (SECTION_ALIASES.has(key)) return SECTION_ALIASES.get(key);

  return null;
}

// ------------------ main ------------------

const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
const spineGeo = JSON.parse(fs.readFileSync(SPINE, "utf8"));
const spineIndex = buildSpine(spineGeo);

const out = [];
let unknownSectionCount = 0;

for (const f of raw.features || []) {
  const props = f.properties || {};
  const section = canonicalSectionFromProps(props);

  if (!section) {
    unknownSectionCount++;
    continue; // skip unmatched sections until you decide aliasing behavior
  }

  const segment = sectionToSegment.get(section);
  if (!segment || !SEGMENTS.includes(segment)) continue;

  const route = routeForSection(section, props);

  // sample each geometry part
  const geom = f.geometry;
  const parts = geometriesToLineParts(geom); // feature geometries are LineString/MultiLineString
  for (const part of parts) {
    if (!part || part.length < 2) continue;

    const pts = sampleAlongLine(part, STEP_MILES);
    for (const p of pts) {
      const mile = spineMileNearestVertex(spineIndex, [p.lon, p.lat]);

      out.push({
        id: makeId(route, mile),
        state: "FL",
        segment, // EXACT casing
        section, // EXACT string
        route,   // EXACT scheme ID
        lat: Number(p.lat.toFixed(6)),
        lon: Number(p.lon.toFixed(6)),
        mile: Number(mile.toFixed(3)),
        cell_id: cellId(p.lat, p.lon),
      });
    }
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(`Wrote ${out.length} points -> ${OUT}`);
console.log(`Step: ${STEP_MILES} miles`);
console.log(`Unmatched Trail_Name sections skipped: ${unknownSectionCount}`);
if (unknownSectionCount) {
  console.log(
    `TIP: List distinct Trail_Name values with:\n` +
      `node -e "const fs=require('fs'); const g=JSON.parse(fs.readFileSync('./${RAW}','utf8')); const set=new Set(); for(const f of g.features||[]){ const v=String(f.properties?.${SECTION_FIELD}||'').trim(); if(v) set.add(v);} console.log([...set].sort().join('\\\\n'))"`
  );
}