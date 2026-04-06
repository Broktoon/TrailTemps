/* shared-utils.js — TrailTemps
   Pure utility functions shared across all trail pages.
   Load this script BEFORE each trail's app.js.
   No trail-specific state; no side effects on load.
*/

/* -------------------------------------------------------
   DOM shorthand
------------------------------------------------------- */

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

/* -------------------------------------------------------
   localStorage cache helpers
------------------------------------------------------- */

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

/* -------------------------------------------------------
   Date helpers
------------------------------------------------------- */

function addDays(d, n) {
  const r = new Date(d.getTime()); r.setDate(r.getDate() + n); return r;
}

function pad2(n) { return String(n).padStart(2, "0"); }

function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

/**
 * Interpret "MM-DD" as the next occurrence of that calendar date
 * (today or future). Used by duration calculator start-date inputs.
 */
function resolveStartDate(monthDay) {
  const [mm, dd] = monthDay.split("-").map(Number);
  const today = new Date();
  const base  = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let candidate = new Date(base.getFullYear(), mm - 1, dd);
  if (candidate < base) candidate = new Date(base.getFullYear() + 1, mm - 1, dd);
  return candidate;
}

/* -------------------------------------------------------
   Number / formatting helpers
------------------------------------------------------- */

function fmtMile(m) { return (Math.round(Number(m) * 10) / 10).toFixed(1); }

function fmtTemp(v) {
  return v != null && Number.isFinite(v) ? Math.round(v) + " \u00b0F" : "\u2014";
}

function fmtRh(v) {
  return v != null && Number.isFinite(v) ? Math.round(v) + "%" : "\u2014";
}

/**
 * Returns an HTML annotation when apparent temperature differs meaningfully
 * from actual temperature (threshold: 3 °F).
 */
function feelsLikeNote(actual, apparent) {
  if (actual == null || apparent == null) return "";
  const diff = apparent - actual;
  if (Math.abs(diff) < 3) return "";
  return diff > 0
    ? ` <span class="feels-hotter">(feels hotter: ${Math.round(apparent)} \u00b0F)</span>`
    : ` <span class="feels-cooler">(feels cooler: ${Math.round(apparent)} \u00b0F)</span>`;
}

/** Read a numeric input; returns the number or null if blank/invalid. */
function numVal(id) {
  const v = el(id)?.value;
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/* -------------------------------------------------------
   Apparent temperature physics
   (NWS / Steadman formulas — used as fallback when
    hi_app / lo_app are absent from normals data)
------------------------------------------------------- */

/** NWS wind chill. Valid when T ≤ 50 °F and wind ≥ 3 mph. Returns null otherwise. */
function windChill(tempF, windMph) {
  if (tempF > 50 || windMph < 3) return null;
  return 35.74 + 0.6215  * tempF
               - 35.75   * Math.pow(windMph, 0.16)
               + 0.4275  * tempF * Math.pow(windMph, 0.16);
}

/** Steadman/NWS heat index. Valid when T ≥ 80 °F. Returns null otherwise. */
function heatIndex(tempF, rh) {
  if (tempF < 80) return null;
  return -42.379
    + 2.04901523  * tempF
    + 10.14333127 * rh
    - 0.22475541  * tempF * rh
    - 0.00683783  * tempF * tempF
    - 0.05481717  * rh    * rh
    + 0.00122874  * tempF * tempF * rh
    + 0.00085282  * tempF * rh    * rh
    - 0.00000199  * tempF * tempF * rh * rh;
}

/* -------------------------------------------------------
   Leaflet helpers (require Leaflet to be loaded first)
------------------------------------------------------- */

/**
 * Returns a Leaflet LatLngBounds that fits all points in the array.
 * Returns null if the array is empty or Leaflet is not loaded.
 */
function boundsFromPoints(pts) {
  if (!pts?.length || typeof L === "undefined") return null;
  let minLat =  Infinity, maxLat = -Infinity;
  let minLon =  Infinity, maxLon = -Infinity;
  for (const p of pts) {
    const la = Number(p.lat), lo = Number(p.lon);
    if (!isFinite(la) || !isFinite(lo)) continue;
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
  }
  if (!isFinite(minLat)) return null;
  return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
}

/**
 * Creates a Leaflet DivIcon shaped like a teardrop map pin.
 * colorHex: fill color string, e.g. "#cc3300"
 */
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

/* -------------------------------------------------------
   Month/Day picker
------------------------------------------------------- */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function daysInMonth(monthIdx) {
  return new Date(2021, monthIdx + 1, 0).getDate(); // 2021 is non-leap
}

/** Format "MM-DD" → "January 15" */
function formatMonthDayName(monthDay) {
  const [mm, dd] = monthDay.split("-").map(Number);
  return `${MONTH_NAMES[mm - 1]} ${dd}`;
}

/**
 * Populate a month <select> and a day <select>, defaulting to today.
 * The day options update automatically when the month changes.
 */
function initMonthDayPickerGeneric(monthSelId, daySelId) {
  const mSel = el(monthSelId), dSel = el(daySelId);
  if (!mSel || !dSel) return;

  mSel.innerHTML = "";
  MONTH_NAMES.forEach((name, i) => {
    const o = document.createElement("option");
    o.value = i + 1; o.textContent = name; mSel.appendChild(o);
  });

  function populateDays() {
    const mi   = Number(mSel.value) - 1;
    const max  = daysInMonth(mi);
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

/** Returns "MM-DD" from a month/day picker pair, or null if either is unset. */
function getSelectedMonthDay(monthSelId, daySelId) {
  const m = el(monthSelId)?.value, d = el(daySelId)?.value;
  if (!m || !d) return null;
  return `${pad2(m)}-${pad2(d)}`;
}
