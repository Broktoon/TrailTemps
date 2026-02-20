/* Appalachian Trail Weather Planner
   - Tool A: Hike duration / end-date calculator (independent)
   - Tool A enhancement: Temperature extremes across the hike (precomputed normals; no historical API calls)
   - Tool B: Weather lookup (State + Mile selection)
   - Leaflet map + OSM tiles
   - AT overlay from local "trail.geojson"
   - Points from points.json
   - Weather: Open-Meteo forecast (5 days) + current
   - Planning (Weather tool): 7-year planning average high/low for selected Month/Day (window-smoothed)
   - Units: Fahrenheit, mph
   - Caching: localStorage
*/

const trailSlug = window.TRAIL_SLUG || "appalachian-trail";

// Fixed paths:
const POINTS_URL = `/data/${trailSlug}/points.json`;
const AT_GEOJSON_URL = "/data/${trailSlug}/trail.geojson";

// Option B (precomputed normals) single-file dataset:
// Build this file locally using tools/build_planning_normals.js (included below in this response).
const NORMALS_URL = "/data/${trailSlug}/historical_weather.json";

// Open-Meteo endpoints
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const HIST_BASE     = "https://archive-api.open-meteo.com/v1/archive";

const FORECAST_DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "windspeed_10m_max"
].join(",");

const HIST_DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min"
].join(",");

// Planning smoothing: +/- 3 days
const TYPICAL_WINDOW_DAYS = 3;

// Caching
const FORECAST_TTL_MS = 30 * 60 * 1000;            // 30 minutes
const HIST_TTL_MS     = 24 * 60 * 60 * 1000;       // 24 hours
const AT_TTL_MS       = 30 * 24 * 60 * 60 * 1000;  // 30 days
const NORMALS_TTL_MS  = 30 * 24 * 60 * 60 * 1000;  // 30 days

let allPoints = [];
let allPointsSortedByMile = [];
let pointsByState = new Map();
let trailMinMiles = null;
let trailMaxMiles = null;
let trailTotalMiles = null;

// Precomputed normals
let normalsByPointId = new Map(); // pointId -> { hi:[365], lo:[365] }
let normalsMeta = null;

// Leaflet globals (Weather map)
let map;
let mapMarker;
let atLayer;
let atHaloLayer;

// Leaflet globals (Duration extremes map)
let durMap = null;
let durMapLayerGroup = null;
let durAtLayer = null;
let durAtHaloLayer = null;

// Map zoom requirements
const INITIAL_ZOOM = 4;
const SELECT_ZOOM  = 7;

const el = (id) => document.getElementById(id);

/* ---------------------------
   Shared utilities
---------------------------- */

function setDurStatus(msg) {
  const s = el("durStatus");
  if (s) s.textContent = msg;
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
  localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
}

function addDays(dateObj, days) {
  const d = new Date(dateObj.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function toISODate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtMile(m) {
  return (Math.round(Number(m) * 10) / 10).toFixed(1);
}

function pointLabel(p) {
  return `${p.state} – Mile ~${fmtMile(p.mile_est)}`;
}

function setHtmlIfExists(id, html) {
  const node = el(id);
  if (node) node.innerHTML = html;
}

function setDisplayIfExists(id, value) {
  const node = el(id);
  if (node) node.style.display = value;
}

/* ---------------------------
   Map sizing normalization:
   Make the Weather map (#map) use the same width as the Extremes map (#durExtremesMap).
   This avoids UI mismatch when the two tools are in different card layouts.
---------------------------- */
function syncWeatherMapWidthToExtremesMap() {
  // Do NOT change DOM widths; it causes snapping when the extremes map becomes visible.
  // Just tell Leaflet to re-measure its container if needed.
  refreshMapSize();
}

/* ---------------------------
   Pin icon for extremes map (teardrop marker, color-coded)
---------------------------- */
function makeColoredPinIcon(colorHex) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41">
      <path d="M12.5 0C5.6 0 0 5.6 0 12.5c0 10.2 12.5 28.5 12.5 28.5S25 22.7 25 12.5C25 5.6 19.4 0 12.5 0z"
            fill="${colorHex}" stroke="#333" stroke-width="1"/>
      <circle cx="12.5" cy="12.5" r="4.2" fill="#ffffff" opacity="0.95"/>
    </svg>
  `.trim();

  const url = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);

  return L.icon({
    iconUrl: url,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [0, -34]
  });
}

/* ---------------------------
   Month/Day picker (no year) – reusable
---------------------------- */
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function daysInMonth(monthIndex) {
  return new Date(2021, monthIndex + 1, 0).getDate(); // 2021 is non-leap
}

function formatMonthDayName(monthDay) {
  const [mmStr, ddStr] = monthDay.split("-");
  const mm = Number(mmStr);
  const dd = Number(ddStr);
  const name = MONTH_NAMES[mm - 1] || mmStr;
  return `${name} ${dd}`;
}

function initMonthDayPickerGeneric(monthSelectId, daySelectId) {
  const monthSel = el(monthSelectId);
  const daySel = el(daySelectId);
  if (!monthSel || !daySel) return;

  monthSel.innerHTML = "";
  MONTH_NAMES.forEach((name, i) => {
    const opt = document.createElement("option");
    opt.value = i + 1; // 1..12
    opt.textContent = name;
    monthSel.appendChild(opt);
  });

  function populateDays() {
    const monthIndex = Number(monthSel.value) - 1;
    const maxDays = daysInMonth(monthIndex);

    const prevDay = Number(daySel.value) || 1;
    daySel.innerHTML = "";

    for (let d = 1; d <= maxDays; d++) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      daySel.appendChild(opt);
    }

    daySel.value = Math.min(prevDay, maxDays);
  }

  monthSel.addEventListener("change", populateDays);

  // Default to today
  const today = new Date();
  monthSel.value = today.getMonth() + 1;
  populateDays();
  daySel.value = Math.min(today.getDate(), daysInMonth(today.getMonth()));
}

function getSelectedMonthDayFrom(monthSelectId, daySelectId) {
  const m = el(monthSelectId)?.value;
  const d = el(daySelectId)?.value;
  if (!m || !d) return null;
  return `${pad2(m)}-${pad2(d)}`; // "MM-DD"
}

/* ---------------------------
   Tool A: Hike duration / end-date calculator
---------------------------- */
function isKatahdinSnowSeason(dateObj) {
  // Snow season: Oct 15 - May 15 (inclusive)
  const m = dateObj.getMonth() + 1;
  const d = dateObj.getDate();

  if (m > 10) return true;
  if (m === 10 && d >= 15) return true;

  if (m < 5) return true;
  if (m === 5 && d <= 15) return true;

  return false;
}

function resolveStartDateFromMonthDay(monthDay) {
  // Interpret MM-DD as the next occurrence relative to today (including today)
  const [mmStr, ddStr] = monthDay.split("-");
  const mm = Number(mmStr);
  const dd = Number(ddStr);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let candidate = new Date(today.getFullYear(), mm - 1, dd);
  if (candidate < today) candidate = new Date(today.getFullYear() + 1, mm - 1, dd);
  return candidate;
}

function numVal(id) {
  const v = el(id)?.value;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function renderDurationResult({ direction, startDate, endDate, distanceMiles, milesPerDay, durationDays }) {
  // Katahdin is reached at the END for NOBO and at the START for SOBO (given full-trail assumption)
  const katahdinDate = (direction === "SOBO") ? startDate : endDate;
  const warningNeeded = isKatahdinSnowSeason(katahdinDate);

  const startStr = startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const endStr   = endDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  const directionLabel = direction === "SOBO"
    ? "Southbound (Maine to Georgia)"
    : "Northbound (Georgia to Maine)";

  const warningHtml = warningNeeded
    ? `<p style="color:#b00000; font-weight:600; margin-top:0.75rem;">
         Hiking on Mt. Katahdin, Maine during the October–May snow season is often closed or restricted based on local conditions.
       </p>`
    : "";

  el("durResult").innerHTML = `
    <table>
      <tr><th>Direction</th><td>${directionLabel}</td></tr>
      <tr><th>Start Date</th><td>${startStr}</td></tr>
      <tr><th>Assumed Route</th><td>Full trail (terminus to terminus)</td></tr>
      <tr><th>Distance</th><td>${fmtMile(distanceMiles)} miles</td></tr>
      <tr><th>Miles per Day</th><td>${fmtMile(milesPerDay)}</td></tr>
      <tr><th>Estimated Duration</th><td>${durationDays} days</td></tr>
      <tr><th>Estimated End Date</th><td>${endStr}</td></tr>
    </table>
    ${warningHtml}
  `;
}

function initDurationUI() {
  initMonthDayPickerGeneric("durMonthSelect", "durDaySelect");

  const btn = el("durBtn");
  if (btn) btn.addEventListener("click", runDurationCalculator);

  const mpdEl = el("durMilesPerDay");
  if (mpdEl && mpdEl.value === "") mpdEl.value = "15";
}

/* ---------------------------
   Option B: Duration extremes using precomputed normals
---------------------------- */
function dayIndexInNonLeapYearFromMonthDay(monthDay) {
  // monthDay: "MM-DD" mapped to a fixed non-leap year (2021)
  const [mmStr, ddStr] = monthDay.split("-");
  const mm = Number(mmStr);
  const dd = Number(ddStr);
  const dt = new Date(2021, mm - 1, dd);
  const start = new Date(2021, 0, 1);
  const diffDays = Math.round((dt - start) / (24 * 60 * 60 * 1000));
  return Math.max(0, Math.min(364, diffDays));
}

function getNearestPointByMile(targetMile) {
  const arr = allPointsSortedByMile;
  if (!arr || arr.length === 0 || !Number.isFinite(targetMile)) return null;

  let lo = 0;
  let hi = arr.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = arr[mid].mile_est;
    if (m === targetMile) return arr[mid];
    if (m < targetMile) lo = mid + 1;
    else hi = mid - 1;
  }

  const a = arr[Math.max(0, Math.min(arr.length - 1, hi))];
  const b = arr[Math.max(0, Math.min(arr.length - 1, lo))];
  if (!a) return b || null;
  if (!b) return a || null;
  return Math.abs(a.mile_est - targetMile) <= Math.abs(b.mile_est - targetMile) ? a : b;
}

function renderDurExtremesBlocks(hottest, coldest) {
  if (!hottest || !coldest) {
    setHtmlIfExists("durExtremesHot", `<p><strong>Unable to compute extremes.</strong> Missing precomputed normals for one or more points.</p>`);
    setHtmlIfExists("durExtremesCold", ``);
    return;
  }

  const hotNice = hottest.date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const coldNice = coldest.date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  setHtmlIfExists("durExtremesHot", `
    <h3>Hottest Day (Average High)</h3>
    <table>
      <tr><th>Date</th><td>${hotNice}</td></tr>
      <tr><th>Location</th><td>${pointLabel(hottest.point)}</td></tr>
      <tr><th>Approx. Daily Mile</th><td>${fmtMile(hottest.targetMile)}</td></tr>
      <tr><th>Avg High</th><td>${hottest.avgHigh != null ? Math.round(hottest.avgHigh) + " °F" : "—"}</td></tr>
      <tr><th>Avg Low</th><td>${hottest.avgLow != null ? Math.round(hottest.avgLow) + " °F" : "—"}</td></tr>
    </table>
  `);

  setHtmlIfExists("durExtremesCold", `
    <h3>Coldest Day/Night (Average Low)</h3>
    <table>
      <tr><th>Date</th><td>${coldNice}</td></tr>
      <tr><th>Location</th><td>${pointLabel(coldest.point)}</td></tr>
      <tr><th>Approx. Daily Mile</th><td>${fmtMile(coldest.targetMile)}</td></tr>
      <tr><th>Avg High</th><td>${coldest.avgHigh != null ? Math.round(coldest.avgHigh) + " °F" : "—"}</td></tr>
      <tr><th>Avg Low</th><td>${coldest.avgLow != null ? Math.round(coldest.avgLow) + " °F" : "—"}</td></tr>
    </table>
  `);
}

function renderDurExtremesMap(hottest, coldest) {
  const mapEl = el("durExtremesMap");
  if (!mapEl) return;
  if (typeof L === "undefined") return;

  const invalidate = () => {
    try { durMap.invalidateSize(); } catch {}
  };

  if (!durMap) {
    durMap = L.map("durExtremesMap", { zoomControl: true }).setView([38.5, -81.0], INITIAL_ZOOM);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(durMap);
    durMapLayerGroup = L.layerGroup().addTo(durMap);

    // Ensure the Appalachian Trail overlay also appears on the extremes map
    loadATPolylineLocalForDurMap().catch(() => {});
  }

  durMapLayerGroup.clearLayers();

  if (!hottest?.point || !coldest?.point) {
    setTimeout(invalidate, 0);
    return;
  }

  const hotLatLng = [hottest.point.lat, hottest.point.lon];
  const coldLatLng = [coldest.point.lat, coldest.point.lon];

  const hotIcon = makeColoredPinIcon("#cc0000");
  const coldIcon = makeColoredPinIcon("#0055cc");

  const hotMarker = L.marker(hotLatLng, { icon: hotIcon })
    .bindPopup(`<strong>Hottest Day</strong><br>${toISODate(hottest.date)}<br>Avg High: ${Math.round(hottest.avgHigh)} °F`)
    .addTo(durMapLayerGroup);

  const coldMarker = L.marker(coldLatLng, { icon: coldIcon })
    .bindPopup(`<strong>Coldest Day/Night</strong><br>${toISODate(coldest.date)}<br>Avg Low: ${Math.round(coldest.avgLow)} °F`)
    .addTo(durMapLayerGroup);

  // Keep pins above the trail overlay
  if (hotMarker.bringToFront) hotMarker.bringToFront();
  if (coldMarker.bringToFront) coldMarker.bringToFront();

  const bounds = L.latLngBounds([hotLatLng, coldLatLng]);
  durMap.fitBounds(bounds, { padding: [30, 30] });
  setTimeout(invalidate, 0);

}

async function computeAndRenderDurationExtremes({ direction, startDate, milesPerDay, durationDays }) {
  setDisplayIfExists("durExtremesWrap", "none");
  setHtmlIfExists("durExtremesHot", "");
  setHtmlIfExists("durExtremesCold", "");

  if (!normalsByPointId || normalsByPointId.size === 0) {
    setDurStatus("Temperature extremes are unavailable because historical_weather.json is not loaded.");
    return;
  }

  if (!Number.isFinite(trailMinMiles) || !Number.isFinite(trailMaxMiles) || allPointsSortedByMile.length === 0) {
    setDurStatus("Trail points are still loading. Please try again in a moment.");
    return;
  }

  const startMile = direction === "SOBO" ? trailMaxMiles : trailMinMiles;
  const sign = direction === "SOBO" ? -1 : 1;

  let hottest = null;
  let coldest = null;

  for (let i = 0; i < durationDays; i++) {
    const date = addDays(startDate, i);
    let targetMile = startMile + sign * (milesPerDay * i);
    if (targetMile < trailMinMiles) targetMile = trailMinMiles;
    if (targetMile > trailMaxMiles) targetMile = trailMaxMiles;

    const point = getNearestPointByMile(targetMile);
    if (!point) continue;

    const normals = normalsByPointId.get(point.id);
    if (!normals || !Array.isArray(normals.hi) || !Array.isArray(normals.lo)) continue;

    const monthDay = toISODate(date).slice(5); // MM-DD
    const idx = dayIndexInNonLeapYearFromMonthDay(monthDay);

    const avgHigh = normals.hi[idx];
    const avgLow = normals.lo[idx];

    if (!Number.isFinite(avgHigh) || !Number.isFinite(avgLow)) continue;

    const rec = { date, targetMile, point, avgHigh, avgLow };

    if (!hottest || rec.avgHigh > hottest.avgHigh) hottest = rec;
    if (!coldest || rec.avgLow < coldest.avgLow) coldest = rec;
  }

  setDisplayIfExists("durExtremesWrap", "block");
  renderDurExtremesBlocks(hottest, coldest);
  renderDurExtremesMap(hottest, coldest);
}

function runDurationCalculator() {
  setDurStatus("");
  if (el("durResult")) el("durResult").innerHTML = "";
  setDisplayIfExists("durExtremesWrap", "none");

  const direction = el("durDirectionSelect")?.value || "NOBO";
  const monthDay = getSelectedMonthDayFrom("durMonthSelect", "durDaySelect");
  const mpd = numVal("durMilesPerDay");

  if (!monthDay) {
    setDurStatus("Please choose a Start Date (month and day).");
    return;
  }
  if (mpd == null || mpd <= 0) {
    setDurStatus("Please enter Miles per Day.");
    return;
  }
  if (mpd < 7) {
    setDurStatus("For this planner, hikes must average at least 7 miles per day.");
    return;
  }
  if (!Number.isFinite(trailTotalMiles) || trailTotalMiles == null) {
    setDurStatus("Trail distance is still loading. Please try again in a moment.");
    return;
  }

  const startDate = resolveStartDateFromMonthDay(monthDay);
  const distance = trailTotalMiles;
  const durationDays = Math.ceil(distance / mpd);

  if (durationDays > 365) {
    setDurStatus("For this planner, hikes cannot exceed one year (365 days). Please adjust Miles per Day.");
    return;
  }

  // End date should be the LAST hiking day: start + (durationDays - 1)
  const endDate = addDays(startDate, durationDays - 1);

  renderDurationResult({
    direction,
    startDate,
    endDate,
    distanceMiles: distance,
    milesPerDay: mpd,
    durationDays
  });

  // Compute extremes synchronously (no network) once normals are loaded.
  if (normalsByPointId && normalsByPointId.size > 0) {
    computeAndRenderDurationExtremes({
      direction,
      startDate,
      milesPerDay: mpd,
      durationDays
    }).catch(err => {
      console.error(err);
      setDurStatus(`Error computing temperature extremes: ${err.message}`);
    });
  } else {
    setDurStatus("Temperature extremes will appear once historical_weather.json is available.");
  }
}

/* ---------------------------
   Weather tool: Month/Day picker
---------------------------- */
function getSelectedMonthDay() {
  return getSelectedMonthDayFrom("monthSelect", "daySelect");
}

function initMonthDayPicker() {
  initMonthDayPickerGeneric("monthSelect", "daySelect");
}

// Northbound order (GA -> ME)
const STATE_ORDER = [
  "GA","NC","TN","VA","WV","MD","PA","NJ","NY","CT","MA","VT","NH","ME"
];

const STATE_NAME = {
  GA: "Georgia",
  NC: "North Carolina",
  TN: "Tennessee",
  VA: "Virginia",
  WV: "West Virginia",
  MD: "Maryland",
  PA: "Pennsylvania",
  NJ: "New Jersey",
  NY: "New York",
  CT: "Connecticut",
  MA: "Massachusetts",
  VT: "Vermont",
  NH: "New Hampshire",
  ME: "Maine"
};

/* ---------------------------
   State + Mile selection
---------------------------- */
function buildPointsByState() {
  pointsByState = new Map();
  for (const p of allPoints) {
    const st = p.state;
    if (!pointsByState.has(st)) pointsByState.set(st, []);
    pointsByState.get(st).push(p);
  }
  for (const [st, arr] of pointsByState.entries()) {
    arr.sort((a, b) => a.mile_est - b.mile_est);
  }
}

function renderStateOptions() {
  const stateSel = el("stateSelect");
  if (!stateSel) return;
  stateSel.innerHTML = "";

  const statesInData = Array.from(pointsByState.keys());

  statesInData.sort((a, b) => {
    const ia = STATE_ORDER.indexOf(a);
    const ib = STATE_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  for (const st of statesInData) {
    const opt = document.createElement("option");
    opt.value = st;
    opt.textContent = STATE_NAME[st] || st;
    stateSel.appendChild(opt);
  }

  if (statesInData.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No states loaded";
    stateSel.appendChild(opt);
  }
}

function renderMileOptionsForState(state) {
  const mileSel = el("mileSelect");
  if (!mileSel) return;
  mileSel.innerHTML = "";

  const arr = pointsByState.get(state) || [];
  for (const p of arr) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = fmtMile(p.mile_est);
    mileSel.appendChild(opt);
  }

  if (arr.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No mile points for state";
    mileSel.appendChild(opt);
  }
}

function getSelectedPointFromStateMile() {
  const state = el("stateSelect")?.value;
  const pointId = el("mileSelect")?.value;
  if (!state || !pointId) return null;

  const arr = pointsByState.get(state) || [];
  return arr.find(p => p.id === pointId) || null;
}

/* ---------------------------
   Map (Weather tool)
---------------------------- */
function refreshMapSize() {
  if (!map) return;
  setTimeout(() => {
    try { map.invalidateSize(); } catch {}
  }, 0);
}

function ensureWeatherMapVisibleAndInitialized() {
  const wrap = el("weatherMapWrap");
  if (wrap) wrap.style.display = "block";

  // Initialize Leaflet only once, and only after the container is visible
  if (!map) {
    initMap();
    loadATPolylineLocal(); // keep AT overlay behavior, but only once map exists
  }

  refreshMapSize();
}

function initMap() {
  if (typeof L === "undefined") {
    console.warn("Leaflet not loaded (L is undefined).");
    return;
  }

  map = L.map("map", { zoomControl: true }).setView([38.5, -81.0], INITIAL_ZOOM);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  window.addEventListener("resize", () => {
    refreshMapSize();
  });
}

function updateMap(point) {
  if (!map) return;

  const latlng = [point.lat, point.lon];

  if (!mapMarker) {
    mapMarker = L.marker(latlng).addTo(map);
  } else {
    mapMarker.setLatLng(latlng);
  }

  mapMarker.bindPopup(pointLabel(point));
  map.setView(latlng, SELECT_ZOOM);

  if (mapMarker.bringToFront) mapMarker.bringToFront();
  refreshMapSize();
}

/* ---------------------------
   Local AT overlay
---------------------------- */
async function loadATPolylineLocal() {
  if (!map) return;

  const CACHE_KEY = "at_geojson_cached_v1";
  const cached = cacheGet(CACHE_KEY, AT_TTL_MS);

  try {
    let geojson = cached;
    if (!geojson) {
      const resp = await fetch(AT_GEOJSON_URL, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`Failed to load ${AT_GEOJSON_URL} (${resp.status})`);
      geojson = await resp.json();
      cacheSet(CACHE_KEY, geojson);
    }

    if (atLayer) { try { map.removeLayer(atLayer); } catch {} atLayer = null; }
    if (atHaloLayer) { try { map.removeLayer(atHaloLayer); } catch {} atHaloLayer = null; }

    atHaloLayer = L.geoJSON(geojson, {
      style: () => ({
        color: "#ffffff",
        weight: 8,
        opacity: 0.55,
        lineCap: "round",
        lineJoin: "round"
      }),
      interactive: false
    }).addTo(map);

    atLayer = L.geoJSON(geojson, {
      style: () => ({
        color: "#cc0000",
        weight: 4.5,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round"
      }),
      interactive: false
    }).addTo(map);

    if (atHaloLayer.bringToBack) atHaloLayer.bringToBack();
    if (atLayer.bringToBack) atLayer.bringToBack();
    if (mapMarker && mapMarker.bringToFront) mapMarker.bringToFront();

  } catch (e) {
    console.warn("AT overlay failed:", e);
  } finally {
    refreshMapSize();
  }
}

// Same AT overlay for the Temperature Extremes map
async function loadATPolylineLocalForDurMap() {
  if (!durMap) return;

  const CACHE_KEY = "at_geojson_cached_v1";
  const cached = cacheGet(CACHE_KEY, AT_TTL_MS);

  try {
    let geojson = cached;
    if (!geojson) {
      const resp = await fetch(AT_GEOJSON_URL, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`Failed to load ${AT_GEOJSON_URL} (${resp.status})`);
      geojson = await resp.json();
      cacheSet(CACHE_KEY, geojson);
    }

    if (durAtLayer) { try { durMap.removeLayer(durAtLayer); } catch {} durAtLayer = null; }
    if (durAtHaloLayer) { try { durMap.removeLayer(durAtHaloLayer); } catch {} durAtHaloLayer = null; }

    durAtHaloLayer = L.geoJSON(geojson, {
      style: () => ({
        color: "#ffffff",
        weight: 8,
        opacity: 0.55,
        lineCap: "round",
        lineJoin: "round"
      }),
      interactive: false
    }).addTo(durMap);

    durAtLayer = L.geoJSON(geojson, {
      style: () => ({
        color: "#cc0000",
        weight: 4.5,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round"
      }),
      interactive: false
    }).addTo(durMap);

    if (durAtHaloLayer.bringToBack) durAtHaloLayer.bringToBack();
    if (durAtLayer.bringToBack) durAtLayer.bringToBack();

  } catch (e) {
    console.warn("AT overlay (extremes map) failed:", e);
  } finally {
    try { durMap.invalidateSize(); } catch {}
  }
}

/* ---------------------------
   Data loading
---------------------------- */
async function loadPoints() {
  const resp = await fetch(POINTS_URL, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`Failed to load ${POINTS_URL} (${resp.status})`);
  const data = await resp.json();

  allPoints = data
    .map(p => ({
      ...p,
      state: (p.state || "").toString().toUpperCase(),
      mile_est: Number(p.mile_est),
      lat: Number(p.lat),
      lon: Number(p.lon),
      id: (p.id != null ? String(p.id) : `${(p.state || "").toString().toUpperCase()}_${Number(p.mile_est)}`)
    }))
    .filter(p => p && p.state && Number.isFinite(p.mile_est) && Number.isFinite(p.lat) && Number.isFinite(p.lon));

  trailMaxMiles = allPoints.reduce((mx, p) => Math.max(mx, p.mile_est), -Infinity);
  trailMinMiles = allPoints.reduce((mn, p) => Math.min(mn, p.mile_est),  Infinity);
  trailTotalMiles = (Number.isFinite(trailMaxMiles) && Number.isFinite(trailMinMiles))
    ? (trailMaxMiles - trailMinMiles)
    : null;

  allPointsSortedByMile = [...allPoints].sort((a, b) => a.mile_est - b.mile_est);

  buildPointsByState();
}

async function loadPrecomputedNormals() {
  const CACHE_KEY = "planning_normals_cached_v1";
  const cached = cacheGet(CACHE_KEY, NORMALS_TTL_MS);

  let payload = cached;
  if (!payload) {
    const resp = await fetch(NORMALS_URL, { cache: "no-cache" });
    if (!resp.ok) {
      throw new Error(`Failed to load ${NORMALS_URL} (${resp.status})`);
    }
    payload = await resp.json();
    cacheSet(CACHE_KEY, payload);
  }

  normalsByPointId = new Map();
  normalsMeta = payload.meta || null;

  const pts = payload.points || [];
  for (const p of pts) {
    if (!p || !p.id) continue;
    if (!Array.isArray(p.hi) || !Array.isArray(p.lo)) continue;
    normalsByPointId.set(String(p.id), { hi: p.hi, lo: p.lo });
  }
}

/* ---------------------------
   Open-Meteo
---------------------------- */
async function fetchForecast(point) {
  const cacheKey = `forecast:${point.id}`;
  const cached = cacheGet(cacheKey, FORECAST_TTL_MS);
  if (cached) return cached;

  const url = new URL(FORECAST_BASE);
  url.searchParams.set("latitude",  point.lat);
  url.searchParams.set("longitude", point.lon);
  url.searchParams.set("daily", FORECAST_DAILY_VARS);
  url.searchParams.set("current_weather", "true");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("windspeed_unit", "mph");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "5");

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Forecast request failed (${resp.status})`);
  const data = await resp.json();

  cacheSet(cacheKey, data);
  return data;
}

function lastSevenYearsRange() {
  const today = new Date();
  const end = addDays(today, -2);

  const start = new Date(end.getTime());
  start.setFullYear(start.getFullYear() - 7);

  return { start_date: toISODate(start), end_date: toISODate(end) };
}

async function fetchHistorical(point, range) {
  const cacheKey = `hist:${point.id}:${range.start_date}:${range.end_date}`;
  const cached = cacheGet(cacheKey, HIST_TTL_MS);
  if (cached) return cached;

  const url = new URL(HIST_BASE);
  url.searchParams.set("latitude",  point.lat);
  url.searchParams.set("longitude", point.lon);
  url.searchParams.set("start_date", range.start_date);
  url.searchParams.set("end_date", range.end_date);
  url.searchParams.set("daily", HIST_DAILY_VARS);
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", "auto");

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Historical request failed (${resp.status})`);
  const data = await resp.json();

  cacheSet(cacheKey, data);
  return data;
}

/* ---------------------------
   Planning computation (Weather tool)
---------------------------- */
function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function indexHistoricalByMonthDay(histDaily) {
  const idx = new Map();
  const times = histDaily.time || [];
  const tmax  = histDaily.temperature_2m_max || [];
  const tmin  = histDaily.temperature_2m_min || [];

  for (let i = 0; i < times.length; i++) {
    const md = times[i].slice(5); // "MM-DD"
    if (!idx.has(md)) idx.set(md, { max: [], min: [] });
    const bucket = idx.get(md);
    if (tmax[i] != null) bucket.max.push(tmax[i]);
    if (tmin[i] != null) bucket.min.push(tmin[i]);
  }
  return idx;
}

function mdWindowKeys(dateISO, windowDays) {
  const parts = dateISO.split("-").map(Number);
  const m = parts[1];
  const d = parts[2];
  const base = new Date(2001, m - 1, d);

  const keys = [];
  for (let offset = -windowDays; offset <= windowDays; offset++) {
    const dt = addDays(base, offset);
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    keys.push(`${mm}-${dd}`);
  }
  return keys;
}

function computePlanningAverageForMonthDay(histDaily, monthDay, windowDays) {
  const idx = indexHistoricalByMonthDay(histDaily);
  const fakeISO = `2001-${monthDay}`;
  const keys = mdWindowKeys(fakeISO, windowDays);

  const maxVals = [];
  const minVals = [];

  for (const k of keys) {
    const bucket = idx.get(k);
    if (!bucket) continue;
    maxVals.push(...bucket.max);
    minVals.push(...bucket.min);
  }

  return {
    monthDay,
    avgHigh: avg(maxVals),
    avgLow: avg(minVals)
  };
}

/* ---------------------------
   Rendering (Weather tool)
---------------------------- */
function renderPlanningSummary(point, monthDay, range, avgHigh, avgLow) {
  const niceDate = formatMonthDayName(monthDay);

  el("planningSummaryBlock").innerHTML = `
    <h2>Planning: 7-year average</h2>
    <table>
      <tr><th>Location</th><td>${pointLabel(point)}</td></tr>
      <tr><th>Planning Date</th><td>${niceDate}</td></tr>
      <tr><th>7-year Avg High</th><td>${avgHigh != null ? Math.round(avgHigh) + " °F" : "—"}</td></tr>
      <tr><th>7-year Avg Low</th><td>${avgLow != null ? Math.round(avgLow) + " °F" : "—"}</td></tr>
      <tr><th>Historical Range Used</th><td>${range.start_date} to ${range.end_date}</td></tr>
    </table>
    <p class="note">
      Averages are computed from daily highs/lows across the range above, using a
      ${TYPICAL_WINDOW_DAYS * 2 + 1}-day window centered on the Planning Date.
      This is a “recent planning average,” not an official 30-year climate normal.
    </p>
  `;
}

function renderCurrent(forecastData, point) {
  const c = forecastData.current_weather;
  if (!c) {
    el("currentBlock").innerHTML = "";
    return;
  }

  el("currentBlock").innerHTML = `
    <h2>Current conditions</h2>
    <table>
      <tr><th>Location</th><td>${pointLabel(point)}</td></tr>
      <tr><th>Temperature</th><td>${Math.round(c.temperature)} °F</td></tr>
      <tr><th>Wind</th><td>${Math.round(c.windspeed)} mph (dir ${Math.round(c.winddirection)}°)</td></tr>
      <tr><th>Time</th><td>${c.time}</td></tr>
    </table>
  `;
}

function renderForecastTable(forecastData) {
  const d = forecastData.daily;
  if (!d || !d.time) {
    el("forecastBlock").innerHTML = "";
    return;
  }

  const rows = d.time.map((date, i) => {
    const hi = d.temperature_2m_max?.[i];
    const lo = d.temperature_2m_min?.[i];
    const p  = d.precipitation_probability_max?.[i];
    const w  = d.windspeed_10m_max?.[i];

    return `
      <tr>
        <td>${date}</td>
        <td>${hi != null ? Math.round(hi) + " °F" : ""}</td>
        <td>${lo != null ? Math.round(lo) + " °F" : ""}</td>
        <td>${p != null ? Math.round(p) + "%" : ""}</td>
        <td>${w != null ? Math.round(w) + " mph" : ""}</td>
      </tr>
    `;
  }).join("");

  el("forecastBlock").innerHTML = `
    <h2>5-day forecast</h2>
    <table>
      <tr>
        <th>Date</th>
        <th>Forecast High</th>
        <th>Forecast Low</th>
        <th>Precip (max)</th>
        <th>Wind (max)</th>
      </tr>
      ${rows}
    </table>
  `;

  refreshMapSize();
}

/* ---------------------------
   Weather run
---------------------------- */
async function runWeather() {
  const point = getSelectedPointFromStateMile();
  if (!point) {
    return;
  }

  const monthDay = getSelectedMonthDay();
  if (!monthDay) {
    return;
  }

ensureWeatherMapVisibleAndInitialized();
updateMap(point);


  el("planningSummaryBlock").innerHTML = "";
  el("currentBlock").innerHTML = "";
  el("forecastBlock").innerHTML = "";

  try {
    const forecastData = await fetchForecast(point);

    renderCurrent(forecastData, point);
    renderForecastTable(forecastData);

    const range = lastSevenYearsRange();

    const histData = await fetchHistorical(point, range);
    const histDaily = histData?.daily;

    if (!histDaily?.time) {
      return;
    }

    const planning = computePlanningAverageForMonthDay(histDaily, monthDay, TYPICAL_WINDOW_DAYS);
    renderPlanningSummary(point, monthDay, range, planning.avgHigh, planning.avgLow);

  } catch (err) {
    console.error(err);
  } finally {
    refreshMapSize();
  }
}

/* ---------------------------
   UI init
---------------------------- */
function initWeatherUI() {
  el("goBtn")?.addEventListener("click", runWeather);

  el("stateSelect")?.addEventListener("change", () => {
    const st = el("stateSelect").value;
    renderMileOptionsForState(st);

    const p = getSelectedPointFromStateMile();
   if (p && map) updateMap(p);
  });

  el("mileSelect")?.addEventListener("change", () => {
    const p = getSelectedPointFromStateMile();
    if (p) updateMap(p);
  });

  initMonthDayPicker();
}

/* ---------------------------
   Main
   IMPORTANT: run only after DOM is ready so dropdowns populate reliably
---------------------------- */
async function main() {
  // Tool A init
  initDurationUI();

  // Tool B init
  initWeatherUI();

  initMap();

  // Load trail overlay (non-blocking)
  loadATPolylineLocal();

  try {
    await loadPoints();

    renderStateOptions();

    const stateSel = el("stateSelect");
    const firstState = stateSel?.value;
    if (firstState) {
      renderMileOptionsForState(firstState);
      const firstPoint = getSelectedPointFromStateMile() || (pointsByState.get(firstState) ? pointsByState.get(firstState)[0] : null);
      if (firstPoint) updateMap(firstPoint);
    }

    // Load precomputed normals (best-effort)
    try {
      await loadPrecomputedNormals();
      if (normalsMeta?.source) {
        setDurStatus(`Precomputed planning normals loaded (${normalsMeta.source}).`);
      }
    } catch (e) {
      console.warn(e);
      setDurStatus("Precomputed planning normals not found. Add data/historical_weather.json to enable temperature extremes.");
    }

    setTimeout(() => {
      refreshMapSize();
    }, 250);

  } catch (err) {
    console.error(err);
  }
}

// Ensure initialization runs after the DOM is ready (covers cases where the script is loaded in <head> without defer)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    main().catch(err => {
      console.error(err);
    });
  });
} else {
  main().catch(err => {
    console.error(err);
  });
}
