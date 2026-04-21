/* Continental Divide Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - 4 direction options (nobo/sobo × Waterton/Chief Mountain)
           - 4 alternate route groups (Gila, RMNP, Anaconda, Spotted Bear)
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json, 5-mile intervals)
           - Elevation correction (trail_elev vs grid_elev, same logic as AZT/PCT)
           - Heat advisory >= 100 F, cold advisory <= 20 F
   Tool B: Weather planner
           - State selector (NM, CO, WY, MT) + state-relative mile input
           - Open-Meteo forecast (5-day) + current conditions
           - 7-year planning average high/low
   Maps: Leaflet + OSM tiles + trail.geojson overlay
   Units: Fahrenheit, mph, %
   Caching: localStorage (TTL-based); historical_weather.json (~40-50 MB)
            relies on HTTP cache only (too large for localStorage)
   ---------------------------------------------------------------*/

/* ============================================================
   1. TRAIL IDENTITY & URL RESOLUTION
   ============================================================ */

function getTrailMeta() {
  const slug =
    window.TRAIL_SLUG ||
    document.body?.dataset?.trail ||
    "continental-divide-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:       new URL("points.json",            dataDir).href,
    trailGeojsonUrl: new URL("trail.geojson",          dataDir).href,
    normalsUrl:      new URL("historical_weather.json", dataDir).href,
    cdtMetaUrl:      new URL("cdt_meta.json",           dataDir).href,
    defaultMapCenter: [38.5, -107.5],
    defaultZoom:      5,
  };
}

const META      = getTrailMeta();
const trailSlug = META.slug;

console.log("[CDT] slug =", trailSlug);

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

const ELEV_THRESHOLD_FT     = 300;

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

let allPoints    = [];
let pointsSorted = [];  // spine points sorted by mile

let altPointsByAltId = new Map();  // alt_id → [{...point}] sorted by alt_mile

let cdtMeta = null;

let normalsByPointId  = new Map();  // id → { hi, lo, app_hi, app_lo, rh_hi, rh_lo, ws, grid_elev }
let normalsByMile     = [];         // [{id, mile, grid_elev}] spine, sorted
let normalsAltByMile  = new Map();  // alt_id → [{id, alt_mile, grid_elev}] sorted

let map           = null;
let mapMarker     = null;
let durMap        = null;
let durMapLayerGroup = null;

const SELECT_ZOOM = 10;

/* ============================================================
   5. UTILITY
   ============================================================ */

function refreshMapSize() {
  if (map) setTimeout(() => { try { map.invalidateSize(); } catch {} }, 0);
}

function cdtPointLabel(point) {
  if (point.alt_id) {
    return `${point.alt_id} Alt Mile ${fmtMile(point.alt_mile)}`;
  }
  return `Mile ${fmtMile(point.mile)} (${point.state})`;
}

/* ============================================================
   6. ELEVATION CORRECTION
   ============================================================ */

function applyElevationCorrection(normals, trailElevFt, gridElevFt) {
  if (!Number.isFinite(trailElevFt) || !Number.isFinite(gridElevFt)) return normals;
  const diff = trailElevFt - gridElevFt;
  if (Math.abs(diff) <= ELEV_THRESHOLD_FT) return normals;

  const diffK     = diff / 1000;
  const corrected = { ...normals };

  if (diff > ELEV_THRESHOLD_FT) {
    corrected.app_hi = normals.app_hi.map(v => Number.isFinite(v) ? Math.round((v + diffK * -3.5) * 10) / 10 : v);
    corrected.app_lo = normals.app_lo.map(v => Number.isFinite(v) ? Math.round((v + diffK * -2.0) * 10) / 10 : v);
  } else {
    corrected.app_hi = normals.app_hi.map(v => Number.isFinite(v) ? Math.round((v + diffK * -3.5) * 10) / 10 : v);
  }

  return corrected;
}

/* ============================================================
   7. ALTERNATE SELECTION
   ============================================================ */

function getSelectedAlts() {
  return {
    gila:           document.querySelector('input[name="alt-gila"]:checked')?.value          ?? "main",
    rmnp:           document.querySelector('input[name="alt-rmnp"]:checked')?.value          ?? "main",
    anaconda:       document.querySelector('input[name="alt-anaconda"]:checked')?.value      ?? "main",
    "spotted-bear": document.querySelector('input[name="alt-spotted-bear"]:checked')?.value ?? "main",
  };
}

function calcTotalMiles(directionId, selectedAlts) {
  const opts = cdtMeta?.direction_options || [];
  const opt  = opts.find(o => o.id === directionId);
  let miles  = opt?.total_miles ?? 3100;

  for (const ag of (cdtMeta?.alt_groups || [])) {
    const defaultSel = ag.default_id ?? "main";
    const sel        = selectedAlts?.[ag.id] ?? defaultSel;
    if (sel !== defaultSel) miles += (ag.delta_miles ?? 0);
  }
  return miles;
}

/* ============================================================
   8. DATA LOADING
   ============================================================ */

async function loadCdtMeta() {
  const key    = `cdt_meta_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload  = cached;
  if (!payload) {
    const r = await fetch(META.cdtMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`cdt_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  cdtMeta = payload;
  console.log("[CDT] cdt_meta loaded:", cdtMeta.alt_groups?.length, "alt groups");
}

async function loadPoints() {
  const r = await fetch(META.pointsUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`points.json fetch failed (${r.status})`);
  const data = await r.json();

  allPoints = data.filter(p =>
    Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))
  ).map(p => ({
    ...p,
    lat:       Number(p.lat),
    lon:       Number(p.lon),
    id:        String(p.id),
    mile:      p.mile       != null ? Number(p.mile)      : undefined,
    alt_mile:  p.alt_mile   != null ? Number(p.alt_mile)  : undefined,
    trail_elev: p.trail_elev != null ? Number(p.trail_elev) : undefined,
  }));

  // Spine points sorted by mile
  pointsSorted = allPoints
    .filter(p => Number.isFinite(p.mile) && !p.alt_id)
    .sort((a, b) => a.mile - b.mile);

  // Alt points indexed by alt_id
  altPointsByAltId = new Map();
  for (const p of allPoints) {
    if (!p.alt_id || !Number.isFinite(p.alt_mile)) continue;
    if (!altPointsByAltId.has(p.alt_id)) altPointsByAltId.set(p.alt_id, []);
    altPointsByAltId.get(p.alt_id).push(p);
  }
  for (const [, arr] of altPointsByAltId) arr.sort((a, b) => a.alt_mile - b.alt_mile);

  console.log("[CDT] points loaded:", allPoints.length,
    "(spine:", pointsSorted.length,
    "alt:", allPoints.length - pointsSorted.length, ")");
}

async function loadPrecomputedNormals() {
  const r = await fetch(META.normalsUrl);
  if (!r.ok) throw new Error(`historical_weather.json fetch failed (${r.status})`);
  const payload = await r.json();

  normalsByPointId = new Map();
  for (const p of (payload.points || [])) {
    if (!p?.id) continue;
    normalsByPointId.set(String(p.id), {
      hi:        p.hi     || [],
      lo:        p.lo     || [],
      app_hi:    p.hi_app || p.hi || [],
      app_lo:    p.lo_app || p.lo || [],
      rh_hi:     p.rh_hi  || [],
      rh_lo:     p.rh_lo  || [],
      ws:        p.ws     || [],
      grid_elev: p.grid_elev != null ? Number(p.grid_elev) : null,
    });
  }

  // Spine normals index (by mile)
  normalsByMile = pointsSorted
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, mile: p.mile, grid_elev: normalsByPointId.get(p.id).grid_elev }));

  // Alt normals index (by alt_id + alt_mile)
  normalsAltByMile = new Map();
  for (const p of (payload.points || [])) {
    if (!p?.alt_id || !p.id) continue;
    if (!normalsAltByMile.has(p.alt_id)) normalsAltByMile.set(p.alt_id, []);
    normalsAltByMile.get(p.alt_id).push({
      id:       p.id,
      alt_mile: Number(p.alt_mile),
      grid_elev: p.grid_elev != null ? Number(p.grid_elev) : null,
    });
  }
  for (const [, arr] of normalsAltByMile) arr.sort((a, b) => a.alt_mile - b.alt_mile);

  console.log("[CDT] normals loaded:", normalsByPointId.size, "points");
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
const ALT_STYLE = {
  color: "#e06060", weight: 2.0, opacity: 0.55, dashArray: "5, 8", lineCap: "round"
};

function applyTrailOverlay(targetMap, haloRef, layerRef, onDone) {
  fetchTrailGeojson()
    .then(geojson => {
      if (haloRef.current)  { try { targetMap.removeLayer(haloRef.current);  } catch {} }
      if (layerRef.current) { try { targetMap.removeLayer(layerRef.current); } catch {} }

      layerRef.current = L.geoJSON(geojson, {
        style: feature =>
          feature.properties?.segment_type === "alternate" ? ALT_STYLE : TRAIL_STYLE,
        interactive: false,
      }).addTo(targetMap);

      if (layerRef.current.bringToBack) layerRef.current.bringToBack();
      if (onDone) onDone();
    })
    .catch(e => console.warn("[CDT] trail overlay failed:", e));
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
  if (typeof L === "undefined") { console.warn("[CDT] Leaflet not loaded"); return; }
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
  if (!map) { initMap(); loadTrailOverlay(); }
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
  mapMarker.bindPopup(cdtPointLabel(point));
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

function getNearestAltPoint(altId, altMile) {
  const arr = altPointsByAltId.get(altId) || [];
  if (!arr.length) return null;
  return binaryNearest(arr, altMile, p => p.alt_mile);
}

/* ============================================================
   12. NORMALS LOOKUP (with elevation correction)
   ============================================================ */

function getNearestNormals(point) {
  let entry    = null;
  let gridElev = null;

  if (point.alt_id) {
    const direct = normalsByPointId.get(point.id);
    if (direct?.hi?.length) {
      entry    = direct;
      gridElev = direct.grid_elev;
    } else {
      const arr     = normalsAltByMile.get(point.alt_id) || [];
      const nearest = binaryNearest(arr, point.alt_mile ?? 0, e => e.alt_mile);
      if (nearest) {
        entry    = normalsByPointId.get(nearest.id) || null;
        gridElev = nearest.grid_elev;
      }
    }
  } else {
    const direct = normalsByPointId.get(point.id);
    if (direct?.hi?.length) {
      entry    = direct;
      gridElev = direct.grid_elev;
    } else {
      const nearest = binaryNearest(normalsByMile, point.mile ?? 0, e => e.mile);
      if (nearest) {
        entry    = normalsByPointId.get(nearest.id) || null;
        gridElev = nearest.grid_elev;
      }
    }
  }

  if (!entry) return null;
  return applyElevationCorrection(entry, point.trail_elev, gridElev);
}

/* ============================================================
   13. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key    = `cdt_forecast:${point.id}`;
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
  const key    = `cdt_hist:${point.id}:${range.start_date}:${range.end_date}`;
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
  const idx     = indexHistoricalByMonthDay(histDaily, fields);
  const keys    = mdWindowKeys(monthDay, windowDays);
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
  const label    = cdtPointLabel(point);

  el("planningSummaryBlock").innerHTML = `
    <h2>Planning: 7-year Average</h2>
    <table>
      <tr><th>Date / Location</th><td colspan="3">${niceDate} &mdash; ${label}</td></tr>
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
      <tr><th>Location</th><td>${cdtPointLabel(point)}</td></tr>
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
        <th>Date</th><th>High (actual)</th><th>Low (actual)</th>
        <th>Humidity (hi/lo)</th><th>Precip</th><th>Wind</th>
      </tr>
      ${rows}
    </table>
    <p class="note">
      "Feels hotter/cooler" note appears when apparent temperature differs from actual
      by 3 &deg;F or more. Wind chill is reflected in the apparent low when temperatures
      are cold and winds are significant.
    </p>
  `;
  refreshMapSize();
}

/* ============================================================
   16. WEATHER TOOL STATE INFO
   ============================================================ */

function updateStateInfo() {
  const stateId   = el("cdtStateSelect")?.value;
  const infoEl    = el("cdtStateInfo");
  const mileInput = el("cdtMileInput");
  if (!stateId || !infoEl) return;

  const sections = cdtMeta?.sections || window.CDT_STATES_BOOTSTRAP || [];
  const sec = sections.find(s => s.state === stateId || s.id === stateId);
  if (!sec) return;

  const maxMile = Math.round((sec.axis_end ?? sec.e) - (sec.axis_start ?? sec.s));
  infoEl.textContent = `State Range: 0\u2013${maxMile} Miles`;

  if (mileInput) {
    mileInput.placeholder = `e.g., ${Math.round(maxMile / 2)}`;
    const cur = Number(mileInput.value);
    if (cur < 0 || cur > maxMile) mileInput.value = "";
  }
}

/* ============================================================
   17. WEATHER TOOL RUN
   ============================================================ */

async function runWeather() {
  const stateId  = el("cdtStateSelect")?.value;
  const mileRaw  = el("cdtMileInput")?.value;
  const monthDay = getSelectedMonthDay("monthSelect", "daySelect");

  setWeatherStatus("");
  if (!stateId)                         { setWeatherStatus("Please select a state."); return; }
  if (mileRaw === "" || mileRaw == null) { setWeatherStatus("Please enter a trail mile."); return; }
  if (!monthDay)                         { setWeatherStatus("Please choose a planning date."); return; }

  const stateMile = Number(mileRaw);
  if (!Number.isFinite(stateMile) || stateMile < 0) {
    setWeatherStatus("Please enter a valid mile number.");
    return;
  }

  const sections = cdtMeta?.sections || window.CDT_STATES_BOOTSTRAP || [];
  const sec = sections.find(s => s.state === stateId || s.id === stateId);
  if (sec) {
    const maxMile = (sec.axis_end ?? sec.e) - (sec.axis_start ?? sec.s);
    if (stateMile > maxMile) {
      setWeatherStatus(`Please enter a mile between 0 and ${Math.round(maxMile)} for ${sec.name}.`);
      return;
    }
  }

  const axisStart = sec ? (sec.axis_start ?? sec.s ?? 0) : 0;
  const spineMile = axisStart + stateMile;
  const point     = getNearestPoint(spineMile);
  if (!point) {
    setHtmlIfExists("currentBlock", "<p>No data point found. Trail data may still be loading.</p>");
    return;
  }

  ensureWeatherMapVisible();
  updateWeatherMap(point);
  setHtmlIfExists("planningSummaryBlock", "");
  setHtmlIfExists("currentBlock",        "");
  setHtmlIfExists("forecastBlock",       "");

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
      if (s) s.innerHTML = '<p style="color:#003388; font-weight:600; margin:0.5rem 0 0;">\u26a0 Cold Advisory: Apparent low temperatures at or below 20&nbsp;&deg;F are indicated for this location and date. Conditions at this level may be hazardous without proper cold-weather gear.</p>';
    }
    if (forecastData.daily?.apparent_temperature_max?.some(v => Number.isFinite(v) && v >= 100) ||
        (Number.isFinite(avgs.avgAppHigh) && avgs.avgAppHigh >= 100)) {
      const s = el("weatherStatus");
      if (s) s.innerHTML = '<p style="color:#8a0000; font-weight:600; margin:0.5rem 0 0;">\u26a0 Heat Advisory: Apparent high temperatures at or above 100&nbsp;&deg;F are indicated for this location and date. Plan accordingly and carry extra water.</p>';
    }

  } catch (err) {
    console.error("[CDT] runWeather error:", err);
    setHtmlIfExists("currentBlock", `<p style="color:#900">Weather data unavailable: ${err.message}</p>`);
  } finally {
    refreshMapSize();
  }
}

/* ============================================================
   18. HIKE ROUTE BUILDING
   ============================================================ */

function buildNoboSegments(altGroups, selectedAlts, isChiefMtn) {
  const spineTotal   = cdtMeta?.trail?.spine_miles ?? 3100;
  const chiefMtnMile = cdtMeta?.trail?.chief_mtn_spine_mile ?? (spineTotal - 8);
  const endMile      = isChiefMtn ? chiefMtnMile : spineTotal;

  const segments = [];
  let spinePos   = 0;

  for (const ag of altGroups) {
    if (ag.branch_mile >= endMile) break;

    const defaultSel = ag.default_id ?? "main";
    const sel        = selectedAlts?.[ag.id] ?? defaultSel;
    const useAlt     = sel !== "main";
    const mainLen    = ag.rejoin_mile - ag.branch_mile;
    const altLen     = mainLen + (ag.alt?.delta_miles ?? 0);
    const rejoin  = Math.min(ag.rejoin_mile, endMile);

    if (ag.branch_mile > spinePos) {
      segments.push({ type: "spine", from: spinePos, to: ag.branch_mile });
    }

    if (useAlt) {
      segments.push({ type: "alt", altId: ag.id, altLen: Math.max(altLen, 0) });
    } else {
      segments.push({ type: "spine", from: ag.branch_mile, to: rejoin });
    }

    spinePos = rejoin;
  }

  if (spinePos < endMile) {
    segments.push({ type: "spine", from: spinePos, to: endMile });
  }

  let cum = 0;
  for (const seg of segments) {
    seg.hikeStart = cum;
    seg.hikeLen   = seg.type === "spine" ? seg.to - seg.from : seg.altLen;
    cum += seg.hikeLen;
  }

  return segments;
}

function buildSoboSegments(noboSegments) {
  return noboSegments.slice().reverse().map((seg, i, arr) => {
    const hikeLen   = seg.hikeLen;
    const hikeStart = arr.slice(0, i).reduce((s, x) => s + x.hikeLen, 0);
    if (seg.type === "spine") {
      return { type: "spine", from: seg.to, to: seg.from, hikeLen, hikeStart, sobo: true };
    }
    return { ...seg, hikeLen, hikeStart, sobo: true };
  });
}

function getPointAtHikeMile(hikeMile, segments) {
  for (let i = 0; i < segments.length; i++) {
    const seg    = segments[i];
    const segEnd = seg.hikeStart + seg.hikeLen;

    if (hikeMile <= segEnd || i === segments.length - 1) {
      const local = Math.max(0, hikeMile - seg.hikeStart);

      if (seg.type === "alt") {
        const altMile = seg.sobo ? Math.max(0, seg.altLen - local) : local;
        return getNearestAltPoint(seg.altId, altMile) || getNearestPoint(seg.sobo ? seg.to ?? 0 : seg.from ?? 0);
      } else {
        const spineMile = seg.sobo ? seg.from - local : seg.from + local;
        return getNearestPoint(Math.max(0, spineMile));
      }
    }
  }
  return getNearestPoint(0);
}

function buildHikePoints({ directionId, startDate, milesPerDay, totalMiles, selectedAlts }) {
  const isNobo     = directionId.startsWith("nobo");
  const isChiefMtn = directionId.endsWith("chief_mtn");

  const altGroups = (cdtMeta?.alt_groups || [])
    .slice()
    .sort((a, b) => a.branch_mile - b.branch_mile);

  const noboSegs = buildNoboSegments(altGroups, selectedAlts, isChiefMtn);
  const segments = isNobo ? noboSegs : buildSoboSegments(noboSegs);

  const durationDays = Math.ceil(totalMiles / milesPerDay);
  const hikePoints   = [];

  for (let i = 0; i < durationDays; i++) {
    const date     = addDays(startDate, i);
    const hikeMile = Math.min(milesPerDay * i, totalMiles);
    const point    = getPointAtHikeMile(hikeMile, segments);
    if (point) hikePoints.push({ date, point });
  }

  return hikePoints;
}

/* ============================================================
   19. DURATION EXTREMES (Tool A+)
   ============================================================ */

function renderDurExtremesBlocks(hottest, coldest, opts = {}) {
  renderDurExtremesBlocksShared(hottest, coldest, {
    formatLocation: (rec) => cdtPointLabel(rec.point),
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
  if (!hikePoints.length) return;

  const utciCounts = computeUtciCounts(hikePoints, getNearestNormals);
  const endDate    = addDays(params.startDate, params.durationDays - 1);

  const warningHtml = extraNote || "";

  setDisplayIfExists("durExtremesWrap", "block");

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
    if (!Number.isFinite(avgHigh) || !Number.isFinite(avgLow)) continue;
    const heatVal = Number.isFinite(avgAppHigh) ? avgAppHigh : avgHigh;
    const coldVal = Number.isFinite(avgAppLow)  ? avgAppLow  : avgLow;
    if (!hottest || heatVal > (Number.isFinite(hottest.appHigh) ? hottest.appHigh : hottest.avgHigh)) {
      hottest = { date, point, avgHigh, avgLow, appHigh: avgAppHigh, appLow: avgAppLow, rhHigh: avgRhHigh, rhLow: avgRhLow };
    }
    if (!coldest || coldVal < (Number.isFinite(coldest.appLow) ? coldest.appLow : coldest.avgLow)) {
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

function renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay, durationDays, selectedAlts }) {
  const startStr = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr   = endDate.toLocaleDateString(undefined,   { year: "numeric", month: "long", day: "numeric" });

  const opts     = cdtMeta?.direction_options || [];
  const dirLabel = opts.find(o => o.id === directionId)?.label || directionId;

  const altRows = (cdtMeta?.alt_groups || []).map(ag => {
    const defaultSel = ag.default_id ?? "main";
    const sel        = selectedAlts?.[ag.id] ?? defaultSel;
    const using      = sel === "main"
      ? (ag.main?.label ?? "Main Route")
      : (ag.alt?.label  ?? ag.label);
    return `<tr><th>${ag.label ?? ag.id}</th><td>${using}</td></tr>`;
  }).join("");

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${dirLabel}</td></tr>
      <tr><th>Start Date</th><td>${startStr}</td></tr>
      <tr><th>Total Distance</th><td>${fmtMile(totalMiles)} miles</td></tr>
      <tr><th>Miles per Day</th><td>${fmtMile(milesPerDay)}</td></tr>
      <tr><th>Estimated Duration</th><td>${durationDays} days</td></tr>
      <tr><th>Estimated End Date</th><td>${endStr}</td></tr>
      ${altRows}
    </table>
  `;
}

function runDurationCalculator() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const directionId  = el("durDirectionSelect")?.value || "nobo_waterton";
  const monthDay     = getSelectedMonthDay("durMonthSelect", "durDaySelect");
  const mpd          = numVal("durMilesPerDay");
  const selectedAlts = getSelectedAlts();

  if (!monthDay)               { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5)                 { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles   = calcTotalMiles(directionId, selectedAlts);
  const durationDays = Math.ceil(totalMiles / mpd);

  if (durationDays > 730) {
    setDurStatus("Estimated duration exceeds two years. Please increase miles per day.");
    return;
  }

  const startDate = resolveStartDate(monthDay);
  const endDate   = addDays(startDate, durationDays - 1);

  renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay: mpd, durationDays, selectedAlts });

  if (normalsByPointId.size > 0 && allPoints.length > 0) {
    computeAndRenderDurationExtremes({
      directionId, startDate, milesPerDay: mpd, totalMiles, durationDays, selectedAlts
    }).catch(err => {
      console.error("[CDT] extremes error:", err);
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

  const mpd          = numVal("durMilesPerDay");
  const directionId  = el("durDirectionSelect")?.value || "nobo_waterton";
  const selectedAlts = getSelectedAlts();

  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles   = calcTotalMiles(directionId, selectedAlts);
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
      getHikePoints: (startDate) => buildHikePoints({
        directionId, startDate, milesPerDay: mpd, totalMiles, selectedAlts
      }),
      getNormals: getNearestNormals,
    });

    if (!bestStartDate) {
      setHtmlIfExists("bestStartResult", "<p style='color:#b00000;'>No suitable start date found. The CDT's high-elevation terrain may eliminate all start dates due to extreme cold at the highest passes. Try a different route or direction.</p>");
      return;
    }

    computeAndRenderDurationExtremes({
      directionId,
      startDate: bestStartDate,
      milesPerDay: mpd,
      totalMiles,
      durationDays,
      selectedAlts,
      startDateLabel: "<em>BestStart!</em> Date",
    }).catch(err => {
      console.error("[CDT] BestStart extremes error:", err);
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
  if (mpdEl && mpdEl.value === "") mpdEl.value = "20";
}

function initWeatherUI() {
  el("goBtn")?.addEventListener("click", runWeather);
  el("cdtStateSelect")?.addEventListener("change", updateStateInfo);
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

  loadCdtMeta()
    .then(() => updateStateInfo())
    .catch(e => console.warn("[CDT] cdt_meta not loaded:", e));

  try {
    await loadPoints();
    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[CDT] loadPoints failed:", err);
  }

  setDurStatus("Loading historical weather data (large file, may take a moment)\u2026");
  try {
    await loadPrecomputedNormals();
  } catch (e) {
    console.warn("[CDT] normals not loaded:", e);
    setDurStatus("Historical weather data not yet available \u2014 run generate-normals-cdt.js to enable temperature extremes.");
  }

  setTimeout(refreshMapSize, 250);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => main().catch(console.error));
} else {
  main().catch(console.error);
}
