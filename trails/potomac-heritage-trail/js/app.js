/* Potomac Heritage National Scenic Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - 2 direction options (Westbound / Eastbound)
           - DC route alternate: River Trail (main) or City Park Trail (+16.71 mi)
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json, ~5-mile intervals)
           - No elevation correction (low-elevation trail)
           - Heat index advisory when apparent high ≥ 100 °F
           - Wind chill advisory when apparent low ≤ 20 °F
   Tool B: Weather planner
           - Region selector → Section selector → Section Mile → Date
           - Includes Virginia and Eastern Continental Divide WP-only sections
           - Open-Meteo forecast (5-day) + current conditions
           - 7-year planning average high/low
           - Apparent temperature (Steadman: heat index + wind chill)
   Maps: Leaflet + OSM tiles + trail.geojson overlay
         - Spine features: full opacity
         - WP-only features (VA, ECD): reduced opacity
   Units: Fahrenheit, mph, %
   Caching: localStorage (TTL-based); HTTP cache for large files
   ---------------------------------------------------------------*/

/* ============================================================
   1. TRAIL IDENTITY & URL RESOLUTION
   ============================================================ */

function getTrailMeta() {
  const slug =
    window.TRAIL_SLUG ||
    document.body?.dataset?.trail ||
    "potomac-heritage-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:        new URL("points.json",             dataDir).href,
    trailGeojsonUrl:  new URL("trail.geojson",           dataDir).href,
    normalsUrl:       new URL("historical_weather.json", dataDir).href,
    phtMetaUrl:       new URL("pht_meta.json",           dataDir).href,
    defaultMapCenter: [39.22, -77.91],
    defaultZoom:      7,
  };
}

const META      = getTrailMeta();
const trailSlug = META.slug;

console.log("[PHT] slug =", trailSlug);

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

// Spine geometry constants (match pht_meta.json exactly)
const PHT_BASE_SPINE_MILES = 552.96;
const DC_BRANCH_MILE       = 216.586;  // spine mile at DC fork (Anacostia/South Capitol)
const DC_REJOIN_MILE       = 228.914;  // spine mile at Georgetown / C&O Canal mile 0
const DC_RIVER_LEN         = 12.328;   // DC River Trail section length (miles)
const DC_CITY_PARK_LEN     = 29.043;   // DC City Park Trail section length (miles)
const DC_CITY_PARK_DELTA   = 16.71;    // extra miles via City Park Trail vs River Trail

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

let allPoints      = [];
let spinePoints    = [];  // on-spine points only, sorted by mile
let pointsBySection = new Map(); // section_id → points sorted by section_mile

let phtMeta = null;

let normalsByPointId        = new Map(); // point.id → normals
let normalsBySectionMile    = new Map(); // section_id → [{id, section_mile}] sorted

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
   6. POINT LABEL HELPER
   ============================================================ */

function phtPointLabel(point) {
  const sections = phtMeta?.sections || window.PHT_SECTIONS_BOOTSTRAP || [];
  const sec = sections.find(s => s.id === point.section_id);
  const secName = sec ? sec.name : (point.section_id || "Unknown");
  return `${secName} \u2014 Mile ${fmtMile(point.section_mile ?? 0)}`;
}

/* ============================================================
   7. MILEAGE CALCULATION
   ============================================================ */

function getSelectedAlts() {
  const dcVal = document.querySelector('input[name="dcRoute"]:checked')?.value || "river-trail";
  return { "dc-route": dcVal };
}

function calcTotalMiles(directionId, selectedAlts) {
  const base    = phtMeta?.trail?.spine_miles ?? PHT_BASE_SPINE_MILES;
  const dcChoice = selectedAlts?.["dc-route"] || "river-trail";
  const delta   = (dcChoice === "city-park-trail") ? DC_CITY_PARK_DELTA : 0;
  return base + delta;
}

/* ============================================================
   8. DATA LOADING
   ============================================================ */

async function loadPhtMeta() {
  const key    = `pht_meta_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload  = cached;
  if (!payload) {
    const r = await fetch(META.phtMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`pht_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  phtMeta = payload;
  console.log("[PHT] pht_meta loaded:", phtMeta.sections?.length, "sections");
}

async function loadPoints() {
  const r = await fetch(META.pointsUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`points.json fetch failed (${r.status})`);
  const data = await r.json();

  allPoints = data.filter(p =>
    isFinite(Number(p.lat)) && isFinite(Number(p.lon))
  ).map(p => ({
    ...p,
    lat:          Number(p.lat),
    lon:          Number(p.lon),
    id:           String(p.id),
    section_mile: Number(p.section_mile ?? 0),
    mile:         p.mile != null ? Number(p.mile) : null,
  }));

  // Spine points: have mile, no alt_id, not DC alt sections
  spinePoints = allPoints
    .filter(p => p.mile != null && !p.alt_id)
    .sort((a, b) => a.mile - b.mile);

  // Group all points by section_id, sorted by section_mile
  pointsBySection = new Map();
  for (const p of allPoints) {
    if (!p.section_id) continue;
    if (!pointsBySection.has(p.section_id)) pointsBySection.set(p.section_id, []);
    pointsBySection.get(p.section_id).push(p);
  }
  for (const pts of pointsBySection.values()) {
    pts.sort((a, b) => a.section_mile - b.section_mile);
  }

  console.log("[PHT] points loaded:", allPoints.length,
    "(spine:", spinePoints.length, ", by-section:", pointsBySection.size, "sections)");
}

async function loadPrecomputedNormals() {
  // historical_weather.json — rely on HTTP cache (may be large)
  const r = await fetch(META.normalsUrl);
  if (!r.ok) throw new Error(`historical_weather.json fetch failed (${r.status})`);
  const payload = await r.json();

  normalsByPointId     = new Map();
  normalsBySectionMile = new Map();

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

    const sid = p.section_id;
    if (sid) {
      if (!normalsBySectionMile.has(sid)) normalsBySectionMile.set(sid, []);
      normalsBySectionMile.get(sid).push({ id: String(p.id), section_mile: p.section_mile ?? 0 });
    }
  }

  // Sort each section's normals by section_mile
  for (const arr of normalsBySectionMile.values()) {
    arr.sort((a, b) => a.section_mile - b.section_mile);
  }

  console.log("[PHT] normals loaded:", normalsByPointId.size, "points");
  setDurStatus("Historical weather data loaded (" + normalsByPointId.size + " points).");
  setTimeout(() => setDurStatus(""), 4000);
}

/* ============================================================
   9. TRAIL GEOJSON OVERLAY
   ============================================================ */

async function fetchTrailGeojson() {
  const key    = `trail_geojson_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  if (cached) return cached;
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
const TRAIL_STYLE_WP = {
  color: "#e06060", weight: 2, opacity: 0.45, lineCap: "round", lineJoin: "round"
};

function applyTrailOverlay(targetMap, haloRef, layerRef, onDone) {
  fetchTrailGeojson()
    .then(geojson => {
      if (haloRef.current)  { try { targetMap.removeLayer(haloRef.current);  } catch {} }
      if (layerRef.current) { try { targetMap.removeLayer(layerRef.current); } catch {} }

      layerRef.current = L.geoJSON(geojson, {
        style: (feature) => {
          const onSpine = feature.properties?.on_spine !== false;
          return onSpine ? TRAIL_STYLE : TRAIL_STYLE_WP;
        },
        interactive: false,
      }).addTo(targetMap);

      if (layerRef.current.bringToBack) layerRef.current.bringToBack();
      if (onDone) onDone();
    })
    .catch(e => console.warn("[PHT] trail overlay failed:", e));
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
  if (typeof L === "undefined") { console.warn("[PHT] Leaflet not loaded"); return; }
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
  mapMarker.bindPopup(phtPointLabel(point));
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

/** Look up the nearest spine point (southern-maryland, co-canal, gap, lhht) by spine mile */
function getNearestSpinePoint(spineMile) {
  return binaryNearest(spinePoints, spineMile, p => p.mile);
}

/** Look up the nearest point within a specific section by section_mile */
function getNearestSectionPoint(sectionId, secMile) {
  const pts = pointsBySection.get(sectionId) || [];
  return binaryNearest(pts, secMile, p => p.section_mile);
}

/** Find nearest normals for any point (by direct id, then section fallback) */
function getNearestNormals(point) {
  const direct = normalsByPointId.get(point.id);
  if (direct?.hi?.length) return direct;

  // Nearest in the same section by section_mile
  const sectionNormals = normalsBySectionMile.get(point.section_id);
  if (sectionNormals?.length) {
    const best = binaryNearest(sectionNormals, point.section_mile ?? 0, e => e.section_mile);
    if (best) {
      const n = normalsByPointId.get(best.id);
      if (n?.hi?.length) return n;
    }
  }

  return null;
}

/* ============================================================
   12. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key    = `pht_forecast:${point.id}`;
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
  const key    = `pht_hist:${point.id}:${range.start_date}:${range.end_date}`;
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
  const label    = phtPointLabel(point);

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
      <tr><th>Location</th><td>${phtPointLabel(point)}</td></tr>
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
   15. WEATHER TOOL SECTION/REGION SELECTOR
   ============================================================ */

// UI-only display name overrides (data files unchanged)
const SECTION_DISPLAY_NAMES = {
  "ent-to-red-rock-wilderness-overlook-regional-park": "Red Rock Wilderness Overlook",
  "belmont-ferry-farm-trail-to-rappahannock-river-heritage-trail-connector": "Belmont Ferry to Rappahannock Trail",
};

// Sections hidden from the UI selector (still present in data for lookups)
const SECTION_UI_HIDDEN = new Set([
  "northern-virginia-unnamed",
]);

function sectionDisplayName(sec) {
  return SECTION_DISPLAY_NAMES[sec.id] || sec.name;
}

function getSections() {
  return phtMeta?.sections || window.PHT_SECTIONS_BOOTSTRAP || [];
}

function getRegions() {
  return phtMeta?.regions || window.PHT_REGIONS_BOOTSTRAP || [];
}

function populateSectionSelect(regionId) {
  const sectionSel = el("phtSectionSelect");
  if (!sectionSel) return;

  const sections = getSections();
  const filtered = sections.filter(s => s.region === regionId && !SECTION_UI_HIDDEN.has(s.id));

  sectionSel.innerHTML = "";
  for (const sec of filtered) {
    const opt = document.createElement("option");
    opt.value = sec.id;
    opt.textContent = sectionDisplayName(sec);
    sectionSel.appendChild(opt);
  }
  updateSectionInfo();
}

function getSectionLength(sec) {
  // pht_meta.json stores spine-absolute mile_start/mile_end; bootstrap uses mile_start=0
  return (sec.mile_end ?? 0) - (sec.mile_start ?? 0);
}

function updateSectionInfo() {
  const sectionId = el("phtSectionSelect")?.value;
  const infoEl    = el("phtSectionInfo");
  const mileInput = el("phtMileInput");
  if (!sectionId || !infoEl) return;

  const sections = getSections();
  const sec = sections.find(s => s.id === sectionId);
  if (!sec) return;

  const secLen  = getSectionLength(sec);
  const maxMile = fmtMile(secLen);
  infoEl.textContent = `Section Range: 0\u2013${maxMile} Miles`;

  if (mileInput) {
    mileInput.placeholder = `e.g., ${Math.round(secLen / 2)}`;
    const cur = Number(mileInput.value);
    if (cur < 0 || cur > secLen) mileInput.value = "";
  }
}

/* ============================================================
   16. WEATHER TOOL RUN
   ============================================================ */

async function runWeather() {
  const sectionId = el("phtSectionSelect")?.value;
  const mileRaw   = el("phtMileInput")?.value;
  const monthDay  = getSelectedMonthDay("monthSelect", "daySelect");

  setWeatherStatus("");
  if (!sectionId)                       { setWeatherStatus("Please select a section."); return; }
  if (mileRaw === "" || mileRaw == null) { setWeatherStatus("Please enter a trail mile."); return; }
  if (!monthDay)                        { setWeatherStatus("Please choose a planning date."); return; }

  const mile = Number(mileRaw);
  if (!isFinite(mile) || mile < 0) { setWeatherStatus("Please enter a valid number for the trail mile."); return; }

  const sections = getSections();
  const sec = sections.find(s => s.id === sectionId);
  if (sec) {
    const secLen = getSectionLength(sec);
    if (mile > secLen) {
      setWeatherStatus(`Please enter a mile between 0 and ${fmtMile(secLen)} for this section.`);
      return;
    }
  }

  const point = getNearestSectionPoint(sectionId, mile);
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
    console.error("[PHT] runWeather error:", err);
    setHtmlIfExists("currentBlock", `<p style="color:#900">Weather data unavailable: ${err.message}</p>`);
  } finally {
    refreshMapSize();
  }
}

/* ============================================================
   17. DURATION CALCULATOR (Tool A)
   ============================================================ */

function renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay, durationDays, selectedAlts }) {
  const startStr = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr   = endDate.toLocaleDateString(undefined,   { year: "numeric", month: "long", day: "numeric" });
  const opts     = phtMeta?.direction_options || [];
  const dirLabel = opts.find(o => o.id === directionId)?.label
    || (directionId === "westbound"
        ? "Westbound \u2014 Point Lookout, MD \u2192 Laurel Ridge, PA"
        : "Eastbound \u2014 Laurel Ridge, PA \u2192 Point Lookout, MD");

  const dcChoice  = selectedAlts?.["dc-route"] || "river-trail";
  const dcLabel   = dcChoice === "city-park-trail" ? "DC City Park Trail (+16.7 mi)" : "DC River Trail";

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${dirLabel}</td></tr>
      <tr><th>D.C. Route</th><td>${dcLabel}</td></tr>
      <tr><th>Start Date</th><td>${startStr}</td></tr>
      <tr><th>Total Distance</th><td>${fmtMile(totalMiles)} miles</td></tr>
      <tr><th>Miles per Day</th><td>${fmtMile(milesPerDay)}</td></tr>
      <tr><th>Estimated Duration</th><td>${durationDays} days</td></tr>
      <tr><th>Estimated End Date</th><td>${endStr}</td></tr>
    </table>
  `;
}

/* ============================================================
   18. HIKE POINT BUILDER
   ============================================================ */

/**
 * Build ordered sequence of trail points for a hike, one per day.
 * Handles the DC alternate routing zone.
 *
 * Westbound (Point Lookout → Laurel Ridge):
 *   cumMile 0…branchMile:             Southern Maryland (spine mile = cumMile)
 *   cumMile branchMile…branchMile+dcLen: DC alt zone (section_mile = cumMile - branchMile)
 *   cumMile beyond DC zone:            C&O/GAP/LHHT (spine mile = cumMile - altDelta)
 *
 * Eastbound (Laurel Ridge → Point Lookout):
 *   cumMile 0…(baseMiles-rejoinMile):  LHHT/GAP/C&O (spine mile = baseMiles - cumMile)
 *   DC zone:                           section_mile = dcLen - (cumMile - dcEnter)
 *   beyond DC zone:                    Southern Maryland (spine mile = totalMiles - cumMile)
 */
function buildHikePoints({ directionId, startDate, milesPerDay, totalMiles, selectedAlts }) {
  const durationDays = Math.ceil(totalMiles / milesPerDay);
  const isWestbound  = directionId === "westbound";
  const dcChoice     = selectedAlts?.["dc-route"] || "river-trail";
  const dcAltLen     = (dcChoice === "city-park-trail") ? DC_CITY_PARK_LEN   : DC_RIVER_LEN;
  const altDelta     = (dcChoice === "city-park-trail") ? DC_CITY_PARK_DELTA : 0;
  const dcSectionId  = (dcChoice === "city-park-trail") ? "dc-city-park-trail" : "dc-river-trail";

  // DC zone boundaries in hike-mile space (distance from start)
  const dcEnter = isWestbound
    ? DC_BRANCH_MILE                              // westbound: branch at mile 216.586
    : (PHT_BASE_SPINE_MILES - DC_REJOIN_MILE);   // eastbound: reach rejoin ~mile 324.046
  const dcExit = dcEnter + dcAltLen;

  const hikePoints = [];

  for (let i = 0; i < durationDays; i++) {
    const date = addDays(startDate, i);
    const h    = Math.min(milesPerDay * i, totalMiles);

    let point = null;

    if (h >= dcEnter && h <= dcExit) {
      // Within DC alternate zone
      const secMile = isWestbound
        ? h - DC_BRANCH_MILE                    // 0 at branch, dcAltLen at rejoin
        : dcAltLen - (h - dcEnter);             // dcAltLen at rejoin end, 0 at branch end
      point = getNearestSectionPoint(dcSectionId, Math.max(0, Math.min(dcAltLen, secMile)));
    } else if (isWestbound) {
      if (h < DC_BRANCH_MILE) {
        // Southern Maryland (pre-DC, westbound)
        point = getNearestSpinePoint(h);
      } else {
        // C&O Canal, GAP, LHHT (post-DC, westbound)
        point = getNearestSpinePoint(h - altDelta);
      }
    } else {
      // Eastbound
      if (h < dcEnter) {
        // LHHT, GAP, C&O (pre-DC, eastbound) — spine mile counts DOWN from western end
        point = getNearestSpinePoint(PHT_BASE_SPINE_MILES - h);
      } else {
        // Southern Maryland (post-DC, eastbound)
        point = getNearestSpinePoint(totalMiles - h);
      }
    }

    if (point) hikePoints.push({ date, point });
  }

  return hikePoints;
}

/* ============================================================
   19. DURATION EXTREMES (Tool A+)
   ============================================================ */

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

function renderDurExtremesBlocks(hottest, coldest, opts = {}) {
  renderDurExtremesBlocksShared(hottest, coldest, {
    formatLocation: (rec) => phtPointLabel(rec.point),
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
  const endDate    = addDays(params.startDate, params.durationDays - 1);

  const warningHtml = "";

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

/* ============================================================
   20. DURATION CALCULATOR RUN
   ============================================================ */

function runDurationCalculator() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const directionId  = el("durDirectionSelect")?.value || "westbound";
  const selectedAlts = getSelectedAlts();
  const monthDay     = getSelectedMonthDay("durMonthSelect", "durDaySelect");
  const mpd          = numVal("durMilesPerDay");

  if (!monthDay)               { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5)                 { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles   = calcTotalMiles(directionId, selectedAlts);
  const durationDays = Math.ceil(totalMiles / mpd);

  if (durationDays > 365) {
    setDurStatus("Estimated duration exceeds one year. Please increase miles per day.");
    return;
  }

  const startDate = resolveStartDate(monthDay);
  const endDate   = addDays(startDate, durationDays - 1);

  renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay: mpd, durationDays, selectedAlts });

  if (normalsByPointId.size > 0 && allPoints.length > 0) {
    computeAndRenderDurationExtremes({
      directionId, startDate, milesPerDay: mpd, totalMiles, durationDays, selectedAlts
    }).catch(err => {
      console.error("[PHT] extremes error:", err);
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

  const directionId  = el("durDirectionSelect")?.value || "westbound";
  const selectedAlts = getSelectedAlts();
  const totalMiles   = calcTotalMiles(directionId, selectedAlts);
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
      getHikePoints: (startDate) => buildHikePoints({ directionId, startDate, milesPerDay: mpd, totalMiles, selectedAlts }),
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
      selectedAlts,
      startDateLabel: "<em>BestStart!</em> Date"
    }).catch(err => {
      console.error("[PHT] BestStart extremes error:", err);
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
  initMonthDayPickerGeneric("monthSelect", "daySelect");

  const regionSel  = el("phtRegionSelect");
  const sectionSel = el("phtSectionSelect");

  if (regionSel) {
    regionSel.addEventListener("change", () => {
      populateSectionSelect(regionSel.value);
    });
    // Initialize with first region
    populateSectionSelect(regionSel.value);
  }

  if (sectionSel) {
    sectionSel.addEventListener("change", updateSectionInfo);
  }
}

/* ============================================================
   23. MAIN
   ============================================================ */

async function main() {
  initDurationUI();
  initWeatherUI();

  // Initialize weather map
  initMap();
  loadTrailOverlay();

  // Load pht_meta.json (non-blocking — bootstrap handles immediate UI)
  loadPhtMeta()
    .then(() => {
      const regionSel = el("phtRegionSelect");
      if (regionSel) populateSectionSelect(regionSel.value);
    })
    .catch(e => console.warn("[PHT] pht_meta not loaded:", e));

  // Load points
  try {
    await loadPoints();

    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[PHT] loadPoints failed:", err);
  }

  // Load precomputed normals (best-effort)
  try {
    await loadPrecomputedNormals();
  } catch (e) {
    console.warn("[PHT] normals not loaded:", e);
    setDurStatus("Temperature extremes unavailable \u2014 historical_weather.json not found. Run the generation script to enable this feature.");
  }

  setTimeout(refreshMapSize, 250);
}

document.addEventListener("DOMContentLoaded", main);
