/* Florida Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - Alternate route mileage adjustments (Okeechobee, Ocala-Orlando Loop)
           - Blackwater terminus encoded in direction dropdown
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json)
           - Works for both spine and western-corridor hikes
   Tool B: Weather planner
           - Region → Section → Section-mile → Date
           - Open-Meteo forecast (5-day) + current conditions
           - 7-year planning average high/low
           - Apparent temperature (heat index / wind chill) via Steadman
           - Relative humidity derived from actual + apparent temp
   Maps: Leaflet + OSM tiles + local trail.geojson overlay
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
    "florida-trail";

  const pageDir = new URL(".", window.location.href);
  const dataDir = new URL("./data/", pageDir);

  return {
    slug,
    pageDir: pageDir.href,
    dataDir: dataDir.href,
    pointsUrl:        new URL("points.json",            dataDir).href,
    trailGeojsonUrl:  new URL("trails.geojson",         dataDir).href,
    normalsUrl:       new URL("historical_weather.json", dataDir).href,
    ftMetaUrl:        new URL("ft_meta.json",            dataDir).href,
    defaultMapCenter: [28.0, -82.5],
    defaultZoom:      6,
  };
}

const META = getTrailMeta();
const trailSlug = META.slug;

console.log("[FT] slug =", trailSlug);
console.log("[FT] pointsUrl =", META.pointsUrl);

/* ============================================================
   2. OPEN-METEO ENDPOINTS & VARIABLE LISTS
   ============================================================ */

const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const HIST_BASE     = "https://archive-api.open-meteo.com/v1/archive";

// Apparent temperature (Steadman) lets us derive heat index / wind chill.
// Relative humidity lets us show RH directly.
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

const TYPICAL_WINDOW_DAYS  = 3;           // ±3-day smoothing for planning averages

const FORECAST_TTL_MS      = 30 * 60 * 1000;           // 30 min
const HIST_TTL_MS          = 24 * 60 * 60 * 1000;      // 24 hr
const TRAIL_TTL_MS         = 30 * 24 * 60 * 60 * 1000; // 30 days
const NORMALS_TTL_MS       = 30 * 24 * 60 * 60 * 1000; // 30 days
const NORMALS_CACHE_VERSION = "v2";

// Florida Trail spine total (southern terminus → Fort Pickens)
// Blackwater terminus is at axis_mile 1080 (branch 1034, extension 46 mi)
const FT_SPINE_TOTAL   = 1204; // miles (Big Cypress S → Fort Pickens)
const FT_SPINE_MIN     = 0;
const FT_SPINE_MAX     = 1204;
const FT_BW_END        = 1080; // Blackwater terminal axis_mile

/* ============================================================
   4. ALT-GROUP MILEAGE DEFINITIONS
   Mirrors ft_meta.json alt_groups — used when ft_meta hasn't loaded yet.
   ============================================================ */

// Each alt group: { id, branch_mile, rejoin_mile, sections: [{section_id,delta_miles,is_default}] }
const ALT_GROUP_DEFAULTS = [
  {
    id: "alt-okee",
    branch_mile: 94,
    rejoin_mile: 150,
    sections: [
      { section_id: "okeechobee_west", section_ids: ["okeechobee_west"], delta_miles: 0,   is_default: true  },
      { section_id: "okee_east",       section_ids: ["okee_east"],       delta_miles: 64,  is_default: false },
    ],
  },
  {
    id: "alt-orlando-ocala-loop",
    branch_mile: 240,
    rejoin_mile: 438,
    sections: [
      {
        section_id: "eastern_corridor",
        section_ids: ["three_lakes","bull_creek","tosohatchee","lake_jessup","cassia","ocala_south"],
        delta_miles: 0,
        is_default: true,
      },
      {
        section_id: "western_corridor",
        section_ids: ["upper_kiss","reedy_creek","green_swamp_east","green_swamp_west","croom","citrus","cfgwest","cfgeast_ocalawest"],
        delta_miles: -36,
        is_default: false,
      },
    ],
  },
];

/* ============================================================
   5. MODULE-LEVEL STATE
   ============================================================ */

// Points
let allPoints = [];
let pointsBySectionId = new Map();  // section_id → Point[]
let allPointsSortedByAxisMile = []; // for spine lookups

// FT meta (loaded from ft_meta.json)
let ftMeta = null;
let ftSectionById = new Map();
let ftAltGroupById = new Map();

// Precomputed normals
let normalsByPointId = new Map(); // point.id → { hi:[365], lo:[365], app_hi:[365], app_lo:[365], rh_hi:[365], rh_lo:[365] }
let normalsSortedByMile = []; // [{ axis_mile, id }] sorted — for nearest-sample lookup
let normalsMeta = null;

// Leaflet — Weather map
let map = null;
let mapMarker = null;
let trailLayer = null;
let trailHaloLayer = null;

// Leaflet — Extremes map
let durMap = null;
let durMapLayerGroup = null;
let durTrailLayer = null;
let durTrailHaloLayer = null;

const SELECT_ZOOM = 8;

/* ============================================================
   6. UTILITY FUNCTIONS (trail-specific only — shared utils in /js/shared-utils.js)
   ============================================================ */

function refreshMapSize() {
  if (map) setTimeout(() => { try { map.invalidateSize(); } catch {} }, 0);
}


/* ============================================================
   7. POINT LABEL HELPERS
   ============================================================ */

function ftPointLabel(p) {
  // section display name from bootstrap or meta
  const sec = ftSectionById.get(p.section_id)
    || window.FT_SECTIONS_BOOTSTRAP?.find(s => s.id === p.section_id);
  const secName = sec?.name || p.section_id;
  return `${secName} — Section Mile ${fmtMile(p.sec_mile)}`;
}

/* ============================================================
   10. MILEAGE CALCULATION
   ============================================================ */

/**
 * Read the current alternate-group selections from the HTML radio buttons.
 * Returns { "alt-okee": "okeechobee_west"|"okee_east",
 *           "alt-orlando-ocala-loop": "eastern_corridor"|"western_corridor" }
 */
function getSelectedAlts() {
  return {
    "alt-okee":
      (document.querySelector('input[name="alt-okee"]:checked') || {}).value
      || "okeechobee_west",
    "alt-orlando-ocala-loop":
      (document.querySelector('input[name="alt-ocala-loop"]:checked') || {}).value
      || "eastern_corridor",
  };
}

/**
 * Determine whether the hike uses the western corridor based on the radio value.
 */
function isWesternCorridor() {
  return getSelectedAlts()["alt-orlando-ocala-loop"] === "western_corridor";
}

/**
 * Get the alt_group definitions — prefer loaded ft_meta, fall back to hardcoded.
 */
function getAltGroups() {
  if (ftMeta?.alt_groups?.length) return ftMeta.alt_groups;
  return ALT_GROUP_DEFAULTS;
}

/**
 * Calculate total trail miles given direction + alt selections.
 * direction: "NOBO_PICKENS" | "NOBO_BLACKWATER" | "SOBO_PICKENS" | "SOBO_BLACKWATER"
 */
function calcTotalMiles(direction, selectedAlts) {
  const useBlackwater = direction.includes("BLACKWATER");

  // Base: spine total or Blackwater-shortened version
  let total = useBlackwater
    ? (FT_BW_END - FT_SPINE_MIN)   // 0 → 1080 = 1080 miles on axis
    : FT_SPINE_TOTAL;              // 0 → 1204 = 1204 miles

  // Apply each mid-trail alt group adjustment
  for (const group of getAltGroups()) {
    // Blackwater replaces the tail; skip alt-groups that lie entirely within the dropped tail
    if (useBlackwater && group.branch_mile >= FT_BW_END) continue;

    const spineSegLen = group.rejoin_mile - group.branch_mile;

    // Find chosen option — check section_id (ft_meta.json field) first,
    // then section_ids array (ALT_GROUP_DEFAULTS fallback).
    const chosenVal = selectedAlts[group.id];
    const chosen = (chosenVal
      ? group.sections.find(s =>
          s.section_id === chosenVal ||
          (Array.isArray(s.section_ids) && s.section_ids.includes(chosenVal))
        )
      : null
    ) || group.sections.find(s => s.is_default) || group.sections[0];

    total -= spineSegLen;
    total += chosen.delta_miles + spineSegLen;
    // Simplification: total += chosen.delta_miles
    // (above is equivalent but written for clarity)
  }

  return Math.round(total);
}

/* ============================================================
   12. DATA LOADING
   ============================================================ */

async function loadFtMeta() {
  const key = `ft_meta_${trailSlug}_v1`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  let payload = cached;
  if (!payload) {
    const r = await fetch(META.ftMetaUrl, { cache: "no-cache" });
    if (!r.ok) throw new Error(`ft_meta.json fetch failed (${r.status})`);
    payload = await r.json();
    cacheSet(key, payload);
  }
  ftMeta = payload;
  ftSectionById  = new Map((ftMeta.sections  || []).map(s => [s.id, s]));
  ftAltGroupById = new Map((ftMeta.alt_groups || []).map(g => [g.id, g]));
  console.log("[FT] ft_meta loaded:", ftMeta.sections?.length, "sections");
}

async function loadPoints() {
  const r = await fetch(META.pointsUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`points.json fetch failed (${r.status})`);
  const data = await r.json();

  allPoints = data
    .map(p => ({
      ...p,
      axis_mile: Number(p.axis_mile),
      sec_mile:  Number(p.sec_mile),
      lat:       Number(p.lat),
      lon:       Number(p.lon),
      id:        String(p.id),
    }))
    .filter(p =>
      isFinite(p.axis_mile) && isFinite(p.lat) && isFinite(p.lon) && p.section_id
    );

  // Index by section
  pointsBySectionId = new Map();
  for (const p of allPoints) {
    if (!pointsBySectionId.has(p.section_id)) pointsBySectionId.set(p.section_id, []);
    pointsBySectionId.get(p.section_id).push(p);
  }
  for (const arr of pointsBySectionId.values()) {
    arr.sort((a,b) => a.sec_mile - b.sec_mile);
  }

  // Spine-sorted array (for extremes tool)
  allPointsSortedByAxisMile = [...allPoints]
    .filter(p => isFinite(p.axis_mile))
    .sort((a,b) => a.axis_mile - b.axis_mile);

  console.log("[FT] points loaded:", allPoints.length);
}

async function loadPrecomputedNormals() {
  // historical_weather.json is too large for localStorage — rely on HTTP cache instead.
  const r = await fetch(META.normalsUrl);
  if (!r.ok) throw new Error(`historical_weather.json fetch failed (${r.status})`);
  const payload = await r.json();

  normalsByPointId = new Map();
  normalsMeta = payload.meta || null;

  for (const p of (payload.points || [])) {
    if (!p?.id) continue;
    normalsByPointId.set(String(p.id), {
      hi:     p.hi     || [],
      lo:     p.lo     || [],
      app_hi: p.hi_app || p.hi || [],   // JSON uses hi_app/lo_app keys
      app_lo: p.lo_app || p.lo || [],
      rh_hi:  p.rh_hi  || [],
      rh_lo:  p.rh_lo  || [],
    });
  }
  // Build a mile-sorted index of sampled points for nearest-neighbour fallback.
  // allPoints is loaded before normals, so we can filter here.
  normalsSortedByMile = allPoints
    .filter(p => normalsByPointId.has(p.id))
    .map(p => ({ id: p.id, axis_mile: p.axis_mile }))
    .sort((a, b) => a.axis_mile - b.axis_mile);

  console.log("[FT] normals loaded:", normalsByPointId.size, "points,", normalsSortedByMile.length, "indexed by mile");
}

/* ============================================================
   13. TRAIL GEOJSON OVERLAY  (shared helper)
   ============================================================ */

async function fetchTrailGeojson() {
  const key = `trail_geojson_${trailSlug}_v5`;
  const cached = cacheGet(key, TRAIL_TTL_MS);
  if (cached) return cached;
  const r = await fetch(META.trailGeojsonUrl, { cache: "no-store" });
  if (!r.ok) throw new Error(`trail.geojson fetch failed (${r.status})`);
  const gj = await r.json();
  cacheSet(key, gj);
  return gj;
}

function applyTrailOverlay(targetMap, haloRef, layerRef, onDone) {
  fetchTrailGeojson()
    .then(geojson => {
      // Strip all feature properties so nothing in the GeoJSON can influence Leaflet styling
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
        style: { color:"#e06060", weight:3.25, opacity:0.85, lineCap:"round", lineJoin:"round" },
        interactive: false
      }).addTo(targetMap);

      if (layerRef.current.bringToBack) layerRef.current.bringToBack();
      if (onDone) onDone();
    })
    .catch(e => console.warn("[FT] trail overlay failed:", e));
}

// Mutable refs for weather map overlay
const weatherHaloRef  = { current: null };
const weatherLayerRef = { current: null };

// Mutable refs for extremes map overlay
const durHaloRef  = { current: null };
const durLayerRef = { current: null };

async function loadTrailOverlay() {
  if (!map) return;
  applyTrailOverlay(map, weatherHaloRef, weatherLayerRef, refreshMapSize);
}

async function loadTrailOverlayForDurMap() {
  if (!durMap) return;
  applyTrailOverlay(durMap, durHaloRef, durLayerRef, () => {
    try { durMap.invalidateSize(); } catch {}
  });
}

/* ============================================================
   14. WEATHER MAP (Tool B)
   ============================================================ */

function initMap() {
  if (typeof L === "undefined") { console.warn("[FT] Leaflet not loaded"); return; }
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
  mapMarker.bindPopup(ftPointLabel(point));
  map.setView(ll, SELECT_ZOOM);
  if (mapMarker.bringToFront) mapMarker.bringToFront();
  refreshMapSize();
}

/* ============================================================
   15. POINT LOOKUP HELPERS
   ============================================================ */

/**
 * Find nearest point in a section by sec_mile.
 */
function getNearestPointInSection(sectionId, secMile) {
  const arr = pointsBySectionId.get(sectionId);
  if (!arr?.length) return null;
  let best = null, bestDist = Infinity;
  for (const p of arr) {
    const d = Math.abs(p.sec_mile - secMile);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

/**
 * Find nearest spine point by axis_mile (binary search).
 */
function getNearestSpinePoint(axisMile) {
  const arr = allPointsSortedByAxisMile;
  if (!arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo+hi)>>1;
    if (arr[mid].axis_mile === axisMile) return arr[mid];
    if (arr[mid].axis_mile < axisMile) lo = mid+1; else hi = mid-1;
  }
  const a = arr[Math.max(0, hi)];
  const b = arr[Math.min(arr.length-1, lo)];
  if (!a) return b;
  if (!b) return a;
  return Math.abs(a.axis_mile-axisMile) <= Math.abs(b.axis_mile-axisMile) ? a : b;
}

/**
 * For the western corridor, find a point by walking through the ordered
 * section list and accumulating sec_mile offsets.
 * Returns { point, sectionId } or null.
 */
function getNearestWesternCorridorPoint(cumulativeMile) {
  // Ordered western corridor section ids (S→N)
  const westSections = [
    "upper_kiss","reedy_creek","green_swamp_east","green_swamp_west",
    "croom","citrus","cfgwest","cfgeast_ocalawest"
  ];

  let remaining = cumulativeMile;
  for (const secId of westSections) {
    const arr = pointsBySectionId.get(secId);
    if (!arr?.length) continue;
    const secLen = arr[arr.length-1].sec_mile;
    if (remaining <= secLen || secId === westSections[westSections.length-1]) {
      // Point is in this section
      return { point: getNearestPointInSection(secId, remaining), sectionId: secId };
    }
    remaining -= secLen;
  }
  return null;
}

/* ============================================================
   16. OPEN-METEO API CALLS
   ============================================================ */

async function fetchForecast(point) {
  const key = `ft_forecast:${point.id}`;
  const cached = cacheGet(key, FORECAST_TTL_MS);
  if (cached) return cached;

  const url = new URL(FORECAST_BASE);
  url.searchParams.set("latitude",          point.lat);
  url.searchParams.set("longitude",         point.lon);
  url.searchParams.set("daily",             FORECAST_DAILY_VARS);
  url.searchParams.set("current_weather",   "true");
  url.searchParams.set("temperature_unit",  "fahrenheit");
  url.searchParams.set("windspeed_unit",    "mph");
  url.searchParams.set("timezone",          "auto");
  url.searchParams.set("forecast_days",     "5");

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
  const key = `ft_hist:${point.id}:${range.start_date}:${range.end_date}`;
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
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}

function indexHistoricalByMonthDay(histDaily, fields) {
  // fields: array of field names to bucket (e.g. ["temperature_2m_max","apparent_temperature_max",...])
  const idx = new Map();
  const times = histDaily.time || [];
  for (let i = 0; i < times.length; i++) {
    const md = times[i].slice(5); // "MM-DD"
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
  const base = new Date(2001, mm-1, dd);
  const keys = [];
  for (let off = -windowDays; off <= windowDays; off++) {
    const dt = addDays(base, off);
    keys.push(`${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`);
  }
  return keys;
}

function computePlanningAverages(histDaily, monthDay, windowDays) {
  const fields = [
    "temperature_2m_max","temperature_2m_min",
    "apparent_temperature_max","apparent_temperature_min",
    "relative_humidity_2m_max","relative_humidity_2m_min",
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
  const secName = ftSectionById.get(point.section_id)?.name
    || window.FT_SECTIONS_BOOTSTRAP?.find(s=>s.id===point.section_id)?.name
    || point.section_id;

  el("planningSummaryBlock").innerHTML = `
    <h2>Planning: 7-year Average</h2>
    <table>
      <tr><th>Date / Location</th><td colspan="3">${niceDate} — ${secName}, Mile ~${fmtMile(point.sec_mile)}</td></tr>
      <tr><th></th><th style="background:#f0f0f0;">Actual Temp</th><th style="background:#f0f0f0;">Apparent Temp</th><th style="background:#f0f0f0;">Relative Humidity</th></tr>
      <tr><th>Avg High</th><td>${fmtTemp(avgs.avgHigh)}</td><td>${fmtTemp(avgs.avgAppHigh)}</td><td>${fmtRh(avgs.avgRhHigh)}</td></tr>
      <tr><th>Avg Low</th><td>${fmtTemp(avgs.avgLow)}</td><td>${fmtTemp(avgs.avgAppLow)}</td><td>${fmtRh(avgs.avgRhLow)}</td></tr>
      <tr><th>Historical Range</th><td colspan="3">${range.start_date} to ${range.end_date}</td></tr>
    </table>
    <p class="note">
      Averages computed from daily highs/lows over a ${TYPICAL_WINDOW_DAYS*2+1}-day window
      centered on the planning date, across 7 years of data.
      Apparent temperature uses the Steadman methodology (heat index at high humidity,
      wind chill at low temperatures).
    </p>
  `;
}

function renderCurrent(forecastData, point) {
  const c = forecastData.current_weather;
  const block = el("currentBlock");
  if (!c || !block) return;

  const secName = ftSectionById.get(point.section_id)?.name
    || window.FT_SECTIONS_BOOTSTRAP?.find(s=>s.id===point.section_id)?.name
    || point.section_id;

  block.innerHTML = `
    <h2>Current Conditions</h2>
    <table>
      <tr><th>Location</th><td>${secName} — Section Mile ~${fmtMile(point.sec_mile)}</td></tr>
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
    const hi    = d.temperature_2m_max?.[i];
    const lo    = d.temperature_2m_min?.[i];
    const appHi = d.apparent_temperature_max?.[i];
    const appLo = d.apparent_temperature_min?.[i];
    const rhHi  = d.relative_humidity_2m_max?.[i];
    const rhLo  = d.relative_humidity_2m_min?.[i];
    const precip = d.precipitation_probability_max?.[i];
    const wind  = d.windspeed_10m_max?.[i];

    return `
      <tr>
        <td>${date}</td>
        <td>${fmtTemp(hi)}${feelsLikeNote(hi, appHi)}</td>
        <td>${fmtTemp(lo)}${feelsLikeNote(lo, appLo)}</td>
        <td>${rhHi != null ? fmtRh(rhHi) : "—"} / ${rhLo != null ? fmtRh(rhLo) : "—"}</td>
        <td>${precip != null ? Math.round(precip)+"%" : "—"}</td>
        <td>${wind != null ? Math.round(wind)+" mph" : "—"}</td>
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
      "Feels hotter/cooler" note appears when apparent temperature differs
      from actual by 3 °F or more.
    </p>
  `;

  refreshMapSize();
}

/* ============================================================
   20. WEATHER TOOL RUN
   ============================================================ */

async function runWeather() {
  const sectionId = el("sectionSelect")?.value;
  const secMileRaw = el("ftMileInput")?.value;
  const monthDay = getSelectedMonthDay("monthSelect","daySelect");

  setWeatherStatus("");
  if (!sectionId) { setWeatherStatus("Please select a section."); return; }
  if (secMileRaw === "" || secMileRaw == null) { setWeatherStatus("Please enter a section mile."); return; }
  if (!monthDay) { setWeatherStatus("Please choose a planning date."); return; }

  const secMile = Number(secMileRaw);

  // Validate against the section's known mile range
  const metaSections = ftMeta?.sections?.length ? ftMeta.sections : (window.FT_SECTIONS_BOOTSTRAP || []);
  const activeSec = metaSections.find(s => s.id === sectionId);
  const secMax = activeSec?.mile_end != null ? (activeSec.mile_end - (activeSec.mile_start || 0)) : 99;
  if (secMile < 0 || secMile > secMax) {
    setWeatherStatus("Section mileage entered must be within the listed range. Please try again.");
    return;
  }

  const point = getNearestPointInSection(sectionId, secMile);

  if (!point) {
    el("currentBlock").innerHTML = `<p>No data point found for this section. The trail data for <strong>${sectionId}</strong> may not be loaded yet.</p>`;
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
    console.error("[FT] runWeather error:", err);
    setHtmlIfExists("currentBlock", `<p style="color:#900">Weather data unavailable: ${err.message}</p>`);
  } finally {
    refreshMapSize();
  }
}

/* ============================================================
   21. DURATION CALCULATOR  (Tool A)
   ============================================================ */

function renderDurationResult({ direction, startDate, endDate, totalMiles, milesPerDay, durationDays }) {
  const startStr = startDate.toLocaleDateString(undefined, { year:"numeric", month:"long", day:"numeric" });
  const endStr   = endDate.toLocaleDateString(undefined,   { year:"numeric", month:"long", day:"numeric" });

  const dirLabels = {
    NOBO_PICKENS:    "Northbound — Big Cypress South to Fort Pickens (Main)",
    NOBO_BLACKWATER: "Northbound — Big Cypress South to Blackwater Extension",
    SOBO_PICKENS:    "Southbound — Fort Pickens to Big Cypress South (Main)",
    SOBO_BLACKWATER: "Southbound — Blackwater Extension to Big Cypress South",
  };

  // Heat index warning appended separately after extremes are computed (see computeAndRenderDurationExtremes)
  const heatWarning = "";

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${dirLabels[direction] || direction}</td></tr>
      <tr><th>Start Date</th><td>${startStr}</td></tr>
      <tr><th>Total Distance</th><td>${fmtMile(totalMiles)} miles</td></tr>
      <tr><th>Miles per Day</th><td>${fmtMile(milesPerDay)}</td></tr>
      <tr><th>Estimated Duration</th><td>${durationDays} days</td></tr>
      <tr><th>Estimated End Date</th><td>${endStr}</td></tr>
    </table>
    ${heatWarning}
  `;
}

/* ============================================================
   22. DURATION EXTREMES  (Tool A+)
   ============================================================ */

function dayIndexFromMonthDay(monthDay) {
  const [mm,dd] = monthDay.split("-").map(Number);
  const dt    = new Date(2021, mm-1, dd);
  const start = new Date(2021, 0, 1);
  return Math.max(0, Math.min(364, Math.round((dt-start)/(86400000))));
}

/**
 * Build the ordered sequence of points for a hike, one per day.
 * Returns array of { date, point } objects.
 *
 * For spine hikes (NOBO/SOBO_PICKENS, eastern corridor):
 *   axis_mile advances by milesPerDay each day.
 *
 * For western corridor hikes:
 *   We walk through the western sections S→N (or N→S) by cumulative sec_mile.
 *   The western corridor occupies the portion of the hike between
 *   branch_mile (240) and rejoin_mile (438) on the spine.
 *
 * For Blackwater hikes: spine ends at axis_mile 1080 instead of 1204.
 */
function buildHikePoints({ direction, startDate, milesPerDay, totalMiles, selectedAlts }) {
  const isNobo = direction.startsWith("NOBO");
  const isBw   = direction.includes("BLACKWATER");
  const useWest = selectedAlts["alt-orlando-ocala-loop"] === "western_corridor";

  const durationDays = Math.ceil(totalMiles / milesPerDay);
  const spineStart = isNobo ? FT_SPINE_MIN : (isBw ? FT_BW_END : FT_SPINE_MAX);
  const spineSign  = isNobo ? 1 : -1;

  // Determine corridor split points (relative to cumulative distance from start)
  // Branch point in spine-miles from start
  const branchAxisMile  = 240;
  const rejoinAxisMile  = 438;
  const branchFromStart = isNobo
    ? branchAxisMile - FT_SPINE_MIN
    : (isBw ? FT_BW_END : FT_SPINE_MAX) - rejoinAxisMile;
  const spineBeforeSplit  = branchFromStart;         // cumulative miles before corridor split
  const corridorLen       = useWest ? 157 : (rejoinAxisMile - branchAxisMile); // 157 mi (western) or 198 mi (eastern spine segment)

  // Western section list (NOBO order)
  const westSectionsNOBO = [
    "upper_kiss","reedy_creek","green_swamp_east","green_swamp_west",
    "croom","citrus","cfgwest","cfgeast_ocalawest"
  ];

  // Compute cumulative max sec_mile per western section (for interpolation)
  const westSectionLengths = westSectionsNOBO.map(sid => {
    const arr = pointsBySectionId.get(sid);
    if (!arr?.length) return 0;
    return arr[arr.length-1].sec_mile;
  });
  const westTotal = westSectionLengths.reduce((a,b)=>a+b,0);

  const hikePoints = [];

  for (let i = 0; i < durationDays; i++) {
    const date = addDays(startDate, i);
    const cumMile = milesPerDay * i;  // cumulative miles walked from start

    let point = null;

    if (useWest && cumMile >= spineBeforeSplit && cumMile < spineBeforeSplit + corridorLen) {
      // In the western corridor
      const corridorMile = cumMile - spineBeforeSplit;
      // Scale to actual western corridor total
      const scaledMile   = (corridorMile / corridorLen) * westTotal;
      const corridorList = isNobo ? westSectionsNOBO : [...westSectionsNOBO].reverse();
      const scaledPos    = isNobo ? scaledMile : (westTotal - scaledMile);

      let remaining = scaledPos;
      for (let s = 0; s < westSectionsNOBO.length; s++) {
        const secId  = corridorList[s];
        const secLen = westSectionLengths[isNobo ? s : westSectionsNOBO.length-1-s];
        if (secLen === 0) continue;
        if (remaining <= secLen || s === westSectionsNOBO.length-1) {
          point = getNearestPointInSection(secId, Math.max(0, remaining));
          break;
        }
        remaining -= secLen;
      }
    } else {
      // On the spine (before split, after rejoin, or eastern corridor throughout)
      let axisMile;
      if (useWest && cumMile >= spineBeforeSplit + corridorLen) {
        // After western corridor rejoins spine
        const afterMile = cumMile - corridorLen + (rejoinAxisMile - branchAxisMile);
        axisMile = isNobo
          ? FT_SPINE_MIN + afterMile
          : (isBw ? FT_BW_END : FT_SPINE_MAX) - afterMile;
      } else {
        axisMile = spineStart + spineSign * cumMile;
      }

      axisMile = Math.max(FT_SPINE_MIN, Math.min(isBw ? FT_BW_END : FT_SPINE_MAX, axisMile));
      point = getNearestSpinePoint(axisMile);
    }

    if (point) hikePoints.push({ date, point });
  }

  return hikePoints;
}

/**
 * Find the nearest sampled normals record to a given axis_mile.
 * Falls back to nearest sample when the exact point ID isn't in the normals map.
 */
function getNearestNormals(point) {
  // Fast path: exact match
  const direct = normalsByPointId.get(point.id);
  if (direct?.hi?.length) return direct;

  // Fallback: binary search normalsSortedByMile for nearest axis_mile
  const target = point.axis_mile;
  const arr = normalsSortedByMile;
  if (!arr.length) return null;

  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].axis_mile < target) lo = mid + 1;
    else hi = mid;
  }
  // Check both neighbours and pick closer one
  const candidates = [arr[Math.max(0, lo - 1)], arr[lo]].filter(Boolean);
  const best = candidates.reduce((a, b) =>
    Math.abs(a.axis_mile - target) <= Math.abs(b.axis_mile - target) ? a : b
  );
  return normalsByPointId.get(best.id) || null;
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

    // Hottest by apparent high (most dangerous heat)
    const heatVal = isFinite(avgAppHigh) ? avgAppHigh : avgHigh;
    if (!hottest || heatVal > (isFinite(hottest.appHigh) ? hottest.appHigh : hottest.avgHigh)) {
      hottest = { date, point, avgHigh, avgLow, appHigh: avgAppHigh, appLow: avgAppLow, rhHigh: avgRhHigh, rhLow: avgRhLow };
    }

    // Coldest by apparent low (most dangerous cold)
    const coldVal = isFinite(avgAppLow) ? avgAppLow : avgLow;
    if (!coldest || coldVal < (isFinite(coldest.appLow) ? coldest.appLow : coldest.avgLow)) {
      coldest = { date, point, avgHigh, avgLow, appHigh: avgAppHigh, appLow: avgAppLow, rhHigh: avgRhHigh, rhLow: avgRhLow };
    }
  }

  return { hottest, coldest };
}

function renderDurExtremesBlocks(hottest, coldest, opts = {}) {
  renderDurExtremesBlocksShared(hottest, coldest, {
    formatLocation: (rec) => ftPointLabel(rec.point),
    ...opts
  });
}

function renderDurExtremesMap(hottest, coldest) {
  const mapEl = el("durExtremesMap");
  if (!mapEl || typeof L === "undefined") return;

  if (!durMap) {
    durMap = L.map("durExtremesMap", { zoomControl: true })
               .setView([27.5, -82.5], 6);
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
  durMap.fitBounds(bounds, { padding: [30,30] });
  try { durMap.invalidateSize(); } catch {}
}

async function computeAndRenderDurationExtremes(params) {
  const { startDate, durationDays, totalMiles, startDateLabel = "Start Date" } = params;
  setDisplayIfExists("durExtremesWrap", "none");
  setHtmlIfExists("durExtremesHot", "");
  setHtmlIfExists("durExtremesCold", "");
  if (el("bestStartResult")) el("bestStartResult").innerHTML = "";

  if (!normalsByPointId.size) {
    setDurStatus("Temperature extremes unavailable — historical_weather.json not loaded.");
    return;
  }
  if (!allPoints.length) {
    setDurStatus("Trail points still loading — please try again.");
    return;
  }

  const hikePoints = buildHikePoints(params);
  if (!hikePoints.length) {
    setDurStatus("Could not compute hike path — check data loading.");
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

  // Heat index advisory: if the hottest apparent high reaches 100 °F or above,
  // append a warning to the duration result block (mirrors NWS Heat Advisory threshold).
  const peakHeatIndex = hottest?.appHigh ?? hottest?.avgHigh;
  if (peakHeatIndex != null && peakHeatIndex >= 100) {
    const hiRounded = Math.round(peakHeatIndex);
    const durResult = el("durResult");
    if (durResult) {
      const warn = document.createElement("p");
      warn.style.cssText = "color:#9a4000; font-weight:600; margin-top:0.75rem;";
      warn.textContent = `⚠ Heat advisory: the hottest day on your hike has an estimated heat index of ${hiRounded} °F — at or above the 100 °F National Weather Service Heat Advisory threshold. Plan for early morning starts, ample hydration, and extra rest during peak heat.`;
      durResult.appendChild(warn);
    }
  }
}

function runDurationCalculator() {
  setDurStatus("");
  setHtmlIfExists("durResult", "");
  setDisplayIfExists("durExtremesWrap", "none");

  const direction  = el("durDirectionSelect")?.value || "NOBO_PICKENS";
  const monthDay   = getSelectedMonthDay("durMonthSelect","durDaySelect");
  const mpd        = numVal("durMilesPerDay");
  const selectedAlts = getSelectedAlts();

  if (!monthDay) { setDurStatus("Please choose a start date."); return; }
  if (mpd == null || mpd <= 0) { setDurStatus("Please enter miles per day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }

  const totalMiles  = calcTotalMiles(direction, selectedAlts);
  const durationDays = Math.ceil(totalMiles / mpd);

  if (durationDays > 365) {
    setDurStatus("Estimated duration exceeds one year. Please increase miles per day.");
    return;
  }

  const startDate = resolveStartDate(monthDay);
  const endDate   = addDays(startDate, durationDays - 1);

  renderDurationResult({ direction, startDate, endDate, totalMiles, milesPerDay: mpd, durationDays });

  if (normalsByPointId.size > 0 && allPoints.length > 0) {
    computeAndRenderDurationExtremes({
      direction, startDate, milesPerDay: mpd, totalMiles, durationDays, selectedAlts
    }).catch(err => {
      console.error("[FT] extremes error:", err);
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

  const direction    = el("durDirectionSelect")?.value || "NOBO_PICKENS";
  const selectedAlts = getSelectedAlts();
  const mpd          = numVal("durMilesPerDay");

  if (mpd == null || mpd <= 0) { setDurStatus("Please enter Miles per Day."); return; }
  if (mpd < 5) { setDurStatus("For this planner, hikes must average at least 5 miles per day."); return; }
  if (!normalsByPointId.size) { setDurStatus("Historical weather data is still loading. Please try again."); return; }
  if (!allPoints.length) { setDurStatus("Trail data is still loading. Please try again."); return; }

  const totalMiles   = calcTotalMiles(direction, selectedAlts);
  const durationDays = Math.ceil(totalMiles / mpd);
  if (durationDays > 365) { setDurStatus("For this planner, hikes cannot exceed one year. Please adjust Miles per Day."); return; }

  const { bestStartDate } = runBestStartShared({
    durationDays,
    getHikePoints: (startDate) => buildHikePoints({ direction, startDate, milesPerDay: mpd, totalMiles, selectedAlts }),
    getNormals: (point) => getNearestNormals(point),
  });

  if (!bestStartDate) {
    setHtmlIfExists("bestStartResult",
      `<p style="color:#b00000; font-weight:600; margin-top:0.75rem;">No valid start date found \u2014 every possible start date includes at least one day of extreme heat or cold stress. Try adjusting miles per day.</p>`);
    return;
  }

  computeAndRenderDurationExtremes({
    direction, startDate: bestStartDate, milesPerDay: mpd, totalMiles, durationDays, selectedAlts,
    startDateLabel: "<em>BestStart!</em> Date"
  }).catch(err => { console.error(err); setDurStatus(`Error: ${err.message}`); });
}

/* ============================================================
   23. SECTION SELECTOR WIRING  (Weather Tool)
   ============================================================ */

/**
 * Populate the section dropdown for the given region.
 * Uses ft_meta if loaded, otherwise falls back to FT_SECTIONS_BOOTSTRAP.
 * Shows ALL sections (including alts) so the user can look up weather
 * anywhere on the trail, including alternate routes.
 */
function populateSections(regionId) {
  const sel = el("sectionSelect");
  if (!sel) return;
  sel.innerHTML = "";

  const source = ftMeta?.sections?.length
    ? ftMeta.sections
    : (window.FT_SECTIONS_BOOTSTRAP || []);

  const inRegion = source.filter(s => s.region_id === regionId);

  for (const s of inRegion) {
    const opt = document.createElement("option");
    opt.value = s.id;
    let label = s.name;
    if (s.is_alt) label += " *";
    opt.textContent = label;
    sel.appendChild(opt);
  }

  updateSectionInfo();
}

function updateSectionInfo() {
  const sectionId = el("sectionSelect")?.value;
  const infoEl    = el("ftSectionInfo");
  const mileInput = el("ftMileInput");
  if (!sectionId || !infoEl) return;

  const source = ftMeta?.sections?.length
    ? ftMeta.sections
    : (window.FT_SECTIONS_BOOTSTRAP || []);
  const sec = source.find(s => s.id === sectionId);
  if (!sec) return;

  if (sec.mile_start == null) {
    infoEl.textContent = "Named/roadwalk route — enter miles from your section entry point (0–99).";
    if (mileInput) { mileInput.min=0; mileInput.max=99; mileInput.placeholder="e.g., 10"; }
  } else {
    const len = sec.mile_end - sec.mile_start;
    infoEl.textContent = `Section Range: 0-${len} Miles`;
    if (mileInput) {
      mileInput.min=0; mileInput.max=len;
      mileInput.placeholder = `e.g., ${Math.round(len/2)}`;
      const cur = Number(mileInput.value);
      if (!cur || cur < 0 || cur > len) mileInput.value = "";
    }
  }
}

/* ============================================================
   24. UI INITIALIZATION
   ============================================================ */

function initDurationUI() {
  initMonthDayPickerGeneric("durMonthSelect","durDaySelect");
  const btn = el("durBtn");
  if (btn) btn.addEventListener("click", runDurationCalculator);
  el("bestStartBtn")?.addEventListener("click", runBestStart);
  const mpdEl = el("durMilesPerDay");
  if (mpdEl && mpdEl.value === "") mpdEl.value = "12";
}

function initWeatherUI() {
  el("goBtn")?.addEventListener("click", runWeather);

  const regionSel  = el("regionSelect");
  const sectionSel = el("sectionSelect");

  if (regionSel) {
    regionSel.addEventListener("change", () => populateSections(regionSel.value));
  }
  if (sectionSel) {
    sectionSel.addEventListener("change", updateSectionInfo);
  }

  initMonthDayPickerGeneric("monthSelect","daySelect");
}

/* ============================================================
   25. MAIN
   ============================================================ */

async function main() {
  initDurationUI();
  initWeatherUI();

  // Boot section dropdowns from inline bootstrap immediately
  const regionSel = el("regionSelect");
  if (regionSel) {
    populateSections(regionSel.value);
  }

  // Initialize weather map (lazy — only shows when Get Weather is clicked)
  initMap();
  loadTrailOverlay();

  // Load ft_meta.json (non-blocking but important — re-populates sections if loaded)
  loadFtMeta()
    .then(() => {
      // Re-populate section dropdown with canonical meta data
      const rid = el("regionSelect")?.value;
      if (rid) populateSections(rid);
    })
    .catch(e => console.warn("[FT] ft_meta not loaded:", e));

  // Load points
  try {
    await loadPoints();

    // Fit weather map to trail extent
    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20,20] });
    }

  } catch (err) {
    console.error("[FT] loadPoints failed:", err);
  }

  // Load precomputed normals (best-effort)
  try {
    await loadPrecomputedNormals();
    if (normalsMeta?.source) {
      setDurStatus(`Historical weather data loaded (${normalsMeta.source}).`);
    } else {
      setDurStatus(""); // normals loaded silently
    }
  } catch (e) {
    console.warn("[FT] normals not loaded:", e);
    setDurStatus("Temperature extremes unavailable — historical_weather.json not found.");
  }

  setTimeout(refreshMapSize, 250);
}

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => main().catch(console.error));
} else {
  main().catch(console.error);
}
