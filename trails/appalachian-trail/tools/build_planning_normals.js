#!/usr/bin/env node
/**
 * Build precomputed planning normals for Appalachian Trail points.
 *
 * Output: data/planning_normals.json
 *
 * What it does:
 *  - Reads data/points.json
 *  - For each point, downloads 7 years of daily max/min temperatures from Open-Meteo Historical Weather API
 *  - Computes a window-smoothed planning average for every month-day (365 days, non-leap year index)
 *  - Writes a compact single-file JSON suitable for mobile (arrays of integers)
 *
 * Notes:
 *  - This script makes network calls; run it locally (Node 18+ recommended).
 *  - It is rate-limit aware (429) and retries with exponential backoff.
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
const OUT_PATH = path.join(__dirname, "..", "data", "planning_normals.json");

const HIST_BASE = "https://archive-api.open-meteo.com/v1/archive";
const DAILY_VARS = "temperature_2m_max,temperature_2m_min";

const WINDOW_DAYS = 3; // +/-3 days (7-day window)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toISODate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function lastSevenYearsRange() {
  // Use "today - 2 days" to respect Open-Meteo delay
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  end.setDate(end.getDate() - 2);

  const start = new Date(end.getTime());
  start.setFullYear(start.getFullYear() - 7);

  return { start_date: toISODate(start), end_date: toISODate(end) };
}

async function fetchWithRetry(url, { maxRetries = 8, baseDelayMs = 800, maxDelayMs = 20000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url);

    if (resp.ok) return resp;

    const retryable = resp.status === 429 || resp.status === 502 || resp.status === 503;
    if (!retryable || attempt === maxRetries) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} for ${url}\n${body.slice(0, 200)}`);
    }

    const ra = resp.headers.get("Retry-After");
    let delay = ra ? Number(ra) * 1000 : baseDelayMs * Math.pow(2, attempt);
    if (!Number.isFinite(delay) || delay <= 0) delay = baseDelayMs * Math.pow(2, attempt);
    delay = Math.min(delay, maxDelayMs);

    console.log(`  Rate-limited/temporary error (HTTP ${resp.status}). Retry in ${Math.round(delay / 1000)}s...`);
    await sleep(delay);
  }

  throw new Error("Retry exhausted");
}

function indexHistoricalByMonthDay(histDaily) {
  const idx = new Map();
  const times = histDaily.time || [];
  const tmax = histDaily.temperature_2m_max || [];
  const tmin = histDaily.temperature_2m_min || [];

  for (let i = 0; i < times.length; i++) {
    const md = times[i].slice(5); // MM-DD
    if (!idx.has(md)) idx.set(md, { max: [], min: [] });
    const bucket = idx.get(md);
    if (tmax[i] != null) bucket.max.push(tmax[i]);
    if (tmin[i] != null) bucket.min.push(tmin[i]);
  }
  return idx;
}

function addDays(dateObj, days) {
  const d = new Date(dateObj.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function mdWindowKeys(monthDay, windowDays) {
  // monthDay: MM-DD; build a window around a fixed non-leap year (2021)
  const [mmStr, ddStr] = monthDay.split("-");
  const base = new Date(2021, Number(mmStr) - 1, Number(ddStr));

  const keys = [];
  for (let offset = -windowDays; offset <= windowDays; offset++) {
    const dt = addDays(base, offset);
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    keys.push(`${mm}-${dd}`);
  }
  return keys;
}

function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computePlanningForMonthDay(histIdx, monthDay, windowDays) {
  const keys = mdWindowKeys(monthDay, windowDays);
  const maxVals = [];
  const minVals = [];

  for (const k of keys) {
    const b = histIdx.get(k);
    if (!b) continue;
    maxVals.push(...b.max);
    minVals.push(...b.min);
  }

  return { hi: avg(maxVals), lo: avg(minVals) };
}

function monthDayFromDayIndex(i) {
  // i: 0..364 mapped to 2021-01-01 .. 2021-12-31
  const base = new Date(2021, 0, 1);
  const dt = addDays(base, i);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

async function fetchHistoricalForPoint(point, range) {
  const url = new URL(HIST_BASE);
  url.searchParams.set("latitude", point.lat);
  url.searchParams.set("longitude", point.lon);
  url.searchParams.set("start_date", range.start_date);
  url.searchParams.set("end_date", range.end_date);
  url.searchParams.set("daily", DAILY_VARS);
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", "auto");

  // Gentle throttle to reduce 429 likelihood
  await sleep(250);

  const resp = await fetchWithRetry(url.toString());
  return resp.json();
}

async function main() {
  if (!fs.existsSync(POINTS_PATH)) {
    throw new Error(`Missing ${POINTS_PATH}. Expected your points.json at data/points.json`);
  }

  const pointsRaw = JSON.parse(fs.readFileSync(POINTS_PATH, "utf8"));
  const points = pointsRaw
    .map((p) => ({
      id: String(p.id != null ? p.id : `${(p.state || "").toString().toUpperCase()}_${Number(p.mile_est)}`),
      state: (p.state || "").toString().toUpperCase(),
      mile_est: Number(p.mile_est),
      lat: Number(p.lat),
      lon: Number(p.lon)
    }))
    .filter((p) => p.id && p.state && Number.isFinite(p.mile_est) && Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (points.length === 0) {
    throw new Error("No valid points in points.json (expect fields: state, mile_est, lat, lon)");
  }

  const range = lastSevenYearsRange();
  console.log(`Building planning normals using range ${range.start_date} to ${range.end_date}`);
  console.log(`Points: ${points.length} (one historical request per point)`);

  const out = {
    meta: {
      version: new Date().toISOString().slice(0, 10),
      window_days: WINDOW_DAYS,
      range,
      days: 365,
      units: "fahrenheit",
      rounding: "integer"
    },
    points: []
  };

  // Sequential is safest for rate-limits.
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    console.log(`[${i + 1}/${points.length}] ${p.id} (${p.state} mile~${p.mile_est})`);

    const hist = await fetchHistoricalForPoint(p, range);
    const daily = hist?.daily;
    if (!daily?.time) {
      console.log("  Warning: no daily data returned; writing null arrays");
      out.points.push({ id: p.id, hi: Array(365).fill(null), lo: Array(365).fill(null) });
      continue;
    }

    const idx = indexHistoricalByMonthDay(daily);
    const hi = new Array(365);
    const lo = new Array(365);

    for (let di = 0; di < 365; di++) {
      const md = monthDayFromDayIndex(di);
      const v = computePlanningForMonthDay(idx, md, WINDOW_DAYS);
      hi[di] = v.hi == null ? null : Math.round(v.hi);
      lo[di] = v.lo == null ? null : Math.round(v.lo);
    }

    out.points.push({ id: p.id, hi, lo });
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`\nWrote: ${OUT_PATH}`);
  console.log("Tip: ensure your hosting serves JSON with gzip/brotli compression.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
