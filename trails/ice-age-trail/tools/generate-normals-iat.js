/**
 * generate-normals-iat.js
 *
 * Generates daily "normals" (365-day averaged arrays) for Ice Age Trail points.
 * - Reads trails/ice-age-trail/data/points.json
 * - Selects one point per ~5 axis miles across the full trail (~240 points)
 * - Fetches daily max/min temps, apparent temps, humidity, and wind speed
 *   via Open-Meteo Historical Weather API (ERA5-Land, 2018–2024)
 * - Computes per-MM-DD average across years (skips Feb 29)
 * - Writes to trails/ice-age-trail/data/historical_weather.json
 * - Resume-safe: writes after EACH point; re-run to continue where it stopped
 *
 * Run: node trails/ice-age-trail/tools/generate-normals-iat.js
 *
 * Open-Meteo Historical Weather API: https://open-meteo.com/en/docs/historical-weather-api
 */

const fs   = require("fs");
const path = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join("trails", "ice-age-trail", "data");
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

// Target spacing in axis miles for normals point selection.
const NORMALS_INTERVAL_MILES = 5.0;

// Set to a number (e.g. 3) to process only first N missing points — useful for testing.
// Set to null to process all.
const MAX_POINTS = null;

// ─── API CONFIG ─────────────────────────────────────────────────────────────

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
// Main spine: select the point whose axis_mile is closest to each multiple of
// NORMALS_INTERVAL_MILES. This gives roughly 1 point per 5 miles across
// the full ~1,250-mile trail (~250 points total).
//
// East Alt: same approach using alt_mile for the ~71-mile alternate route.

function selectTargetPoints(allPoints) {
  if (!allPoints.length) return [];

  // Main spine only (no alt_id)
  const mainPoints = allPoints.filter(p => !p.alt_id);
  const maxAxis = Math.max(...mainPoints.map(p => p.axis_mile));
  const targets = [];
  const used    = new Set();

  for (let target = 0; target <= maxAxis + NORMALS_INTERVAL_MILES * 0.5; target += NORMALS_INTERVAL_MILES) {
    let best = null, bestDist = Infinity;
    for (const p of mainPoints) {
      const d = Math.abs(p.axis_mile - target);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    if (best && !used.has(best.id)) {
      used.add(best.id);
      targets.push(best);
    }
  }

  // East Alt (alt_id === "east") — sampled by alt_mile
  const eastAltPoints = allPoints.filter(p => p.alt_id === "east");
  if (eastAltPoints.length) {
    const maxAlt = Math.max(...eastAltPoints.map(p => p.alt_mile));
    for (let target = 0; target <= maxAlt + NORMALS_INTERVAL_MILES * 0.5; target += NORMALS_INTERVAL_MILES) {
      let best = null, bestDist = Infinity;
      for (const p of eastAltPoints) {
        const d = Math.abs(p.alt_mile - target);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      if (best && !used.has(best.id)) {
        used.add(best.id);
        targets.push(best);
      }
    }
  }

  return targets;
}

// ─── UTILITIES ─────────────────────────────────────────────────────────────

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * ERA5-Land grid resolution is ~9 km (~5.6 mi). Any two points within
 * REUSE_THRESHOLD_MI of each other will receive identical data from the API.
 * When a new target is close to an existing normals entry, copy the arrays
 * instead of making a redundant API call.
 */
const REUSE_THRESHOLD_MI = 1.0;

function findNearestExisting(pt, existingPoints) {
  let bestDist = Infinity, best = null;
  for (const e of existingPoints) {
    const d = haversineMiles(pt.lat, pt.lon, e.lat, e.lon);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return bestDist <= REUSE_THRESHOLD_MI ? best : null;
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

// ─── DATE / DOY HELPERS ───────────────────────────────────────────────────

function isLeapDay(dateStr) {
  return dateStr.slice(5) === "02-29";
}

function mmddKey(dateStr) {
  return dateStr.slice(5); // "MM-DD"
}

function buildDayOfYearMap() {
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

// ─── NORMALS COMPUTATION ──────────────────────────────────────────────────

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
    return arr.map(b =>
      b.length ? Math.round((b.reduce((a, x) => a + x, 0) / b.length) * 10) / 10 : null
    );
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

// ─── MAIN ─────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(POINTS_PATH)) {
    console.error(`ERROR: ${POINTS_PATH} not found. Run build-points-iat.js first.`);
    process.exit(1);
  }

  const allPoints = readJson(POINTS_PATH);
  const targets   = selectTargetPoints(allPoints);

  const mainPoints    = allPoints.filter(p => !p.alt_id);
  const eastAltPoints = allPoints.filter(p => p.alt_id === "east");
  console.log(`[IAT] ${allPoints.length} total points (${mainPoints.length} main + ${eastAltPoints.length} East Alt)`);
  console.log(`[IAT] ${targets.length} selected for normals (every ~${NORMALS_INTERVAL_MILES} miles)`);
  console.log(`[IAT] Main axis range: 0 – ${Math.max(...mainPoints.map(p => p.axis_mile)).toFixed(1)} miles`);
  if (eastAltPoints.length) {
    console.log(`[IAT] East Alt alt_mile range: 0 – ${Math.max(...eastAltPoints.map(p => p.alt_mile)).toFixed(1)} miles`);
  }

  // Load existing output (resume-safe).
  // Strip stale entries whose IDs are no longer in points.json — these were
  // generated from a previous build and have since been replaced.
  const validIds = new Set(allPoints.map(p => p.id));
  let output = { meta: null, points: [] };
  if (fs.existsSync(HIST_PATH)) {
    try {
      const existing = readJson(HIST_PATH);
      if (existing.points?.length) {
        const before = existing.points.length;
        existing.points = existing.points.filter(p => validIds.has(p.id));
        const removed = before - existing.points.length;
        output = existing;
        console.log(`[IAT] Resuming — ${output.points.length} valid points already written` +
          (removed > 0 ? ` (removed ${removed} stale)` : ""));
      }
    } catch {
      console.log("[IAT] Could not read existing output — starting fresh");
    }
  }

  const doneIds = new Set(output.points.map(p => p.id));

  output.meta = {
    source:    "ERA5-Land via Open-Meteo archive API",
    dataset:   DATASET,
    years:     `${START_DATE.slice(0,4)}-${END_DATE.slice(0,4)}`,
    generated: new Date().toISOString().slice(0, 10),
    variables: DAILY_VARS,
    interval_miles: NORMALS_INTERVAL_MILES,
  };

  // Snapshot of existing valid normals for proximity reuse (avoids re-fetching
  // when a new target is within ERA5-Land grid resolution of an existing entry).
  const existingForReuse = [...output.points];

  const todo  = targets.filter(p => !doneIds.has(p.id));
  const limit = MAX_POINTS != null ? Math.min(MAX_POINTS, todo.length) : todo.length;

  console.log(`[IAT] ${todo.length} points remaining  (limit: ${MAX_POINTS ?? "all"})`);

  let reuseCount = 0, fetchCount = 0;

  for (let i = 0; i < limit; i++) {
    const pt = todo[i];
    const locLabel = pt.alt_id === "east"
      ? `alt_mile: ${pt.alt_mile}`
      : `axis: ${pt.axis_mile}`;
    console.log(
      `\n[${i+1}/${limit}] ${pt.id}` +
      `  section: ${pt.section}  ${locLabel}` +
      `  lat=${pt.lat}  lon=${pt.lon}`
    );

    // Build the shared entry header
    const entry = {
      id:        pt.id,
      lat:       pt.lat,
      lon:       pt.lon,
      section:   pt.section,
      region:    pt.region,
      mile:      pt.mile,
    };
    if (pt.alt_id === "east") {
      entry.alt_id   = pt.alt_id;
      entry.alt_mile = pt.alt_mile;
    } else {
      entry.axis_mile = pt.axis_mile;
    }

    // Try to reuse a nearby existing entry before making an API call.
    const nearby = findNearestExisting(pt, existingForReuse);
    if (nearby) {
      const { hi, lo, hi_app, lo_app, rh_hi, rh_lo, ws } = nearby;
      Object.assign(entry, { hi, lo, hi_app, lo_app, rh_hi, rh_lo, ws });
      output.points.push(entry);
      writeJson(HIST_PATH, output);
      reuseCount++;
      console.log(`  Reused from nearby ${nearby.id} (same ERA5-Land cell). (${output.points.length} total)`);
      continue;
    }

    // No nearby entry — fetch from Open-Meteo API.
    const url = new URL(API_BASE);
    url.searchParams.set("latitude",          pt.lat);
    url.searchParams.set("longitude",         pt.lon);
    url.searchParams.set("start_date",        START_DATE);
    url.searchParams.set("end_date",          END_DATE);
    url.searchParams.set("daily",             DAILY_VARS);
    url.searchParams.set("temperature_unit",  TEMP_UNIT);
    url.searchParams.set("windspeed_unit",    WIND_UNIT);
    url.searchParams.set("timezone",          TIMEZONE);

    let data;
    try {
      data = await fetchWithRetry(url.toString());
    } catch (err) {
      console.error(`  ERROR fetching ${pt.id}: ${err.message}`);
      console.error("  Stopping — re-run to resume from this point.");
      break;
    }

    const normals = computeNormals(data.daily);
    Object.assign(entry, normals);
    output.points.push(entry);
    fetchCount++;

    writeJson(HIST_PATH, output);
    console.log(`  Fetched from API. (${output.points.length} total written)`);

    if (i < limit - 1) {
      // Only sleep before API fetches, not after reuse
      const nextPt = todo[i + 1];
      const nextNearby = findNearestExisting(nextPt, existingForReuse);
      if (!nextNearby) {
        console.log(`  Waiting ${SLEEP_MS / 1000}s…`);
        await sleep(SLEEP_MS);
      }
    }
  }

  console.log(`\n[IAT] Done. ${output.points.length} / ${targets.length} points in ${HIST_PATH}`);
  console.log(`[IAT]   ${reuseCount} reused from nearby existing  |  ${fetchCount} fetched from API`);
  if (output.points.length < targets.length) {
    console.log("Re-run to continue generating remaining points.");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
