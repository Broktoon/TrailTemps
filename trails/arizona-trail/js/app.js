/* Arizona Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - 4 direction options (NOBO/SOBO × Main/Alt Flagstaff)
           - Flagstaff alternate swaps P32 ↔ P33 for that segment
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json)
           - Elevation correction applied to apparent temperature
           - Heat index advisory when apparent high ≥ 100 °F
           - Wind chill advisory when apparent low ≤ 20 °F
   Tool B: Weather planner
           - Region → Passage → Spine Mile → Date
           - Open-Meteo forecast (5-day) + current conditions
           - 7-year planning average high/low
           - Apparent temperature (Steadman: heat index + wind chill)
           - Elevation correction noted in output when applied
   Maps: Leaflet + OSM tiles + trail.geojson overlay
   Units: Fahrenheit, mph, %
   Caching: localStorage (TTL-based)
   ---------------------------------------------------------------

   Elevation correction logic (applied to apparent temperature):
   - Trail significantly ABOVE grid (trail_elev > grid_elev + ELEV_THRESHOLD_FT):
       apparent_high += 3.5 °F per 1000 ft above grid
       apparent_low  -= 2.0 °F per 1000 ft above grid
   - Trail significantly BELOW grid (grid_elev > trail_elev + ELEV_THRESHOLD_FT):
       apparent_high += 3.5 °F per 1000 ft below grid
       apparent_low  unchanged (cold-air drainage offsets canyon heat at night)
   Requires points.json to include trail_elev and grid_elev fields (feet).
   If either field is absent, no correction is applied.
   --------------------------------------------------------------- */

/* ============================================================
   1. TRAIL IDENTITY & URL RESOLUTION
   ============================================================ */

function getTrailMeta() {
  const slug =
    window.TRAIL_SLUG ||
    document.body?.dataset?.trail ||
    "arizona-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:       new URL("points.json",            dataDir).href,
    trailGeojsonUrl: new URL("trail.geojson",          dataDir).href,
    normalsUrl:      new URL("historical_weather.json", dataDir).href,
    aztMetaUrl:      new URL("azt_meta.json",           dataDir).href,
    defaultMapCenter: [33.5, -111.5],
    defaultZoom:      6,
  };
}

const META      = getTrailMeta();
const trailSlug = META.slug;

console.log("[AZT] slug =", trailSlug);

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

// Elevation correction constants
const ELEV_THRESHOLD_FT     = 300;   // minimum diff (ft) to trigger a correction
const ELEV_HIGH_ADJ_PER_KFT = 3.5;  // °F added to apparent high per 1000 ft diff
const ELEV_LOW_ADJ_PER_KFT  = 2.0;  // °F subtracted from apparent low per 1000 ft above grid

// AZT spine constants
const AZT_SPINE_MIN  = 0.0;
const AZT_SPINE_MAX  = 882.5;
// Flagstaff alt: branches mid-P31 at Fisher Point (spine mile ~568.3), rejoins at P34 start
const AZT_FLAGSTAFF_BRANCH  = 568.3;
const AZT_FLAGSTAFF_REJOIN  = 596.3;

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

// Points
let allPoints        = [];
let pointsByMile     = new Map(); // nearest-integer mile → Point (main spine)
let pointsSorted     = [];        // [Point] sorted by mile

// AZT meta (loaded from azt_meta.json)
let aztMeta = null;

// Precomputed normals
let normalsByPointId  = new Map(); // point.id → { hi, lo, app_hi, app_lo, rh_hi, rh_lo, ws }
let normalsByMile     = [];        // [{ id, mile }] sorted — nearest-neighbour fallback
let normalsMeta       = null;

// Leaflet — Weather map
let map        = null;
let mapMarker  = null;

// Leaflet — Extremes map
let durMap           = null;
let durMapLayerGroup = null;

const SELECT_ZOOM = 11;

/* ============================================================
   5. UTILITY FUNCTIONS (trail-specific only — shared utils in /js/shared-utils.js)
   ============================================================ */

function refreshMapSize() {
  if (map) setTimeout(() => { try { map.invalidateSize(); } catch {} }, 0);
}

/* ============================================================
   6. ELEVATION CORRECTION
   ============================================================ */

/**
 * Apply elevation-based correction to apparent high and low temperatures.
 * Requires point.trail_elev and point.grid_elev (both in feet).
 * Returns { corrAppHigh, corrAppLow, elevDiffFt, direction }
 * where direction is "above", "below", or null (no correction).
 */
function applyElevationCorrection(appHigh, appLow, point) {
  const trailElev = Number(point?.trail_elev);
  const gridElev  = Number(point?.grid_elev);

  if (!isFinite(trailElev) || !isFinite(gridElev)) {
    return { corrAppHigh: appHigh, corrAppLow: appLow, elevDiffFt: 0, direction: null };
  }

  const diff = trailElev - gridElev; // positive = trail above grid

  if (Math.abs(diff) < ELEV_THRESHOLD_FT) {
    return { corrAppHigh: appHigh, corrAppLow: appLow, elevDiffFt: diff, direction: null };
  }

  let corrAppHigh = appHigh;
  let corrAppLow  = appLow;

  if (diff > 0) {
    // Trail above grid — thinner atmosphere amplifies heat during day, cold at night
    const kft = diff / 1000;
    if (appHigh != null) corrAppHigh = appHigh + ELEV_HIGH_ADJ_PER_KFT * kft;
    if (appLow  != null) corrAppLow  = appLow  - ELEV_LOW_ADJ_PER_KFT  * kft;
    return { corrAppHigh, corrAppLow, elevDiffFt: diff, direction: "above" };
  } else {
    // Trail below grid — canyon heat trapping raises apparent high; low unchanged
    const kft = Math.abs(diff) / 1000;
    if (appHigh != null) corrAppHigh = appHigh + ELEV_HIGH_ADJ_PER_KFT * kft;
    return { corrAppHigh, corrAppLow, elevDiffFt: diff, direction: "below" };
  }
}

function elevCorrectionNote(direction, elevDiffFt) {
  if (!direction) return "";
  const absDiff = Math.round(Math.abs(elevDiffFt));
  if (direction === "above") {
    return ` <span class="elev-adjusted" title="Trail is ~${absDiff} ft above weather grid; apparent temperatures adjusted">(elev. adj. +${absDiff}\u00a0ft)</span>`;
  }
  return ` <span class="elev-adjusted" title="Trail is ~${absDiff} ft below weather grid; apparent high adjusted">(elev. adj. \u2212${absDiff}\u00a0ft)</span>`;
}

/* ============================================================
   7. POINT LABEL HELPER
   ============================================================ */

function aztPointLabel(point) {
  const passages = aztMeta?.passages || window.AZT_PASSAGES_BOOTSTRAP || [];
  const passage  = passages.find(p => p.id === point.passage_id);
  const name     = passage ? passage.name : `Mile ${fmtMile(point.mile)}`;
  return `${name} \u2014 Mile ${fmtMile(point.mile)}`;
}

/* ============================================================
   10. ALTERNATE SELECTION + MILEAGE CALCULATION
   ============================================================ */

/**
 * Read the current alternate-group selections from the HTML radio buttons.
 * Returns { "pusch": "p11"|"p11e", "flagstaff": "p32"|"p33" }
 */
function getSelectedAlts() {
  return {
    pusch:     (document.querySelector('input[name="alt-pusch"]:checked')    || {}).value || "p11",
    flagstaff: (document.querySelector('input[name="alt-flagstaff"]:checked') || {}).value || "p32",
  };
}

/**
 * Calculate total trail miles given direction + alt selections.
 * Base total is the main-route distance (882.5 mi).
 * Each alternate group contributes a delta vs. the main segment it replaces.
 */
function calcTotalMiles(directionId, selectedAlts) {
  // Alt group definitions: delta_miles is the change vs. the main route segment
  const ALT_GROUPS = (aztMeta?.alt_groups?.length ? aztMeta.alt_groups : null) || [
    { id: "pusch",     main: "p11",  alt: "p11e", delta_miles: -1.4  },
    { id: "flagstaff", main: "p32",  alt: "p33",  delta_miles: -12.6 },
  ];

  let total = AZT_SPINE_MAX; // 882.5 mi main route
  for (const group of ALT_GROUPS) {
    if (selectedAlts[group.id] === group.alt) {
      total += group.delta_miles;
    }
  }
  return Math.round(total * 10) / 10;
}

/* ============================================================
   12. DATA LOADING
   ============================================================ */

async function loadAztMeta() {
  const key = `azt_meta_${trailSlug}_v5`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload = cached;
  if (!payload) {
    const r = await fetch(META.aztMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`azt_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  aztMeta = payload;
  console.log("[AZT] azt_meta loaded:", aztMeta.passages?.length, "passages");
}

async function loadPoints() {
  const r = await fetch(META.pointsUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`points.json fetch failed (${r.status})`);
  const data = await r.json();

  allPoints = data.filter(p =>
    isFinite(Number(p.lat)) && isFinite(Number(p.lon))
  ).map(p => ({
    ...p,
    lat:  Number(p.lat),
    lon:  Number(p.lon),
    mile: Number(p.mile),
    id:   String(p.id),
  }));

  pointsByMile = new Map();
  for (const p of allPoints) {
    const key = Math.round(p.mile);
    if (!pointsByMile.has(key)) pointsByMile.set(key, p);
  }

  pointsSorted = [...allPoints].sort((a, b) => a.mile - b.mile);

  console.log("[AZT] points loaded:", allPoints.length);
}

async function loadPrecomputedNormals() {
  const key = `azt_normals_${trailSlug}_${NORMALS_CACHE_VERSION}`;
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

  // Build nearest-neighbour mile index
  normalsByMile = pointsSorted
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, mile: p.mile }));

  console.log("[AZT] normals loaded:", normalsByPointId.size, "points");
}

/* ============================================================
   13. TRAIL GEOJSON OVERLAY
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
    .catch(e => console.warn("[AZT] trail overlay failed:", e));
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
   14. WEATHER MAP (Tool B)
   ============================================================ */

function initMap() {
  if (typeof L === "undefined") { console.warn("[AZT] Leaflet not loaded"); return; }
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
  mapMarker.bindPopup(aztPointLabel(point));
  map.setView(ll, SELECT_ZOOM);
  if (mapMarker.bringToFront) mapMarker.bringToFront();
  refreshMapSize();
}

/* ============================================================
   15. POINT LOOKUP HELPERS
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

/**
 * Find the nearest point to a given spine mile, respecting alternate selections.
 * Alt passage points (p11e, p33) are keyed by passage_mile, not spine mile.
 * Falls back to main-spine nearest if no alt points exist yet.
 */
function getNearestPoint(mile, selectedAlts = {}) {
  const useAltFlagstaff = (selectedAlts.flagstaff || "p32") === "p33";
  const useAltPusch     = (selectedAlts.pusch     || "p11") === "p11e";

  // Pusch Ridge segment (P11 / P11e): spine miles ~164–183
  const PUSCH_BRANCH = 164.0, PUSCH_REJOIN = 183.0;
  if (mile >= PUSCH_BRANCH && mile <= PUSCH_REJOIN) {
    const passageId = useAltPusch ? "p11e" : "p11";
    const segPts = pointsSorted.filter(p => p.passage_id === passageId);
    if (segPts.length) {
      // Alt points use passage_mile; main points use spine mile
      const keyFn = useAltPusch ? p => p.passage_mile : p => p.mile;
      const localMile = useAltPusch ? (mile - PUSCH_BRANCH) : mile;
      return binaryNearest(segPts, localMile, keyFn);
    }
  }

  // Flagstaff segment (P32 / P33): spine miles ~568–596
  if (mile >= AZT_FLAGSTAFF_BRANCH && mile <= AZT_FLAGSTAFF_REJOIN) {
    const passageId = useAltFlagstaff ? "p33" : "p32";
    const segPts = pointsSorted.filter(p => p.passage_id === passageId);
    if (segPts.length) {
      const keyFn = useAltFlagstaff ? p => p.passage_mile : p => p.mile;
      const localMile = useAltFlagstaff ? (mile - AZT_FLAGSTAFF_BRANCH) : mile;
      return binaryNearest(segPts, localMile, keyFn);
    }
  }

  // Default: nearest point on main spine
  return binaryNearest(pointsSorted, mile, p => p.mile);
}

/* ============================================================
   16. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key = `azt_forecast:${point.id}`;
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
  const key = `azt_hist:${point.id}:${range.start_date}:${range.end_date}`;
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
   17. PLANNING AVERAGE COMPUTATION
   ============================================================ */

function avg(arr) {
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function indexHistoricalByMonthDay(histDaily, fields) {
  const idx   = new Map();
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
   19. WEATHER TOOL RENDERING
   ============================================================ */

function renderPlanningSummary(point, monthDay, range, avgs) {
  const niceDate = formatMonthDayName(monthDay);
  const label    = aztPointLabel(point);
  const { corrAppHigh, corrAppLow, elevDiffFt, direction } =
    applyElevationCorrection(avgs.avgAppHigh, avgs.avgAppLow, point);

  const elevNote = elevCorrectionNote(direction, elevDiffFt);

  el("planningSummaryBlock").innerHTML = `
    <h2>Planning: 7-year Average</h2>
    <table>
      <tr><th>Date / Location</th><td colspan="3">${niceDate} \u2014 ${label}</td></tr>
      <tr><th></th><th style="background:#f0f0f0;">Actual Temp</th><th style="background:#f0f0f0;">Apparent Temp</th><th style="background:#f0f0f0;">Relative Humidity</th></tr>
      <tr><th>Avg High</th><td>${fmtTemp(avgs.avgHigh)}</td><td>${fmtTemp(corrAppHigh)}${elevNote}</td><td>${fmtRh(avgs.avgRhHigh)}</td></tr>
      <tr><th>Avg Low</th><td>${fmtTemp(avgs.avgLow)}</td><td>${fmtTemp(corrAppLow)}${elevNote}</td><td>${fmtRh(avgs.avgRhLow)}</td></tr>
      <tr><th>Historical Range</th><td colspan="3">${range.start_date} to ${range.end_date}</td></tr>
    </table>
    <p class="note">
      Averages computed from daily highs/lows over a ${TYPICAL_WINDOW_DAYS*2+1}-day window
      centered on the planning date, across 7 years of data.
      Apparent temperature uses the Steadman methodology (heat index at high humidity,
      wind chill at low temperatures with wind).
      ${direction ? "An elevation correction has been applied — see the notes section below for details." : ""}
    </p>
  `;
}

function renderCurrent(forecastData, point) {
  const c     = forecastData.current_weather;
  const block = el("currentBlock");
  if (!c || !block) return;

  block.innerHTML = `
    <h2>Current Conditions</h2>
    <table>
      <tr><th>Location</th><td>${aztPointLabel(point)}</td></tr>
      <tr><th>Temperature</th><td>${fmtTemp(c.temperature)}</td></tr>
      <tr><th>Wind</th><td>${Math.round(c.windspeed)} mph</td></tr>
      <tr><th>Time</th><td>${c.time}</td></tr>
    </table>
  `;
}

function renderForecastTable(forecastData, point) {
  const d     = forecastData.daily;
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

    const { corrAppHigh, corrAppLow, elevDiffFt, direction } =
      applyElevationCorrection(appHi, appLo, point);
    const elevNote = elevCorrectionNote(direction, elevDiffFt);

    return `
      <tr>
        <td>${date}</td>
        <td>${fmtTemp(hi)}${feelsLikeNote(hi, corrAppHigh)}</td>
        <td>${fmtTemp(lo)}${feelsLikeNote(lo, corrAppLow)}</td>
        <td>${rhHi != null ? fmtRh(rhHi) : "\u2014"} / ${rhLo != null ? fmtRh(rhLo) : "\u2014"}</td>
        <td>${precip != null ? Math.round(precip) + "%" : "\u2014"}</td>
        <td>${wind != null ? Math.round(wind) + " mph" : "\u2014"}${elevNote}</td>
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
   20. WEATHER TOOL PASSAGE INFO (runtime update after meta loads)
   ============================================================ */

function updatePassageInfo() {
  const passageId = el("aztPassageSelect")?.value;
  const infoEl    = el("aztPassageInfo");
  const mileInput = el("aztMileInput");
  if (!passageId || !infoEl) return;

  const passages = (aztMeta?.passages?.length ? aztMeta.passages : null)
    || window.AZT_PASSAGES_BOOTSTRAP || [];
  const p = passages.find(x => x.id === passageId);
  if (!p) return;

  const len = Math.round(p.mile_end - p.mile_start);
  infoEl.textContent = `Passage Range: 0\u2013${len} Miles`;

  if (mileInput) {
    mileInput.min  = 0;
    mileInput.max  = len;
    mileInput.step = 1;
    mileInput.placeholder = `e.g., ${Math.round(len / 2)}`;
    const cur = Number(mileInput.value);
    if (cur < 0 || cur > len) mileInput.value = "";
  }
}

function populatePassagesForRegion(regionId) {
  const passageSel = el("aztPassageSelect");
  if (!passageSel) return;
  passageSel.innerHTML = "";

  const passages = (aztMeta?.passages?.length ? aztMeta.passages : null)
    || window.AZT_PASSAGES_BOOTSTRAP || [];
  passages
    .filter(p => p.region === regionId && p.alt_group !== "flagstaff")
    .forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      passageSel.appendChild(opt);
    });

  updatePassageInfo();
}

/* ============================================================
   21. WEATHER TOOL RUN
   ============================================================ */

async function runWeather() {
  const passageId = el("aztPassageSelect")?.value;
  const mileRaw   = el("aztMileInput")?.value;
  const monthDay  = getSelectedMonthDay("monthSelect", "daySelect");

  setWeatherStatus("");
  if (!passageId) { setWeatherStatus("Please select a passage."); return; }
  if (mileRaw === "" || mileRaw == null) { setWeatherStatus("Please enter a mile."); return; }
  if (!monthDay) { setWeatherStatus("Please choose a planning date."); return; }

  const passageMile = Number(mileRaw);

  const passages = (aztMeta?.passages?.length ? aztMeta.passages : null)
    || window.AZT_PASSAGES_BOOTSTRAP || [];
  const passage  = passages.find(p => p.id === passageId);

  const passageLen = passage ? Math.round(passage.mile_end - passage.mile_start) : 99;
  if (passageMile < 0 || passageMile > passageLen) {
    setWeatherStatus(`Please enter a passage mile between 0 and ${passageLen}.`);
    return;
  }

  if (!allPoints.length) {
    setWeatherStatus("Trail data is still loading — please try again in a moment.");
    return;
  }

  // Convert passage-relative mile to absolute spine mile for point lookup
  const spineMile = (passage?.mile_start ?? 0) + passageMile;

  // Resolve alt selection based on chosen passage
  const weatherAlts = {
    flagstaff: passageId === "p33" ? "p33" : "p32",
    pusch:     passageId === "p11e" ? "p11e" : "p11",
  };
  const point = getNearestPoint(spineMile, weatherAlts);

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
    renderForecastTable(forecastData, point);

    const range    = lastSevenYearsRange();
    const histData = await fetchHistorical(point, range);
    const daily    = histData?.daily;
    if (!daily?.time) return;

    const avgs = computePlanningAverages(daily, monthDay, TYPICAL_WINDOW_DAYS);
    renderPlanningSummary(point, monthDay, range, avgs);

    const forecastAppLows = forecastData.daily?.apparent_temperature_min || [];
    if (forecastAppLows.some(v => Number.isFinite(v) && v <= 20) ||
        (Number.isFinite(avgs.avgAppLow) && avgs.avgAppLow <= 20)) {
      const s = el("weatherStatus");
      if (s) s.innerHTML = '<p style="color:#003388; font-weight:600; margin:0.5rem 0 0;">&#9888; Cold Advisory: Apparent low temperatures at or below 20&nbsp;&deg;F are indicated for this location and date. Conditions at this level may be hazardous without proper cold-weather gear. Check local NWS forecasts before setting out.</p>';
    }

  } catch (err) {
    console.error("[AZT] runWeather error:", err);
    setHtmlIfExists("currentBlock", `<p style="color:#900">Weather data unavailable: ${err.message}</p>`);
  } finally {
    refreshMapSize();
  }
}

/* ============================================================
   22. DURATION CALCULATOR  (Tool A)
   ============================================================ */

function renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay, durationDays }) {
  const startStr  = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr    = endDate.toLocaleDateString(undefined,   { year: "numeric", month: "long", day: "numeric" });
  const dirLabel  = directionId === "nobo"
    ? "Northbound — Coronado Memorial/Mexico to Utah Border"
    : "Southbound — Utah Border to Coronado Memorial/Mexico";

  const alts     = getSelectedAlts();
  const puschLbl = alts.pusch === "p11e" ? "Pusch Ridge Bypass (Alt.)" : "Santa Catalina Mountains (Main)";
  const flagLbl  = alts.flagstaff === "p33" ? "Flagstaff Urban Route (Alt.)" : "Elden Mountain (Main)";

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${dirLabel}</td></tr>
      <tr><th>Pusch Ridge</th><td>${puschLbl}</td></tr>
      <tr><th>Flagstaff</th><td>${flagLbl}</td></tr>
      <tr><th>Start Date</th><td>${startStr}</td></tr>
      <tr><th>Total Distance</th><td>${fmtMile(totalMiles)} miles</td></tr>
      <tr><th>Miles per Day</th><td>${fmtMile(milesPerDay)}</td></tr>
      <tr><th>Estimated Duration</th><td>${durationDays} days</td></tr>
      <tr><th>Estimated End Date</th><td>${endStr}</td></tr>
    </table>
  `;
}

/* ============================================================
   23. DURATION EXTREMES  (Tool A+)
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

  if (!normalsByMile.length) return null;
  const best = binaryNearest(normalsByMile, point.mile, e => e.mile);
  return best ? (normalsByPointId.get(best.id) || null) : null;
}

/**
 * Build the ordered sequence of points for a hike, one per day.
 * Prefers alt-passage points when the hiker has selected that alternate.
 */
function buildHikePoints({ directionId, startDate, milesPerDay, totalMiles, selectedAlts }) {
  const durationDays    = Math.ceil(totalMiles / milesPerDay);
  const hikePoints      = [];
  const isNobo          = directionId === "nobo";
  const useAltFlagstaff = (selectedAlts?.flagstaff || "p32") === "p33";
  const useAltPusch     = (selectedAlts?.pusch     || "p11") === "p11e";

  for (let i = 0; i < durationDays; i++) {
    const date    = addDays(startDate, i);
    const cumMile = milesPerDay * i;

    let spineMile;
    if (isNobo) {
      spineMile = Math.min(AZT_SPINE_MIN + cumMile, AZT_SPINE_MAX);
    } else {
      spineMile = Math.max(AZT_SPINE_MAX - cumMile, AZT_SPINE_MIN);
    }

    const point = getNearestPoint(spineMile, selectedAlts);
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
    const rawAppHigh = normals.app_hi[idx];
    const rawAppLow  = normals.app_lo[idx];

    if (!isFinite(avgHigh) || !isFinite(avgLow)) continue;

    // Apply elevation correction to normals-based apparent temperatures
    const { corrAppHigh: avgAppHigh, corrAppLow: avgAppLow } =
      applyElevationCorrection(rawAppHigh, rawAppLow, point);

    const avgRhHigh = normals.rh_hi?.[idx];
    const avgRhLow  = normals.rh_lo?.[idx];

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

function renderDurExtremesBlocks(hottest, coldest, opts = {}) {
  renderDurExtremesBlocksShared(hottest, coldest, {
    formatLocation: (rec) => aztPointLabel(rec.point),
    ...opts
  });
}

function renderDurExtremesMap(hottest, coldest) {
  const mapEl = el("durExtremesMap");
  if (!mapEl || typeof L === "undefined") return;

  if (!durMap) {
    durMap = L.map("durExtremesMap", { zoomControl: true })
               .setView(META.defaultMapCenter, META.defaultZoom);
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
  const { startDate, durationDays, totalMiles, startDateLabel = "Start Date" } = params;
  setDisplayIfExists("durExtremesWrap", "none");
  setHtmlIfExists("durExtremesHot",  "");
  setHtmlIfExists("durExtremesCold", "");
  if (el("bestStartResult")) el("bestStartResult").innerHTML = "";

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
  const utciCounts = computeUtciCounts(hikePoints, getNearestNormals);
  const endDate = startDate ? addDays(startDate, durationDays - 1) : null;

  setDisplayIfExists("durExtremesWrap", "block");
  renderDurExtremesBlocks(hottest, coldest, {
    startDate, endDate, distanceMiles: totalMiles, durationDays, startDateLabel, utciCounts
  });
  renderDurExtremesMap(hottest, coldest);

  const durResult = el("durResult");
  if (!durResult) return;

  // Heat index advisory (apparent high ≥ 100 °F)
  const peakHeat = hottest?.appHigh ?? hottest?.avgHigh;
  if (peakHeat != null && peakHeat >= 100) {
    const warn = document.createElement("p");
    warn.style.cssText = "color:#9a4000; font-weight:600; margin-top:0.75rem;";
    warn.textContent = `\u26a0 Heat advisory: the hottest day on your hike has an estimated apparent temperature of ${Math.round(peakHeat)} \u00b0F \u2014 at or above the 100 \u00b0F heat advisory threshold. Plan for early morning starts, ample hydration, and frequent water source checks.`;
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

  const directionId  = el("durDirectionSelect")?.value || "nobo";
  const selectedAlts = getSelectedAlts();
  const monthDay     = getSelectedMonthDay("durMonthSelect", "durDaySelect");
  const mpd          = numVal("durMilesPerDay");

  if (!monthDay) { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5)  { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles   = calcTotalMiles(directionId, selectedAlts);
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
      directionId, startDate, milesPerDay: mpd, totalMiles, durationDays, selectedAlts
    }).catch(err => {
      console.error("[AZT] extremes error:", err);
      setDurStatus(`Error computing extremes: ${err.message}`);
    });
  } else {
    setDurStatus("Temperature extremes will appear once trail data finishes loading.");
  }
}

function runBestStart() {
  setDurStatus("");
  if (el("bestStartResult")) el("bestStartResult").innerHTML = "";
  if (el("durResult")) el("durResult").innerHTML = "";
  setDisplayIfExists("durExtremesWrap", "none");

  const directionId  = el("durDirectionSelect")?.value || "nobo";
  const selectedAlts = getSelectedAlts();
  const mpd          = numVal("durMilesPerDay");

  if (mpd == null || mpd <= 0) { setDurStatus("Please enter Miles per Day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }
  if (!normalsByPointId.size) { setDurStatus("Historical weather data is still loading. Please try again."); return; }
  if (!allPoints.length) { setDurStatus("Trail data is still loading. Please try again."); return; }

  const totalMiles   = calcTotalMiles(directionId, selectedAlts);
  const durationDays = Math.ceil(totalMiles / mpd);
  if (durationDays > 365) { setDurStatus("For this planner, hikes cannot exceed one year. Please adjust Miles per Day."); return; }

  const { bestStartDate } = runBestStartShared({
    durationDays,
    getHikePoints: (startDate) => buildHikePoints({ directionId, startDate, milesPerDay: mpd, totalMiles, selectedAlts }),
    getNormals: (point) => getNearestNormals(point),
  });

  if (!bestStartDate) {
    setHtmlIfExists("bestStartResult",
      `<p style="color:#b00000; font-weight:600; margin-top:0.75rem;">No valid start date found \u2014 every possible start date includes at least one day of extreme heat or cold stress. Try adjusting miles per day.</p>`);
    return;
  }

  computeAndRenderDurationExtremes({
    directionId, startDate: bestStartDate, milesPerDay: mpd, totalMiles, durationDays, selectedAlts,
    startDateLabel: "<em>BestStart!</em> Date"
  }).catch(err => { console.error(err); setDurStatus(`Error: ${err.message}`); });
}

/* ============================================================
   24. UI INITIALIZATION
   ============================================================ */

function initDurationUI() {
  initMonthDayPickerGeneric("durMonthSelect", "durDaySelect");
  el("durBtn")?.addEventListener("click", runDurationCalculator);
  el("bestStartBtn")?.addEventListener("click", runBestStart);
  const mpdEl = el("durMilesPerDay");
  if (mpdEl && mpdEl.value === "") mpdEl.value = "15";
}

function initWeatherUI() {
  el("goBtn")?.addEventListener("click", runWeather);

  const regionSel  = el("aztRegionSelect");
  const passageSel = el("aztPassageSelect");

  if (regionSel) {
    regionSel.addEventListener("change", () => {
      populatePassagesForRegion(regionSel.value);
    });
    // Initial population (may already be done by bootstrap, but ensures correct data)
    populatePassagesForRegion(regionSel.value);
  }
  if (passageSel) {
    passageSel.addEventListener("change", updatePassageInfo);
  }

  initMonthDayPickerGeneric("monthSelect", "daySelect");
  updatePassageInfo();
}

/* ============================================================
   25. MAIN
   ============================================================ */

async function main() {
  initDurationUI();
  initWeatherUI();

  // Initialize weather map
  initMap();
  loadTrailOverlay();

  // Load azt_meta.json (non-blocking — updates labels/options if loaded)
  loadAztMeta()
    .then(() => {
      // Re-populate passages with canonical meta data
      const regionSel = el("aztRegionSelect");
      if (regionSel) populatePassagesForRegion(regionSel.value);
      updatePassageInfo();
    })
    .catch(e => console.warn("[AZT] azt_meta not loaded:", e));

  // Load points
  try {
    await loadPoints();

    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[AZT] loadPoints failed:", err);
  }

  // Load precomputed normals (best-effort)
  try {
    await loadPrecomputedNormals();
    setDurStatus(""); // normals loaded silently
  } catch (e) {
    console.warn("[AZT] normals not loaded:", e);
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
