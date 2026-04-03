/**
 * generate-normals-ntt.js
 *
 * Generates daily "normals" (365-day averaged arrays) for Natchez Trace Trail points.
 * - Reads trails/natchez-trace-trail/data/points.json
 * - Selects points at target intervals within each section (see TARGET_POINTS below)
 * - Fetches daily max/min temps, apparent temps, humidity, and wind speed
 *   via Open-Meteo Historical Weather API (ERA5-Land)
 * - Computes average for each MM-DD across START_DATE..END_DATE (skips Feb 29)
 * - Writes to trails/natchez-trace-trail/data/historical_weather.json
 * - Resume-safe: writes after EACH point; re-run to continue where it stopped
 *
 * Run: node trails/natchez-trace-trail/tools/generate-normals-ntt.js
 *
 * Open-Meteo Historical Weather API: https://open-meteo.com/en/docs/historical-weather-api
 */

const fs   = require("fs");
const path = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join("trails", "natchez-trace-trail", "data");
const POINTS_PATH = path.join(DATA_DIR, "points.json");
const HIST_PATH   = path.join(DATA_DIR, "historical_weather.json");

// Year range for normals — ERA5-Land available from 1950 onward.
const START_DATE = "2018-01-01";
const END_DATE   = "2024-12-31";
const DATASET    = "ERA5-Land";

const TEMP_UNIT = "fahrenheit";
const WIND_UNIT = "mph";
const TIMEZONE  = "auto";

// 15 seconds between requests — avoids Open-Meteo rate-limit (429s).
const SLEEP_MS = 15000;

// Set to a number (e.g. 5) to process only first N missing points — useful for testing.
// Set to null to process all.
const MAX_POINTS = null;

// ─── API VARIABLES ─────────────────────────────────────────────────────────

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

// ─── TARGET POINT SELECTION ────────────────────────────────────────────────
//
// NTT sections are short and disconnected — select points at section starts,
// ends, and at ~3–5 mile intervals within each section.
//
// Section lengths:
//   Portkopinu:        3.5 mi  → select axis miles 0.0, 3.5           (2 pts)
//   Rocky Springs:     6.5 mi  → select axis miles 3.5, 7.0, 10.0     (3 pts)
//   Yockanookany:     23.0 mi  → select axis miles 10, 15, 20, 25, 30, 33 (6 pts)
//   Blackland Prairie: 6.0 mi  → select axis miles 33, 36, 39          (3 pts)
//   Highland Rim:     20.0 mi  → select axis miles 39, 44, 49, 54, 59  (5 pts)
//
// Total: ~19 points

const TARGET_AXIS_MILES = new Set([
  // Portkopinu
  0.0, 3.5,
  // Rocky Springs
  7.0, 10.0,
  // Yockanookany
  15.0, 20.0, 25.0, 30.0, 33.0,
  // Blackland Prairie
  36.0, 39.0,
  // Highland Rim
  44.0, 49.0, 54.0, 59.0,
]);

function isTargetPoint(p) {
  // Match exact axis_mile values. Points must have axis_mile set.
  return TARGET_AXIS_MILES.has(Number(p.axis_mile));
}

// ─── UTILITIES ─────────────────────────────────────────────────────────────

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, retries = 3, delayMs = 30000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) {
      console.log(`    Rate limited (429), waiting ${delayMs / 1000}s before retry ${attempt}/${retries}…`);
      await sleep(delayMs);
    } else {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
  }
  throw new Error(`Failed after ${retries} retries: ${url}`);
}

// ─── DATE / DOY HELPERS ────────────────────────────────────────────────────

function isLeapDay(dateStr) {
  return dateStr.slice(5) === "02-29";
}

function mmddKey(dateStr) {
  return dateStr.slice(5); // "MM-DD"
}

function buildDayOfYearMap() {
  // Returns Map<"MM-DD", 0-based index 0..364> (Feb 29 excluded)
  const map = new Map();
  let idx = 0;
  const ref = new Date("2001-01-01");
  for (let d = 0; d < 365; d++) {
    const dt  = new Date(ref.getTime() + d * 86400000);
    const key = `${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    map.set(key, idx++);
  }
  return map;
}

// ─── NORMALS COMPUTATION ───────────────────────────────────────────────────

function computeNormals(dailyData) {
  const DOY_MAP = buildDayOfYearMap();

  const buckets = {
    hi:     Array.from({length: 365}, () => []),
    lo:     Array.from({length: 365}, () => []),
    hi_app: Array.from({length: 365}, () => []),
    lo_app: Array.from({length: 365}, () => []),
    rh_hi:  Array.from({length: 365}, () => []),
    rh_lo:  Array.from({length: 365}, () => []),
    ws:     Array.from({length: 365}, () => []),
  };

  const times = dailyData.time || [];
  for (let i = 0; i < times.length; i++) {
    const dateStr = times[i];
    if (isLeapDay(dateStr)) continue;
    const key = mmddKey(dateStr);
    const idx = DOY_MAP.get(key);
    if (idx == null) continue;

    const push = (arr, field) => {
      const v = dailyData[field]?.[i];
      if (v != null && isFinite(v)) arr[idx].push(v);
    };

    push(buckets.hi,     "temperature_2m_max");
    push(buckets.lo,     "temperature_2m_min");
    push(buckets.hi_app, "apparent_temperature_max");
    push(buckets.lo_app, "apparent_temperature_min");
    push(buckets.rh_hi,  "relative_humidity_2m_max");
    push(buckets.rh_lo,  "relative_humidity_2m_min");
    push(buckets.ws,     "windspeed_10m_max");
  }

  function avgBuckets(arr) {
    return arr.map(b => b.length ? Math.round((b.reduce((a, x) => a + x, 0) / b.length) * 10) / 10 : null);
  }

  return {
    hi:     avgBuckets(buckets.hi),
    lo:     avgBuckets(buckets.lo),
    hi_app: avgBuckets(buckets.hi_app),
    lo_app: avgBuckets(buckets.lo_app),
    rh_hi:  avgBuckets(buckets.rh_hi),
    rh_lo:  avgBuckets(buckets.rh_lo),
    ws:     avgBuckets(buckets.ws),
  };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(POINTS_PATH)) {
    console.error(`ERROR: ${POINTS_PATH} not found. Generate points.json first.`);
    process.exit(1);
  }

  const allPoints = readJson(POINTS_PATH);

  const targets = allPoints.filter(isTargetPoint);
  console.log(`[NTT] ${allPoints.length} total points, ${targets.length} selected for normals`);

  // Load existing output (resume-safe)
  let output = { meta: null, points: [] };
  if (fs.existsSync(HIST_PATH)) {
    const existing = readJson(HIST_PATH);
    if (existing.points?.length) {
      output = existing;
      console.log(`[NTT] Resuming — ${output.points.length} points already written`);
    }
  }

  const doneIds = new Set(output.points.map(p => p.id));

  output.meta = {
    source:    `ERA5-Land via Open-Meteo archive API`,
    dataset:   DATASET,
    years:     `${START_DATE.slice(0,4)}-${END_DATE.slice(0,4)}`,
    generated: new Date().toISOString().slice(0, 10),
    variables: DAILY_VARS,
  };

  const todo = targets.filter(p => !doneIds.has(p.id));
  console.log(`[NTT] ${todo.length} points remaining`);

  const limit = MAX_POINTS != null ? Math.min(MAX_POINTS, todo.length) : todo.length;

  for (let i = 0; i < limit; i++) {
    const pt = todo[i];
    console.log(`\n[${i+1}/${limit}] ${pt.id}  (section: ${pt.section}, mile: ${pt.mile}, axis: ${pt.axis_mile})  lat=${pt.lat}, lon=${pt.lon}`);

    const url = new URL(API_BASE);
    url.searchParams.set("latitude",         pt.lat);
    url.searchParams.set("longitude",        pt.lon);
    url.searchParams.set("start_date",       START_DATE);
    url.searchParams.set("end_date",         END_DATE);
    url.searchParams.set("daily",            DAILY_VARS);
    url.searchParams.set("temperature_unit", TEMP_UNIT);
    url.searchParams.set("windspeed_unit",   WIND_UNIT);
    url.searchParams.set("timezone",         TIMEZONE);

    let data;
    try {
      data = await fetchWithRetry(url.toString());
    } catch (err) {
      console.error(`  ERROR fetching ${pt.id}: ${err.message}`);
      console.error("  Stopping — re-run to resume from this point.");
      break;
    }

    const normals = computeNormals(data.daily);

    output.points.push({
      id:        pt.id,
      lat:       pt.lat,
      lon:       pt.lon,
      section:   pt.section,
      mile:      pt.mile,
      axis_mile: pt.axis_mile,
      ...normals,
    });

    writeJson(HIST_PATH, output);
    console.log(`  Saved. (${output.points.length} total written)`);

    if (i < limit - 1) {
      console.log(`  Waiting ${SLEEP_MS / 1000}s…`);
      await sleep(SLEEP_MS);
    }
  }

  console.log(`\n[NTT] Done. ${output.points.length} / ${targets.length} points in ${HIST_PATH}`);
  if (output.points.length < targets.length) {
    console.log("Re-run to continue generating remaining points.");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
