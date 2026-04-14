/* Pacific Crest Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - 2 direction options (NOBO / SOBO)
           - Single continuous spine; no alternates
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json, 5-mile intervals)
           - Elevation correction applied to apparent temperatures
           - Heat index advisory when apparent high ≥ 100 °F
           - Wind chill advisory when apparent low ≤ 20 °F
   Tool B: Weather planner
           - Section selector (5 sections) → Trail Mile → Date
           - Open-Meteo forecast (5-day) + current conditions
           - 7-year planning average high/low
           - Apparent temperature (Steadman: heat index + wind chill)
           - Elevation correction applied to apparent temperatures
   Maps: Leaflet + OSM tiles + trail.geojson overlay (5 section LineStrings)
   Units: Fahrenheit, mph, %
   Caching: localStorage (TTL-based); HTTP cache for large files

   Elevation correction logic (applied to apparent temperature):
   - Trail significantly ABOVE grid (trail_elev > grid_elev + 300 ft):
       apparent_high -= 3.5 °F per 1000 ft above grid
       apparent_low  -= 2.0 °F per 1000 ft above grid
   - Trail significantly BELOW grid (grid_elev > trail_elev + 300 ft):
       apparent_high += 3.5 °F per 1000 ft below grid
       apparent_low  unchanged
   trail_elev: from points.json (SRTM via OpenTopoData, feet)
   grid_elev:  from historical_weather.json (Open-Meteo ERA5-Land, feet)
   ---------------------------------------------------------------*/

/* ============================================================
   1. TRAIL IDENTITY & URL RESOLUTION
   ============================================================ */

function getTrailMeta() {
  const slug =
    window.TRAIL_SLUG ||
    document.body?.dataset?.trail ||
    "pacific-crest-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:        new URL("points.json",             dataDir).href,
    trailGeojsonUrl:  new URL("trail.geojson",           dataDir).href,
    normalsUrl:       new URL("historical_weather.json", dataDir).href,
    pctMetaUrl:       new URL("pct_meta.json",           dataDir).href,
    defaultMapCenter: [40.5, -120.0],
    defaultZoom:      5,
  };
}

const META      = getTrailMeta();
const trailSlug = META.slug;

console.log("[PCT] slug =", trailSlug);

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

const FORECAST_TTL_MS       = 30 * 60 * 1000;           // 30 min
const HIST_TTL_MS           = 24 * 60 * 60 * 1000;      // 24 hr
const TRAIL_TTL_MS          = 30 * 24 * 60 * 60 * 1000; // 30 days
const NORMALS_CACHE_VERSION = "v1";

const PCT_TRAIL_MILES = 2653.0;

// Elevation correction thresholds (matches AZT)
const ELEV_THRESHOLD_FT     = 300;  // deadband before any correction fires
const ELEV_HIGH_ADJ_PER_KFT = 3.5; // °F per 1,000 ft for apparent high
const ELEV_LOW_ADJ_PER_KFT  = 2.0; // °F per 1,000 ft for apparent low (trail above only)

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

let allPoints    = [];
let pointsSorted = [];  // sorted by mile

let pctMeta = null;

let normalsByPointId = new Map(); // point.id → normals arrays
let normalsByMile    = [];        // [{ id, mile }] sorted — nearest-neighbour fallback

// Leaflet — Weather map
let map       = null;
let mapMarker = null;

// Leaflet — Extremes map
let durMap           = null;
let durMapLayerGroup = null;

const SELECT_ZOOM = 11;

/* ============================================================
   5. UTILITY FUNCTIONS (trail-specific)
   ============================================================ */

function refreshMapSize() {
  if (map) setTimeout(() => { try { map.invalidateSize(); } catch {} }, 0);
}

/* ============================================================
   6. ELEVATION CORRECTION
   ============================================================ */

/**
 * Apply elevation-based correction to apparent high and low temperatures.
 * Requires point.trail_elev (feet, from SRTM via OpenTopoData)
 * and point.grid_elev (feet, from Open-Meteo ERA5-Land, stored in historical_weather.json).
 * Returns { corrAppHigh, corrAppLow, elevDiffFt, direction }
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
    // Trail above grid — cooler apparent temperatures at altitude
    const kft = diff / 1000;
    if (appHigh != null) corrAppHigh = appHigh - ELEV_HIGH_ADJ_PER_KFT * kft;
    if (appLow  != null) corrAppLow  = appLow  - ELEV_LOW_ADJ_PER_KFT  * kft;
    return { corrAppHigh, corrAppLow, elevDiffFt: diff, direction: "above" };
  } else {
    // Trail below grid — canyon heat raises apparent high
    const kft = Math.abs(diff) / 1000;
    if (appHigh != null) corrAppHigh = appHigh + ELEV_HIGH_ADJ_PER_KFT * kft;
    return { corrAppHigh, corrAppLow, elevDiffFt: diff, direction: "below" };
  }
}

function elevCorrectionNote(direction, elevDiffFt) {
  if (!direction) return "";
  const absDiff = Math.round(Math.abs(elevDiffFt));
  if (direction === "above") {
    return ` <span class="elev-adjusted" title="Trail is ~${absDiff} ft above weather grid; apparent temperatures adjusted">(elev.\u00a0adj.\u00a0+${absDiff}\u00a0ft)</span>`;
  }
  return ` <span class="elev-adjusted" title="Trail is ~${absDiff} ft below weather grid; apparent high adjusted">(elev.\u00a0adj.\u00a0\u2212${absDiff}\u00a0ft)</span>`;
}

/* ============================================================
   7. POINT LABEL HELPER
   ============================================================ */

function pctPointLabel(point) {
  const sections = pctMeta?.sections || window.PCT_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => point.mile >= s.mile_start && point.mile <= s.mile_end);
  const secName = sec ? sec.name : "Mile " + fmtMile(point.mile);
  return `${secName} \u2014 ${point.state} \u2014 Mile ${fmtMile(point.mile)}`;
}

/* ============================================================
   8. MILEAGE CALCULATION
   ============================================================ */

function calcTotalMiles(directionId) {
  const opts = pctMeta?.direction_options || [];
  const opt  = opts.find(o => o.id === directionId);
  return opt ? opt.total_miles : PCT_TRAIL_MILES;
}

/* ============================================================
   9. DATA LOADING
   ============================================================ */

async function loadPctMeta() {
  const key    = `pct_meta_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload  = cached;
  if (!payload) {
    const r = await fetch(META.pctMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`pct_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  pctMeta = payload;
  console.log("[PCT] pct_meta loaded:", pctMeta.sections?.length, "sections");
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
    id:   String(p.id),
    mile: Number(p.mile),
  }));

  pointsSorted = [...allPoints].sort((a, b) => a.mile - b.mile);

  console.log("[PCT] points loaded:", allPoints.length);
}

async function loadPrecomputedNormals() {
  // historical_weather.json can be large — rely on HTTP cache, skip localStorage
  const r = await fetch(META.normalsUrl);
  if (!r.ok) throw new Error(`historical_weather.json fetch failed (${r.status})`);
  const payload = await r.json();

  normalsByPointId = new Map();

  // Build grid_elev lookup and enrich allPoints so elevation correction works
  const gridElevById = new Map();
  for (const p of (payload.points || [])) {
    if (!p?.id) continue;
    if (p.grid_elev != null) gridElevById.set(String(p.id), p.grid_elev);

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

  // Enrich allPoints with grid_elev for applyElevationCorrection
  for (const p of allPoints) {
    if (gridElevById.has(p.id)) p.grid_elev = gridElevById.get(p.id);
  }

  // Build nearest-neighbour mile index
  normalsByMile = pointsSorted
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, mile: p.mile }));

  console.log("[PCT] normals loaded:", normalsByPointId.size, "points");
  setDurStatus("Historical weather data loaded (" + normalsByPointId.size + " points).");
}

/* ============================================================
   10. TRAIL GEOJSON OVERLAY
   ============================================================ */

async function fetchTrailGeojson() {
  const key    = `trail_geojson_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  if (cached) return cached;
  // ~9 MB file — rely on browser HTTP cache; localStorage will overflow gracefully
  const r = await fetch(META.trailGeojsonUrl);
  if (!r.ok) throw new Error(`trail.geojson fetch failed (${r.status})`);
  const gj = await r.json();
  cacheSet(key, gj);
  return gj;
}

const weatherHaloRef  = { current: null };
const weatherLayerRef = { current: null };
const durHaloRef      = { current: null };
const durLayerRef     = { current: null };

const TRAIL_STYLE = {
  color: "#e06060", weight: 3.25, opacity: 0.85, lineCap: "round", lineJoin: "round"
};

function applyTrailOverlay(targetMap, haloRef, layerRef, onDone) {
  fetchTrailGeojson()
    .then(geojson => {
      if (haloRef.current)  { try { targetMap.removeLayer(haloRef.current);  } catch {} }
      if (layerRef.current) { try { targetMap.removeLayer(layerRef.current); } catch {} }

      layerRef.current = L.geoJSON(geojson, {
        style: () => TRAIL_STYLE,
        interactive: false,
      }).addTo(targetMap);

      if (layerRef.current.bringToBack) layerRef.current.bringToBack();
      if (onDone) onDone();
    })
    .catch(e => console.warn("[PCT] trail overlay failed:", e));
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
   11. WEATHER MAP (Tool B)
   ============================================================ */

function initMap() {
  if (typeof L === "undefined") { console.warn("[PCT] Leaflet not loaded"); return; }
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
  mapMarker.bindPopup(pctPointLabel(point));
  map.setView(ll, SELECT_ZOOM);
  if (mapMarker.bringToFront) mapMarker.bringToFront();
  refreshMapSize();
}

/* ============================================================
   12. POINT LOOKUP HELPERS
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

function getNearestPoint(mile) {
  return binaryNearest(pointsSorted, mile, p => p.mile);
}

/* ============================================================
   13. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key    = `pct_forecast:${point.id}`;
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
  const key    = `pct_hist:${point.id}:${range.start_date}:${range.end_date}`;
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
   14. PLANNING AVERAGE COMPUTATION
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
   15. WEATHER TOOL RENDERING
   ============================================================ */

function renderPlanningSummary(point, monthDay, range, avgs) {
  const niceDate = formatMonthDayName(monthDay);
  const label    = pctPointLabel(point);
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
      ${direction ? "An elevation correction has been applied \u2014 see the notes section below for details." : ""}
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
      <tr><th>Location</th><td>${pctPointLabel(point)}</td></tr>
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
        <td>${wind   != null ? Math.round(wind)   + " mph" : "\u2014"}${elevNote}</td>
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
   16. WEATHER TOOL SECTION INFO
   ============================================================ */

function updateSectionInfo() {
  const sectionId = el("sectionSelect")?.value;
  const infoEl    = el("pctSectionInfo");
  const mileInput = el("pctMileInput");
  if (!sectionId || !infoEl) return;

  const sections = pctMeta?.sections || window.PCT_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => s.id === sectionId);
  if (!sec) return;

  infoEl.textContent = `Region Range: ${sec.mile_start}\u2013${sec.mile_end} Miles`;

  if (mileInput) {
    mileInput.placeholder = `e.g., ${Math.round((sec.mile_start + sec.mile_end) / 2)}`;
    const cur = Number(mileInput.value);
    if (cur < sec.mile_start || cur > sec.mile_end) mileInput.value = "";
  }
}

/* ============================================================
   17. WEATHER TOOL RUN
   ============================================================ */

async function runWeather() {
  const sectionId = el("sectionSelect")?.value;
  const mileRaw   = el("pctMileInput")?.value;
  const monthDay  = getSelectedMonthDay("monthSelect", "daySelect");

  setWeatherStatus("");
  if (!sectionId)                       { setWeatherStatus("Please select a section."); return; }
  if (mileRaw === "" || mileRaw == null) { setWeatherStatus("Please enter a trail mile."); return; }
  if (!monthDay)                        { setWeatherStatus("Please choose a planning date."); return; }

  const mile = Number(mileRaw);
  if (!isFinite(mile)) { setWeatherStatus("Please enter a valid number for the trail mile."); return; }

  const sections = pctMeta?.sections || window.PCT_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => s.id === sectionId);
  if (sec && (mile < sec.mile_start || mile > sec.mile_end)) {
    setWeatherStatus(`Please enter a mile between ${sec.mile_start} and ${sec.mile_end} for this region.`);
    return;
  }

  const point = getNearestPoint(mile);
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

  } catch (err) {
    console.error("[PCT] runWeather error:", err);
    setHtmlIfExists("currentBlock", `<p style="color:#900">Weather data unavailable: ${err.message}</p>`);
  } finally {
    refreshMapSize();
  }
}

/* ============================================================
   18. DURATION CALCULATOR (Tool A)
   ============================================================ */

function renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay, durationDays }) {
  const startStr = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr   = endDate.toLocaleDateString(undefined,   { year: "numeric", month: "long", day: "numeric" });
  const opts     = pctMeta?.direction_options || [];
  const dirLabel = opts.find(o => o.id === directionId)?.label
    || (directionId === "nobo"
        ? "Northbound \u2014 Campo (Mexican Border) \u2192 Manning Park (Canadian Border)"
        : "Southbound \u2014 Manning Park (Canadian Border) \u2192 Campo (Mexican Border)");

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${dirLabel}</td></tr>
      <tr><th>Start Date</th><td>${startStr}</td></tr>
      <tr><th>Total Distance</th><td>${fmtMile(totalMiles)} miles</td></tr>
      <tr><th>Miles per Day</th><td>${fmtMile(milesPerDay)}</td></tr>
      <tr><th>Estimated Duration</th><td>${durationDays} days</td></tr>
      <tr><th>Estimated End Date</th><td>${endStr}</td></tr>
    </table>
  `;
}

/* ============================================================
   19. DURATION EXTREMES (Tool A+)
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
 * Build ordered sequence of trail points for a hike, one per day.
 * NOBO: Campo (mile 0) → Manning Park (mile 2653)
 * SOBO: Manning Park (mile 2653) → Campo (mile 0)
 */
function buildHikePoints({ directionId, startDate, milesPerDay, totalMiles }) {
  const durationDays = Math.ceil(totalMiles / milesPerDay);
  const hikePoints   = [];
  const isNobo       = directionId === "nobo";

  for (let i = 0; i < durationDays; i++) {
    const date      = addDays(startDate, i);
    const cumMile   = milesPerDay * i;
    const trailMile = isNobo
      ? Math.min(cumMile, totalMiles)
      : Math.max(totalMiles - cumMile, 0);

    const point = getNearestPoint(trailMile);
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

    const rawAppHigh = normals.app_hi[idx];
    const rawAppLow  = normals.app_lo[idx];
    const avgHigh    = normals.hi[idx];
    const avgLow     = normals.lo[idx];

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
    formatLocation: (rec) => pctPointLabel(rec.point),
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
  const { startDateLabel } = params;
  setDisplayIfExists("durExtremesWrap", "none");
  setHtmlIfExists("durExtremesHot",  "");
  setHtmlIfExists("durExtremesCold", "");
  setHtmlIfExists("bestStartResult", "");

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
  const endDate = addDays(params.startDate, params.durationDays - 1);

  // Build advisory HTML to pass into the shared renderer
  let warningHtml = "";
  const peakHeat  = hottest?.appHigh ?? hottest?.avgHigh;
  const peakChill = coldest?.appLow  ?? coldest?.avgLow;
  if (peakHeat != null && peakHeat >= 100) {
    warningHtml += `<p style="color:#9a4000; font-weight:600; margin-top:0.75rem;">\u26a0 Heat advisory: the hottest day on your hike has an estimated heat index of ${Math.round(peakHeat)}\u00a0\u00b0F \u2014 at or above the 100\u00a0\u00b0F National Weather Service Heat Advisory threshold. Plan for early morning starts, ample hydration, and extra rest during peak heat.</p>`;
  }
  if (peakChill != null && peakChill <= 20) {
    warningHtml += `<p style="color:#003388; font-weight:600; margin-top:0.75rem;">\u26a0 Cold weather advisory: the coldest night on your hike is expected to be at or below 20\u00a0\u00b0F. Conditions at this level may be hazardous without proper preparation and equipment. Check local NWS forecasts before your hike.</p>`;
  }

  setDisplayIfExists("durExtremesWrap", "block");
  renderDurExtremesBlocks(hottest, coldest, {
    startDate: params.startDate,
    endDate,
    distanceMiles: params.totalMiles,
    durationDays: params.durationDays,
    startDateLabel,
    utciCounts,
    warningHtml
  });
  renderDurExtremesMap(hottest, coldest);
}

function runDurationCalculator() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const directionId = el("durDirectionSelect")?.value || "nobo";
  const monthDay    = getSelectedMonthDay("durMonthSelect", "durDaySelect");
  const mpd         = numVal("durMilesPerDay");

  if (!monthDay)               { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5)                 { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles   = calcTotalMiles(directionId);
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
      console.error("[PCT] extremes error:", err);
      setDurStatus(`Error computing extremes: ${err.message}`);
    });
  } else {
    setDurStatus("Temperature extremes will appear once trail data finishes loading.");
  }
}

function runBestStart() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setHtmlIfExists("bestStartResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const mpd = numVal("durMilesPerDay");
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const directionId  = el("durDirectionSelect")?.value || "nobo";
  const totalMiles   = calcTotalMiles(directionId);
  const durationDays = Math.ceil(totalMiles / mpd);

  if (durationDays > 365) {
    setDurStatus("Estimated duration exceeds one year. Please increase miles per day.");
    return;
  }

  if (!normalsByPointId.size || !allPoints.length) {
    setDurStatus("Historical data not yet loaded \u2014 please wait and try again.");
    return;
  }

  setHtmlIfExists("bestStartResult", "<p style='color:#555;font-style:italic;'>Scanning all start dates\u2026</p>");

  setTimeout(() => {
    const { bestStartDate } = runBestStartShared({
      durationDays,
      getHikePoints: (startDate) => buildHikePoints({ directionId, startDate, milesPerDay: mpd, totalMiles }),
      getNormals: getNearestNormals
    });

    if (!bestStartDate) {
      setHtmlIfExists("bestStartResult", "<p style='color:#b00000; font-weight:600; margin-top:0.75rem;'>No valid start date found \u2014 every possible start date includes at least one day of extreme heat or cold stress. Try adjusting miles per day.</p>");
      return;
    }

    computeAndRenderDurationExtremes({
      directionId,
      startDate: bestStartDate,
      milesPerDay: mpd,
      totalMiles,
      durationDays,
      startDateLabel: "<em>BestStart!</em> Date"
    }).catch(err => {
      console.error("[PCT] BestStart extremes error:", err);
      setDurStatus(`Error computing extremes: ${err.message}`);
    });
  }, 0);
}

/* ============================================================
   20. UI INITIALIZATION
   ============================================================ */

function initDurationUI() {
  initMonthDayPickerGeneric("durMonthSelect", "durDaySelect");
  el("durBtn")?.addEventListener("click", runDurationCalculator);
  el("bestStartBtn")?.addEventListener("click", runBestStart);
  const mpdEl = el("durMilesPerDay");
  if (mpdEl && mpdEl.value === "") mpdEl.value = "20";
}

function initWeatherUI() {
  el("goBtn")?.addEventListener("click", runWeather);
  el("sectionSelect")?.addEventListener("change", updateSectionInfo);
  initMonthDayPickerGeneric("monthSelect", "daySelect");
  updateSectionInfo();
}

/* ============================================================
   21. MAIN
   ============================================================ */

async function main() {
  initDurationUI();
  initWeatherUI();

  // Initialize weather map
  initMap();
  loadTrailOverlay();

  // Load pct_meta.json (non-blocking)
  loadPctMeta()
    .then(() => { updateSectionInfo(); })
    .catch(e => console.warn("[PCT] pct_meta not loaded:", e));

  // Load points
  try {
    await loadPoints();

    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[PCT] loadPoints failed:", err);
  }

  // Load precomputed normals (best-effort)
  try {
    await loadPrecomputedNormals();
  } catch (e) {
    console.warn("[PCT] normals not loaded:", e);
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
