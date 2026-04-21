/* Ice Age Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - West to East or East to West
           - Heat index advisory ≥ 100 °F
           - Wind chill advisory ≤ 20 °F
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json, 5-mile intervals)
   Tool B: Weather planner
           - Region → Segment → Segment Mile → Date
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
    "ice-age-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:          new URL("points.json",             dataDir).href,
    trailGeojsonUrl:    new URL("trail.geojson",           dataDir).href,
    roadwalkGeojsonUrl: new URL("trail_roadwalk.geojson",  dataDir).href,
    normalsUrl:         new URL("historical_weather.json",  dataDir).href,
    iatMetaUrl:         new URL("iat_meta.json",            dataDir).href,
    defaultMapCenter: [44.5, -90.0],
    defaultZoom:      7,
  };
}

const META      = getTrailMeta();
const trailSlug = META.slug;

console.log("[IAT] slug =", trailSlug);

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
const NORMALS_CACHE_VERSION = "v1";

const IAT_TOTAL_MILES = 1315.6;  // total axis miles incl. absorbed roadwalk (West Alt); East Alt ≈ 1303

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

let allPoints        = [];
let pointsByAxisMile = [];   // sorted by axis_mile — main spine + West Alt points only
let eastAltPoints    = [];   // sorted by alt_mile — East Alt points only
let iatMeta          = null;

// Precomputed normals
let normalsByPointId  = new Map();
let normalsSortedAxis = [];   // [{ id, axis_mile }] sorted — nearest-neighbour
let normalsMeta       = null;

// Leaflet — Weather map
let map       = null;
let mapMarker = null;

// Leaflet — Extremes map
let durMap           = null;
let durMapLayerGroup = null;

const SELECT_ZOOM = 11;

/* ============================================================
   5. UTILITY FUNCTIONS (trail-specific only)
   ============================================================ */

function refreshMapSize() {
  if (map) setTimeout(() => { try { map.invalidateSize(); } catch {} }, 0);
}

/* ============================================================
   6. POINT LABEL HELPER
   ============================================================ */

function iatPointLabel(point) {
  const segName = point.section
    ? point.section.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "Unknown Segment";
  return `${segName} \u2014 Mile ${fmtMile(point.mile)}`;
}

/* ============================================================
   9. MILEAGE CALCULATION
   ============================================================ */

/** Returns "west" or "east" based on the selected radio button. */
function getSelectedAlt() {
  const checked = document.querySelector('input[name="iatAlt"]:checked');
  return checked ? checked.value : "west";
}

function calcTotalMiles(directionId, selectedAlt) {
  // Main spine total_trail_miles already represents the West Alt route.
  // East Alt applies delta_miles.
  const spineTotal = iatMeta?.trail?.total_trail_miles || IAT_TOTAL_MILES;
  const ag         = iatMeta?.alt_groups?.[0];
  const altId      = selectedAlt || getSelectedAlt();

  const delta = altId === "east" ? (ag?.east_alt?.delta_miles ?? -12.7) : 0;
  return Math.round((spineTotal + delta) * 10) / 10;
}

/* ============================================================
   11. DATA LOADING
   ============================================================ */

async function loadIatMeta() {
  const key = `iat_meta_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload = cached;
  if (!payload) {
    const r = await fetch(META.iatMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`iat_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  iatMeta = payload;
  console.log("[IAT] iat_meta loaded:", iatMeta.sections?.length, "sections");
}

async function loadPoints() {
  const r = await fetch(META.pointsUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`points.json fetch failed (${r.status})`);
  const data = await r.json();

  const parsed = data.filter(p =>
    isFinite(Number(p.lat)) && isFinite(Number(p.lon))
  ).map(p => ({
    ...p,
    lat:  Number(p.lat),
    lon:  Number(p.lon),
    id:   String(p.id),
    mile: Number(p.mile),
  }));

  // Separate main spine (has axis_mile) from East Alt (has alt_mile + alt_id)
  allPoints     = parsed.filter(p => !p.alt_id).map(p => ({ ...p, axis_mile: Number(p.axis_mile) }));
  eastAltPoints = parsed.filter(p => p.alt_id === "east")
                        .map(p => ({ ...p, alt_mile: Number(p.alt_mile) }))
                        .sort((a, b) => a.alt_mile - b.alt_mile);

  pointsByAxisMile = [...allPoints].sort((a, b) => a.axis_mile - b.axis_mile);

  console.log("[IAT] points loaded:", allPoints.length, "main +", eastAltPoints.length, "East Alt");
}

async function loadPrecomputedNormals() {
  // historical_weather.json may be large — rely on HTTP cache instead of localStorage.
  const r = await fetch(META.normalsUrl);
  if (!r.ok) throw new Error(`historical_weather.json fetch failed (${r.status})`);
  const payload = await r.json();

  normalsByPointId = new Map();
  normalsMeta      = payload.meta || null;

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

  // Build nearest-neighbour axis_mile index over main-spine points that have normals.
  // East Alt points fall back to nearest main-spine normal via getNearestNormals().
  normalsSortedAxis = pointsByAxisMile
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, axis_mile: p.axis_mile }));

  console.log("[IAT] normals loaded:", normalsByPointId.size, "points");
  if (normalsMeta) {
    const count = normalsByPointId.size;
    setDurStatus(`Historical weather data loaded (${count} points, ${normalsMeta.years || ""}).`);
    setTimeout(() => setDurStatus(""), 4000);
  }
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

async function fetchRoadwalkGeojson() {
  const key = `roadwalk_geojson_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  if (cached) return cached;
  const r = await fetch(META.roadwalkGeojsonUrl, { cache: "no-store" });
  if (!r.ok) throw new Error(`trail_roadwalk.geojson fetch failed (${r.status})`);
  const gj = await r.json();
  cacheSet(key, gj);
  return gj;
}

const weatherHaloRef       = { current: null };
const weatherLayerRef      = { current: null };
const weatherRoadwalkRef   = { current: null };
const durHaloRef           = { current: null };
const durLayerRef          = { current: null };
const durRoadwalkRef       = { current: null };

function applyTrailOverlay(targetMap, haloRef, layerRef, roadwalkRef, onDone) {
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

      if (haloRef.current)  { try { targetMap.removeLayer(haloRef.current);  } catch {} }
      if (layerRef.current) { try { targetMap.removeLayer(layerRef.current); } catch {} }

      layerRef.current = L.geoJSON(clean, {
        style: { color: "#e06060", weight: 3.25, opacity: 0.85, lineCap: "round", lineJoin: "round" },
        interactive: false
      }).addTo(targetMap);

      if (layerRef.current.bringToBack) layerRef.current.bringToBack();
      if (onDone) onDone();
    })
    .catch(e => console.warn("[IAT] trail overlay failed:", e));

  // Roadwalk (connecting route) — dotted line, display-only, best-effort
  fetchRoadwalkGeojson()
    .then(geojson => {
      if (roadwalkRef.current) { try { targetMap.removeLayer(roadwalkRef.current); } catch {} }
      roadwalkRef.current = L.geoJSON(geojson, {
        style: { color: "#e06060", weight: 3, opacity: 0.65, lineCap: "round", dashArray: "1 9" },
        interactive: false
      }).addTo(targetMap);
      if (roadwalkRef.current.bringToBack) roadwalkRef.current.bringToBack();
    })
    .catch(e => console.warn("[IAT] roadwalk overlay failed (non-critical):", e));
}

function loadTrailOverlay() {
  if (!map) return;
  applyTrailOverlay(map, weatherHaloRef, weatherLayerRef, weatherRoadwalkRef, refreshMapSize);
}

function loadTrailOverlayForDurMap() {
  if (!durMap) return;
  applyTrailOverlay(durMap, durHaloRef, durLayerRef, durRoadwalkRef, () => {
    try { durMap.invalidateSize(); } catch {}
  });
}

/* ============================================================
   13. WEATHER MAP (Tool B)
   ============================================================ */

function initMap() {
  if (typeof L === "undefined") { console.warn("[IAT] Leaflet not loaded"); return; }
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
  mapMarker.bindPopup(iatPointLabel(point));
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

/** Find the main-spine point whose axis_mile is nearest to the target. */
function getNearestPointByAxisMile(axisMile) {
  return binaryNearest(pointsByAxisMile, axisMile, p => p.axis_mile);
}

/** Find the East Alt point whose alt_mile is nearest to the target. */
function getNearestEastAltPoint(altMile) {
  return binaryNearest(eastAltPoints, altMile, p => p.alt_mile);
}

/* ============================================================
   15. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key = `iat_forecast:${point.id}`;
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
  const key = `iat_hist:${point.id}:${range.start_date}:${range.end_date}`;
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
   18. WEATHER TOOL RENDERING
   ============================================================ */

function renderPlanningSummary(point, monthDay, range, avgs) {
  const niceDate = formatMonthDayName(monthDay);
  const label    = iatPointLabel(point);

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
  const c     = forecastData.current_weather;
  const block = el("currentBlock");
  if (!c || !block) return;

  block.innerHTML = `
    <h2>Current Conditions</h2>
    <table>
      <tr><th>Location</th><td>${iatPointLabel(point)}</td></tr>
      <tr><th>Temperature</th><td>${fmtTemp(c.temperature)}</td></tr>
      <tr><th>Wind</th><td>${Math.round(c.windspeed)} mph</td></tr>
      <tr><th>Time</th><td>${c.time}</td></tr>
    </table>
  `;
}

function renderForecastTable(forecastData) {
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
   19. WEATHER TOOL SEGMENT INFO (kept in sync with segment select)
   ============================================================ */

function updateSegmentInfo() {
  // The bootstrap in index.html owns segment/region selectors.
  // app.js calls this after iat_meta loads to keep range info current.
  if (typeof iatUpdateSegmentInfo === "function") iatUpdateSegmentInfo();
}

/* ============================================================
   20. WEATHER TOOL RUN
   ============================================================ */

async function runWeather() {
  const segId    = el("segmentSelect")?.value;
  const mileRaw  = el("iatMileInput")?.value;
  const monthDay = getSelectedMonthDay("monthSelect", "daySelect");

  setWeatherStatus("");
  if (!segId)  { setWeatherStatus("Please select a segment."); return; }
  if (mileRaw === "" || mileRaw == null) { setWeatherStatus("Please enter a mile."); return; }
  if (!monthDay) { setWeatherStatus("Please choose a planning date."); return; }

  const segMile = Number(mileRaw);
  if (!isFinite(segMile) || segMile < 0) {
    setWeatherStatus("Please enter a valid mile (0 or greater).");
    return;
  }

  // Find segment to compute axis_mile
  const sections = window.IAT_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => s.id === segId);
  if (!sec) { setWeatherStatus("Segment data not found."); return; }

  const segLen = Math.round((sec.e - sec.s) * 10) / 10;
  if (segMile > segLen) {
    setWeatherStatus(`Please enter a mile between 0 and ${segLen}.`);
    return;
  }

  const axisMile = sec.s + segMile;
  const point    = getNearestPointByAxisMile(axisMile);

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

    const forecastAppLows = forecastData.daily?.apparent_temperature_min || [];
    if (forecastAppLows.some(v => Number.isFinite(v) && v <= 20) ||
        (Number.isFinite(avgs.avgAppLow) && avgs.avgAppLow <= 20)) {
      const s = el("weatherStatus");
      if (s) s.innerHTML = '<p style="color:#003388; font-weight:600; margin:0.5rem 0 0;">&#9888; Cold Advisory: Apparent low temperatures at or below 20&nbsp;&deg;F are indicated for this location and date. Conditions at this level may be hazardous without proper cold-weather gear. Check local NWS forecasts before setting out.</p>';
    }

  } catch (err) {
    console.error("[IAT] runWeather error:", err);
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

  const opts      = iatMeta?.direction_options || [];
  const dirLabel  = opts.find(o => o.id === directionId)?.label || directionId;
  const ag        = iatMeta?.alt_groups?.[0];
  const altId     = getSelectedAlt();
  const altLabel  = ag
    ? (altId === "east" ? ag.east_alt?.label : ag.west_alt?.label) || ""
    : "";

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${dirLabel}</td></tr>
      ${altLabel ? `<tr><th>Route</th><td>${altLabel}</td></tr>` : ""}
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

function getNearestNormals(point) {
  const direct = normalsByPointId.get(point.id);
  if (direct?.hi?.length) return direct;

  // For East Alt points (no axis_mile), find nearest by lat/lon distance
  // to a normals point. For main-spine points, use binary search on axis_mile.
  if (point.alt_id === "east") {
    let bestId = null, bestDist = Infinity;
    for (const { id } of normalsSortedAxis) {
      const np = allPoints.find(p => p.id === id);
      if (!np) continue;
      const dLat = np.lat - point.lat, dLon = np.lon - point.lon;
      const d = dLat * dLat + dLon * dLon;
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
    return bestId ? (normalsByPointId.get(bestId) || null) : null;
  }

  const best = binaryNearest(normalsSortedAxis, point.axis_mile, e => e.axis_mile);
  return best ? (normalsByPointId.get(best.id) || null) : null;
}

/**
 * Build the ordered sequence of points for a hike, one per day.
 *
 * Main spine axis_miles cover the West Alt (Baraboo + roadwalk).
 * East Alt points have alt_mile (0-based from branch) instead of axis_mile.
 *
 * For each day's cumulative mile:
 *   - Pre-branch  → getNearestPointByAxisMile (main spine)
 *   - In alt zone, West Alt → getNearestPointByAxisMile (Baraboo on main spine)
 *   - In alt zone, East Alt → getNearestEastAltPoint (alt_mile lookup)
 *   - Post-rejoin → getNearestPointByAxisMile (main spine)
 */
function buildHikePoints({ directionId, startDate, milesPerDay, totalMiles, selectedAlt }) {
  const durationDays = Math.ceil(totalMiles / milesPerDay);
  const hikePoints   = [];
  const isWTE        = directionId === "west_to_east";
  const spineTotal   = iatMeta?.trail?.total_trail_miles || IAT_TOTAL_MILES;
  const ag           = iatMeta?.alt_groups?.[0];
  const altId        = selectedAlt || "west";

  const branchAxis   = ag?.branch_axis_mile ?? 617.2;
  const rejoinAxis   = ag?.rejoin_axis_mile ?? 640.5;
  const westAltMiles = ag?.west_alt?.total_miles || WEST_ALT_TOTAL_MILES;
  const eastAltMiles = ag?.east_alt?.total_miles || EAST_ALT_TOTAL_MILES;
  const altMiles     = altId === "east" ? eastAltMiles : westAltMiles;

  // Miles from trail start to branch point (WTE: 0→branch; ETW: 0→(total−branch))
  const preBranchMiles = isWTE ? branchAxis : (spineTotal - branchAxis);

  function getPoint(cumMile) {
    const capped = Math.min(cumMile, totalMiles);

    if (capped <= preBranchMiles) {
      // Pre-branch: direct spine lookup
      const axis = isWTE ? capped : (spineTotal - capped);
      return getNearestPointByAxisMile(axis);

    } else if (capped <= preBranchMiles + altMiles) {
      // In the alt zone
      const altProgress = capped - preBranchMiles;  // miles from branch

      if (altId === "east") {
        // East Alt: look up by alt_mile
        return getNearestEastAltPoint(altProgress);
      } else {
        // West Alt: Baraboo is on the main spine; map proportionally onto
        // the branch→rejoin axis_mile range
        const spineAltLen = rejoinAxis - branchAxis;
        const t           = spineAltLen > 0 ? altProgress / westAltMiles : 0;
        const axis        = isWTE
          ? branchAxis + t * spineAltLen
          : rejoinAxis - t * spineAltLen;
        return getNearestPointByAxisMile(axis);
      }

    } else {
      // Post-rejoin: back on main spine
      const postMiles = capped - preBranchMiles - altMiles;
      const axis = isWTE
        ? Math.min(rejoinAxis + postMiles, spineTotal)
        : Math.max(branchAxis - postMiles, 0);
      return getNearestPointByAxisMile(axis);
    }
  }

  for (let i = 0; i < durationDays; i++) {
    const date  = addDays(startDate, i);
    const point = getPoint(milesPerDay * i);
    if (point) hikePoints.push({ date, point });
  }

  return hikePoints;
}

// Expose alt segment miles constants (miles within the alt zone only, not full trail)
const WEST_ALT_TOTAL_MILES = 83.7;
const EAST_ALT_TOTAL_MILES = 71.0;

function computeExtremesFromHikePoints(hikePoints) {
  if (!hikePoints.length) return { hottest: null, coldest: null };

  let hottest = null, coldest = null;

  for (const { date, point } of hikePoints) {
    const normals = getNearestNormals(point);
    if (!normals?.hi?.length) continue;

    const monthDay    = toISODate(date).slice(5);
    const idx         = dayIndexFromMonthDay(monthDay);
    const avgHigh     = normals.hi[idx];
    const avgLow      = normals.lo[idx];
    const avgAppHigh  = normals.app_hi[idx];
    const avgAppLow   = normals.app_lo[idx];
    const avgRhHigh   = normals.rh_hi?.[idx];
    const avgRhLow    = normals.rh_lo?.[idx];

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

function renderDurExtremesBlocks(hottest, coldest, opts = {}) {
  renderDurExtremesBlocksShared(hottest, coldest, {
    formatLocation: (rec) => iatPointLabel(rec.point),
    ...opts
  });
}

function renderDurExtremesMap(hottest, coldest) {
  const mapEl = el("durExtremesMap");
  if (!mapEl || typeof L === "undefined") return;

  if (!durMap) {
    durMap = L.map("durExtremesMap", { zoomControl: true })
               .setView([44.5, -90.0], 7);
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

  const bounds = boundsFromPoints([hottest.point, coldest.point]);
  if (bounds) durMap.fitBounds(bounds, { padding: [30, 30] });
  else durMap.setView([44.5, -90.0], 7);
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

  const hikePoints = buildHikePoints({ ...params, selectedAlt: params.selectedAlt || getSelectedAlt() });
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

  const directionId  = el("durDirectionSelect")?.value || "west_to_east";
  const selectedAlt  = getSelectedAlt();
  const monthDay     = getSelectedMonthDay("durMonthSelect", "durDaySelect");
  const mpd          = numVal("durMilesPerDay");

  if (!monthDay) { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles   = calcTotalMiles(directionId, selectedAlt);
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
      directionId, startDate, milesPerDay: mpd, totalMiles, durationDays, selectedAlt
    }).catch(err => {
      console.error("[IAT] extremes error:", err);
      setDurStatus(`Error computing extremes: ${err.message}`);
    });
  } else {
    setDurStatus("Temperature extremes will appear once trail data finishes loading.");
  }
}

/* ============================================================
   23. UI INITIALIZATION
   ============================================================ */

function runBestStart() {
  setDurStatus("");
  if (el("bestStartResult")) el("bestStartResult").innerHTML = "";
  if (el("durResult")) el("durResult").innerHTML = "";
  setDisplayIfExists("durExtremesWrap", "none");

  const directionId  = el("durDirectionSelect")?.value || "west_to_east";
  const selectedAlt  = getSelectedAlt();
  const mpd          = numVal("durMilesPerDay");

  if (mpd == null || mpd <= 0) { setDurStatus("Please enter Miles per Day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }
  if (!normalsByPointId.size) { setDurStatus("Historical weather data is still loading. Please try again."); return; }
  if (!allPoints.length) { setDurStatus("Trail data is still loading. Please try again."); return; }

  const totalMiles   = calcTotalMiles(directionId, selectedAlt);
  const durationDays = Math.ceil(totalMiles / mpd);
  if (durationDays > 365) { setDurStatus("For this planner, hikes cannot exceed one year. Please adjust Miles per Day."); return; }

  const { bestStartDate } = runBestStartShared({
    durationDays,
    getHikePoints: (startDate) => buildHikePoints({ directionId, startDate, milesPerDay: mpd, totalMiles, selectedAlt }),
    getNormals: (point) => getNearestNormals(point),
  });

  if (!bestStartDate) {
    setHtmlIfExists("bestStartResult",
      `<p style="color:#b00000; font-weight:600; margin-top:0.75rem;">No valid start date found \u2014 every possible start date includes at least one day of extreme heat or cold stress. Try adjusting miles per day.</p>`);
    return;
  }

  computeAndRenderDurationExtremes({
    directionId, startDate: bestStartDate, milesPerDay: mpd, totalMiles, durationDays, selectedAlt,
    startDateLabel: "<em>BestStart!</em> Date"
  }).catch(err => { console.error(err); setDurStatus(`Error: ${err.message}`); });
}

function initDurationUI() {
  initMonthDayPickerGeneric("durMonthSelect", "durDaySelect");
  el("durBtn")?.addEventListener("click", runDurationCalculator);
  el("bestStartBtn")?.addEventListener("click", runBestStart);
  const mpdEl = el("durMilesPerDay");
  if (mpdEl && mpdEl.value === "") mpdEl.value = "15";
}

function initWeatherUI() {
  el("goBtn")?.addEventListener("click", runWeather);
  initMonthDayPickerGeneric("monthSelect", "daySelect");
  // Segment info already initialized by the bootstrap inline script.
  // Attach additional listener so typing in the mile input keeps info live.
  el("segmentSelect")?.addEventListener("change", updateSegmentInfo);
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

  // Load iat_meta.json (non-blocking)
  loadIatMeta()
    .then(() => updateSegmentInfo())
    .catch(e => console.warn("[IAT] iat_meta not loaded:", e));

  // Load points
  try {
    await loadPoints();

    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[IAT] loadPoints failed:", err);
  }

  // Load precomputed normals (best-effort)
  try {
    await loadPrecomputedNormals();
  } catch (e) {
    console.warn("[IAT] normals not loaded:", e);
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
