#!/usr/bin/env node
/* =============================================================================
   import-alt-gpx.js
   Fetches official ATA GPX track files for alternate passages (P11e and P33),
   interpolates at 0.5-mile intervals, and appends the resulting points to
   data/points.json.

   Existing points are preserved. Alternate-passage points are appended at the
   end of the file (they are not on the main spine, so mile values may overlap
   with main-route miles — passage_id is the distinguishing field).

   Usage:
     node trails/arizona-trail/tools/import-alt-gpx.js
     node trails/arizona-trail/tools/import-alt-gpx.js --dry-run

   Arguments:
     --dry-run    Print plan without writing to points.json

   Requirements: Node 18+  (built-in fetch)
   ============================================================================= */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dir    = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dir, "../data");
const PTS_PATH = path.join(DATA_DIR, "points.json");

const DRY_RUN = process.argv.includes("--dry-run");

const POINTS_INTERVAL_MI = 0.5;
const METERS_PER_MI      = 1609.344;
const MI_PER_METER       = 1 / METERS_PER_MI;

/* --- Alternate passages to import ----------------------------------------- */

const ALT_PASSAGES = [
  {
    id:          "p11e",
    name:        "Passage 11e — Pusch Ridge Bypass",
    gpx_url:     "https://aztrailmedia.s3.us-west-1.amazonaws.com/wp-content/uploads/2025/03/pass-11e.gpx",
    id_prefix:   "azt-p11e-mi",
  },
  {
    id:          "p33",
    name:        "Passage 33 — Flagstaff Urban Route",
    gpx_url:     "https://aztrailmedia.s3.us-west-1.amazonaws.com/wp-content/uploads/2025/08/pass-33.gpx",
    id_prefix:   "azt-p33-mi",
  },
];

/* --- GPX parsing ----------------------------------------------------------- */

/**
 * Extract track points from a GPX XML string.
 * Returns array of { lat, lon, elev_ft } objects.
 * Handles both <trkpt> (track) elements.
 */
function parseGpxTrack(xml) {
  const points = [];
  // Match every <trkpt lat="..." lon="...">...</trkpt> block
  const trkptRe = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = trkptRe.exec(xml)) !== null) {
    const lat  = parseFloat(m[1]);
    const lon  = parseFloat(m[2]);
    const body = m[3];
    const eleMatch = /<ele>([^<]+)<\/ele>/.exec(body);
    // GPX elevation is in meters; ArcGIS Z coords were in feet, but ATA GPX uses standard meters
    const elev_ft = eleMatch ? Math.round(parseFloat(eleMatch[1]) * 3.28084) : null;
    if (isFinite(lat) && isFinite(lon)) points.push({ lat, lon, elev_ft });
  }
  return points;
}

/* --- Geometry helpers ------------------------------------------------------ */

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const dφ = (lat2 - lat1) * Math.PI / 180;
  const dλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function interpolatePt(p1, p2, t) {
  return {
    lat:     p1.lat  + t * (p2.lat  - p1.lat),
    lon:     p1.lon  + t * (p2.lon  - p1.lon),
    elev_ft: (p1.elev_ft != null && p2.elev_ft != null)
               ? Math.round(p1.elev_ft + t * (p2.elev_ft - p1.elev_ft))
               : null,
  };
}

function sampleAlongTrack(gpxPoints, intervalMi) {
  const intervalM    = intervalMi * METERS_PER_MI;
  const samples      = [];
  let cumDist        = 0;
  let nextSampleDist = 0;

  for (let i = 1; i < gpxPoints.length; i++) {
    const prev   = gpxPoints[i - 1];
    const curr   = gpxPoints[i];
    const segLen = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
    if (segLen === 0) continue;

    while (nextSampleDist <= cumDist + segLen) {
      const t  = (nextSampleDist - cumDist) / segLen;
      const pt = interpolatePt(prev, curr, Math.max(0, Math.min(1, t)));
      samples.push({ ...pt, passage_mile: nextSampleDist * MI_PER_METER });
      nextSampleDist += intervalM;
    }
    cumDist += segLen;
  }

  // Include final terminus
  const last    = gpxPoints[gpxPoints.length - 1];
  const totalMi = cumDist * MI_PER_METER;
  if (!samples.length || totalMi - samples[samples.length - 1].passage_mile > intervalMi * 0.5) {
    samples.push({ lat: last.lat, lon: last.lon, elev_ft: last.elev_ft, passage_mile: totalMi });
  }

  return { samples, totalMi };
}

/* --- Build point objects --------------------------------------------------- */

function buildPoints(samples, passage) {
  return samples.map(s => {
    const mile = Math.round(s.passage_mile * 10) / 10;
    const id   = `${passage.id_prefix}${String(Math.round(mile * 10)).padStart(4, "0")}`;
    const pt   = {
      id,
      passage_id:   passage.id,
      passage_mile: mile,
      lat:          Math.round(s.lat * 1e6) / 1e6,
      lon:          Math.round(s.lon * 1e6) / 1e6,
    };
    if (s.elev_ft != null) pt.trail_elev = s.elev_ft;
    return pt;
  });
}

/* --- Main ------------------------------------------------------------------ */

async function main() {
  // Load existing points
  const existing     = JSON.parse(readFileSync(PTS_PATH, "utf8"));
  const existingIds  = new Set(existing.map(p => p.id));

  console.log(`\nAZT Alternate Passage GPX Importer`);
  console.log(`Existing points.json: ${existing.length} points`);
  if (DRY_RUN) console.log(`DRY RUN — no files will be written.\n`);

  const toAdd = [];

  for (const passage of ALT_PASSAGES) {
    console.log(`\n--- ${passage.name} ---`);
    console.log(`Fetching: ${passage.gpx_url}`);

    const res = await fetch(passage.gpx_url);
    if (!res.ok) {
      console.error(`  FAILED: HTTP ${res.status}`);
      continue;
    }
    const xml = await res.text();
    const gpxPoints = parseGpxTrack(xml);
    console.log(`  Parsed ${gpxPoints.length} GPX track points`);

    if (gpxPoints.length < 2) {
      console.error(`  Too few points — skipping.`);
      continue;
    }

    const { samples, totalMi } = sampleAlongTrack(gpxPoints, POINTS_INTERVAL_MI);
    const points = buildPoints(samples, passage);

    // Filter out any already-existing IDs
    const newPts  = points.filter(p => !existingIds.has(p.id));
    const skipCnt = points.length - newPts.length;

    console.log(`  Total track length:  ${totalMi.toFixed(2)} mi`);
    console.log(`  Sampled points:      ${points.length} at ${POINTS_INTERVAL_MI}-mile intervals`);
    if (skipCnt > 0) console.log(`  Already present:     ${skipCnt} (skipped)`);
    console.log(`  New points to add:   ${newPts.length}`);
    console.log(`  Elev range: ${Math.min(...newPts.map(p=>p.trail_elev).filter(Boolean))} – ${Math.max(...newPts.map(p=>p.trail_elev).filter(Boolean))} ft`);
    console.log(`  Start: (${newPts[0]?.lat}, ${newPts[0]?.lon})`);
    console.log(`  End:   (${newPts[newPts.length-1]?.lat}, ${newPts[newPts.length-1]?.lon})`);

    toAdd.push(...newPts);
  }

  console.log(`\nTotal new points to append: ${toAdd.length}`);

  if (!DRY_RUN && toAdd.length > 0) {
    const updated = [...existing, ...toAdd];
    writeFileSync(PTS_PATH, JSON.stringify(updated, null, 2), "utf8");
    console.log(`Updated points.json: ${updated.length} total points`);
  } else if (toAdd.length === 0) {
    console.log(`Nothing to add — points.json unchanged.`);
  } else {
    console.log(`Dry run — points.json not modified.`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
