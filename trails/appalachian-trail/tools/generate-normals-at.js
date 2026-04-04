/**
 * generate-normals-at.js
 *
 * Generates daily "normals" (365-day averaged arrays) for Appalachian Trail points.
 * - Reads trails/appalachian-trail/data/points.json (439 points at 5-mile intervals)
 * - Fetches daily max/min temps, apparent temps, humidity, and wind speed
 *   via Open-Meteo Historical Weather API (ERA5-Land, 2018–2024)
 * - Computes average for each MM-DD across the date range (skips Feb 29)
 * - Writes to trails/appalachian-trail/data/historical_weather.json
 * - Resume-safe: writes after EACH point; re-run to continue where it stopped
 * - Existing records that are missing hi_app/lo_app are treated as incomplete
 *   and regenerated (the old file only had hi/lo; this adds apparent temp, RH, wind)
 *
 * Run: node trails/appalachian-trail/tools/generate-normals-at.js
 *
 * At 15s per point, 439 points ≈ 1.8 hours total (resume-safe if interrupted).
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join("trails", "appalachian-trail", "data");
const POINTS_PATH = path.join(DATA_DIR, "points.json");
const HIST_PATH   = path.join(DATA_DIR, "historical_weather.json");

const START_DATE = "2018-01-01";
const END_DATE   = "2024-12-31";
const DATASET    = "ERA5-Land";

const TEMP_UNIT = "fahrenheit";
const WIND_UNIT = "mph";
const TIMEZONE  = "auto";

// 15 seconds between requests — avoids Open-Meteo rate-limit (429s)
const SLEEP_MS = 15000;

// Set to a number (e.g. 5) to process only first N missing points — useful for testing.
// Set to null to process all.
const MAX_POINTS = null;

// ─── API ───────────────────────────────────────────────────────────────────

const API_BASE = "https://archive-api.open-meteo.com/v1/archive";

const DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "relative_humidity_2m_max",
  "relative_humidity_2m_min",
  "windspeed_10m_max",
].join(",");

// ─── UTILITIES ─────────────────────────────────────────────────────────────

function readJson(p)       { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }
function sleep(ms)         { return new Promise((r) => setTimeout(r, ms)); }
function isFeb29(iso)      { return iso.endsWith("-02-29"); }
function buildEmpty365()   { return new Array(365).fill(null); }

function dayIndexFromMMDD(mmdd) {
  const [mm, dd] = mmdd.split("-").map(Number);
  const d     = new Date(2021, mm - 1, dd);
  const start = new Date(2021, 0, 1);
  return Math.max(0, Math.min(364, Math.round((d - start) / 86400000)));
}

// ─── API FETCH ─────────────────────────────────────────────────────────────

async function fetchDailyData(lat, lon) {
  const url = new URL(API_BASE);
  url.searchParams.set("latitude",         String(lat));
  url.searchParams.set("longitude",        String(lon));
  url.searchParams.set("start_date",       START_DATE);
  url.searchParams.set("end_date",         END_DATE);
  url.searchParams.set("daily",            DAILY_VARS);
  url.searchParams.set("temperature_unit", TEMP_UNIT);
  url.searchParams.set("windspeed_unit",   WIND_UNIT);
  url.searchParams.set("timezone",         TIMEZONE);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const err = new Error(`HTTP ${resp.status} from Open-Meteo`);
    err.status = resp.status;
    err.body   = txt.slice(0, 300);
    throw err;
  }
  return resp.json();
}

// ─── NORMALS COMPUTATION ───────────────────────────────────────────────────

function computeNormals(daily) {
  const acc = new Map();

  const times  = daily?.time                      || [];
  const hi     = daily?.temperature_2m_max        || [];
  const lo     = daily?.temperature_2m_min        || [];
  const app_hi = daily?.apparent_temperature_max  || [];
  const app_lo = daily?.apparent_temperature_min  || [];
  const rh_hi  = daily?.relative_humidity_2m_max  || [];
  const rh_lo  = daily?.relative_humidity_2m_min  || [];
  const ws     = daily?.windspeed_10m_max         || [];

  const fields  = ["hi", "lo", "app_hi", "app_lo", "rh_hi", "rh_lo", "ws"];
  const sources = [hi, lo, app_hi, app_lo, rh_hi, rh_lo, ws];

  for (let i = 0; i < times.length; i++) {
    const iso = times[i];
    if (isFeb29(iso)) continue;
    const mmdd = iso.slice(5);

    if (!acc.has(mmdd)) {
      const bucket = {};
      for (const f of fields) bucket[f] = { sum: 0, n: 0 };
      acc.set(mmdd, bucket);
    }
    const bucket = acc.get(mmdd);
    sources.forEach((src, idx) => {
      const v = src[i];
      if (Number.isFinite(v)) { bucket[fields[idx]].sum += v; bucket[fields[idx]].n++; }
    });
  }

  const out = {};
  for (const f of fields) out[f] = buildEmpty365();

  for (const [mmdd, bucket] of acc.entries()) {
    const idx = dayIndexFromMMDD(mmdd);
    for (const f of fields) {
      const b = bucket[f];
      out[f][idx] = b.n ? (b.sum / b.n) : null;
    }
  }

  const hiCount = out.hi.filter(Number.isFinite).length;
  return { normals: out, hiCount };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(POINTS_PATH)) throw new Error(`Missing: ${POINTS_PATH}`);

  const allPoints = readJson(POINTS_PATH);
  if (!Array.isArray(allPoints)) throw new Error("points.json must be an array");

  console.log(`Points in points.json:   ${allPoints.length}`);

  // Load or initialize historical_weather.json
  let hist;
  if (fs.existsSync(HIST_PATH)) {
    hist = readJson(HIST_PATH);
    if (!hist || typeof hist !== "object") hist = {};
    if (!Array.isArray(hist.points)) hist.points = [];
    if (!hist.meta) hist.meta = {};
  } else {
    hist = { meta: {}, points: [] };
  }

  // A record is complete only if it has hi_app (new field).
  // Old records with only hi/lo are treated as incomplete and regenerated.
  const completeIds = new Set(
    hist.points.filter((p) => Array.isArray(p.hi_app)).map((p) => String(p.id))
  );

  // Remove incomplete records so they get regenerated cleanly
  const incompleteCount = hist.points.filter((p) => !Array.isArray(p.hi_app)).length;
  if (incompleteCount > 0) {
    console.log(`Removing ${incompleteCount} incomplete records (missing hi_app) for regeneration.`);
    hist.points = hist.points.filter((p) => Array.isArray(p.hi_app));
  }

  const missing = allPoints.filter((p) => !completeIds.has(String(p.id)));

  console.log(`Complete normals records: ${hist.points.length}`);
  console.log(`Points to generate:       ${missing.length}`);

  if (missing.length === 0) {
    console.log("✔ All points already have complete normals. Nothing to do.");
    return;
  }

  const toProcess = MAX_POINTS != null ? missing.slice(0, MAX_POINTS) : missing;
  console.log(`Processing:               ${toProcess.length} points`);
  console.log(`Estimated time:           ~${Math.ceil(toProcess.length * SLEEP_MS / 60000)} minutes\n`);

  let processed = 0;

  for (const p of toProcess) {
    const id  = String(p.id);
    const lat = Number(p.lat);
    const lon = Number(p.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.warn(`Skipping ${id}: invalid lat/lon`);
      continue;
    }

    console.log(`[${processed + 1}/${toProcess.length}] ${id}  mile=${p.mile}  lat=${lat}  lon=${lon}`);

    try {
      const data  = await fetchDailyData(lat, lon);
      const daily = data?.daily;
      if (!daily?.time?.length) throw new Error("No daily.time in response");

      const { normals, hiCount } = computeNormals(daily);

      if (hiCount < 330) {
        console.warn(`  ⚠ Sparse coverage (${hiCount}/365 days). Still writing.`);
      }

      hist.points.push({
        id,
        lat,
        lon,
        hi:     normals.hi,
        lo:     normals.lo,
        hi_app: normals.app_hi,
        lo_app: normals.app_lo,
        rh_hi:  normals.rh_hi,
        rh_lo:  normals.rh_lo,
        ws:     normals.ws,
      });

      hist.meta.source    = `Open-Meteo ${DATASET} ${START_DATE}..${END_DATE}`;
      hist.meta.dataset   = DATASET;
      hist.meta.range     = `${START_DATE}..${END_DATE}`;
      hist.meta.units     = `temperature: ${TEMP_UNIT}, wind: ${WIND_UNIT}`;
      hist.meta.generated = new Date().toISOString();
      writeJson(HIST_PATH, hist);

      processed++;
      console.log(`  ✔ Written (hi coverage: ${hiCount}/365 days)`);

      if (processed < toProcess.length) await sleep(SLEEP_MS);

    } catch (err) {
      console.error(`\nERROR on ${id}: ${err.message}`);
      if (err.status) console.error(`  HTTP status: ${err.status}`);
      if (err.body)   console.error(`  Body: ${err.body}`);
      console.error("\nStopping. Re-run to resume from where it left off.");
      process.exit(1);
    }
  }

  console.log(`\n✔ Done. Generated ${processed} new records.`);
  console.log(`historical_weather.json now has ${hist.points.length} total records.`);
  console.log(`(Expected ${allPoints.length} when complete)`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
