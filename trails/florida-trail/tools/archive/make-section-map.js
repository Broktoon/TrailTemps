#!/usr/bin/env node
/**
 * Build a Trail_Name -> canonical Section mapping template.
 *
 * Outputs:
 *  - trails/florida-trail/data/section_map.json
 *
 * Each entry has:
 *  - observed: the Trail_Name value from ArcGIS
 *  - canonical: set to "" initially (you fill with one of your exact Section identifiers)
 *  - count: number of features using this Trail_Name
 */

const fs = require("fs");
const path = require("path");

const RAW = "trails/florida-trail/data/trail_raw.geojson";
const OUT = "trails/florida-trail/data/section_map.json";

const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));

const counts = new Map();
for (const f of raw.features || []) {
  const v = String(f.properties?.Trail_Name || "").trim();
  if (!v) continue;
  counts.set(v, (counts.get(v) || 0) + 1);
}

const rows = [...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([observed, count]) => ({ observed, canonical: "", count }));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows, null, 2) + "\n", "utf8");

console.log(`Wrote ${rows.length} Trail_Name entries -> ${OUT}`);
console.log(`Fill canonical with one of your exact Section identifiers, then re-run build-points.`);