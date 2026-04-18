/**
 * generate-normals-nct.js
 *
 * Generates daily "normals" (365-day averaged arrays) for North Country Trail points.
 * - Reads trails/north-country-trail/data/points.json
 * - All points are at 5-mile intervals (~887 points expected)
 * - Fetches daily max/min temps, apparent temps, humidity, and wind speed
 *   via Open-Meteo Historical Weather API (ERA5-Land, 2018-2024)
 * - Computes average for each MM-DD across START_DATE..END_DATE (skips Feb 29)
 * - Writes trails/north-country-trail/data/historical_weather.json
 *   (wrapped in { meta, points } — ~55-60 MB when complete)
 * - Resume-safe: saves after EACH point; re-run to continue where stopped
 *
 * Run from repo root:
 *   node trails/north-country-trail/tools/generate-normals-nct.js
 *
 * Throttle: 2-second delay between requests (Open-Meteo Professional).
 * If using the Open-Meteo free tier, change SLEEP_MS to 15000.
 *
 * Open-Meteo Historical Weather API: https://open-meteo.com/en/docs/historical-weather-api
 */

const fs   = require("fs");
const path = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join("trails", "north-country-trail", "data");
const POINTS_PATH = path.join(DATA_DIR, "points.json");
const HIST_PATH   = path.join(DATA_DIR, "historical_weather.json");

const START_DATE = "2018-01-01";
const END_DATE   = "2024-12-31";
const DATASET    = "ERA5-Land";

const TEMP_UNIT = "fahrenheit";
const WIND_UNIT = "mph";
const TIMEZONE  = "auto";

// 2-second delay — Open-Meteo Professional subscription.
// Change to 15000 if switching back to the free tier.
const SLEEP_MS = 2000;

// Set to a number (e.g. 5) to process only the first N missing points for testing.
// Set to null to process all.
const MAX_POINTS = null;

// ─── API ───────────────────────────────────────────────────────────────────

const API_BASE  = "https://customer-archive-api.open-meteo.com/v1/archive";
const API_KEY   = "TTyLPYLitRdmWqlF";

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

function readJson(p)        { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, obj)  { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }
function sleep(ms)          { return new Promise(r => setTimeout(r, ms)); }
function isFeb29(iso)       { return iso.endsWith("-02-29"); }
function buildEmpty365()    { return new Array(365).fill(null); }

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
  url.searchParams.set("apikey",           API_KEY);

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

  const times  = daily?.time                     || [];
  const hi     = daily?.temperature_2m_max       || [];
  const lo     = daily?.temperature_2m_min       || [];
  const app_hi = daily?.apparent_temperature_max || [];
  const app_lo = daily?.apparent_temperature_min || [];
  const rh_hi  = daily?.relative_humidity_2m_max || [];
  const rh_lo  = daily?.relative_humidity_2m_min || [];
  const ws     = daily?.windspeed_10m_max        || [];

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
      out[f][idx] = b.n ? b.sum / b.n : null;
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

  const targetPoints = allPoints.filter(p =>
    Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))
  );

  console.log(`Points in points.json:       ${allPoints.length}`);
  console.log(`Valid target points:          ${targetPoints.length}`);
  console.log(`Estimated run time:           ~${Math.ceil(targetPoints.length * SLEEP_MS / 60000)} minutes`);
  console.log(`Estimated output file size:   ~${Math.round(targetPoints.length * 0.065)} MB`);

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

  const existingIds = new Set(hist.points.map(p => String(p.id)));
  const missing     = targetPoints.filter(p => !existingIds.has(String(p.id)));

  console.log(`Existing normals records:     ${hist.points.length}`);
  console.log(`Missing normals to generate:  ${missing.length}`);

  if (missing.length === 0) {
    console.log("\u2714 All target points already have normals. Nothing to do.");
    return;
  }

  const toProcess = MAX_POINTS != null ? missing.slice(0, MAX_POINTS) : missing;
  let processed = 0;

  for (const p of toProcess) {
    const id  = String(p.id);
    const lat = Number(p.lat);
    const lon = Number(p.lon);

    console.log(`\n[${processed + 1}/${toProcess.length}] ${id}  mile=${p.mile}  state=${p.state}  lat=${lat}  lon=${lon}`);

    try {
      const data  = await fetchDailyData(lat, lon);
      const daily = data?.daily;
      if (!daily?.time?.length) throw new Error("No daily.time in response");

      const { normals, hiCount } = computeNormals(daily);

      if (hiCount < 330) {
        console.warn(`  \u26a0 Sparse coverage (hi=${hiCount} days). Still writing.`);
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
      console.log(`  \u2714 Written (hi coverage: ${hiCount}/365 days)`);

      await sleep(SLEEP_MS);

    } catch (err) {
      console.error(`\nERROR on ${id}: ${err.message}`);
      if (err.status) console.error(`HTTP status: ${err.status}`);
      if (err.body)   console.error(`Body: ${err.body}`);
      console.error("\nStopping. Re-run to continue from where it stopped.");
      process.exit(1);
    }
  }

  console.log(`\n\u2714 Done. Generated ${processed} new normals records.`);
  console.log(`historical_weather.json now has ${hist.points.length} total records.`);
  console.log(`(Expected ${targetPoints.length} when complete)`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
