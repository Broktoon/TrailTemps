/**
 * generate-missing-normals-at.js
 *
 * Fills missing daily "normals" (365-day hi/lo arrays) for Appalachian Trail points.
 * - Reads points.json (expects id + legacy_id + lat/lon + mile or mile_est)
 * - Reads historical_weather.json (expects { meta, points:[...] })
 * - Finds which point IDs are missing in historical_weather.json
 * - Fetches daily max/min temps via Open-Meteo Historical Weather API
 * - Computes average max/min for each MM-DD across a year range (skips Feb 29)
 * - Appends new records to historical_weather.json
 * - Writes progress to disk after EACH point (safe resume)
 *
 * Open-Meteo Historical Weather API docs: https://open-meteo.com/en/docs/historical-weather-api
 */

const fs = require("fs");
const path = require("path");

// ---------------- CONFIG ----------------
const DATA_DIR = path.join("trails", "appalachian-trail", "data");
const POINTS_PATH = path.join(DATA_DIR, "points.json");
const HIST_PATH = path.join(DATA_DIR, "historical_weather.json");

// Year range for "normals" averaging.
// Pick something stable and available; adjust as you like.
// (Historical Weather API supports long ranges; ERA5(-Land) is good for consistency.)
const START_DATE = "2018-01-01";
const END_DATE   = "2024-12-31";

// Dataset choice: ERA5 or ERA5-Land are recommended for consistency over time.
// Docs: Historical Weather API suggests ERA5/ERA5-Land for long-term consistency.
const DATASET = "ERA5-Land"; // or "ERA5"

// Units
const TEMP_UNIT = "fahrenheit";
const TIMEZONE  = "auto";

// Throttle to reduce rate-limit risk
const SLEEP_MS_BETWEEN_REQUESTS = 2000; // ~1 req/sec. Increase if you hit 429s.

// Resume controls
// - Only process first N missing points: set MAX_POINTS (e.g., 25), else null for all
const MAX_POINTS = null;
// --------------------------------------

// Open-Meteo Historical Weather API endpoint (per docs)
const API_BASE = "https://archive-api.open-meteo.com/v1/archive";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dayIndexFromMMDD(mmdd) {
  // Map MM-DD to 0..364 using a fixed non-leap year (2021)
  const [mm, dd] = mmdd.split("-").map(Number);
  const d = new Date(2021, mm - 1, dd);
  const start = new Date(2021, 0, 1);
  return Math.round((d - start) / (24 * 60 * 60 * 1000));
}

function isFeb29(isoDate) {
  return isoDate.endsWith("-02-29");
}

function buildEmpty365() {
  const arr = new Array(365);
  for (let i = 0; i < 365; i++) arr[i] = null;
  return arr;
}

async function fetchDailyMaxMin(lat, lon) {
  const url = new URL(API_BASE);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start_date", START_DATE);
  url.searchParams.set("end_date", END_DATE);
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
  url.searchParams.set("temperature_unit", TEMP_UNIT);
  url.searchParams.set("timezone", TIMEZONE);


  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const err = new Error(`HTTP ${resp.status} from Open-Meteo`);
    err.status = resp.status;
    err.body = txt.slice(0, 300);
    throw err;
  }
  return resp.json();
}

function compute365AveragesFromDaily(daily) {
  const times = daily?.time || [];
  const tmax = daily?.temperature_2m_max || [];
  const tmin = daily?.temperature_2m_min || [];

  // Accumulate by MM-DD (skip Feb 29)
  const acc = new Map(); // mmdd -> {maxSum, maxN, minSum, minN}
  for (let i = 0; i < times.length; i++) {
    const iso = times[i];
    if (isFeb29(iso)) continue;

    const mmdd = iso.slice(5); // "MM-DD"
    if (!acc.has(mmdd)) acc.set(mmdd, { maxSum: 0, maxN: 0, minSum: 0, minN: 0 });

    const bucket = acc.get(mmdd);
    const hi = tmax[i];
    const lo = tmin[i];

    if (Number.isFinite(hi)) { bucket.maxSum += hi; bucket.maxN++; }
    if (Number.isFinite(lo)) { bucket.minSum += lo; bucket.minN++; }
  }

  const hi365 = buildEmpty365();
  const lo365 = buildEmpty365();

  for (const [mmdd, b] of acc.entries()) {
    const idx = dayIndexFromMMDD(mmdd);
    if (idx < 0 || idx > 364) continue;

    hi365[idx] = b.maxN ? (b.maxSum / b.maxN) : null;
    lo365[idx] = b.minN ? (b.minSum / b.minN) : null;
  }

  // Basic validation: ensure we have most days
  const hiCount = hi365.filter(v => Number.isFinite(v)).length;
  const loCount = lo365.filter(v => Number.isFinite(v)).length;
  return { hi365, lo365, hiCount, loCount };
}

function ensureHistShape(hist) {
  if (!hist || typeof hist !== "object") throw new Error("historical_weather.json is not an object");
  if (!Array.isArray(hist.points)) hist.points = [];
  if (!hist.meta || typeof hist.meta !== "object") hist.meta = {};
  return hist;
}

async function main() {
  if (!fs.existsSync(POINTS_PATH)) throw new Error(`Missing: ${POINTS_PATH}`);
  if (!fs.existsSync(HIST_PATH)) throw new Error(`Missing: ${HIST_PATH}`);

  const points = readJson(POINTS_PATH);
  if (!Array.isArray(points)) throw new Error("points.json must be an array");

  const hist = ensureHistShape(readJson(HIST_PATH));

  const existingIds = new Set(hist.points.map(p => String(p.id)));
  const missing = points.filter(p => !existingIds.has(String(p.id)));

  console.log(`Total points in points.json: ${points.length}`);
  console.log(`Existing normals records:     ${hist.points.length}`);
  console.log(`Missing normals to generate:  ${missing.length}`);

  const toProcess = (MAX_POINTS != null) ? missing.slice(0, MAX_POINTS) : missing;

  let processed = 0;
  for (const p of toProcess) {
    const id = String(p.id);
    const legacyId = p.legacy_id != null ? String(p.legacy_id) : null;

    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.warn(`Skipping ${id}: invalid lat/lon`);
      continue;
    }

    console.log(`\n[${processed + 1}/${toProcess.length}] Fetching ${id} (${legacyId || "no-legacy"}) lat=${lat} lon=${lon}`);

    try {
      const data = await fetchDailyMaxMin(lat, lon);
      const daily = data?.daily;
      if (!daily?.time?.length) throw new Error("No daily.time in response");

      const { hi365, lo365, hiCount, loCount } = compute365AveragesFromDaily(daily);

      if (hiCount < 330 || loCount < 330) {
        console.warn(`Warning for ${id}: sparse day coverage (hi=${hiCount}, lo=${loCount}). Still writing.`);
      }

      const rec = {
        id,
        ...(legacyId ? { legacy_id: legacyId } : {}),
        hi: hi365,
        lo: lo365
      };

      hist.points.push(rec);

      // Persist progress after each point (safe resume)
      hist.meta.normals_source = "Open-Meteo Historical Weather API (daily max/min averaged by MM-DD)";
      hist.meta.normals_range = `${START_DATE}..${END_DATE}`;
      hist.meta.normals_dataset = DATASET;
      writeJson(HIST_PATH, hist);

      processed++;
      await sleep(SLEEP_MS_BETWEEN_REQUESTS);

    } catch (err) {
      console.error(`ERROR on ${id}: ${err.message}`);
      if (err.status) console.error(`HTTP status: ${err.status}`);
      if (err.body) console.error(`Body: ${err.body}`);
      console.error("Stopping so you can resume later without corrupting output.");
      process.exit(1);
    }
  }

  console.log(`\n✔ Done. Generated ${processed} new normals records.`);
  console.log(`historical_weather.json now has ${hist.points.length} total records.`);
}

main();