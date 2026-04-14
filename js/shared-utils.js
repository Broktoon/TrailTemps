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

/* -------------------------------------------------------
   Day-of-year index helper
   Maps "MM-DD" to 0–364 using fixed non-leap year 2021.
   Used by all trail app.js files for normals lookups.
------------------------------------------------------- */

function dayIndexFromMonthDay(monthDay) {
  const [mmStr, ddStr] = monthDay.split("-");
  const mm = Number(mmStr), dd = Number(ddStr);
  const dt    = new Date(2021, mm - 1, dd);
  const start = new Date(2021, 0, 1);
  return Math.max(0, Math.min(364, Math.round((dt - start) / 86400000)));
}

/* -------------------------------------------------------
   UTCI thermal comfort scoring
   Tier-based proxy for the Universal Thermal Climate Index.
   All thresholds are in apparent °F.
------------------------------------------------------- */

function utciScoreHigh(appHigh) {
  if (appHigh > 115) return 0;   // Extreme heat — eliminates start date
  if (appHigh > 100) return 2;   // Very Strong heat
  if (appHigh > 90)  return 5;   // Strong heat
  if (appHigh > 79)  return 8;   // Moderate heat
  return 10;                      // Comfort zone
}

function utciScoreLow(appLow) {
  if (appLow < -17) return 0;   // Extreme cold — eliminates start date
  if (appLow < 9)   return 2;   // Very Strong cold
  if (appLow < 32)  return 5;   // Strong cold
  if (appLow < 48)  return 8;   // Moderate cold
  return 10;                     // Comfort zone
}

function utciHeatDepth(score, appHigh) {
  if (score === 8) return (appHigh - 80) / 11;
  if (score === 5) return (appHigh - 91) / 10;
  if (score === 2) return (appHigh - 101) / 15;
  return 0;
}

function utciColdDepth(score, appLow) {
  if (score === 8) return (48 - appLow) / 16;
  if (score === 5) return (32 - appLow) / 23;
  if (score === 2) return (9  - appLow) / 26;
  return 0;
}

function scoreToHeatCat(score) {
  if (score === 8) return "moderate-heat";
  if (score === 5) return "strong-heat";
  if (score === 2) return "very-strong-heat";
  return "extreme-heat";
}

function scoreToColdCat(score) {
  if (score === 8) return "moderate-cold";
  if (score === 5) return "strong-cold";
  if (score === 2) return "very-strong-cold";
  return "extreme-cold";
}

/**
 * Assigns a hiking day to one of 9 UTCI thermal categories.
 * Assumes extreme days (score 0) have already been filtered out by runBestStartShared.
 */
function utciCategoryDay(highScore, lowScore, appHigh, appLow) {
  if (highScore === 10 && lowScore === 10) return "comfort";
  if (highScore === 0) return "extreme-heat";
  if (lowScore  === 0) return "extreme-cold";
  if (highScore < lowScore) return scoreToHeatCat(highScore);
  if (lowScore  < highScore) return scoreToColdCat(lowScore);
  const hd = utciHeatDepth(highScore, appHigh);
  const cd = utciColdDepth(lowScore,  appLow);
  if (hd > cd) return scoreToHeatCat(highScore);
  if (cd > hd) return scoreToColdCat(lowScore);
  return scoreToHeatCat(highScore);  // true tie: assign heat
}

/**
 * Count UTCI thermal comfort categories across all hike points.
 * hikePoints  — [{date, point}, ...]
 * getNormals  — (point) => {app_hi:[365], app_lo:[365], ...} | null
 * Returns an object with day counts for each of the 9 UTCI categories.
 */
function computeUtciCounts(hikePoints, getNormals) {
  const counts = {
    "extreme-cold": 0, "very-strong-cold": 0, "strong-cold": 0, "moderate-cold": 0,
    "comfort": 0,
    "moderate-heat": 0, "strong-heat": 0, "very-strong-heat": 0, "extreme-heat": 0
  };
  for (const { date, point } of hikePoints) {
    const normals = getNormals(point);
    if (!normals?.app_hi?.length) continue;
    const idx     = dayIndexFromMonthDay(toISODate(date).slice(5));
    const appHigh = normals.app_hi[idx];
    const appLow  = normals.app_lo[idx];
    if (!Number.isFinite(appHigh) || !Number.isFinite(appLow)) continue;
    const hs = utciScoreHigh(appHigh);
    const ls = utciScoreLow(appLow);
    counts[utciCategoryDay(hs, ls, appHigh, appLow)]++;
  }
  return counts;
}

/**
 * Unified output renderer for the duration/BestStart calculator section.
 * Replaces per-trail renderDurExtremesBlocks.
 *
 * hottest / coldest — rec objects: { date, point, avgHigh, avgLow, appHigh, appLow, rhHigh, rhLow }
 * opts:
 *   startDate      — Date or null
 *   endDate        — Date or null
 *   distanceMiles  — number or null
 *   durationDays   — number or null
 *   startDateLabel — string (default "Start Date"; may contain HTML e.g. "<em>BestStart!</em> Date")
 *   utciCounts     — counts object or null (shows "—" when null)
 *   formatLocation — (rec) => string  — trail-specific location label
 *   durationNote   — optional HTML string shown below duration row (e.g. NTT travel days)
 *   warningHtml    — optional HTML string shown below duration table (e.g. AT Katahdin warning)
 */
function renderDurExtremesBlocksShared(hottest, coldest, opts = {}) {
  const {
    startDate      = null,
    endDate        = null,
    distanceMiles  = null,
    durationDays   = null,
    startDateLabel = "Start Date",
    utciCounts     = null,
    formatLocation = (rec) => rec.point?.id || "Unknown",
    durationNote   = "",
    warningHtml    = ""
  } = opts;

  // Clear legacy divs
  setHtmlIfExists("durExtremesCold", "");
  if (el("durResult"))       el("durResult").innerHTML       = "";
  if (el("bestStartResult")) el("bestStartResult").innerHTML = "";

  if (!hottest || !coldest) {
    setHtmlIfExists("durExtremesHot", "<p>Temperature extremes unavailable \u2014 historical normals not loaded.</p>");
    return;
  }

  // 1. Duration summary table
  const startStr = startDate
    ? startDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "\u2014";
  const endStr = endDate
    ? endDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "\u2014";

  const durHtml = `
    <table style="width:100%; margin-bottom:4px;">
      <tr>
        <th style="width:25%;">${startDateLabel}</th>
        <th style="width:25%;">Estimated End Date</th>
        <th style="width:25%;">Distance</th>
        <th style="width:25%;">Estimated Duration</th>
      </tr>
      <tr>
        <td>${startStr}</td>
        <td>${endStr}</td>
        <td>${distanceMiles != null ? fmtMile(distanceMiles) + " miles" : "\u2014"}</td>
        <td>${durationDays != null ? durationDays + " days" : "\u2014"}</td>
      </tr>
    </table>
    ${durationNote ? `<p style="margin:2px 0 6px; font-size:0.88rem; color:#555;">${durationNote}</p>` : ""}
    ${warningHtml}`;

  // 2. UTCI thermal comfort profile
  const UTCI_COLS = [
    { key: "extreme-cold",     label: "Extreme Cold",     style: "background:#001e70;color:#fff;" },
    { key: "very-strong-cold", label: "Very Strong Cold", style: "background:#0044cc;color:#fff;" },
    { key: "strong-cold",      label: "Strong Cold",      style: "background:#3377ff;color:#fff;" },
    { key: "moderate-cold",    label: "Moderate Cold",    style: "background:#99bbff;color:#000;" },
    { key: "comfort",          label: "Comfort Zone",     style: "background:#2e7a2e;color:#fff;" },
    { key: "moderate-heat",    label: "Moderate Heat",    style: "background:#ffcc66;color:#000;" },
    { key: "strong-heat",      label: "Strong Heat",      style: "background:#ff8800;color:#fff;" },
    { key: "very-strong-heat", label: "Very Strong Heat", style: "background:#cc2200;color:#fff;" },
    { key: "extreme-heat",     label: "Extreme Heat",     style: "background:#660000;color:#fff;" },
  ];
  const headerCells = UTCI_COLS.map(c =>
    `<th style="${c.style} padding:5px 8px; font-size:0.78rem; font-weight:600;">${c.label}</th>`
  ).join("");
  const dataCells = UTCI_COLS.map(c =>
    `<td style="text-align:center; padding:5px 8px;">${utciCounts ? (utciCounts[c.key] ?? 0) : "\u2014"}</td>`
  ).join("");
  const utciHtml = `
    <h3>Thermal Stress and Comfort Profile: Days on Trail</h3>
    <div style="overflow-x:auto; margin-bottom:12px;">
      <table style="border-collapse:collapse; min-width:620px;">
        <tr>${headerCells}</tr>
        <tr>${dataCells}</tr>
      </table>
    </div>`;

  // 3. Side-by-side extremes
  function extremeCols(rec) {
    const niceDate = rec.date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const location = formatLocation(rec);
    return `
      <tr><th>Date</th><td colspan="3">${niceDate}</td></tr>
      <tr><th>Location</th><td colspan="3">${location}</td></tr>
      <tr><th></th><th style="background:#f0f0f0;">Actual Temp</th><th style="background:#f0f0f0;">Apparent Temp</th><th style="background:#f0f0f0;">Rel. Humidity</th></tr>
      <tr><th>Anticipated High</th><td>${fmtTemp(rec.avgHigh)}</td><td>${fmtTemp(rec.appHigh)}</td><td>${fmtRh(rec.rhHigh)}</td></tr>
      <tr><th>Anticipated Low</th><td>${fmtTemp(rec.avgLow)}</td><td>${fmtTemp(rec.appLow)}</td><td>${fmtRh(rec.rhLow)}</td></tr>`;
  }
  const extremesHtml = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
      <div>
        <h3>Hottest Day (Highest Apparent High)</h3>
        <table>${extremeCols(hottest)}</table>
      </div>
      <div>
        <h3>Coldest Night (Lowest Apparent Low)</h3>
        <table>${extremeCols(coldest)}</table>
      </div>
    </div>`;

  setHtmlIfExists("durExtremesHot", durHtml + utciHtml + extremesHtml);
}

/**
 * Scan all 365 start dates and return the one with the highest UTCI thermal comfort score.
 * Pure computation — no DOM access.
 *
 * config:
 *   durationDays  — integer, hike length in days
 *   getHikePoints — (startDate: Date) => [{date, point}, ...]
 *   getNormals    — (point) => {app_hi:[365], app_lo:[365]} | null
 *   eliminator    — optional (startDate: Date, endDate: Date) => bool  (true = skip this candidate)
 *
 * Returns { bestStartDate: Date | null, bestCounts: object | null }
 */
function runBestStartShared({ durationDays, getHikePoints, getNormals, eliminator = null }) {
  const REF_YEAR = 2025;
  let bestScore = -Infinity, bestStartDate = null, bestCounts = null;

  for (let doy = 0; doy < 365; doy++) {
    const startDate = new Date(REF_YEAR, 0, 1 + doy);
    const endDate   = addDays(startDate, durationDays - 1);

    if (eliminator && eliminator(startDate, endDate)) continue;

    const hikePoints = getHikePoints(startDate);
    if (!hikePoints || !hikePoints.length) continue;

    let totalScore = 0, eliminated = false;
    const counts = {
      "extreme-cold": 0, "very-strong-cold": 0, "strong-cold": 0, "moderate-cold": 0,
      "comfort": 0,
      "moderate-heat": 0, "strong-heat": 0, "very-strong-heat": 0, "extreme-heat": 0
    };

    for (const { date, point } of hikePoints) {
      const normals = getNormals(point);
      if (!normals?.app_hi?.length) continue;
      const idx     = dayIndexFromMonthDay(toISODate(date).slice(5));
      const appHigh = normals.app_hi[idx];
      const appLow  = normals.app_lo[idx];
      if (!Number.isFinite(appHigh) || !Number.isFinite(appLow)) continue;
      const hs = utciScoreHigh(appHigh);
      const ls = utciScoreLow(appLow);
      if (hs === 0 || ls === 0) { eliminated = true; break; }
      totalScore += (hs + ls) / 2;
      counts[utciCategoryDay(hs, ls, appHigh, appLow)]++;
    }

    if (eliminated) continue;
    if (totalScore > bestScore) {
      bestScore     = totalScore;
      bestStartDate = new Date(startDate);
      bestCounts    = { ...counts };
    }
  }

  return { bestStartDate, bestCounts };
}
