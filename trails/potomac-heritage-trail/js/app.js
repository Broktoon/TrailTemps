/* Potomac Heritage National Scenic Trail Weather Planner — app.js
   ---------------------------------------------------------------
   Tool A: Hike duration / end-date calculator
           - 2 direction options (Westbound / Eastbound)
           - DC route: City Park Trail (the main spine) or the River Trail
             alternate, which is shorter. Every length is read from the data.
   Tool A+: Temperature extremes across the hike
           - Uses precomputed normals (historical_weather.json, ~5-mile intervals)
           - No elevation correction (low-elevation trail)
           - Heat index advisory when apparent high ≥ 100 °F
           - Wind chill advisory when apparent low ≤ 20 °F
   Tool B: Weather planner
           - Region selector → Section selector → Section Mile → Date
           - A "section" is the main route within a region, the DC alternate,
             or a named side trail. Includes the Virginia and Eastern
             Continental Divide side trails, which are not on the hike route.
           - Open-Meteo forecast (5-day) + current conditions
           - 7-year planning average high/low
           - Apparent temperature (Steadman: heat index + wind chill)
   Maps: Leaflet + OSM tiles + trail.geojson overlay
         - Spine and alternate: full opacity
         - Side trails (VA, ECD, spurs): reduced opacity
         - Youghiogheny paddle route: dashed; drawn, not walked
   Data: canonical 7-field points.json, hydrated at load from pht_meta.json
         by /js/hydrate-points.js. Rebuilt in SectionsHiked from the NPS POHE
         centerline; mile 0 is Laurel Ridge, PA and the axis runs east.
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

// No mileage is written down in this file. The spine length, where the DC
// alternate leaves and rejoins, and both DC route lengths are all measured
// from points.json and pht_meta.json at load (see resolveDcAlternate). The
// constants that used to sit here went stale the moment NPS republished the
// layer, and the spine total among them outlived the route it described.

// The two values of the "dcRoute" radio group in index.html.
const DC_MAIN_CHOICE = "city-park-trail";   // the spine
const DC_ALT_CHOICE  = "river-trail";       // the one alternate

// Side trails shorter than this are left out of the Weather Planner's section
// list. They stay in the data and on the map. The NPS layer cuts the Virginia
// network into 171 side routes, 66 of them under half a mile (a bridge, a
// park entrance, one block of a street), and a planner list that long buries
// the trails people are looking for. Weather does not vary over half a mile.
const WP_MIN_SIDE_TRAIL_MILES = 0.5;

/* ============================================================
   4. MODULE-LEVEL STATE
   ============================================================ */

let allPoints     = [];
let spinePoints   = [];          // route "main" only, sorted by mile (west to east)
let pointsByRoute = new Map();   // route_id → points sorted by that route's mile

let phtMeta     = null;
let routeById   = new Map();     // route_id → pht_meta.routes entry
let regionById  = new Map();     // region_id → pht_meta.regions entry

// The DC alternate, resolved against the spine at load. null if the data has
// no alternate. { route, lo, hi, length, zeroAtLo, points }
let dcAlt = null;

// One entry per thing the Weather Planner can look up: the main route within
// a region, the alternate, or a side trail. key → place.
let wpPlaces     = [];
let wpPlaceByKey = new Map();

// The walked line for each DC choice, built once. choice → { axis, total }
let hikeAxisCache = new Map();

let normalsByPointId = new Map();   // point.id → normals
let normalsSamples   = [];          // [{ id, lat, lon }] where weather was sampled
let normalsMemo      = new Map();   // point.id → normals found by location

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

// Which Weather Planner place a point belongs to. A spine point belongs to
// its region's stretch of the main route; anything else to its own route.
function placeKeyOf(point) {
  return point.route_id === "main" ? "main|" + point.region_id : point.route_id;
}

function phtPointLabel(point) {
  const place = wpPlaceByKey.get(placeKeyOf(point));
  if (!place) return point.region_name || "Unknown";
  return `${place.name} \u2014 Mile ${fmtMile(place.mileOf(point))}`;
}

/* ============================================================
   7. MILEAGE CALCULATION
   ============================================================ */

function getSelectedAlts() {
  const dcVal = document.querySelector('input[name="dcRoute"]:checked')?.value || DC_MAIN_CHOICE;
  return { "dc-route": dcVal };
}

// Total distance walked for a DC choice, or null while the trail data is
// still loading. Direction does not change the distance on this trail.
function calcTotalMiles(directionId, selectedAlts) {
  if (!spinePoints.length) return null;
  return getHikeAxis(selectedAlts?.["dc-route"]).total;
}

/* ============================================================
   8. DATA LOADING
   ============================================================ */

async function loadPhtMeta() {
  // Deliberately NOT kept in localStorage any more. This file used to hold
  // labels, and a 30-day-old copy only showed a stale name. It now holds the
  // tables every point is rebuilt from, so it must be the same vintage as
  // points.json, which is revalidated on every load. A cached meta file paired
  // with fresh points after a data update would hand out wrong regions and
  // ids with no error. "no-cache" revalidates, so an unchanged file costs one
  // conditional request.
  const r = await fetch(META.phtMetaUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`pht_meta.json fetch failed (${r.status})`);
  phtMeta    = await r.json();
  routeById  = new Map((phtMeta.routes  || []).map(r => [r.id, r]));
  regionById = new Map((phtMeta.regions || []).map(r => [r.id, r]));
  console.log("[PHT] pht_meta loaded:", routeById.size, "routes,", regionById.size, "regions");
}

async function loadPoints() {
  // points.json stores only lat, lon, mile, route_id, route_type and state.
  // Everything else this file reads off a point (id, region, route_kind) is
  // rebuilt from the meta file, so the meta has to be here first.
  if (!phtMeta) throw new Error("pht_meta.json must be loaded before points.json");

  const r = await fetch(META.pointsUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`points.json fetch failed (${r.status})`);
  const data = await r.json();

  allPoints = hydratePoints(data, phtMeta)
    .filter(p => isFinite(Number(p.lat)) && isFinite(Number(p.lon)) && p.mile != null)
    .map(p => ({
      ...p,
      lat:  Number(p.lat),
      lon:  Number(p.lon),
      id:   String(p.id),
      mile: Number(p.mile),
    }));

  // A mile is only meaningful within one route: every side trail restarts at
  // zero. So points are grouped by route before anything is sorted by mile.
  pointsByRoute = new Map();
  for (const p of allPoints) {
    if (!pointsByRoute.has(p.route_id)) pointsByRoute.set(p.route_id, []);
    pointsByRoute.get(p.route_id).push(p);
  }
  for (const pts of pointsByRoute.values()) pts.sort((a, b) => a.mile - b.mile);

  spinePoints   = pointsByRoute.get("main") || [];
  hikeAxisCache = new Map();

  resolveDcAlternate();
  buildWeatherPlaces();

  console.log("[PHT] points loaded:", allPoints.length,
    "(spine:", spinePoints.length, ", routes:", pointsByRoute.size,
    ", planner places:", wpPlaces.length, ")");
}

async function loadPrecomputedNormals() {
  // historical_weather.json — rely on HTTP cache (may be large)
  const r = await fetch(META.normalsUrl);
  if (!r.ok) throw new Error(`historical_weather.json fetch failed (${r.status})`);
  const payload = await r.json();

  normalsByPointId = new Map();
  normalsSamples   = [];
  normalsMemo      = new Map();

  for (const p of (payload.points || [])) {
    if (!p?.id) continue;
    const id = String(p.id);
    normalsByPointId.set(id, {
      hi:     p.hi     || [],
      lo:     p.lo     || [],
      app_hi: p.hi_app || p.hi || [],
      app_lo: p.lo_app || p.lo || [],
      rh_hi:  p.rh_hi  || [],
      rh_lo:  p.rh_lo  || [],
      ws:     p.ws     || [],
    });

    // lat/lon here is where ERA5-Land was sampled, which the migration keeps
    // even though the id now names the nearest trail point.
    if (p.hi?.length && isFinite(Number(p.lat)) && isFinite(Number(p.lon))) {
      normalsSamples.push({ id, lat: Number(p.lat), lon: Number(p.lon) });
    }
  }

  console.log("[PHT] normals loaded:", normalsByPointId.size, "points");
  setDurStatus("Historical weather data loaded (" + normalsByPointId.size + " points).");
  setTimeout(() => setDurStatus(""), 4000);
}

/* ============================================================
   9. TRAIL GEOJSON OVERLAY
   ============================================================ */

async function fetchTrailGeojson() {
  // _v2 for the same reason as the meta file: the rebuilt geojson carries
  // route_kind where the old one carried on_spine, so a cached _v1 copy would
  // draw every feature in the wrong style.
  const key    = `trail_geojson_${trailSlug}_v2`;
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
// Drawn for corridor completeness but not walked: the Youghiogheny River
// paddle route. It carries no mileage and no points.
const TRAIL_STYLE_NOT_WALKED = {
  color: "#e06060", weight: 2, opacity: 0.45, dashArray: "6 6", lineCap: "butt", lineJoin: "round"
};

// The geojson tags each feature with the canonical route fields.
//   route_id "roadwalk"  the NON-hikeable sense of that tag: a connector drawn
//                        for continuity only. On this trail, the paddle route.
//   route_kind "side"    additional to the through-route; available in the
//                        Weather Planner, never on the hike.
//   anything else        the spine or the DC alternate.
// Road-walked stretches of the spine (route_type "roadwalk") are hikeable and
// counted, and stay solid: about a third of the spine is on roads.
function trailFeatureStyle(feature) {
  const p = feature.properties || {};
  if (p.route_id === "roadwalk") return TRAIL_STYLE_NOT_WALKED;
  if (p.route_kind === "side")   return TRAIL_STYLE_WP;
  return TRAIL_STYLE;
}

function applyTrailOverlay(targetMap, haloRef, layerRef, onDone) {
  fetchTrailGeojson()
    .then(geojson => {
      if (haloRef.current)  { try { targetMap.removeLayer(haloRef.current);  } catch {} }
      if (layerRef.current) { try { targetMap.removeLayer(layerRef.current); } catch {} }

      layerRef.current = L.geoJSON(geojson, {
        style: trailFeatureStyle,
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

/** Nearest spine point to a location. Used once, to seat the DC alternate. */
function nearestSpinePointByLocation(lat, lon) {
  let best = null, bd = Infinity;
  for (const p of spinePoints) {
    const d = haversineMiles(lat, lon, p.lat, p.lon);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8, t = Math.PI / 180;
  const dLat = (lat2 - lat1) * t, dLon = (lon2 - lon1) * t;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Work out where the DC alternate leaves and rejoins the spine, from the
 * geometry itself.
 *
 * The meta file records one junction (junction_mile) and the alternate's
 * length, but not the mile where it rejoins, so the far end is found by
 * snapping each end of the alternate to the spine. `lo` and `hi` are the two
 * spine miles in axis order; the stretch of spine between them is what the
 * alternate replaces.
 *
 * zeroAtLo records which way the alternate's own mile runs, so it can be
 * walked in axis order whichever end NPS happened to digitise first.
 */
function resolveDcAlternate() {
  dcAlt = null;
  const route = (phtMeta?.routes || []).find(r => r.kind === "alternate");
  const pts   = route ? pointsByRoute.get(route.id) : null;
  if (!route || !pts?.length || !spinePoints.length) return;

  const first = pts[0], last = pts[pts.length - 1];
  const a = nearestSpinePointByLocation(first.lat, first.lon);
  const b = nearestSpinePointByLocation(last.lat,  last.lon);
  const zeroAtLo = a.mile <= b.mile;

  dcAlt = {
    route,
    lo:     Math.min(a.mile, b.mile),
    hi:     Math.max(a.mile, b.mile),
    length: last.mile - first.mile,
    zeroAtLo,
    // In axis order: from the lo junction to the hi junction.
    points: zeroAtLo ? pts : pts.slice().reverse(),
  };
  console.log("[PHT] DC alternate:", route.name, fmtMile(dcAlt.length), "mi, replacing spine mile",
    dcAlt.lo, "to", dcAlt.hi, "(" + fmtMile(dcAlt.hi - dcAlt.lo) + " mi)");
}

/**
 * The line a hiker walks for one DC choice, as an ordered list of
 * { h, point } where h is miles from the western terminus.
 *
 * Main route: the spine, as is.
 * Alternate:  the spine up to `lo`, then the alternate, then the spine from
 *             `hi`, with everything after shifted by the miles saved.
 *
 * Built once per choice and reused: BestStart! walks this line 365 times.
 */
function getHikeAxis(dcChoice) {
  const useAlt = dcChoice === DC_ALT_CHOICE && dcAlt;
  const key    = useAlt ? "alt" : "main";
  if (hikeAxisCache.has(key)) return hikeAxisCache.get(key);

  const axis = [];
  const base = spinePoints.length ? spinePoints[0].mile : 0;

  if (!useAlt) {
    for (const p of spinePoints) axis.push({ h: p.mile - base, point: p });
  } else {
    const { lo, hi, length, points, zeroAtLo } = dcAlt;
    const altStart = points[0].mile;
    for (const p of spinePoints) {
      if (p.mile <= lo) axis.push({ h: p.mile - base, point: p });
    }
    for (const p of points) {
      const along = zeroAtLo ? p.mile - altStart : altStart - p.mile;
      axis.push({ h: (lo - base) + along, point: p });
    }
    for (const p of spinePoints) {
      if (p.mile >= hi) axis.push({ h: (lo - base) + length + (p.mile - hi), point: p });
    }
  }

  const built = { axis, total: axis.length ? axis[axis.length - 1].h : 0 };
  hikeAxisCache.set(key, built);
  return built;
}

/** Look up the nearest point within a Weather Planner place by its displayed mile */
function getNearestPlacePoint(placeKey, mile) {
  const place = wpPlaceByKey.get(placeKey);
  if (!place) return null;
  return binaryNearest(place.points, mile, place.mileOf);
}

/**
 * Find normals for any point: its own if it has them, otherwise the sample
 * nearest to it on the ground.
 *
 * Nearest by LOCATION, not by mile. On a single line the two agree, which is
 * why the other trails use mile. This trail is a network, and each of its 171
 * side trails restarts at mile zero, so a mile comparison across routes would
 * be comparing unrelated numbers. Every point is within 4.7 miles of a sample
 * (2.5 on the spine), inside one ERA5-Land cell; migrate-pht-canonical.js
 * checks that and fails if it stops being true.
 *
 * Squared equirectangular distance is enough to rank 216 samples a few miles
 * apart, and the answer is remembered per point.
 */
function getNearestNormals(point) {
  const direct = normalsByPointId.get(point.id);
  if (direct?.hi?.length) return direct;

  if (normalsMemo.has(point.id)) return normalsMemo.get(point.id);

  let best = null, bd = Infinity;
  const cosLat = Math.cos(point.lat * Math.PI / 180);
  for (const s of normalsSamples) {
    const dy = s.lat - point.lat;
    const dx = (s.lon - point.lon) * cosLat;
    const d  = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = s; }
  }
  const found = best ? (normalsByPointId.get(best.id) || null) : null;
  normalsMemo.set(point.id, found);
  return found;
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

// UI-only display names, keyed by the route name NPS publishes.
const ROUTE_DISPLAY_NAMES = {
  // The Duration Calculator and the page text call the alternate the DC
  // River Trail; NPS names its longest piece. One name for one route.
  "Potomac River Trail": "DC River Trail",
  "Ent to Red Rock Wilderness Overlook Regional Park": "Red Rock Wilderness Overlook",
  "Belmont Ferry Farm Trail to Rappahannock River Heritage Trail Connector": "Belmont Ferry to Rappahannock Trail",
};

function routeDisplayName(route) {
  const name = (route.name || "").trim();
  return ROUTE_DISPLAY_NAMES[name] || name;
}

// A quarter of the side network by length (34 routes, 75 miles) carries no
// name in any NPS field. A route that cannot be offered by name is left out
// of the section list; it stays in the data and on the map.
function isUnnamedRoute(route) {
  return /^Unnamed\b/i.test((route.name || "").trim());
}

function addWeatherPlace(place) {
  wpPlaces.push(place);
  wpPlaceByKey.set(place.key, place);
}

/**
 * Build the list of things the Weather Planner can look up.
 *
 * The old data had 48 named sections. The rebuilt data has none (NPS
 * publishes no section scheme for this trail), so a "section" here is one of:
 *
 *   the main route within one region   key "main|<region id>"
 *   the DC alternate                   key "<route id>"
 *   a side trail                       key "<route id>"
 *
 * Each place carries its own mileOf(), the mile shown to the user, and its
 * points sorted by that mile, so lookup and labelling cannot disagree.
 */
function buildWeatherPlaces() {
  wpPlaces     = [];
  wpPlaceByKey = new Map();

  // The main route. Miles count from each region's EASTERN end, as this page
  // always has: the C&O towpath and the Great Allegheny Passage are both
  // mileposted from their east ends. The data's own axis runs the other way
  // (mile 0 is Laurel Ridge), so the shown mile is measured back from the
  // region's easternmost point.
  for (const region of (phtMeta?.regions || [])) {
    const pts = spinePoints.filter(p => p.region_id === region.id);
    if (!pts.length) continue;
    const eastMile = pts[pts.length - 1].mile;
    addWeatherPlace({
      key:      "main|" + region.id,
      regionId: region.id,
      kind:     "spine",
      name:     region.name,
      length:   eastMile - pts[0].mile,
      mileOf:   p => eastMile - p.mile,
      points:   pts.slice().reverse(),
      listed:   true,
    });
  }

  // The alternate and the side trails, one place per route. A side trail has
  // no position on the trail axis, so its mile simply runs from the end NPS
  // digitised first. The alternate is turned to count from its eastern end,
  // to match the main route beside it.
  for (const route of (phtMeta?.routes || [])) {
    if (route.kind === "spine") continue;
    const pts = pointsByRoute.get(route.id);
    if (!pts?.length) continue;

    const first    = pts[0].mile;
    const last     = pts[pts.length - 1].mile;
    const isAlt    = route.kind === "alternate";
    const fromEast = isAlt && dcAlt && dcAlt.route.id === route.id && dcAlt.zeroAtLo;

    // The route's published length, not the span of its points. Points sit
    // every 0.05 mi and the last can fall up to that far short of the route's
    // true end: two half-mile trails have their last point at 0.45, and
    // judged by their points they dropped out of the section list.
    const length = Number.isFinite(route.miles) ? route.miles : (last - first);

    addWeatherPlace({
      key:      route.id,
      regionId: route.region_id,
      kind:     route.kind,
      name:     routeDisplayName(route),
      length,
      mileOf:   fromEast ? (p => last - p.mile) : (p => p.mile - first),
      points:   fromEast ? pts.slice().reverse() : pts,
      listed:   isAlt || (!isUnnamedRoute(route) && length >= WP_MIN_SIDE_TRAIL_MILES),
    });
  }
}

// The places offered for one region: main route first, then the alternate,
// then side trails longest first.
function placesForRegion(regionId) {
  const rank = { spine: 0, alternate: 1, side: 2 };
  return wpPlaces
    .filter(p => p.regionId === regionId && p.listed)
    .sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.length - a.length));
}

function placeOptionLabel(place, siblings) {
  if (place.kind === "spine")     return place.name + " (main route)";
  if (place.kind === "alternate") return place.name + " (alternate)";
  // NPS reuses names: there are two Ridge Rds and three pieces of the Mount
  // Vernon Trail. Their lengths tell them apart.
  const shared = siblings.filter(s => s.name === place.name).length > 1;
  return shared ? `${place.name} (${fmtMile(place.length)} mi)` : place.name;
}

// Regions on the main route are listed east to west, the page's primary
// direction; the side regions follow in the order the meta file gives them.
function populateRegionSelect() {
  const regionSel = el("phtRegionSelect");
  if (!regionSel) return;

  const regions  = (phtMeta?.regions || []).filter(r => placesForRegion(r.id).length > 0);
  const onSpine  = regions.filter(r => r.on_spine).sort((a, b) => b.mile_start - a.mile_start);
  const offSpine = regions.filter(r => !r.on_spine);
  const ordered  = [...onSpine, ...offSpine];

  const previous = regionSel.value;
  regionSel.innerHTML = "";
  for (const region of ordered) {
    const opt = document.createElement("option");
    opt.value = region.id;
    opt.textContent = region.name;
    regionSel.appendChild(opt);
  }
  if (ordered.some(r => r.id === previous)) regionSel.value = previous;

  populateSectionSelect(regionSel.value);
}

function populateSectionSelect(regionId) {
  const sectionSel = el("phtSectionSelect");
  if (!sectionSel) return;

  const places = placesForRegion(regionId);
  sectionSel.innerHTML = "";
  for (const place of places) {
    const opt = document.createElement("option");
    opt.value = place.key;
    opt.textContent = placeOptionLabel(place, places);
    sectionSel.appendChild(opt);
  }
  updateSectionInfo();
}

function updateSectionInfo() {
  const place     = wpPlaceByKey.get(el("phtSectionSelect")?.value);
  const infoEl    = el("phtSectionInfo");
  const mileInput = el("phtMileInput");
  if (!place || !infoEl) return;

  infoEl.textContent = `Section Range: 0\u2013${fmtMile(place.length)} Miles`;

  if (mileInput) {
    const mid = place.length / 2;
    mileInput.placeholder = `e.g., ${place.length >= 4 ? Math.round(mid) : fmtMile(mid)}`;
    const cur = Number(mileInput.value);
    if (cur < 0 || cur > place.length) mileInput.value = "";
  }
}

// The two DC route lengths shown beside the radio buttons come from the data,
// so they cannot drift from what the calculator actually uses.
function updateDcRouteLabels() {
  if (!dcAlt) return;
  const mainLen = dcAlt.hi - dcAlt.lo;
  const altLen  = dcAlt.length;
  const mainEl  = el("dcMainMiles");
  const altEl   = el("dcAltMiles");
  if (mainEl) mainEl.textContent = `${fmtMile(mainLen)} mi: `;
  if (altEl)  altEl.textContent  = `${fmtMile(altLen)} mi (${fmtMile(mainLen - altLen)} mi shorter): `;
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

  // The select's value is a Weather Planner place key (see buildWeatherPlaces).
  const place = wpPlaceByKey.get(sectionId);
  if (place && mile > place.length) {
    setWeatherStatus(`Please enter a mile between 0 and ${fmtMile(place.length)} for this section.`);
    return;
  }

  const point = getNearestPlacePoint(sectionId, mile);
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

function directionLabel(directionId) {
  const termini = phtMeta?.trail?.termini || {};
  const east = termini.east || "Point Lookout, MD";
  const west = termini.west || "Laurel Ridge, PA";
  return directionId === "westbound"
    ? `Westbound \u2014 ${east} \u2192 ${west}`
    : `Eastbound \u2014 ${west} \u2192 ${east}`;
}

function dcRouteLabel(dcChoice) {
  if (dcChoice === DC_ALT_CHOICE && dcAlt) {
    const saved = (dcAlt.hi - dcAlt.lo) - dcAlt.length;
    return `DC River Trail (${fmtMile(saved)} mi shorter)`;
  }
  return "DC City Park Trail";
}

function renderDurationResult({ directionId, startDate, endDate, totalMiles, milesPerDay, durationDays, selectedAlts }) {
  const startStr = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr   = endDate.toLocaleDateString(undefined,   { year: "numeric", month: "long", day: "numeric" });

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${directionLabel(directionId)}</td></tr>
      <tr><th>D.C. Route</th><td>${dcRouteLabel(selectedAlts?.["dc-route"])}</td></tr>
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
 * Build the ordered sequence of trail points for a hike, one per day.
 *
 * getHikeAxis returns the walked line measured from the western terminus,
 * with the DC alternate already spliced in if it was chosen. A day's position
 * is then only a distance along that line:
 *
 *   Eastbound (Laurel Ridge to Point Lookout):  the distance walked
 *   Westbound (Point Lookout to Laurel Ridge):  the total minus the distance walked
 *
 * This replaced three hand-written zones (before DC, inside DC, after DC) for
 * each direction, each with its own offset arithmetic against constants.
 */
function buildHikePoints({ directionId, startDate, milesPerDay, totalMiles, selectedAlts }) {
  const { axis, total } = getHikeAxis(selectedAlts?.["dc-route"]);
  if (!axis.length) return [];

  const durationDays = Math.ceil(totalMiles / milesPerDay);
  const isWestbound  = directionId === "westbound";
  const hikePoints   = [];

  for (let i = 0; i < durationDays; i++) {
    const date   = addDays(startDate, i);
    const walked = Math.min(milesPerDay * i, total);
    const entry  = binaryNearest(axis, isWestbound ? total - walked : walked, e => e.h);
    if (entry) hikePoints.push({ date, point: entry.point });
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
  // The distance is measured from points.json, so there is none until it loads.
  if (totalMiles == null) { setDurStatus("Trail data is still loading. Please try again in a moment."); return; }
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
  // The distance is measured from points.json, so there is none until it loads.
  if (totalMiles == null) { setDurStatus("Trail data is still loading. Please try again in a moment."); return; }
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

  // Both selects are filled by populateRegionSelect() once the trail data has
  // loaded: the list of regions and sections is read from that data.
  if (regionSel) {
    regionSel.addEventListener("change", () => {
      populateSectionSelect(regionSel.value);
    });
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

  // Meta first, then points: points.json holds only position, mile and route,
  // and the rest is rebuilt from the meta file, so the order is not optional. The region and
  // section lists, and the DC route lengths, are filled in from the result.
  try {
    await loadPhtMeta();
    await loadPoints();

    populateRegionSelect();
    updateDcRouteLabels();

    if (map) {
      const b = boundsFromPoints(allPoints);
      if (b) map.fitBounds(b, { padding: [20, 20] });
    }
  } catch (err) {
    console.error("[PHT] trail data failed to load:", err);
    setWeatherStatus("Trail data could not be loaded. Please refresh the page.");
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
