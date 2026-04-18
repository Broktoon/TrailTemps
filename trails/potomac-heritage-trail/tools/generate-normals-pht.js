/**
 * generate-normals-pht.js
 *
 * Generates daily "normals" (365-day averaged arrays) for all PHT sections,
 * including both through-hike spine and Weather-Planner-only sections.
 *
 * - Reads  trails/potomac-heritage-trail/data/points.json
 * - Selects target points at ~5-mile intervals per section (both spine + WP-only)
 * - Fetches ERA5-Land normals via Open-Meteo Historical Weather API (2018–2024)
 * - Writes trails/potomac-heritage-trail/data/historical_weather.json
 * - Resume-safe: saves after each point; re-run to continue
 *
 * Run from repo root:
 *   node trails/potomac-heritage-trail/tools/generate-normals-pht.js
 *
 * Options:
 *   --dry-run   Print selected target points without fetching
 *   --max N     Process only the first N missing points (for testing)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── config ────────────────────────────────────────────────────────────────────
const DATA_DIR    = path.join('trails', 'potomac-heritage-trail', 'data');
const POINTS_PATH = path.join(DATA_DIR, 'points.json');
const HIST_PATH   = path.join(DATA_DIR, 'historical_weather.json');

const START_DATE  = '2018-01-01';
const END_DATE    = '2024-12-31';
const DATASET     = 'ERA5-Land';
const TEMP_UNIT   = 'fahrenheit';
const WIND_UNIT   = 'mph';
const TIMEZONE    = 'auto';
const SLEEP_MS    = 2000;           // 2-sec throttle — Open-Meteo Professional
const NORMALS_INTERVAL_MI = 5.0;   // one normals point per 5 trail miles

// ── CLI flags ─────────────────────────────────────────────────────────────────
const DRY_RUN  = process.argv.includes('--dry-run');
const maxArg   = process.argv.indexOf('--max');
const MAX_PTS  = maxArg >= 0 ? parseInt(process.argv[maxArg + 1], 10) : null;

// ── API ───────────────────────────────────────────────────────────────────────
const API_BASE  = 'https://customer-archive-api.open-meteo.com/v1/archive';
const API_KEY   = 'TTyLPYLitRdmWqlF';
const DAILY_VARS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'relative_humidity_2m_max',
  'relative_humidity_2m_min',
  'windspeed_10m_max',
].join(',');

// ── helpers ───────────────────────────────────────────────────────────────────
function readJson(p)       { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function sleep(ms)         { return new Promise(r => setTimeout(r, ms)); }
function isFeb29(iso)      { return iso.endsWith('-02-29'); }
function buildEmpty365()   { return new Array(365).fill(null); }

function dayIndexFromMMDD(mmdd) {
  const [mm, dd] = mmdd.split('-').map(Number);
  const d     = new Date(2021, mm - 1, dd);
  const start = new Date(2021, 0, 1);
  return Math.max(0, Math.min(364, Math.round((d - start) / 86400000)));
}

// ── target point selection ────────────────────────────────────────────────────
/**
 * From all points in points.json, select one target point per 5-mile interval
 * within each (section_id, alt_id) group. Ensures at least one point per
 * section regardless of length.
 *
 * Returns an array of points with a synthetic `target_id` matching the id
 * field — these are the actual points.json entries to fetch normals for.
 */
function selectTargetPoints(allPoints) {
  // Group points by section key = "section_id|alt_id"
  const groups = new Map();

  for (const p of allPoints) {
    const key = `${p.section_id}|${p.alt_id || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const targets = [];

  for (const [key, pts] of groups.entries()) {
    // Sort by section_mile ascending
    pts.sort((a, b) => (a.section_mile ?? 0) - (b.section_mile ?? 0));

    const maxMile = pts[pts.length - 1].section_mile ?? 0;

    if (maxMile <= NORMALS_INTERVAL_MI) {
      // Short section — pick midpoint
      const mid = pts[Math.floor(pts.length / 2)];
      targets.push(mid);
    } else {
      // Select points at 0, 5, 10, ... miles within section
      let nextMark = 0;
      for (const p of pts) {
        const m = p.section_mile ?? 0;
        if (m >= nextMark - 0.05) {
          targets.push(p);
          nextMark = Math.floor(m / NORMALS_INTERVAL_MI) * NORMALS_INTERVAL_MI + NORMALS_INTERVAL_MI;
        }
      }
      // Always include the endpoint if not already close
      const last = pts[pts.length - 1];
      if (!targets.length || Math.abs(targets[targets.length - 1].section_mile - last.section_mile) > 1.0) {
        targets.push(last);
      }
    }
  }

  return targets;
}

// ── API fetch ─────────────────────────────────────────────────────────────────
async function fetchDailyData(lat, lon) {
  const url = new URL(API_BASE);
  url.searchParams.set('latitude',         String(lat));
  url.searchParams.set('longitude',        String(lon));
  url.searchParams.set('start_date',       START_DATE);
  url.searchParams.set('end_date',         END_DATE);
  url.searchParams.set('daily',            DAILY_VARS);
  url.searchParams.set('temperature_unit', TEMP_UNIT);
  url.searchParams.set('windspeed_unit',   WIND_UNIT);
  url.searchParams.set('timezone',         TIMEZONE);
  url.searchParams.set('apikey',           API_KEY);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const txt  = await resp.text().catch(() => '');
    const err  = new Error(`HTTP ${resp.status} from Open-Meteo`);
    err.status = resp.status;
    err.body   = txt.slice(0, 300);
    throw err;
  }
  return resp.json();
}

// ── normals computation ───────────────────────────────────────────────────────
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
  const fields  = ['hi', 'lo', 'app_hi', 'app_lo', 'rh_hi', 'rh_lo', 'ws'];
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

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(POINTS_PATH)) throw new Error(`Missing: ${POINTS_PATH}`);

  const allPoints = readJson(POINTS_PATH);
  if (!Array.isArray(allPoints)) throw new Error('points.json must be a flat array');

  console.log(`Points in points.json : ${allPoints.length}`);

  // Select target points (~5-mile interval per section)
  const targetPoints = selectTargetPoints(allPoints);
  console.log(`Target normals points : ${targetPoints.length}`);
  console.log(`Est. run time         : ~${Math.ceil(targetPoints.length * SLEEP_MS / 60000)} minutes`);

  if (DRY_RUN) {
    console.log('\n-- dry run: selected targets --');
    for (const p of targetPoints) {
      const section = p.section_id + (p.alt_id ? `[${p.alt_id}]` : '');
      console.log(`  ${p.id.padEnd(45)} ${section.padEnd(30)} mile=${p.section_mile?.toFixed(1).padStart(7)} lat=${p.lat} lon=${p.lon}`);
    }
    console.log(`\nTotal: ${targetPoints.length} points`);
    return;
  }

  // Load or initialize historical_weather.json
  let hist;
  if (fs.existsSync(HIST_PATH)) {
    hist = readJson(HIST_PATH);
    if (!hist || typeof hist !== 'object') hist = {};
    if (!Array.isArray(hist.points)) hist.points = [];
    if (!hist.meta) hist.meta = {};
  } else {
    hist = { meta: {}, points: [] };
  }

  // Remove stale entries (IDs no longer in points.json)
  const validIds  = new Set(allPoints.map(p => String(p.id)));
  const before    = hist.points.length;
  hist.points     = hist.points.filter(p => validIds.has(String(p.id)));
  if (hist.points.length < before)
    console.log(`Removed ${before - hist.points.length} stale normals entries.`);

  const existingIds = new Set(hist.points.map(p => String(p.id)));
  const missing     = targetPoints.filter(p => !existingIds.has(String(p.id)));

  console.log(`Existing normals      : ${hist.points.length}`);
  console.log(`Missing normals       : ${missing.length}`);

  if (missing.length === 0) {
    console.log('All target points already have normals. Nothing to do.');
    return;
  }

  const toProcess = MAX_PTS != null ? missing.slice(0, MAX_PTS) : missing;

  let processed = 0;
  for (const p of toProcess) {
    const id  = String(p.id);
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    const section = p.section_id + (p.alt_id ? `[${p.alt_id}]` : '');

    console.log(`\n[${processed + 1}/${toProcess.length}] ${id}`);
    console.log(`  section=${section}  mile=${p.section_mile?.toFixed(1)}  lat=${lat}  lon=${lon}`);

    try {
      const data  = await fetchDailyData(lat, lon);
      const daily = data?.daily;
      if (!daily?.time?.length) throw new Error('No daily.time in response');

      const { normals, hiCount } = computeNormals(daily);
      if (hiCount < 330) console.warn(`  Warning: sparse coverage (hi=${hiCount} days)`);

      hist.points.push({
        id,
        lat,
        lon,
        section_id:   p.section_id,
        alt_id:       p.alt_id || null,
        section_mile: p.section_mile,
        on_spine:     p.on_spine !== false,   // true unless explicitly false
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
      console.log(`  Written (hi coverage: ${hiCount}/365)`);
      await sleep(SLEEP_MS);

    } catch (err) {
      console.error(`\nError on ${id}: ${err.message}`);
      if (err.status) console.error(`HTTP ${err.status}`);
      if (err.body)   console.error(`Body: ${err.body}`);
      console.error('Stopping. Re-run to continue.');
      process.exit(1);
    }
  }

  console.log(`\nDone. Generated ${processed} new normals records.`);
  console.log(`historical_weather.json now has ${hist.points.length} / ${targetPoints.length} total records.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
