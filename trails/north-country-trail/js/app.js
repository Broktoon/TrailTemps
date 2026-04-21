/* North Country Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - 2 direction options (WEBO / EABO)
           - Single continuous spine; roadwalk included in mileage
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json, 5-mile intervals)
           - Heat index advisory when apparent high >= 100 F
           - Wind chill advisory when apparent low <= 20 F
   Tool B: Weather planner
           - State selector (8 states) + state-relative mile input
           - Open-Meteo forecast (5-day) + current conditions
           - 7-year planning average high/low
           - Apparent temperature (Steadman: heat index + wind chill)
   Maps: Leaflet + OSM tiles + trail.geojson overlay
         Roadwalk segments rendered as dashed lines (segment_type: "roadwalk")
   Units: Fahrenheit, mph, %
   Caching: localStorage (TTL-based); historical_weather.json is ~55-60 MB
            and relies on HTTP cache only (too large for localStorage)
   ---------------------------------------------------------------*/

/* ============================================================
   1. TRAIL IDENTITY & URL RESOLUTION
   ============================================================ */

function getTrailMeta() {
  const slug =
    window.TRAIL_SLUG ||
    document.body?.dataset?.trail ||
    "north-country-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:       new URL("points.json",            dataDir).href,
    trailGeojsonUrl: new URL("trail.geojson",          dataDir).href,
    normalsUrl:      new URL("historical_weather.json", dataDir).href,
    nctMetaUrl:      new URL("nct_meta.json",           dataDir).href,
    defaultMapCenter: [44.5, -85.0],
    defaultZoom:      5,
  };
}

const META      = getTrailMeta();
const trailSlug = META.slug;

console.log("[NCT] slug =", trailSlug);

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

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

let allPoints       = [];
let pointsSorted    = [];  // [Point] sorted by mile

// NCT meta (loaded from nct_meta.json)
let nctMeta = null;

// Precomputed normals
let normalsByPointId = new Map(); // point.id → { hi, lo, app_hi, app_lo, rh_hi, rh_lo, ws }
let normalsByMile    = [];        // [{ id, mile }] sorted — nearest-neighbour fallback

// Leaflet — Weather map
let map       = null;
let mapMarker = null;

// Leaflet — Extremes map
let durMap           = null;
let durMapLayerGroup = null;

const SELECT_ZOOM = 10;

/* ============================================================
   5. UTILITY FUNCTIONS
   ============================================================ */

function refreshMapSize() {
  if (map) setTimeout(() => { try { map.invalidateSize(); } catch {} }, 0);
}

/* ============================================================
   6. POINT LABEL HELPER
   ============================================================ */

function nctPointLabel(point) {
  return `Mile ${fmtMile(point.mile)} (${point.state})`;
}

/* ============================================================
   7. MILEAGE CALCULATION
   ============================================================ */

function calcTotalMiles(directionId) {
  const opts = nctMeta?.direction_options || [];
  const opt  = opts.find(o => o.id === directionId);
  if (opt) return opt.total_miles;
  // Fallback: use the largest axis_end from sections
  const sections = nctMeta?.sections || window.NCT_STATES_BOOTSTRAP || [];
  if (sections.length) return sections[sections.length - 1].axis_end;
  return 4400;
}

/* ============================================================
   8. DATA LOADING
   ============================================================ */

async function loadNctMeta() {
  const key    = `nct_meta_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload  = cached;
  if (!payload) {
    const r = await fetch(META.nctMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`nct_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  nctMeta = payload;
  console.log("[NCT] nct_meta loaded:", nctMeta.sections?.length, "sections");
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

  pointsSorted = allPoints
    .filter(p => isFinite(p.mile))
    .sort((a, b) => a.mile - b.mile);

  console.log("[NCT] points loaded:", allPoints.length);
}

async function loadPrecomputedNormals() {
  // historical_weather.json is ~55-60 MB — too large for localStorage.
  // We rely entirely on the browser's HTTP cache for repeat visits.
  const r = await fetch(META.normalsUrl);
  if (!r.ok) throw new Error(`historical_weather.json fetch failed (${r.status})`);
  const payload = await r.json();

  normalsByPointId = new Map();
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

  // Build nearest-neighbour mile index for fallback lookups
  normalsByMile = pointsSorted
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, mile: p.mile }));

  console.log("[NCT] normals loaded:", normalsByPointId.size, "points");
  setDurStatus("");
}

/* ============================================================
   9. TRAIL GEOJSON OVERLAY
   ============================================================ */

async function fetchTrailGeojson() {
  const key    = `trail_geojson_${trailSlug}_v1`;
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

const TRAIL_STYLE = {
  color: "#e06060", weight: 3.25, opacity: 0.85, lineCap: "round", lineJoin: "round"
};
const ROADWALK_STYLE = {
  color: "#e06060", weight: 2.25, opacity: 0.55, dashArray: "4, 9", lineCap: "round"
};

function applyTrailOverlay(targetMap, haloRef, layerRef, onDone) {
  fetchTrailGeojson()
    .then(geojson => {
      if (haloRef.current)  { try { targetMap.removeLayer(haloRef.current);  } catch {} }
      if (layerRef.current) { try { targetMap.removeLayer(layerRef.current); } catch {} }

      layerRef.current = L.geoJSON(geojson, {
        style: function (feature) {
          return feature.properties?.segment_type === "roadwalk"
            ? ROADWALK_STYLE
            : TRAIL_STYLE;
        },
        interactive: false,
      }).addTo(targetMap);

      if (layerRef.current.bringToBack) layerRef.current.bringToBack();
      if (onDone) onDone();
    })
    .catch(e => console.warn("[NCT] trail overlay failed:", e));
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
   10. WEATHER MAP (Tool B)
   ============================================================ */

function initMap() {
  if (typeof L === "undefined") { console.warn("[NCT] Leaflet not loaded"); return; }
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
  mapMarker.bindPopup(nctPointLabel(point));
  map.setView(ll, SELECT_ZOOM);
  if (mapMarker.bringToFront) mapMarker.bringToFront();
  refreshMapSize();
}

/* ============================================================
   11. POINT LOOKUP HELPERS
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
   12. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key    = `nct_forecast:${point.id}`;
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
  const key    = `nct_hist:${point.id}:${range.start_date}:${range.end_date}`;
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
   13. PLANNING AVERAGE COMPUTATION
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
   14. WEATHER TOOL RENDERING
   ============================================================ */

function renderPlanningSummary(point, monthDay, range, avgs) {
  const niceDate = formatMonthDayName(monthDay);
  const label    = nctPointLabel(point);

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
      <tr><th>Location</th><td>${nctPointLabel(point)}</td></tr>
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
        <td>${wind   != null ? Math.round(wind)   + " mph" : "\u2014"}</td>
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
   15. WEATHER TOOL STATE INFO
   ============================================================ */

function updateStateInfo() {
  const stateId   = el("nctStateSelect")?.value;
  const infoEl    = el("nctStateInfo");
  const mileInput = el("nctMileInput");
  if (!stateId || !infoEl) return;

  const sections = nctMeta?.sections || window.NCT_STATES_BOOTSTRAP || [];
  const sec = sections.find(s => s.state === stateId);
  if (!sec) return;

  const maxMile = Math.round(sec.axis_end - sec.axis_start);
  infoEl.textContent = `State Range: 0\u2013${maxMile} Miles`;

  if (mileInput) {
    mileInput.placeholder = `e.g., ${Math.round(maxMile / 2)}`;
    const cur = Number(mileInput.value);
    if (cur < 0 || cur > maxMile) mileInput.value = "";
  }
}

/* ============================================================
   16. WEATHER TOOL RUN
   ============================================================ */

async function runWeather() {
  const stateId  = el("nctStateSelect")?.value;
  const mileRaw  = el("nctMileInput")?.value;
  const monthDay = getSelectedMonthDay("monthSelect", "daySelect");

  setWeatherStatus("");
  if (!stateId)                         { setWeatherStatus("Please select a state."); return; }
  if (mileRaw === "" || mileRaw == null) { setWeatherStatus("Please enter a trail mile."); return; }
  if (!monthDay)                         { setWeatherStatus("Please choose a planning date."); return; }

  const stateMile = Number(mileRaw);
  if (!isFinite(stateMile) || stateMile < 0) {
    setWeatherStatus("Please enter a valid mile number.");
    return;
  }

  const sections = nctMeta?.sections || window.NCT_STATES_BOOTSTRAP || [];
  const sec = sections.find(s => s.state === stateId);
  if (sec) {
    const maxMile = sec.axis_end - sec.axis_start;
    if (stateMile > maxMile) {
      setWeatherStatus(`Please enter a mile between 0 and ${Math.round(maxMile)} for ${sec.name}.`);
      return;
    }
  }

  const spineMile = sec ? sec.axis_start + stateMile : stateMile;
  const point     = getNearestPoint(spineMile);
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
    console.error("[NCT] runWeather error:", err);
    setHtmlIfExists("currentBlock", `<p style="color:#900">Weather data unavailable: ${err.message}</p>`);
  } finally {
    refreshMapSize();
  }
}

/* ============================================================
   17. NORMALS LOOKUP
   ============================================================ */

function getNearestNormals(point) {
  const direct = normalsByPointId.get(point.id);
  if (direct?.hi?.length) return direct;

  if (!normalsByMile.length) return null;
  const best = binaryNearest(normalsByMile, point.mile, e => e.mile);
  return best ? (normalsByPointId.get(best.id) || null) : null;
}

/* ============================================================
   18. HIKE POINTS (for duration extremes and BestStart!)
   ============================================================ */

/**
 * Build the ordered sequence of {date, point} pairs for a hike.
 * WEBO: mile 0 (VT/NY eastern terminus) → last mile (ND), going west
 * EABO: last mile (ND) → mile 0 (VT/NY), going east
 */
function buildHikePoints({ directionId, startDate, milesPerDay, totalMiles }) {
  const durationDays = Math.ceil(totalMiles / milesPerDay);
  const hikePoints   = [];
  const isWebo       = directionId === "webo";

  for (let i = 0; i < durationDays; i++) {
    const date    = addDays(startDate, i);
    const cumMile = milesPerDay * i;
    const trailMile = isWebo
      ? Math.min(cumMile, totalMiles)
      : Math.max(totalMiles - cumMile, 0);

    const point = getNearestPoint(trailMile);
    if (point) hikePoints.push({ date, point });
  }

  return hikePoints;
}

/* ============================================================
   19. DURATION EXTREMES (Tool A+)
   ============================================================ */

function renderDurExtremesBlocks(hottest, coldest, opts = {}) {
  renderDurExtremesBlocksShared(hottest, coldest, {
    formatLocation: (rec) => nctPointLabel(rec.point),
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
  const { startDateLabel, extraNote } = params;
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

  const utciCounts = computeUtciCounts(hikePoints, getNearestNormals);
  const endDate    = addDays(params.startDate, params.durationDays - 1);

  const warningHtml = extraNote || "";

  setDisplayIfExists("durExtremesWrap", "block");
  renderDurExtremesBlocks(null, null, {
    startDate: params.startDate,
    endDate,
    distanceMiles: params.totalMiles,
    durationDays: params.durationDays,
    startDateLabel,
    utciCounts,
    warningHtml,
  });

  // Now compute actual hottest/coldest for the extremes tables
  let hottest = null, coldest = null;
  for (const { date, point } of hikePoints) {
    const normals = getNearestNormals(point);
    if (!normals?.hi?.length) continue;
    const monthDay   = toISODate(date).slice(5);
    const idx        = dayIndexFromMonthDay(monthDay);
    const avgHigh    = normals.hi[idx];
    const avgLow     = normals.lo[idx];
    const avgAppHigh = normals.app_hi[idx];
    const avgAppLow  = normals.app_lo[idx];
    const avgRhHigh  = normals.rh_hi?.[idx];
    const avgRhLow   = normals.rh_lo?.[idx];
    if (!isFinite(avgHigh) || !isFinite(avgLow)) continue;
    const heatVal = isFinite(avgAppHigh) ? avgAppHigh : avgHigh;
    const coldVal = isFinite(avgAppLow)  ? avgAppLow  : avgLow;
    if (!hottest || heatVal > (isFinite(hottest.appHigh) ? hottest.appHigh : hottest.avgHigh)) {
      hottest = { date, point, avgHigh, avgLow, appHigh: avgAppHigh, appLow: avgAppLow, rhHigh: avgRhHigh, rhLow: avgRhLow };
    }
    if (!coldest || coldVal < (isFinite(coldest.appLow) ? coldest.appLow : coldest.avgLow)) {
      coldest = { date, point, avgHigh, avgLow, appHigh: avgAppHigh, appLow: avgAppLow, rhHigh: avgRhHigh, rhLow: avgRhLow };
    }
  }

  renderDurExtremesBlocks(hottest, coldest, {
    startDate: params.startDate,
    endDate,
    distanceMiles: params.totalMiles,
    durationDays: params.durationDays,
    startDateLabel,
    utciCounts,
    warningHtml,
  });
  renderDurExtremesMap(hottest, coldest);
}

/* ============================================================
   20. DURATION CALCULATOR (Tool A)
   ============================================================ */

function renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay, durationDays }) {
  const startStr = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr   = endDate.toLocaleDateString(undefined,   { year: "numeric", month: "long", day: "numeric" });

  const opts     = nctMeta?.direction_options || [];
  const dirLabel = opts.find(o => o.id === directionId)?.label || directionId;

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

function runDurationCalculator() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const directionId  = el("durDirectionSelect")?.value || "webo";
  const monthDay     = getSelectedMonthDay("durMonthSelect", "durDaySelect");
  const mpd          = numVal("durMilesPerDay");

  if (!monthDay)               { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5)                 { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles   = calcTotalMiles(directionId);
  const durationDays = Math.ceil(totalMiles / mpd);

  if (durationDays > 730) {
    setDurStatus("Estimated duration exceeds two years. Please increase miles per day.");
    return;
  }

  const startDate = resolveStartDate(monthDay);
  const endDate   = addDays(startDate, durationDays - 1);

  renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay: mpd, durationDays });

  if (normalsByPointId.size > 0 && allPoints.length > 0) {
    computeAndRenderDurationExtremes({
      directionId, startDate, milesPerDay: mpd, totalMiles, durationDays
    }).catch(err => {
      console.error("[NCT] extremes error:", err);
      setDurStatus(`Error computing extremes: ${err.message}`);
    });
  } else {
    setDurStatus("Temperature extremes will appear once trail data finishes loading.");
  }
}

/* ============================================================
   21. BEST START
   ============================================================ */

function runBestStart() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setHtmlIfExists("bestStartResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const mpd = numVal("durMilesPerDay");
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const directionId  = el("durDirectionSelect")?.value || "webo";
  const totalMiles   = calcTotalMiles(directionId);
  const durationDays = Math.ceil(totalMiles / mpd);

  if (durationDays > 730) {
    setDurStatus("Estimated duration exceeds two years. Please increase miles per day.");
    return;
  }

  if (!normalsByPointId.size || !allPoints.length) {
    setDurStatus("Historical data not yet loaded \u2014 please wait and try again.");
    return;
  }

  setHtmlIfExists("bestStartResult", "<p style='color:#555;font-style:italic;'>Scanning all start dates\u2026</p>");

  setTimeout(() => {
    const { bestStartDate, bestCounts } = runBestStartShared({
      durationDays,
      getHikePoints: (startDate) => buildHikePoints({ directionId, startDate, milesPerDay: mpd, totalMiles }),
      getNormals: getNearestNormals,
    });

    if (!bestStartDate) {
      setHtmlIfExists("bestStartResult", "<p style='color:#b00000;'>No suitable start date found.</p>");
      return;
    }

    const bestStartNote = durationDays > 365
      ? `<p class="note" style="color:#555;">Note: this hike spans more than one year, so the <em>BestStart!</em> date has less influence on overall temperature outcomes than on shorter trails. All start dates cover most seasonal conditions; the recommended date reflects the best available margin.</p>`
      : "";

    computeAndRenderDurationExtremes({
      directionId,
      startDate: bestStartDate,
      milesPerDay: mpd,
      totalMiles,
      durationDays,
      startDateLabel: "<em>BestStart!</em> Date",
      extraNote: bestStartNote,
    }).catch(err => {
      console.error("[NCT] BestStart extremes error:", err);
      setDurStatus(`Error computing extremes: ${err.message}`);
    });
  }, 0);
}

/* ============================================================
   22. UI INITIALIZATION
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
  el("nctStateSelect")?.addEventListener("change", updateStateInfo);
  initMonthDayPickerGeneric("monthSelect", "daySelect");
  updateStateInfo();
}

/* ============================================================
   23. MAIN
   ============================================================ */

async function main() {
  initDurationUI();
  initWeatherUI();

  initMap();
  loadTrailOverlay();

  // Load meta (non-blocking — updates state info when ready)
  loadNctMeta()
    .then(() => updateStateInfo())
    .catch(e => console.warn("[NCT] nct_meta not loaded:", e));

  // Load trail points
  try {
    await loadPoints();
    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[NCT] loadPoints failed:", err);
  }

  // Load precomputed normals (large file — rely on HTTP cache)
  setDurStatus("Loading historical weather data (large file, may take a moment)\u2026");
  try {
    await loadPrecomputedNormals();
    // setDurStatus("") is called inside loadPrecomputedNormals on success
  } catch (e) {
    console.warn("[NCT] normals not loaded:", e);
    setDurStatus("Historical weather data not yet available \u2014 run generate-normals-nct.js to enable temperature extremes.");
  }

  setTimeout(refreshMapSize, 250);
}

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => main().catch(console.error));
} else {
  main().catch(console.error);
}
