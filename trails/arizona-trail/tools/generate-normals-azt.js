#!/usr/bin/env node
/* =============================================================================
   generate-normals-azt.js
   Reads data/points.json, selects one point per NORMALS_INTERVAL_MI miles,
   fetches 7-year ERA5-Land normals from Open-Meteo, and writes (or appends
   to) data/historical_weather.json.

   Automatically resumes from where it left off — only fetches points that
   are not yet present in historical_weather.json.

   Usage:
     # Run (or resume) — only fetches missing points:
     node generate-normals-azt.js

     # Dry-run: print which points would be fetched, no API calls:
     node generate-normals-azt.js --dry-run

   Each run MERGES into historical_weather.json — existing records are
   preserved and only missing ones are added.

   Arguments:
     --dry-run    Print plan without making any API calls

   Requirements:  Node 18+  (built-in fetch)
   Rate limit:    15 seconds between requests (Open-Meteo free tier)
   ============================================================================= */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/* ---------- paths ---------------------------------------------------------- */
const __dir     = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.resolve(__dir, "../data");
const PTS_PATH  = path.join(DATA_DIR, "points.json");
const NORM_OUT  = path.join(DATA_DIR, "historical_weather.json");

/* ---------- constants ------------------------------------------------------ */
const NORMALS_INTERVAL_MI = 5.0;   // one normals point per N miles
const RATE_LIMIT_MS       = 15000; // ms between API calls

const HIST_BASE  = "https://archive-api.open-meteo.com/v1/archive";
const DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "relative_humidity_2m_max",
  "relative_humidity_2m_min",
  "windspeed_10m_max",
].join(",");

/* ---------- CLI args ------------------------------------------------------- */
const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

/* ---------- helpers -------------------------------------------------------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function lastSevenYearsRange() {
  const end   = new Date();
  end.setDate(end.getDate() - 2);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 7);
  return { start_date: toISO(start), end_date: toISO(end) };
}

function dayIndex(month, day) {
  const ref   = new Date(2021, month - 1, day);
  const start = new Date(2021, 0, 1);
  return Math.min(364, Math.max(0, Math.round((ref - start) / 86400000)));
}

function buildCalendarNormals(daily) {
  const buckets = Array.from({ length: 365 }, () => ({
    hi: [], lo: [], hi_app: [], lo_app: [], rh_hi: [], rh_lo: [], ws: []
  }));

  const times = daily.time || [];
  for (let i = 0; i < times.length; i++) {
    const [, mm, dd] = times[i].split("-").map(Number);
    const idx = dayIndex(mm, dd);
    const push = (arr, v) => { if (v != null && isFinite(v)) arr.push(v); };
    push(buckets[idx].hi,     daily.temperature_2m_max?.[i]);
    push(buckets[idx].lo,     daily.temperature_2m_min?.[i]);
    push(buckets[idx].hi_app, daily.apparent_temperature_max?.[i]);
    push(buckets[idx].lo_app, daily.apparent_temperature_min?.[i]);
    push(buckets[idx].rh_hi,  daily.relative_humidity_2m_max?.[i]);
    push(buckets[idx].rh_lo,  daily.relative_humidity_2m_min?.[i]);
    push(buckets[idx].ws,     daily.windspeed_10m_max?.[i]);
  }

  const avgArr = (key) => buckets.map(b =>
    b[key].length
      ? Math.round((b[key].reduce((a, v) => a + v, 0) / b[key].length) * 10) / 10
      : null
  );

  return {
    hi:     avgArr("hi"),
    lo:     avgArr("lo"),
    hi_app: avgArr("hi_app"),
    lo_app: avgArr("lo_app"),
    rh_hi:  avgArr("rh_hi"),
    rh_lo:  avgArr("rh_lo"),
    ws:     avgArr("ws"),
  };
}

/* ---------- API call ------------------------------------------------------- */
async function fetchNormals(lat, lon, range) {
  const url = new URL(HIST_BASE);
  url.searchParams.set("latitude",         lat.toFixed(6));
  url.searchParams.set("longitude",        lon.toFixed(6));
  url.searchParams.set("start_date",       range.start_date);
  url.searchParams.set("end_date",         range.end_date);
  url.searchParams.set("daily",            DAILY_VARS);
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("windspeed_unit",   "mph");
  url.searchParams.set("timezone",         "auto");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/* ---------- load/save historical_weather.json ------------------------------ */
function loadExisting() {
  if (!existsSync(NORM_OUT)) return { meta: null, byId: new Map() };
  const raw  = JSON.parse(readFileSync(NORM_OUT, "utf8"));
  const byId = new Map((raw.points || []).map(p => [p.id, p]));
  return { meta: raw.meta || null, byId };
}

function saveOutput(byId, meta) {
  const points = [...byId.values()].sort((a, b) => a.mile - b.mile);
  const output = { meta, points };
  writeFileSync(NORM_OUT, JSON.stringify(output, null, 2), "utf8");
}

/* ---------- select normals points from points.json ------------------------- */
function selectNormalsPoints(allPoints) {
  // Pick one point per NORMALS_INTERVAL_MI — the one closest to each
  // N-mile mark (0, 5, 10, …)
  const selected = [];
  let nextTarget = 0;

  for (const pt of allPoints) {
    if (pt.mile >= nextTarget) {
      selected.push(pt);
      nextTarget = Math.floor(pt.mile / NORMALS_INTERVAL_MI) * NORMALS_INTERVAL_MI
                  + NORMALS_INTERVAL_MI;
    }
  }

  // Always include the final point if not already captured
  const last = allPoints[allPoints.length - 1];
  if (selected[selected.length - 1]?.id !== last.id) selected.push(last);

  return selected;
}

/* ==========================================================================
   MAIN
   ========================================================================== */
async function main() {
  /* --- load points.json --------------------------------------------------- */
  if (!existsSync(PTS_PATH)) {
    console.error(`ERROR: ${PTS_PATH} not found. Run fetch-points-azt.js first.`);
    process.exit(1);
  }
  const allPoints    = JSON.parse(readFileSync(PTS_PATH, "utf8"));
  const normPts      = selectNormalsPoints(allPoints);
  const range        = lastSevenYearsRange();

  /* --- load existing results and find missing points ---------------------- */
  const { meta: existingMeta, byId } = loadExisting();
  const batch = normPts.filter(pt => !byId.has(pt.id));

  /* --- print plan --------------------------------------------------------- */
  console.log(`\nArizona Trail — Normals Generator`);
  console.log(`  Total normals points : ${normPts.length}`);
  console.log(`  Already complete     : ${byId.size}`);
  console.log(`  Remaining            : ${batch.length}`);
  console.log(`  Date range           : ${range.start_date} to ${range.end_date}`);
  console.log(`  Output               : ${NORM_OUT}`);

  if (batch.length === 0) {
    console.log(`\nAll ${normPts.length} points already complete — nothing to do.`);
    return;
  }

  if (DRY_RUN) {
    console.log(`\n  DRY RUN — no API calls will be made.\n`);
    batch.forEach(pt =>
      console.log(`  mile ${pt.mile.toFixed(1).padStart(6)}  ${pt.id}  (${pt.lat}, ${pt.lon})`)
    );
    console.log(`\nTo fetch for real, remove --dry-run.`);
    return;
  }
  console.log(`  Est. time            : ~${Math.ceil(batch.length * RATE_LIMIT_MS / 60000)} min\n`);

  /* --- fetch loop --------------------------------------------------------- */
  let ok = 0, failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const pt    = batch[i];
    const label = `[${byId.size + i + 1}/${normPts.length}] mile ${pt.mile.toFixed(1).padStart(6)}`;
    process.stdout.write(`  ${label} … `);

    try {
      const data       = await fetchNormals(pt.lat, pt.lon, range);
      const normals    = buildCalendarNormals(data.daily || {});
      const gridElevFt = data.elevation != null ? Math.round(data.elevation * 3.28084) : null;

      const record = {
        id:         pt.id,
        lat:        pt.lat,
        lon:        pt.lon,
        mile:       pt.mile,
        passage_id: pt.passage_id,
        ...normals,
      };
      if (gridElevFt        != null) record.grid_elev  = gridElevFt;
      if (pt.trail_elev     != null) record.trail_elev = pt.trail_elev;

      byId.set(pt.id, record);
      ok++;
      process.stdout.write(`OK  (grid elev: ${gridElevFt ?? "n/a"} ft)\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAILED — ${err.message}\n`);
    }

    // Save after every point so progress is never lost
    const metaOut = {
      trail:          "Arizona Trail",
      generated:      new Date().toISOString(),
      source:         "Open-Meteo ERA5-Land archive",
      date_range:     range,
      interval_miles: NORMALS_INTERVAL_MI,
      point_count:    byId.size,
      units: {
        temperature: "Fahrenheit",
        wind_speed:  "mph",
        humidity:    "percent",
        elevation:   "feet",
      },
      fields: {
        hi:     "avg daily high temperature (°F)",
        lo:     "avg daily low temperature (°F)",
        hi_app: "avg daily apparent high temperature (°F, Steadman)",
        lo_app: "avg daily apparent low temperature (°F, Steadman)",
        rh_hi:  "avg daily max relative humidity (%)",
        rh_lo:  "avg daily min relative humidity (%)",
        ws:     "avg daily max wind speed (mph)",
      },
      note: "Each array has 365 values (Jan 1 = index 0). " +
            "grid_elev and trail_elev in feet; used by app.js for elevation correction.",
    };
    saveOutput(byId, metaOut);

    if (i < batch.length - 1) await sleep(RATE_LIMIT_MS);
  }

  /* --- summary ------------------------------------------------------------ */
  console.log(`\nRun complete: ${ok} succeeded, ${failed} failed.`);
  console.log(`historical_weather.json now contains ${byId.size} of ${normPts.length} total points.`);

  if (byId.size < normPts.length) {
    console.log(`\n${normPts.length - byId.size} point(s) still missing — re-run to continue.`);
  } else {
    console.log(`\nAll ${normPts.length} points complete — historical_weather.json is ready.`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
