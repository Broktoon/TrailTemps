#!/usr/bin/env node
/**
 * Resume build_planning_normals.json from a given mile.
 *
 * Compatible with build_planning_normals.js output schema.
 *
 * Usage:
 *   node tools/resume_build_planning_normals.js --startMile=1200
 */
/**
 * DEPRECATED (2026-02-23)
 * This script expects legacy points schema with { mile_est } and legacy point IDs.
 *
 * TrailTemps is now standardized on:
 *   - points.json: uses { mile } only (mile_est removed)
 *   - point IDs: at-main-mi<mile_thousandths>
 *
 * Use instead:
 *   scripts/generate-missing-normals-at.js
 *   scripts/normalize-points-mile-only.js
 *
 * If you must revive this script, update it to read { mile } and to use new IDs.
 */
throw new Error(
  "DEPRECATED: This tool expects legacy {mile_est}. Use scripts/generate-missing-normals-at.js instead."
);
const fs = require("fs");
const path = require("path");

const POINTS_PATH = path.join(__dirname, "..", "data", "points.json");
const OUT_PATH    = path.join(__dirname, "..", "data", "planning_normals.json");

const HIST_BASE = "https://archive-api.open-meteo.com/v1/archive";
const DAILY_VARS = "temperature_2m_max,temperature_2m_min";

const START_MILE = Number(
  process.argv.find(a => a.startsWith("--startMile="))?.split("=")[1] ?? 1200
);

const WINDOW_DAYS = 3;
const DELAY_MS = 1200;
const CHECKPOINT_EVERY = 5;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, maxRetries = 8) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url);
    if (resp.ok) return resp;

    if (![429, 502, 503].includes(resp.status) || attempt === maxRetries) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}\n${body.slice(0, 200)}`);
    }

    const delay = Math.min(15000, 1000 * Math.pow(2, attempt));
    console.log(`  Rate limited (${resp.status}). Retry in ${delay / 1000}s`);
    await sleep(delay);
  }
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function lastSevenYearsRange() {
  const end = new Date();
  end.setDate(end.getDate() - 2);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 7);
  return { start_date: toISODate(start), end_date: toISODate(end) };
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function indexHistoricalByMonthDay(histDaily) {
  const idx = new Map();
  for (let i = 0; i < histDaily.time.length; i++) {
    const md = histDaily.time[i].slice(5);
    if (!idx.has(md)) idx.set(md, { max: [], min: [] });
    if (histDaily.temperature_2m_max[i] != null) idx.get(md).max.push(histDaily.temperature_2m_max[i]);
    if (histDaily.temperature_2m_min[i] != null) idx.get(md).min.push(histDaily.temperature_2m_min[i]);
  }
  return idx;
}

function monthDayFromIndex(i) {
  const base = new Date(2021, 0, 1);
  const d = addDays(base, i);
  return `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function compute365(idx) {
  const hi = Array(365).fill(null);
  const lo = Array(365).fill(null);

  for (let i = 0; i < 365; i++) {
    const md = monthDayFromIndex(i);
    const vals = [];
    const lows = [];

    for (let w = -WINDOW_DAYS; w <= WINDOW_DAYS; w++) {
      const d = addDays(new Date(2021, 0, 1 + i), w);
      const key = `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      if (idx.has(key)) {
        vals.push(...idx.get(key).max);
        lows.push(...idx.get(key).min);
      }
    }

    if (vals.length) hi[i] = Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
    if (lows.length) lo[i] = Math.round(lows.reduce((a,b)=>a+b,0)/lows.length);
  }

  return { hi, lo };
}

(async function main() {
  const points = JSON.parse(fs.readFileSync(POINTS_PATH, "utf8"))
    .map(p => ({
      id: String(p.id ?? `${p.state}_${p.mile_est}`),
      state: String(p.state).toUpperCase(),
      mile_est: Number(p.mile_est),
      lat: Number(p.lat),
      lon: Number(p.lon)
    }))
    .filter(p => Number.isFinite(p.mile_est) && Number.isFinite(p.lat));

  points.sort((a,b) => a.mile_est - b.mile_est);

  const out = fs.existsSync(OUT_PATH)
    ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8"))
    : { meta:{}, points:[] };

  const existing = new Set(out.points.map(p => p.id));
  const range = out.meta.range ?? lastSevenYearsRange();

  let added = 0;

  for (const p of points) {
    if (p.mile_est < START_MILE) continue;
    if (existing.has(p.id)) continue;

    console.log(`mile ${p.mile_est} (${p.id})`);
    await sleep(DELAY_MS);

    const url = new URL(HIST_BASE);
    url.searchParams.set("latitude", p.lat);
    url.searchParams.set("longitude", p.lon);
    url.searchParams.set("start_date", range.start_date);
    url.searchParams.set("end_date", range.end_date);
    url.searchParams.set("daily", DAILY_VARS);
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("timezone", "auto");

    const resp = await fetchWithRetry(url.toString());
    const hist = await resp.json();
    const idx = indexHistoricalByMonthDay(hist.daily);

    const { hi, lo } = compute365(idx);
    out.points.push({ id:p.id, hi, lo });

    added++;
    if (added % CHECKPOINT_EVERY === 0) {
      fs.writeFileSync(OUT_PATH, JSON.stringify(out));
      console.log("  checkpoint saved");
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`Done. Appended ${added} points.`);
})();

