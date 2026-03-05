#!/usr/bin/env node
/**
 * Download ArcGIS FeatureServer layer to GeoJSON.
 * Uses POST for /query to avoid IIS/ArcGIS URL length limits (which can surface as HTML 404 pages).
 *
 * Usage (single line):
 *   node trails/florida-trail/tools/download-trail-geojson.js --layerUrl "https://.../FeatureServer/0" --out "trails/florida-trail/data/trail_raw.geojson"
 */

const fs = require("fs");
const path = require("path");

function arg(name, defVal = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return defVal;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return defVal;
  return v;
}

const layerUrl = arg("--layerUrl");
const outFile = arg("--out", "trails/florida-trail/data/trail_raw.geojson");

if (!layerUrl) {
  console.error('Missing --layerUrl, e.g. --layerUrl "https://.../FeatureServer/0"');
  process.exit(1);
}

async function fetchJsonGET(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function fetchJsonPOST(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) u.set(k, v);
  return u.toString();
}

/** Minimal Esri geometry -> GeoJSON conversion (Polyline + Point). */
function esriGeomToGeoJSONGeometry(esriGeom) {
  if (esriGeom && Array.isArray(esriGeom.paths)) {
    if (esriGeom.paths.length === 1) return { type: "LineString", coordinates: esriGeom.paths[0] };
    return { type: "MultiLineString", coordinates: esriGeom.paths };
  }
  if (esriGeom && typeof esriGeom.x === "number" && typeof esriGeom.y === "number") {
    return { type: "Point", coordinates: [esriGeom.x, esriGeom.y] };
  }
  return null;
}

function esriFeatureToGeoJSONFeature(f) {
  const geom = esriGeomToGeoJSONGeometry(f.geometry);
  if (!geom) return null;
  return { type: "Feature", properties: f.attributes || {}, geometry: geom };
}

async function main() {
  // Layer metadata
  const meta = await fetchJsonGET(`${layerUrl}?${qs({ f: "pjson" })}`);
  const oidField = meta.objectIdField || meta.objectIdFieldName || "OBJECTID";
  const maxRecordCount = meta.maxRecordCount || 1000;

  console.log("Layer:", meta.name || "(unnamed)");
  console.log("OID field:", oidField);
  console.log("maxRecordCount:", maxRecordCount);

  // Get all IDs (GET is fine; small response)
  const idsResp = await fetchJsonGET(
    `${layerUrl}/query?${qs({
      f: "json",
      where: "1=1",
      returnIdsOnly: "true",
      outFields: oidField,
    })}`
  );

  const objectIds = (idsResp.objectIds || []).sort((a, b) => a - b);
  if (!objectIds.length) throw new Error("No objectIds returned (layer may not allow Query).");

  console.log("Total features:", objectIds.length);

  // Download features in POST chunks (avoid long URLs)
  const features = [];
  const chunkSize = Math.min(maxRecordCount, 1000); // keep body size reasonable

  for (let i = 0; i < objectIds.length; i += chunkSize) {
    const chunk = objectIds.slice(i, i + chunkSize);

    const esri = await fetchJsonPOST(`${layerUrl}/query`, {
      f: "json",
      objectIds: chunk.join(","),   // in POST body (safe)
      outFields: "*",
      returnGeometry: "true",
      outSR: "4326",
    });

    if (!Array.isArray(esri.features)) {
      // Sometimes ArcGIS returns {error:{...}} inside 200 OK
      if (esri.error) throw new Error(`ArcGIS error ${esri.error.code}: ${esri.error.message}`);
      throw new Error("Unexpected Esri JSON response; missing 'features' array.");
    }

    for (const f of esri.features) {
      const gj = esriFeatureToGeoJSONFeature(f);
      if (gj) features.push(gj);
    }

    console.log(`Fetched ${Math.min(i + chunk.length, objectIds.length)}/${objectIds.length}...`);
  }

  const out = { type: "FeatureCollection", features };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log("Wrote:", outFile);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});