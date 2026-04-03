/* Natchez Trace Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - NOBO / SOBO direction
           - 5 disconnected sections; hiking miles computed per-section
           - 1 travel day added between each pair of sections (4 total)
           - Total duration = sum(ceil(secLen/mpd) per section) + 4
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json)
           - Heat index advisory when apparent high ≥ 100 °F
           - Wind chill advisory when apparent low ≤ 20 °F
   Tool B: Weather planner
           - Section selector → Section Mile → Date
           - Open-Meteo forecast (5-day) + current conditions
           - 7-year planning average high/low
           - Apparent temperature (Steadman: heat index + wind chill)
   Maps: Leaflet + OSM tiles + trail.geojson overlay
   Units: Fahrenheit, mph, %
   Caching: localStorage (TTL-based)
   ---------------------------------------------------------------*/

/* ============================================================
   1. TRAIL IDENTITY & URL RESOLUTION
   ============================================================ */

function getTrailMeta() {
  const slug =
    window.TRAIL_SLUG ||
    document.body?.dataset?.trail ||
    "natchez-trace-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:       new URL("points.json",            dataDir).href,
    trailGeojsonUrl: new URL("trail.geojson",          dataDir).href,
    normalsUrl:      new URL("historical_weather.json", dataDir).href,
    nttMetaUrl:      new URL("ntt_meta.json",           dataDir).href,
    defaultMapCenter: [33.5, -89.5],
    defaultZoom:      7,
  };
}

const META      = getTrailMeta();
const trailSlug = META.slug;

console.log("[NTT] slug =", trailSlug);

/* ============================================================
   2. OPEN-METEO ENDPOINTS & VARIABLE LISTS
   ============================================================ */

const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const HIST_BASE     = "https://archive-api.open-meteo.com/v1/archive";

const FORECAST_DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "relative_humidity_2m_max",
  "relative_humidity_2m_min",
  "precipitation_probability_max",
  "windspeed_10m_max",
].join(",");

const HIST_DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "relative_humidity_2m_max",
  "relative_humidity_2m_min",
].join(",");

/* ============================================================
   3. CONSTANTS & CACHE SETTINGS
   ============================================================ */

const TYPICAL_WINDOW_DAYS   = 3;

const FORECAST_TTL_MS       = 30 * 60 * 1000;
const HIST_TTL_MS           = 24 * 60 * 60 * 1000;
const TRAIL_TTL_MS          = 30 * 24 * 60 * 60 * 1000;
const NORMALS_TTL_MS        = 30 * 24 * 60 * 60 * 1000;
const NORMALS_CACHE_VERSION = "v2";

// NTT trail structure constants
const NTT_TOTAL_TRAIL_MILES = 68.89;
const NTT_TRAVEL_DAYS       = 4;    // one between each consecutive section pair

// Section definitions (NOBO order). These mirror ntt_meta.json / bootstrap.
// axis_start/axis_end are cumulative trail miles measured from NPS GIS data.
const NTT_SECTIONS_DEF = [
  { id: "portkopinu",        name: "Portkopinu",        axis_start:  0.00, axis_end:  3.44, len:  3.44 },
  { id: "rocky-springs",     name: "Rocky Springs",     axis_start:  3.44, axis_end: 12.43, len:  8.99 },
  { id: "yockanookany",      name: "Yockanookany",      axis_start: 12.43, axis_end: 38.16, len: 25.73 },
  { id: "blackland-prairie", name: "Blackland Prairie", axis_start: 38.16, axis_end: 44.27, len:  6.11 },
  { id: "highland-rim",      name: "Highland Rim",      axis_start: 44.27, axis_end: 68.89, len: 24.63 },
];

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

let allPoints          = [];
let pointsBySection    = new Map();  // sectionId → Point[] sorted by mile (section-relative)
let pointsSortedByAxis = [];         // all points sorted by axis_mile

let nttMeta = null;

let normalsByPointId = new Map();
let normalsByAxis    = [];           // [{id, axis_mile}] sorted — nearest-neighbour fallback
let normalsMeta      = null;

let map        = null;
let mapMarker  = null;

let durMap           = null;
let durMapLayerGroup = null;

const SELECT_ZOOM = 12;

/* ============================================================
   5. UTILITY FUNCTIONS
   ============================================================ */

const el = (id) => document.getElementById(id);

function setHtmlIfExists(id, html) {
  const n = el(id); if (n) n.innerHTML = html;
}
function setDisplayIfExists(id, val) {
  const n = el(id); if (n) n.style.display = val;
}
function setDurStatus(msg) {
  const s = el("durStatus"); if (s) s.textContent = msg;
}
function setWeatherStatus(msg) {
  const s = el("weatherStatus"); if (s) s.textContent = msg;
}

function safeJSONParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function cacheGet(key, ttlMs) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const obj = safeJSONParse(raw);
  if (!obj || !obj.ts) return null;
  if (Date.now() - obj.ts > ttlMs) return null;
  return obj.data;
}
function cacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* quota exceeded — silently skip */ }
}

function addDays(d, n) {
  const r = new Date(d.getTime()); r.setDate(r.getDate() + n); return r;
}
function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtMile(m) { return (Math.round(Number(m) * 10) / 10).toFixed(1); }

function refreshMapSize() {
  if (map) setTimeout(() => { try { map.invalidateSize(); } catch {} }, 0);
}

function boundsFromPoints(pts) {
  if (!pts?.length || typeof L === "undefined") return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    const la = Number(p.lat), lo = Number(p.lon);
    if (!isFinite(la) || !isFinite(lo)) continue;
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
  }
  if (!isFinite(minLat)) return null;
  return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
}

/* ============================================================
   6. POINT LABEL HELPER
   ============================================================ */

function nttPointLabel(point) {
  const secDef = NTT_SECTIONS_DEF.find(s => s.id === point.section);
  const secName = secDef?.name || point.section || "Unknown Section";
  const mile = isFinite(point.mile) ? point.mile : "?";
  return `${secName} \u2014 Mile ${mile}`;
}

/* ============================================================
   7. MONTH/DAY PICKER
   ============================================================ */

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

function daysInMonth(monthIdx) {
  return new Date(2021, monthIdx + 1, 0).getDate();
}

function formatMonthDayName(monthDay) {
  const [mm, dd] = monthDay.split("-").map(Number);
  return `${MONTH_NAMES[mm-1]} ${dd}`;
}

function initMonthDayPickerGeneric(monthSelId, daySelId) {
  const mSel = el(monthSelId), dSel = el(daySelId);
  if (!mSel || !dSel) return;

  mSel.innerHTML = "";
  MONTH_NAMES.forEach((name, i) => {
    const o = document.createElement("option");
    o.value = i + 1; o.textContent = name; mSel.appendChild(o);
  });

  function populateDays() {
    const mi = Number(mSel.value) - 1;
    const max = daysInMonth(mi);
    const prev = Number(dSel.value) || 1;
    dSel.innerHTML = "";
    for (let d = 1; d <= max; d++) {
      const o = document.createElement("option");
      o.value = d; o.textContent = d; dSel.appendChild(o);
    }
    dSel.value = Math.min(prev, max);
  }

  mSel.addEventListener("change", populateDays);
  const today = new Date();
  mSel.value = today.getMonth() + 1;
  populateDays();
  dSel.value = Math.min(today.getDate(), daysInMonth(today.getMonth()));
}

function getSelectedMonthDay(monthSelId, daySelId) {
  const m = el(monthSelId)?.value, d = el(daySelId)?.value;
  if (!m || !d) return null;
  return `${pad2(m)}-${pad2(d)}`;
}

/* ============================================================
   8. COLORED PIN ICON (for extremes map)
   ============================================================ */

function makeColoredPinIcon(colorHex) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41">
    <path d="M12.5 0C5.6 0 0 5.6 0 12.5c0 10.2 12.5 28.5 12.5 28.5S25 22.7 25 12.5C25 5.6 19.4 0 12.5 0z"
          fill="${colorHex}" stroke="#333" stroke-width="1"/>
    <circle cx="12.5" cy="12.5" r="4.2" fill="#ffffff" opacity="0.95"/>
  </svg>`.trim();
  return L.icon({
    iconUrl: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [0, -34]
  });
}

/* ============================================================
   9. DURATION CALCULATION (NTT-specific)
   ============================================================ */

/**
 * Returns total duration days for a complete NTT traverse.
 * Unlike continuous trails, each section is ceilinged independently
 * because you cannot carry over unused miles between disconnected sections.
 * Four travel days are added (one between each consecutive section pair).
 */
function calcNttDuration(milesPerDay) {
  let hikingDays = 0;
  for (const sec of NTT_SECTIONS_DEF) {
    hikingDays += Math.ceil(sec.len / milesPerDay);
  }
  return { hikingDays, travelDays: NTT_TRAVEL_DAYS, totalDays: hikingDays + NTT_TRAVEL_DAYS };
}

/* ============================================================
   10. START DATE RESOLUTION
   ============================================================ */

function resolveStartDate(monthDay) {
  const [mm, dd] = monthDay.split("-").map(Number);
  const today = new Date();
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let candidate = new Date(base.getFullYear(), mm - 1, dd);
  if (candidate < base) candidate = new Date(base.getFullYear() + 1, mm - 1, dd);
  return candidate;
}

function numVal(id) {
  const v = el(id)?.value;
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/* ============================================================
   11. DATA LOADING
   ============================================================ */

async function loadNttMeta() {
  const key = `ntt_meta_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload = cached;
  if (!payload) {
    const r = await fetch(META.nttMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`ntt_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  nttMeta = payload;
  console.log("[NTT] ntt_meta loaded:", nttMeta.sections?.length, "sections");
}

async function loadPoints() {
  const r = await fetch(META.pointsUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`points.json fetch failed (${r.status})`);
  const data = await r.json();

  allPoints = data.filter(p =>
    isFinite(Number(p.lat)) && isFinite(Number(p.lon))
  ).map(p => ({
    ...p,
    lat:       Number(p.lat),
    lon:       Number(p.lon),
    id:        String(p.id),
    mile:      Number(p.mile),
    axis_mile: Number(p.axis_mile),
  }));

  pointsBySection = new Map();
  for (const p of allPoints) {
    if (!pointsBySection.has(p.section)) pointsBySection.set(p.section, []);
    pointsBySection.get(p.section).push(p);
  }
  for (const [, arr] of pointsBySection) {
    arr.sort((a, b) => a.mile - b.mile);
  }

  pointsSortedByAxis = [...allPoints].sort((a, b) => a.axis_mile - b.axis_mile);

  console.log("[NTT] points loaded:", allPoints.length);
}

async function loadPrecomputedNormals() {
  const key = `ntt_normals_${trailSlug}_${NORMALS_CACHE_VERSION}`;
  const cached = cacheGet(key, NORMALS_TTL_MS);
  let payload = cached;
  if (!payload) {
    const r = await fetch(META.normalsUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`historical_weather.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }

  normalsByPointId = new Map();
  normalsMeta = payload.meta || null;

  for (const p of (payload.points || [])) {
    if (!p?.id) continue;
    normalsByPointId.set(String(p.id), {
      hi:     p.hi     || [],
      lo:     p.lo     || [],
      app_hi: p.hi_app || p.hi || [],
      app_lo: p.lo_app || p.lo || [],
      rh_hi:  p.rh_hi  || [],
      rh_lo:  p.rh_lo  || [],
      ws:     p.ws     || [],
    });
  }

  normalsByAxis = pointsSortedByAxis
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, axis_mile: p.axis_mile }));

  console.log("[NTT] normals loaded:", normalsByPointId.size, "points");
}

/* ============================================================
   12. TRAIL GEOJSON OVERLAY
   ============================================================ */

async function fetchTrailGeojson() {
  const key = `trail_geojson_${trailSlug}_v2`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  if (cached) return cached;
  const r = await fetch(META.trailGeojsonUrl, { cache: "no-store" });
  if (!r.ok) throw new Error(`trail.geojson fetch failed (${r.status})`);
  const gj = await r.json();
  cacheSet(key, gj);
  return gj;
}

const weatherHaloRef  = { current: null };
const weatherLayerRef = { current: null };
const durHaloRef      = { current: null };
const durLayerRef     = { current: null };

function applyTrailOverlay(targetMap, haloRef, layerRef, onDone) {
  fetchTrailGeojson()
    .then(geojson => {
      const clean = {
        type: "FeatureCollection",
        features: (geojson.features || []).map(f => ({
          type: "Feature",
          properties: {},
          geometry: f.geometry
        }))
      };

      if (haloRef.current) { try { targetMap.removeLayer(haloRef.current); } catch {} }
      if (layerRef.current) { try { targetMap.removeLayer(layerRef.current); } catch {} }

      layerRef.current = L.geoJSON(clean, {
        style: { color: "#e06060", weight: 3.25, opacity: 0.85, lineCap: "round", lineJoin: "round" },
        interactive: false
      }).addTo(targetMap);

      if (layerRef.current.bringToBack) layerRef.current.bringToBack();
      if (onDone) onDone();
    })
    .catch(e => console.warn("[NTT] trail overlay failed:", e));
}

function loadTrailOverlay() {
  if (!map) return;
  applyTrailOverlay(map, weatherHaloRef, weatherLayerRef, refreshMapSize);
}

function loadTrailOverlayForDurMap() {
  if (!durMap) return;
  applyTrailOverlay(durMap, durHaloRef, durLayerRef, () => {
    try { durMap.invalidateSize(); } catch {}
  });
}

/* ============================================================
   13. WEATHER MAP (Tool B)
   ============================================================ */

function initMap() {
  if (typeof L === "undefined") { console.warn("[NTT] Leaflet not loaded"); return; }
  map = L.map("map", { zoomControl: true })
         .setView(META.defaultMapCenter, META.defaultZoom);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  window.addEventListener("resize", refreshMapSize);
}

function ensureWeatherMapVisible() {
  const wrap = el("weatherMapWrap");
  if (wrap) wrap.style.display = "block";
  if (!map) {
    initMap();
    loadTrailOverlay();
  }
  refreshMapSize();
}

function updateWeatherMap(point) {
  if (!map) return;
  const ll = [point.lat, point.lon];
  if (!mapMarker) {
    mapMarker = L.marker(ll).addTo(map);
  } else {
    mapMarker.setLatLng(ll);
  }
  mapMarker.bindPopup(nttPointLabel(point));
  map.setView(ll, SELECT_ZOOM);
  if (mapMarker.bringToFront) mapMarker.bringToFront();
  refreshMapSize();
}

/* ============================================================
   14. POINT LOOKUP HELPERS
   ============================================================ */

function binaryNearest(sortedArr, target, keyFn) {
  if (!sortedArr.length) return null;
  let lo = 0, hi = sortedArr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyFn(sortedArr[mid]) < target) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [sortedArr[Math.max(0, lo - 1)], sortedArr[lo]].filter(Boolean);
  return candidates.reduce((a, b) =>
    Math.abs(keyFn(a) - target) <= Math.abs(keyFn(b) - target) ? a : b
  );
}

/** Find nearest point within a specific section by section-relative mile. */
function getNearestPointInSection(sectionId, mile) {
  const pts = pointsBySection.get(sectionId);
  if (!pts?.length) return null;
  return binaryNearest(pts, mile, p => p.mile);
}

/** Find nearest point by cumulative axis mile across all sections. */
function getNearestPointByAxis(axisMile) {
  return binaryNearest(pointsSortedByAxis, axisMile, p => p.axis_mile);
}

/* ============================================================
   15. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key = `ntt_forecast:${point.id}`;
  const cached = cacheGet(key, FORECAST_TTL_MS);
  if (cached) return cached;

  const url = new URL(FORECAST_BASE);
  url.searchParams.set("latitude",         point.lat);
  url.searchParams.set("longitude",        point.lon);
  url.searchParams.set("daily",            FORECAST_DAILY_VARS);
  url.searchParams.set("current_weather",  "true");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("windspeed_unit",   "mph");
  url.searchParams.set("timezone",         "auto");
  url.searchParams.set("forecast_days",    "5");

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`Forecast fetch failed (${r.status})`);
  const data = await r.json();
  cacheSet(key, data);
  return data;
}

function lastSevenYearsRange() {
  const end   = addDays(new Date(), -2);
  const start = new Date(end.getTime());
  start.setFullYear(start.getFullYear() - 7);
  return { start_date: toISODate(start), end_date: toISODate(end) };
}

async function fetchHistorical(point, range) {
  const key = `ntt_hist:${point.id}:${range.start_date}:${range.end_date}`;
  const cached = cacheGet(key, HIST_TTL_MS);
  if (cached) return cached;

  const url = new URL(HIST_BASE);
  url.searchParams.set("latitude",         point.lat);
  url.searchParams.set("longitude",        point.lon);
  url.searchParams.set("start_date",       range.start_date);
  url.searchParams.set("end_date",         range.end_date);
  url.searchParams.set("daily",            HIST_DAILY_VARS);
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone",         "auto");

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`Historical fetch failed (${r.status})`);
  const data = await r.json();
  cacheSet(key, data);
  return data;
}

/* ============================================================
   16. PLANNING AVERAGE COMPUTATION
   ============================================================ */

function avg(arr) {
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function indexHistoricalByMonthDay(histDaily, fields) {
  const idx  = new Map();
  const times = histDaily.time || [];
  for (let i = 0; i < times.length; i++) {
    const md = times[i].slice(5);
    if (!idx.has(md)) {
      const bucket = {};
      for (const f of fields) bucket[f] = [];
      idx.set(md, bucket);
    }
    const bucket = idx.get(md);
    for (const f of fields) {
      const v = histDaily[f]?.[i];
      if (v != null) bucket[f].push(v);
    }
  }
  return idx;
}

function mdWindowKeys(monthDay, windowDays) {
  const [mm, dd] = monthDay.split("-").map(Number);
  const base = new Date(2001, mm - 1, dd);
  const keys = [];
  for (let off = -windowDays; off <= windowDays; off++) {
    const dt = addDays(base, off);
    keys.push(`${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`);
  }
  return keys;
}

function computePlanningAverages(histDaily, monthDay, windowDays) {
  const fields = [
    "temperature_2m_max", "temperature_2m_min",
    "apparent_temperature_max", "apparent_temperature_min",
    "relative_humidity_2m_max", "relative_humidity_2m_min",
  ];
  const idx  = indexHistoricalByMonthDay(histDaily, fields);
  const keys = mdWindowKeys(monthDay, windowDays);

  const buckets = {};
  for (const f of fields) buckets[f] = [];

  for (const k of keys) {
    const b = idx.get(k);
    if (!b) continue;
    for (const f of fields) buckets[f].push(...b[f]);
  }

  return {
    avgHigh:    avg(buckets["temperature_2m_max"]),
    avgLow:     avg(buckets["temperature_2m_min"]),
    avgAppHigh: avg(buckets["apparent_temperature_max"]),
    avgAppLow:  avg(buckets["apparent_temperature_min"]),
    avgRhHigh:  avg(buckets["relative_humidity_2m_max"]),
    avgRhLow:   avg(buckets["relative_humidity_2m_min"]),
  };
}

/* ============================================================
   17. TEMPERATURE DISPLAY HELPERS
   ============================================================ */

function fmtTemp(v) {
  return v != null ? `${Math.round(v)} \u00b0F` : "\u2014";
}
function fmtRh(v) {
  return v != null ? `${Math.round(v)}%` : "\u2014";
}

function feelsLikeNote(actual, apparent) {
  if (actual == null || apparent == null) return "";
  const diff = apparent - actual;
  if (Math.abs(diff) < 3) return "";
  return diff > 0
    ? ` <span class="feels-hotter">(feels hotter: ${Math.round(apparent)} \u00b0F)</span>`
    : ` <span class="feels-cooler">(feels cooler: ${Math.round(apparent)} \u00b0F)</span>`;
}

/* ============================================================
   18. WEATHER TOOL RENDERING
   ============================================================ */

function renderPlanningSummary(point, monthDay, range, avgs) {
  const niceDate = formatMonthDayName(monthDay);
  const label = nttPointLabel(point);

  el("planningSummaryBlock").innerHTML = `
    <h2>Planning: 7-year Average</h2>
    <table>
      <tr><th>Date / Location</th><td colspan="3">${niceDate} \u2014 ${label}</td></tr>
      <tr><th></th><th style="background:#f0f0f0;">Actual Temp</th><th style="background:#f0f0f0;">Apparent Temp</th><th style="background:#f0f0f0;">Relative Humidity</th></tr>
      <tr><th>Avg High</th><td>${fmtTemp(avgs.avgHigh)}</td><td>${fmtTemp(avgs.avgAppHigh)}</td><td>${fmtRh(avgs.avgRhHigh)}</td></tr>
      <tr><th>Avg Low</th><td>${fmtTemp(avgs.avgLow)}</td><td>${fmtTemp(avgs.avgAppLow)}</td><td>${fmtRh(avgs.avgRhLow)}</td></tr>
      <tr><th>Historical Range</th><td colspan="3">${range.start_date} to ${range.end_date}</td></tr>
    </table>
    <p class="note">
      Averages computed from daily highs/lows over a ${TYPICAL_WINDOW_DAYS*2+1}-day window
      centered on the planning date, across 7 years of data.
      Apparent temperature uses the Steadman methodology (heat index at high humidity,
      wind chill at low temperatures with wind).
    </p>
  `;
}

function renderCurrent(forecastData, point) {
  const c = forecastData.current_weather;
  const block = el("currentBlock");
  if (!c || !block) return;

  block.innerHTML = `
    <h2>Current Conditions</h2>
    <table>
      <tr><th>Location</th><td>${nttPointLabel(point)}</td></tr>
      <tr><th>Temperature</th><td>${fmtTemp(c.temperature)}</td></tr>
      <tr><th>Wind</th><td>${Math.round(c.windspeed)} mph</td></tr>
      <tr><th>Time</th><td>${c.time}</td></tr>
    </table>
  `;
}

function renderForecastTable(forecastData) {
  const d = forecastData.daily;
  const block = el("forecastBlock");
  if (!d?.time || !block) return;

  const rows = d.time.map((date, i) => {
    const hi     = d.temperature_2m_max?.[i];
    const lo     = d.temperature_2m_min?.[i];
    const appHi  = d.apparent_temperature_max?.[i];
    const appLo  = d.apparent_temperature_min?.[i];
    const rhHi   = d.relative_humidity_2m_max?.[i];
    const rhLo   = d.relative_humidity_2m_min?.[i];
    const precip = d.precipitation_probability_max?.[i];
    const wind   = d.windspeed_10m_max?.[i];

    return `
      <tr>
        <td>${date}</td>
        <td>${fmtTemp(hi)}${feelsLikeNote(hi, appHi)}</td>
        <td>${fmtTemp(lo)}${feelsLikeNote(lo, appLo)}</td>
        <td>${rhHi != null ? fmtRh(rhHi) : "\u2014"} / ${rhLo != null ? fmtRh(rhLo) : "\u2014"}</td>
        <td>${precip != null ? Math.round(precip) + "%" : "\u2014"}</td>
        <td>${wind != null ? Math.round(wind) + " mph" : "\u2014"}</td>
      </tr>`;
  }).join("");

  block.innerHTML = `
    <h2>5-Day Forecast</h2>
    <table>
      <tr>
        <th>Date</th>
        <th>High (actual)</th>
        <th>Low (actual)</th>
        <th>Humidity (hi/lo)</th>
        <th>Precip</th>
        <th>Wind</th>
      </tr>
      ${rows}
    </table>
    <p class="note">
      "Feels hotter/cooler" note appears when apparent temperature differs from actual
      by 3 \u00b0F or more. Wind chill is reflected in the apparent low when temperatures
      are cold and winds are significant.
    </p>
  `;

  refreshMapSize();
}

/* ============================================================
   19. WEATHER TOOL SECTION INFO (runtime update after meta loads)
   ============================================================ */

function updateSectionInfo() {
  const sectionId = el("nttSectionSelect")?.value;
  const infoEl    = el("nttSectionInfo");
  const mileInput = el("nttMileInput");
  if (!sectionId || !infoEl) return;

  const sections = nttMeta?.sections || window.NTT_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => s.id === sectionId);
  if (!sec) return;

  infoEl.textContent = `Section Range: ${sec.mile_start}\u2013${sec.mile_end} Miles`;

  if (mileInput) {
    mileInput.min  = sec.mile_start;
    mileInput.max  = sec.mile_end;
    mileInput.step = 0.1;
    mileInput.placeholder = `e.g., ${Math.round((sec.mile_start + sec.mile_end) / 2)}`;
    const cur = Number(mileInput.value);
    if (cur < sec.mile_start || cur > sec.mile_end) mileInput.value = "";
  }
}

/* ============================================================
   20. WEATHER TOOL RUN
   ============================================================ */

async function runWeather() {
  const sectionId = el("nttSectionSelect")?.value;
  const mileRaw   = el("nttMileInput")?.value;
  const monthDay  = getSelectedMonthDay("monthSelect", "daySelect");

  setWeatherStatus("");
  if (!sectionId) { setWeatherStatus("Please select a section."); return; }
  if (mileRaw === "" || mileRaw == null) { setWeatherStatus("Please enter a section mile."); return; }
  if (!monthDay) { setWeatherStatus("Please choose a planning date."); return; }

  const mile = Number(mileRaw);

  const sections = nttMeta?.sections || window.NTT_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => s.id === sectionId);
  if (sec && (mile < sec.mile_start || mile > sec.mile_end)) {
    setWeatherStatus(`Please enter a mile between ${sec.mile_start} and ${sec.mile_end}.`);
    return;
  }

  const point = getNearestPointInSection(sectionId, mile);

  if (!point) {
    setHtmlIfExists("currentBlock", "<p>No data point found for this location. Trail data may still be loading.</p>");
    return;
  }

  ensureWeatherMapVisible();
  updateWeatherMap(point);

  setHtmlIfExists("planningSummaryBlock", "");
  setHtmlIfExists("currentBlock",         "");
  setHtmlIfExists("forecastBlock",        "");

  try {
    const forecastData = await fetchForecast(point);
    renderCurrent(forecastData, point);
    renderForecastTable(forecastData);

    const range    = lastSevenYearsRange();
    const histData = await fetchHistorical(point, range);
    const daily    = histData?.daily;
    if (!daily?.time) return;

    const avgs = computePlanningAverages(daily, monthDay, TYPICAL_WINDOW_DAYS);
    renderPlanningSummary(point, monthDay, range, avgs);

  } catch (err) {
    console.error("[NTT] runWeather error:", err);
    setHtmlIfExists("currentBlock", `<p style="color:#900">Weather data unavailable: ${err.message}</p>`);
  } finally {
    refreshMapSize();
  }
}

/* ============================================================
   21. DURATION CALCULATOR  (Tool A)
   ============================================================ */

function renderDurationResult({ directionId, startDate, endDate, hikingDays, travelDays, totalDays, milesPerDay }) {
  const startStr = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr   = endDate.toLocaleDateString(undefined,   { year: "numeric", month: "long", day: "numeric" });

  const dirOpts = nttMeta?.direction_options || window.NTT_DIRECTION_OPTIONS_BOOTSTRAP || [];
  const dirLabel = dirOpts.find(o => o.id === directionId)?.label || directionId;

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${dirLabel}</td></tr>
      <tr><th>Start Date</th><td>${startStr}</td></tr>
      <tr><th>Total Trail Miles</th><td>${fmtMile(NTT_TOTAL_TRAIL_MILES)} miles (across 5 sections)</td></tr>
      <tr><th>Miles per Day</th><td>${fmtMile(milesPerDay)}</td></tr>
      <tr><th>Hiking Days</th><td>${hikingDays} days</td></tr>
      <tr><th>Travel Days (between sections)</th><td>${travelDays} days</td></tr>
      <tr><th>Estimated Total Duration</th><td>${totalDays} days</td></tr>
      <tr><th>Estimated End Date</th><td>${endStr}</td></tr>
    </table>
    <p class="note">
      Hiking days are computed per-section (each section's miles are ceilinged independently
      since unused miles cannot carry over to the next section). One travel day is added
      between each pair of consecutive sections.
    </p>
  `;
}

/* ============================================================
   22. DURATION EXTREMES  (Tool A+)
   ============================================================ */

function dayIndexFromMonthDay(monthDay) {
  const [mm, dd] = monthDay.split("-").map(Number);
  const dt    = new Date(2021, mm - 1, dd);
  const start = new Date(2021, 0, 1);
  return Math.max(0, Math.min(364, Math.round((dt - start) / 86400000)));
}

function getNearestNormals(point) {
  const direct = normalsByPointId.get(point.id);
  if (direct?.hi?.length) return direct;

  if (!normalsByAxis.length) return null;
  const best = binaryNearest(normalsByAxis, point.axis_mile, e => e.axis_mile);
  return best ? (normalsByPointId.get(best.id) || null) : null;
}

/**
 * Build the ordered sequence of points for a hike, one per day.
 *
 * NTT is discontinuous: walk each section in order, add a travel day between sections.
 * Travel days use the endpoint of the section just completed (temperature still recorded).
 *
 * NOBO: Portkopinu → Rocky Springs → Yockanookany → Blackland Prairie → Highland Rim
 * SOBO: reverse order
 */
function buildHikePoints({ directionId, startDate, milesPerDay }) {
  const isNobo = directionId === "nobo";
  const sections = isNobo ? NTT_SECTIONS_DEF : [...NTT_SECTIONS_DEF].slice().reverse();

  const events = []; // { axisMile }

  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const daysInSection = Math.ceil(sec.len / milesPerDay);

    for (let d = 0; d < daysInSection; d++) {
      let axisMile;
      if (isNobo) {
        axisMile = Math.min(sec.axis_start + milesPerDay * d, sec.axis_end);
      } else {
        axisMile = Math.max(sec.axis_end - milesPerDay * d, sec.axis_start);
      }
      events.push({ axisMile });
    }

    // Travel day between sections: use the endpoint of the section just finished
    if (si < sections.length - 1) {
      const travelAxisMile = isNobo ? sec.axis_end : sec.axis_start;
      events.push({ axisMile: travelAxisMile });
    }
  }

  return events.map((evt, i) => {
    const point = getNearestPointByAxis(evt.axisMile);
    return point ? { date: addDays(startDate, i), point } : null;
  }).filter(Boolean);
}

function computeExtremesFromHikePoints(hikePoints) {
  if (!hikePoints.length) return { hottest: null, coldest: null };

  let hottest = null, coldest = null;

  for (const { date, point } of hikePoints) {
    const normals = getNearestNormals(point);
    if (!normals?.hi?.length) continue;

    const monthDay = toISODate(date).slice(5);
    const idx      = dayIndexFromMonthDay(monthDay);

    const avgHigh    = normals.hi[idx];
    const avgLow     = normals.lo[idx];
    const avgAppHigh = normals.app_hi[idx];
    const avgAppLow  = normals.app_lo[idx];
    const avgRhHigh  = normals.rh_hi?.[idx];
    const avgRhLow   = normals.rh_lo?.[idx];

    if (!isFinite(avgHigh) || !isFinite(avgLow)) continue;

    const heatVal = isFinite(avgAppHigh) ? avgAppHigh : avgHigh;
    if (!hottest || heatVal > (isFinite(hottest.appHigh) ? hottest.appHigh : hottest.avgHigh)) {
      hottest = { date, point, avgHigh, avgLow, appHigh: avgAppHigh, appLow: avgAppLow, rhHigh: avgRhHigh, rhLow: avgRhLow };
    }

    const coldVal = isFinite(avgAppLow) ? avgAppLow : avgLow;
    if (!coldest || coldVal < (isFinite(coldest.appLow) ? coldest.appLow : coldest.avgLow)) {
      coldest = { date, point, avgHigh, avgLow, appHigh: avgAppHigh, appLow: avgAppLow, rhHigh: avgRhHigh, rhLow: avgRhLow };
    }
  }

  return { hottest, coldest };
}

function renderDurExtremesBlocks(hottest, coldest) {
  if (!hottest || !coldest) {
    setHtmlIfExists("durExtremesHot",  "<p>Temperature extremes unavailable \u2014 historical normals not loaded. Run <code>node trails/natchez-trace-trail/tools/generate-normals-ntt.js</code> to generate them.</p>");
    setHtmlIfExists("durExtremesCold", "");
    return;
  }

  function extremeTable(rec, label) {
    const niceDate = rec.date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    return `
      <h3>${label}</h3>
      <table>
        <tr><th>Date / Location</th><td colspan="3">${niceDate} \u2014 ${nttPointLabel(rec.point)}</td></tr>
        <tr><th></th><th style="background:#f0f0f0;">Actual Temp</th><th style="background:#f0f0f0;">Apparent Temp</th><th style="background:#f0f0f0;">Relative Humidity</th></tr>
        <tr><th>High</th><td>${fmtTemp(rec.avgHigh)}</td><td>${fmtTemp(rec.appHigh)}</td><td>${fmtRh(rec.rhHigh)}</td></tr>
        <tr><th>Low</th><td>${fmtTemp(rec.avgLow)}</td><td>${fmtTemp(rec.appLow)}</td><td>${fmtRh(rec.rhLow)}</td></tr>
      </table>`;
  }

  setHtmlIfExists("durExtremesHot",  extremeTable(hottest, "Hottest Day (Highest Apparent High)"));
  setHtmlIfExists("durExtremesCold", extremeTable(coldest, "Coldest Night (Lowest Apparent Low)"));
}

function renderDurExtremesMap(hottest, coldest) {
  const mapEl = el("durExtremesMap");
  if (!mapEl || typeof L === "undefined") return;

  if (!durMap) {
    durMap = L.map("durExtremesMap", { zoomControl: true })
               .setView([33.5, -89.5], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(durMap);
    durMapLayerGroup = L.layerGroup().addTo(durMap);
    loadTrailOverlayForDurMap();
  }

  durMapLayerGroup.clearLayers();

  if (!hottest?.point || !coldest?.point) {
    try { durMap.invalidateSize(); } catch {}
    return;
  }

  const hotLL  = [hottest.point.lat, hottest.point.lon];
  const coldLL = [coldest.point.lat, coldest.point.lon];

  const hotMarker = L.marker(hotLL, { icon: makeColoredPinIcon("#cc2200") })
    .bindPopup(`<strong>Hottest Day</strong><br>${toISODate(hottest.date)}<br>Apparent High: ${fmtTemp(hottest.appHigh)}`)
    .addTo(durMapLayerGroup);

  const coldMarker = L.marker(coldLL, { icon: makeColoredPinIcon("#0055cc") })
    .bindPopup(`<strong>Coldest Night</strong><br>${toISODate(coldest.date)}<br>Apparent Low: ${fmtTemp(coldest.appLow)}`)
    .addTo(durMapLayerGroup);

  if (hotMarker.bringToFront)  hotMarker.bringToFront();
  if (coldMarker.bringToFront) coldMarker.bringToFront();

  const bounds = L.latLngBounds([hotLL, coldLL]);
  durMap.fitBounds(bounds, { padding: [30, 30] });
  try { durMap.invalidateSize(); } catch {}
}

async function computeAndRenderDurationExtremes(params) {
  setDisplayIfExists("durExtremesWrap", "none");
  setHtmlIfExists("durExtremesHot",  "");
  setHtmlIfExists("durExtremesCold", "");

  if (!normalsByPointId.size) {
    setDurStatus("Temperature extremes unavailable \u2014 historical_weather.json not loaded.");
    return;
  }
  if (!allPoints.length) {
    setDurStatus("Trail points still loading \u2014 please try again.");
    return;
  }

  const hikePoints = buildHikePoints(params);
  if (!hikePoints.length) {
    setDurStatus("Could not compute hike path \u2014 check data loading.");
    return;
  }

  const { hottest, coldest } = computeExtremesFromHikePoints(hikePoints);

  setDisplayIfExists("durExtremesWrap", "block");
  renderDurExtremesBlocks(hottest, coldest);
  renderDurExtremesMap(hottest, coldest);

  const durResult = el("durResult");
  if (!durResult) return;

  // Heat index advisory (apparent high ≥ 100 °F)
  const peakHeat = hottest?.appHigh ?? hottest?.avgHigh;
  if (peakHeat != null && peakHeat >= 100) {
    const warn = document.createElement("p");
    warn.style.cssText = "color:#9a4000; font-weight:600; margin-top:0.75rem;";
    warn.textContent = `\u26a0 Heat advisory: the hottest day on your hike has an estimated heat index of ${Math.round(peakHeat)} \u00b0F \u2014 at or above the 100 \u00b0F National Weather Service Heat Advisory threshold. Plan for early morning starts, ample hydration, and extra rest during peak heat.`;
    durResult.appendChild(warn);
  }

  // Wind chill advisory (apparent low ≤ 20 °F)
  const peakChill = coldest?.appLow ?? coldest?.avgLow;
  if (peakChill != null && peakChill <= 20) {
    const warn = document.createElement("p");
    warn.style.cssText = "color:#003388; font-weight:600; margin-top:0.75rem;";
    warn.textContent = `\u26a0 Cold weather advisory: the coldest night on your hike is expected to be at or below 20 \u00b0F. Conditions at this level may be hazardous without proper preparation and equipment. Check local NWS forecasts before your hike.`;
    durResult.appendChild(warn);
  }
}

function runDurationCalculator() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const directionId = el("durDirectionSelect")?.value || "nobo";
  const monthDay    = getSelectedMonthDay("durMonthSelect", "durDaySelect");
  const mpd         = numVal("durMilesPerDay");

  if (!monthDay) { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 3) { setDurStatus("For this planner, hikes must average at least 3 miles per day."); return; }

  const { hikingDays, travelDays, totalDays } = calcNttDuration(mpd);

  if (totalDays > 365) {
    setDurStatus("Estimated duration exceeds one year. Please increase miles per day.");
    return;
  }

  const startDate = resolveStartDate(monthDay);
  const endDate   = addDays(startDate, totalDays - 1);

  renderDurationResult({ directionId, startDate, endDate, hikingDays, travelDays, totalDays, milesPerDay: mpd });

  if (normalsByPointId.size > 0 && allPoints.length > 0) {
    computeAndRenderDurationExtremes({
      directionId, startDate, milesPerDay: mpd
    }).catch(err => {
      console.error("[NTT] extremes error:", err);
      setDurStatus(`Error computing extremes: ${err.message}`);
    });
  } else {
    setDurStatus("Temperature extremes will appear once trail data finishes loading.");
  }
}

/* ============================================================
   23. UI INITIALIZATION
   ============================================================ */

function initDurationUI() {
  initMonthDayPickerGeneric("durMonthSelect", "durDaySelect");
  el("durBtn")?.addEventListener("click", runDurationCalculator);
  const mpdEl = el("durMilesPerDay");
  if (mpdEl && mpdEl.value === "") mpdEl.value = "10";
}

function initWeatherUI() {
  el("goBtn")?.addEventListener("click", runWeather);
  el("nttSectionSelect")?.addEventListener("change", updateSectionInfo);
  initMonthDayPickerGeneric("monthSelect", "daySelect");
  updateSectionInfo();
}

/* ============================================================
   24. MAIN
   ============================================================ */

async function main() {
  initDurationUI();
  initWeatherUI();

  initMap();
  loadTrailOverlay();

  // Load ntt_meta.json (non-blocking — updates section info if loaded)
  loadNttMeta()
    .then(() => { updateSectionInfo(); })
    .catch(e => console.warn("[NTT] ntt_meta not loaded:", e));

  // Load points
  try {
    await loadPoints();

    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[NTT] loadPoints failed:", err);
  }

  // Load precomputed normals (non-blocking — extremes available once loaded)
  loadPrecomputedNormals()
    .catch(e => console.warn("[NTT] normals not loaded:", e));
}

document.addEventListener("DOMContentLoaded", main);
