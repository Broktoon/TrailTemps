/* New England Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - 4 direction+destination options (NOBO/SOBO × Main/Alt)
           - Middletown spur routing for Alt directions
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json, 5-mile intervals)
           - Wind chill advisory when apparent low ≤ 20 °F
           - Heat index advisory when apparent high ≥ 100 °F
   Tool B: Weather planner
           - Section selector (3 sections) → Mile → Date
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
    "new-england-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:       new URL("points.json",            dataDir).href,
    trailGeojsonUrl: new URL("trail.geojson",          dataDir).href,
    normalsUrl:      new URL("historical_weather.json", dataDir).href,
    netMetaUrl:      new URL("net_meta.json",           dataDir).href,
    defaultMapCenter: [41.9, -72.5],
    defaultZoom:      8,
  };
}

const META     = getTrailMeta();
const trailSlug = META.slug;

console.log("[NET] slug =", trailSlug);

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

const TYPICAL_WINDOW_DAYS   = 3;            // ±3-day smoothing for planning averages

const FORECAST_TTL_MS       = 30 * 60 * 1000;           // 30 min
const HIST_TTL_MS           = 24 * 60 * 60 * 1000;      // 24 hr
const TRAIL_TTL_MS          = 30 * 24 * 60 * 60 * 1000; // 30 days
const NORMALS_TTL_MS        = 30 * 24 * 60 * 60 * 1000; // 30 days
const NORMALS_CACHE_VERSION = "v1";

// NET spine constants
const NET_SPINE_MIN  = 1;    // first whole-mile point
const NET_SPINE_MAX  = 208;  // last whole-mile point
const NET_SPINE_FULL = 208.3;
const NET_SPUR_LEN   = 28;   // miles on Middletown spur
const NET_JUNCTION   = 38;   // spine mile where spur meets main trail

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

// Points
let allPoints          = [];
let mainPointsByMile   = new Map(); // integer mile → Point (main spine)
let spurPointsByMile   = new Map(); // integer spur_mile → Point (spur)
let mainPointsSorted   = [];        // [Point] sorted by mile, main spine
let spurPointsSorted   = [];        // [Point] sorted by spur_mile, spur

// NET meta (loaded from net_meta.json)
let netMeta = null;

// Precomputed normals
let normalsByPointId   = new Map(); // point.id → { hi, lo, app_hi, app_lo, rh_hi, rh_lo, ws }
let normalsMainByMile  = [];        // [{ id, mile }] sorted — main spine nearest-neighbour fallback
let normalsSpurByMile  = [];        // [{ id, mile }] sorted — spur nearest-neighbour fallback
let normalsMeta        = null;

// Leaflet — Weather map
let map        = null;
let mapMarker  = null;

// Leaflet — Extremes map
let durMap           = null;
let durMapLayerGroup = null;

const SELECT_ZOOM = 10;

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

function netPointLabel(point) {
  if (point.spur) {
    return `Connecticut \u2014 Middletown Spur Mile ${point.spur_mile}`;
  }
  const stateName = point.state === "CT" ? "Connecticut" : "Massachusetts";
  return `${stateName} \u2014 Mile ${point.mile}`;
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
   9. MILEAGE CALCULATION
   ============================================================ */

function calcTotalMiles(directionId) {
  const opts = netMeta?.direction_options || [];
  const opt = opts.find(o => o.id === directionId);
  if (opt) return opt.total_miles;
  // Fallback
  return (directionId === "nobo_alt" || directionId === "sobo_alt") ? 198.3 : 208.3;
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

async function loadNetMeta() {
  const key = `net_meta_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload = cached;
  if (!payload) {
    const r = await fetch(META.netMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`net_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  netMeta = payload;
  console.log("[NET] net_meta loaded:", netMeta.sections?.length, "sections");
}

async function loadPoints() {
  const r = await fetch(META.pointsUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`points.json fetch failed (${r.status})`);
  const data = await r.json();

  allPoints = data.filter(p =>
    isFinite(Number(p.lat)) && isFinite(Number(p.lon))
  ).map(p => ({
    ...p,
    lat: Number(p.lat),
    lon: Number(p.lon),
    id:  String(p.id),
    ...(p.spur ? { spur_mile: Number(p.spur_mile) } : { mile: Number(p.mile) }),
  }));

  mainPointsByMile = new Map();
  spurPointsByMile = new Map();

  for (const p of allPoints) {
    if (p.spur) {
      spurPointsByMile.set(p.spur_mile, p);
    } else {
      mainPointsByMile.set(p.mile, p);
    }
  }

  mainPointsSorted = allPoints
    .filter(p => !p.spur && isFinite(p.mile))
    .sort((a, b) => a.mile - b.mile);

  spurPointsSorted = allPoints
    .filter(p => p.spur && isFinite(p.spur_mile))
    .sort((a, b) => a.spur_mile - b.spur_mile);

  console.log("[NET] points loaded:", allPoints.length,
    `(${mainPointsSorted.length} main, ${spurPointsSorted.length} spur)`);
}

async function loadPrecomputedNormals() {
  const key = `net_normals_${trailSlug}_${NORMALS_CACHE_VERSION}`;
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

  // Build nearest-neighbour mile indices for main spine and spur
  normalsMainByMile = mainPointsSorted
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, mile: p.mile }));

  normalsSpurByMile = spurPointsSorted
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, mile: p.spur_mile }));

  console.log("[NET] normals loaded:", normalsByPointId.size, "points");
}

/* ============================================================
   12. TRAIL GEOJSON OVERLAY
   ============================================================ */

async function fetchTrailGeojson() {
  const key = `trail_geojson_${trailSlug}_v1`;
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
        style: { color: "#4466cc", weight: 3.25, opacity: 0.85, lineCap: "round", lineJoin: "round" },
        interactive: false
      }).addTo(targetMap);

      if (layerRef.current.bringToBack) layerRef.current.bringToBack();
      if (onDone) onDone();
    })
    .catch(e => console.warn("[NET] trail overlay failed:", e));
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
  if (typeof L === "undefined") { console.warn("[NET] Leaflet not loaded"); return; }
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
  mapMarker.bindPopup(netPointLabel(point));
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

function getNearestMainPoint(mile) {
  return binaryNearest(mainPointsSorted, mile, p => p.mile);
}

function getNearestSpurPoint(spurMile) {
  return binaryNearest(spurPointsSorted, spurMile, p => p.spur_mile);
}

/* ============================================================
   15. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key = `net_forecast:${point.id}`;
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
  const key = `net_hist:${point.id}:${range.start_date}:${range.end_date}`;
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
  const label = netPointLabel(point);

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
      <tr><th>Location</th><td>${netPointLabel(point)}</td></tr>
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
  const sectionId = el("sectionSelect")?.value;
  const infoEl    = el("netSectionInfo");
  const mileInput = el("netMileInput");
  if (!sectionId || !infoEl) return;

  const sections = netMeta?.sections || window.NET_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => s.id === sectionId);
  if (!sec) return;

  const rangeWord = "Section Range";
  infoEl.textContent = `${rangeWord}: ${sec.mile_start}-${sec.mile_end} Miles`;

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
  const sectionId = el("sectionSelect")?.value;
  const mileRaw   = el("netMileInput")?.value;
  const monthDay  = getSelectedMonthDay("monthSelect", "daySelect");

  setWeatherStatus("");
  if (!sectionId) { setWeatherStatus("Please select a section."); return; }
  if (mileRaw === "" || mileRaw == null) { setWeatherStatus("Please enter a mile."); return; }
  if (!monthDay) { setWeatherStatus("Please choose a planning date."); return; }

  const mile = Number(mileRaw);

  const sections = netMeta?.sections || window.NET_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => s.id === sectionId);
  if (sec && (mile < sec.mile_start || mile > sec.mile_end)) {
    setWeatherStatus(`Please enter a mile between ${sec.mile_start} and ${sec.mile_end}.`);
    return;
  }

  let point;
  if (sectionId === "ct_middletown") {
    point = getNearestSpurPoint(mile);
  } else {
    point = getNearestMainPoint(mile);
  }

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
    console.error("[NET] runWeather error:", err);
    setHtmlIfExists("currentBlock", `<p style="color:#900">Weather data unavailable: ${err.message}</p>`);
  } finally {
    refreshMapSize();
  }
}

/* ============================================================
   21. DURATION CALCULATOR  (Tool A)
   ============================================================ */

function renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay, durationDays }) {
  const startStr = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr   = endDate.toLocaleDateString(undefined,   { year: "numeric", month: "long", day: "numeric" });

  const opts = netMeta?.direction_options || [];
  const dirLabel = opts.find(o => o.id === directionId)?.label || directionId;

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction &amp; Destination</th><td>${dirLabel}</td></tr>
      <tr><th>Start Date</th><td>${startStr}</td></tr>
      <tr><th>Total Distance</th><td>${fmtMile(totalMiles)} miles</td></tr>
      <tr><th>Miles per Day</th><td>${fmtMile(milesPerDay)}</td></tr>
      <tr><th>Estimated Duration</th><td>${durationDays} days</td></tr>
      <tr><th>Estimated End Date</th><td>${endStr}</td></tr>
    </table>
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

/**
 * Get nearest normals record for a point.
 * For main points: searches normalsMainByMile.
 * For spur points: searches normalsSpurByMile.
 */
function getNearestNormals(point) {
  const direct = normalsByPointId.get(point.id);
  if (direct?.hi?.length) return direct;

  const isSpur = !!point.spur;
  const arr    = isSpur ? normalsSpurByMile : normalsMainByMile;
  const target = isSpur ? point.spur_mile : point.mile;

  if (!arr.length) return null;

  const best = binaryNearest(arr, target, e => e.mile);
  return best ? (normalsByPointId.get(best.id) || null) : null;
}

/**
 * Build the ordered sequence of points for a hike, one per day.
 *
 * nobo_main: Guilford (mile 1) → Royalston Falls (mile 208)  [208.3 mi]
 * nobo_alt:  Middletown spur (spur_mile 0→28) → spine (mile 38→208)  [198.3 mi]
 * sobo_main: Royalston Falls (mile 208) → Guilford (mile 1)  [208.3 mi]
 * sobo_alt:  Royalston Falls (mile 208) → junction (mile 38) → spur (28→0)  [198.3 mi]
 */
function buildHikePoints({ directionId, startDate, milesPerDay, totalMiles }) {
  const durationDays = Math.ceil(totalMiles / milesPerDay);
  const hikePoints   = [];

  // Pre-compute split point for alt routes (miles on main spine before/after spur)
  const mainAltLen = NET_SPINE_FULL - NET_JUNCTION; // 208.3 - 38 = 170.3 mi on spine

  for (let i = 0; i < durationDays; i++) {
    const date    = addDays(startDate, i);
    const cumMile = milesPerDay * i;
    let point     = null;

    switch (directionId) {
      case "nobo_main": {
        // Walk spine south→north: mile 1 to 208
        const spineMile = Math.min(NET_SPINE_MIN + cumMile, NET_SPINE_MAX);
        point = getNearestMainPoint(spineMile);
        break;
      }
      case "sobo_main": {
        // Walk spine north→south: mile 208 to 1
        const spineMile = Math.max(NET_SPINE_MAX - cumMile, NET_SPINE_MIN);
        point = getNearestMainPoint(spineMile);
        break;
      }
      case "nobo_alt": {
        // First 28 miles on spur (Middletown → junction), then spine mile 38 → 208
        if (cumMile <= NET_SPUR_LEN) {
          point = getNearestSpurPoint(cumMile);
        } else {
          const spineMile = Math.min(NET_JUNCTION + (cumMile - NET_SPUR_LEN), NET_SPINE_MAX);
          point = getNearestMainPoint(spineMile);
        }
        break;
      }
      case "sobo_alt": {
        // First 170.3 miles on spine (208 → 38), then 28 miles on spur (28 → 0)
        if (cumMile <= mainAltLen) {
          const spineMile = Math.max(NET_SPINE_FULL - cumMile, NET_JUNCTION);
          point = getNearestMainPoint(Math.round(spineMile));
        } else {
          const spurMile = Math.max(NET_SPUR_LEN - (cumMile - mainAltLen), 0);
          point = getNearestSpurPoint(spurMile);
        }
        break;
      }
      default: {
        const spineMile = Math.min(NET_SPINE_MIN + cumMile, NET_SPINE_MAX);
        point = getNearestMainPoint(spineMile);
      }
    }

    if (point) hikePoints.push({ date, point });
  }

  return hikePoints;
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
    setHtmlIfExists("durExtremesHot",  "<p>Temperature extremes unavailable \u2014 historical normals not loaded. Run <code>node scripts/generate-normals-net.js</code> to generate them.</p>");
    setHtmlIfExists("durExtremesCold", "");
    return;
  }

  function extremeTable(rec, label) {
    const niceDate = rec.date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    return `
      <h3>${label}</h3>
      <table>
        <tr><th>Date / Location</th><td colspan="3">${niceDate} \u2014 ${netPointLabel(rec.point)}</td></tr>
        <tr><th></th><th style="background:#f0f0f0;">Actual Temp</th><th style="background:#f0f0f0;">Apparent Temp</th><th style="background:#f0f0f0;">Relative Humidity</th></tr>
        <tr><th>High</th><td>${fmtTemp(rec.avgHigh)}</td><td>${fmtTemp(rec.appHigh)}</td><td>${fmtRh(rec.rhHigh)}</td></tr>
        <tr><th>Low</th><td>${fmtTemp(rec.avgLow)}</td><td>${fmtTemp(rec.appLow)}</td><td>${fmtRh(rec.rhLow)}</td></tr>
      </table>`;
  }

  setHtmlIfExists("durExtremesHot",
    extremeTable(hottest, "Hottest Day (Highest Apparent High)"));
  setHtmlIfExists("durExtremesCold",
    extremeTable(coldest, "Coldest Night (Lowest Apparent Low)"));
}

function renderDurExtremesMap(hottest, coldest) {
  const mapEl = el("durExtremesMap");
  if (!mapEl || typeof L === "undefined") return;

  if (!durMap) {
    durMap = L.map("durExtremesMap", { zoomControl: true })
               .setView([41.9, -72.5], 8);
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
    warn.textContent = `\u26a0 Cold weather advisory: the coldest night on your hike is expected to be at or below 20 \u00b0F. Conditions at this level may be hazardous without proper preparation and equipment. See the weather notes at the bottom of the page for details, and check local NWS forecasts before your hike.`;
    durResult.appendChild(warn);
  }
}

function runDurationCalculator() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const directionId = el("durDirectionSelect")?.value || "nobo_main";
  const monthDay    = getSelectedMonthDay("durMonthSelect", "durDaySelect");
  const mpd         = numVal("durMilesPerDay");

  if (!monthDay) { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles  = calcTotalMiles(directionId);
  const durationDays = Math.ceil(totalMiles / mpd);

  if (durationDays > 365) {
    setDurStatus("Estimated duration exceeds one year. Please increase miles per day.");
    return;
  }

  const startDate = resolveStartDate(monthDay);
  const endDate   = addDays(startDate, durationDays - 1);

  renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay: mpd, durationDays });

  if (normalsByPointId.size > 0 && allPoints.length > 0) {
    computeAndRenderDurationExtremes({
      directionId, startDate, milesPerDay: mpd, totalMiles, durationDays
    }).catch(err => {
      console.error("[NET] extremes error:", err);
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
  if (mpdEl && mpdEl.value === "") mpdEl.value = "12";
}

function initWeatherUI() {
  el("goBtn")?.addEventListener("click", runWeather);
  el("sectionSelect")?.addEventListener("change", updateSectionInfo);
  initMonthDayPickerGeneric("monthSelect", "daySelect");
  updateSectionInfo();
}

/* ============================================================
   24. MAIN
   ============================================================ */

async function main() {
  initDurationUI();
  initWeatherUI();

  // Initialize weather map
  initMap();
  loadTrailOverlay();

  // Load net_meta.json (non-blocking — updates direction labels if loaded)
  loadNetMeta()
    .then(() => {
      // Refresh section info with canonical meta data
      updateSectionInfo();
    })
    .catch(e => console.warn("[NET] net_meta not loaded:", e));

  // Load points
  try {
    await loadPoints();

    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[NET] loadPoints failed:", err);
  }

  // Load precomputed normals (best-effort)
  try {
    await loadPrecomputedNormals();
    setDurStatus(""); // normals loaded silently
  } catch (e) {
    console.warn("[NET] normals not loaded:", e);
    setDurStatus("Temperature extremes unavailable \u2014 historical_weather.json not found. Run the generation script to enable this feature.");
  }

  setTimeout(refreshMapSize, 250);
}

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => main().catch(console.error));
} else {
  main().catch(console.error);
}
