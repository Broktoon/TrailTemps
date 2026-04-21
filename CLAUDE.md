# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

---

## Project Overview

**TrailTemps** (trailtemps.info) is a web-based weather planning platform for long-distance hikers. It provides:

1. Weather Planner — lookup by section/mile + date, with live 5-day forecast and 7-year planning average
2. Hike Duration Planner — start date → projected end date with temperature extremes map
3. Historical Temperature Extremes — pre-computed normals per waypoint (ERA5-Land, 2018–2024)
4. Alternate route selection — mutually exclusive swap alternates (FT and AZT)
5. Interactive Leaflet map display
6. Multi-trail architecture — All eleven National Scenic Trails fully live: Appalachian, Arizona, Continental Divide, Florida, Ice Age, Natchez Trace, New England, North Country, Pacific Crest, Pacific Northwest, and Potomac Heritage.
7. BestStart! calculator — scans all 365 possible start dates and recommends the one with the best UTCI thermal comfort score across the full hike

**Design principles — non-negotiable:**
- Pure static site: no build system, no framework, no backend
- Deployable as plain files via GitHub Pages
- Weather data via Open-Meteo API only (no other external dependencies)
- Modular per-trail structure — each trail is self-contained under `trails/<trail-name>/`

---

## Deployment

- GitHub Pages (static hosting)
- Cloudflare DNS → trailtemps.com / trailtemps.info
- Frontend: HTML + CSS + Vanilla JS + Leaflet.js (CDN, v1.9.4)
- Open-Meteo attribution is required and implemented in the page header (not footer)

---

## Running Data Utility Scripts

Node.js scripts exist **only** for offline data generation — not for the site itself.

Legacy AT scripts (root `scripts/` folder — superseded by tools/ below, kept for reference):
```bash
node scripts/generate-missing-normals-at.js
node scripts/migrate-historical-ids-mixed.js
node scripts/migrate-ids-at-main.js
node scripts/normalize-points-mile-only.js
```

Trail-specific generation tools live in `trails/*/tools/`:
```bash
node trails/appalachian-trail/tools/build-points-at.js
node trails/appalachian-trail/tools/generate-normals-at.js
node trails/new-england-trail/tools/generate-normals-net.js
node trails/natchez-trace-trail/tools/build-points-ntt.js
node trails/natchez-trace-trail/tools/generate-normals-ntt.js
node trails/arizona-trail/tools/fetch-geojson-azt.js
node trails/arizona-trail/tools/fetch-points-azt.js
node trails/arizona-trail/tools/import-alt-gpx.js
node trails/arizona-trail/tools/generate-normals-azt.js
node trails/pacific-crest-trail/tools/build-geojson-pct.js
node trails/pacific-crest-trail/tools/build-points-pct.js
node trails/pacific-crest-trail/tools/generate-normals-pct.js
node trails/pacific-northwest-trail/tools/build-pnt-data.js
node trails/pacific-northwest-trail/tools/fix-ferry-geometry.js
node trails/pacific-northwest-trail/tools/generate-normals-pnt.js
node trails/ice-age-trail/tools/build-points-iat.js
node trails/ice-age-trail/tools/generate-normals-iat.js
node trails/north-country-trail/tools/build-points-nct.js
node trails/north-country-trail/tools/generate-normals-nct.js
node trails/potomac-heritage-trail/tools/build-points-pht.js
node trails/potomac-heritage-trail/tools/generate-normals-pht.js
node trails/continental-divide-trail/tools/build-points-cdt.js
node trails/continental-divide-trail/tools/generate-normals-cdt.js
```

There are no tests, no linter, and no build step.

**Open-Meteo Professional API** — NCT, PHT, and CDT `generate-normals-*.js` scripts use the Professional subscription endpoint (`customer-archive-api.open-meteo.com/v1/archive`) with `apikey=TTyLPYLitRdmWqlF` and a 2-second throttle. Other trails' normals scripts still use the standard endpoint with 15-second throttle. Do not change NCT/PHT/CDT back to the standard endpoint.

---

## Site Architecture

### File Structure

```
index.html                          ← Landing page, trail selector grid
css/styles.css                      ← Shared styles (980px max-width via --maxw CSS var)
js/
  shared-utils.js                   ← Shared utility functions used by all trail app.js files (see section below)
  trail-nav.js                      ← Injects trail selector <details> dropdown into #trail-nav-mount
scripts/                            ← Node utilities for AT data normalization
trails/
  appalachian-trail/
    index.html
    js/app.js                       ← Single-file client app
    data/
      points.json                   ← 439 points at 5-mile intervals
      points_10mi_backup.json       ← backup of old 220-point file
      historical_weather.json       ← ~28 MB; 7 arrays × 439 points × 365 values
      trail.geojson
      archive/                      ← PRESERVE — do not delete
    tools/
      build-points-at.js            ← rebuild points.json from trail.geojson geometry
      generate-normals-at.js        ← fetch ERA5-Land normals for all 439 points
  florida-trail/
    index.html
    js/app.js
    data/
      points.json
      ft_meta.json
      trail.geojson
      trail_backbone.geojson
      historical_weather.json
    tools/
  new-england-trail/
    index.html
    js/app.js
    data/
      points.json
      trail.geojson
      net_meta.json
      historical_weather.json       ← 50 points at 5-mile intervals
    tools/
      generate-normals-net.js       ← Re-run to add/refresh normals
  natchez-trace-trail/
    index.html
    js/app.js
    data/
      points.json                   ← 692 points at 0.1-mile intervals
      trail.geojson                 ← 5 LineString features, one per section
      ntt_meta.json
      historical_weather.json       ← 15 points at ~5-mile intervals
    tools/
      build-points-ntt.js           ← Re-run to rebuild points/geojson from NPS ArcGIS
      generate-normals-ntt.js       ← Re-run to add/refresh normals
  arizona-trail/
    index.html
    js/app.js
    data/
      points.json                   ← 1,766 main spine + 36 P11e + 31 P33 alt points
      trail.geojson                 ← 44 features (one per passage), from USFS ArcGIS Layer 3
      azt_meta.json
      historical_weather.json       ← normals at ~5-mile intervals (178 points target)
    tools/
      fetch-geojson-azt.js          ← Fetches ArcGIS Layer 3, writes trail.geojson
      fetch-points-azt.js           ← Fetches ArcGIS polyline, interpolates at 0.5mi, writes points.json
  pacific-crest-trail/
    index.html
    js/app.js
    data/
      points.json                   ← 532 points at 5-mile intervals (miles 0–2,653)
      trail.geojson
      pct_meta.json
      historical_weather.json       ← 384 normals points at ~5-mile intervals; wrapped in { meta, points }
    tools/
      build-geojson-pct.js          ← Fetches USFS/PCTA geometry, writes trail.geojson
      build-points-pct.js           ← Builds points.json at 5-mile intervals with SRTM elevation
      generate-normals-pct.js       ← Fetches ERA5-Land normals for all 384 points; resume-safe
  pacific-northwest-trail/
    index.html
    js/app.js
    data/
      points.json                   ← 245 points at 5-mile intervals (miles 0–1,217.77)
      trail.geojson                 ← 6 features: 5 section LineStrings + 1 ferry connector
      pnt_meta.json
      historical_weather.json       ← 245 points, all complete
      _raw_usfs.json                ← cached USFS source geometry (used by build-pnt-data.js)
    tools/
      build-pnt-data.js             ← Fetches USFS Region 6 ArcGIS, builds points.json + trail.geojson + pnt_meta.json
      fix-ferry-geometry.js         ← Splits Puget Sound section at water crossing; makes ferry a dashed feature
      generate-normals-pnt.js       ← Fetches ERA5-Land normals for all 245 points; resume-safe (~61 min)
  ice-age-trail/
    index.html
    js/app.js
    data/
      points.json                   ← 2,687 main + 130 East Alt = 2,817 total points at 0.5-mile intervals
      trail.geojson                 ← 124 certified-segment LineStrings (DNR source)
      trail_roadwalk.geojson        ← 97 roadwalk connector features (IATA FeatureServer, display-only)
      iat_meta.json
      historical_weather.json       ← 469 normals points (451 main spine + 18 East Alt, ~5-mile intervals)
    tools/
      build-points-iat.js           ← Fetches WI DNR ArcGIS + IATA roadwalk; stitches, interpolates, writes all data files
      generate-normals-iat.js       ← Fetches ERA5-Land normals; resume-safe; reuses nearby existing points to reduce API calls
  north-country-trail/
    index.html
    js/app.js                       ← Single-file client app
    data/
      points.json                   ← 977 points at 5-mile intervals (miles 0–4,877.03, WEBO)
      trail.geojson                 ← 1,324 features (NCTA ArcGIS Layer 2; off-road solid, roadwalk dashed)
      nct_meta.json
      historical_weather.json       ← (~977 normals points when complete, ~60 MB; generation in progress)
      _raw_nct.json                 ← cached NCTA ArcGIS source geometry (used by build-points-nct.js)
      _raw_sht.json                 ← cached OSM SHT ways (480 ways, relation 1612587)
    tools/
      build-points-nct.js           ← Fetches NCTA ArcGIS + OSM SHT; stitches, interpolates, writes all data files
      generate-normals-nct.js       ← Fetches ERA5-Land normals for all 977 points; resume-safe (~82 min at 5-sec delay)
  potomac-heritage-trail/
    index.html
    js/app.js                       ← Single-file client app
    data/
      points.json                   ← 8,888 total points at 0.1-mile intervals (5,410 spine + DC alts + 3,064 WP-only)
      trail.geojson                 ← NPS FTDS ArcGIS features; spine solid, WP-only semi-transparent
      pht_meta.json
      historical_weather.json       ← { meta, points } wrapped; normals at ~5-mile intervals per section
      _raw_pht.json                 ← cached NPS ArcGIS source geometry (used by build-points-pht.js)
    tools/
      build-points-pht.js           ← Fetches NPS FTDS ArcGIS, stitches chains, interpolates at 0.1-mile intervals, writes all data files
      generate-normals-pht.js       ← Fetches ERA5-Land normals per (section_id, alt_id) group; resume-safe; { meta, points } output
```

### Shared JavaScript Files

**`js/shared-utils.js`** — Loaded before every trail's `app.js` via `<script defer src="/js/shared-utils.js">`. Exports all functions to global scope (no modules). Contains:

- DOM helpers: `el`, `setHtmlIfExists`, `setDisplayIfExists`
- Status helpers: `setDurStatus`, `setWeatherStatus`
- Cache helpers: `cacheGet`, `cacheSet` (with `QuotaExceededError` try/catch), `safeJSONParse`
- Date/time: `addDays`, `pad2`, `toISODate`, `resolveStartDate`, `MONTH_NAMES`, `daysInMonth`, `formatMonthDayName`, `initMonthDayPickerGeneric`, `getSelectedMonthDay(monthSelId, daySelId)`
- Formatting: `fmtMile`, `fmtTemp` (uses `Number.isFinite` guard), `fmtRh`, `feelsLikeNote`, `numVal`
- Weather math: `windChill`, `heatIndex`
- Map helpers: `boundsFromPoints`, `makeColoredPinIcon`
- **BestStart! / UTCI functions** (see BestStart! section below): `dayIndexFromMonthDay`, UTCI scoring helpers (`utciScoreHigh`, `utciScoreLow`, `utciHeatDepth`, `utciColdDepth`, `scoreToHeatCat`, `scoreToColdCat`, `utciCategoryDay`), `computeUtciCounts`, `renderDurExtremesBlocksShared`, `runBestStartShared`

**`js/trail-nav.js`** — Loaded via `<script defer src="/js/trail-nav.js">` on all 11 trail pages. Contains a single `TRAILS` array (the canonical trail list) and injects the `<details class="trail-selector">` dropdown into `<div id="trail-nav-mount">` on page load. Automatically marks the current page using `window.TRAIL_SLUG` or `data-trail` attribute. Badge logic: trails with a non-empty `badge` string show it in the nav; current "Coming" pages show `(Current — Coming Soon)`.

Every trail `index.html` includes these two script tags (plus `window.TRAIL_SLUG` inline) before the trail-specific `app.js`:
```html
<script defer src="/js/trail-nav.js"></script>
<script defer src="/js/shared-utils.js"></script>
<script defer src="js/app.js"></script>
```

### Client-Side Data Flow

1. On page load: fetch `points.json`, `trail.geojson`, `historical_weather.json` (cached in `localStorage`, 30-day TTL)
2. Leaflet renders trail geometry + markers
3. User inputs trigger:
   - Temperature extremes lookup from pre-computed normals (no API call)
   - Live 5-day forecast from `api.open-meteo.com/v1/forecast` (cached 30 min)
   - Historical lookup from `archive-api.open-meteo.com/v1/archive` (cached 24 hours)
4. Two tools per page: (A) hike duration/date calculator + temperature extremes, (B) point weather lookup

### localStorage Cache TTLs

| Data | TTL |
|------|-----|
| Forecast (Open-Meteo) | 30 minutes |
| Historical API response | 24 hours |
| Static data (points, GeoJSON, normals) | 30 days (versioned by cache key) |

### localStorage / HTTP Caching

Large `historical_weather.json` files (AT ~28 MB, and similarly large FT/NET files) exceed the localStorage quota and will throw `QuotaExceededError` if caching is attempted. For these trails, `loadPrecomputedNormals()` does **not** cache normals in localStorage — the browser's HTTP cache handles reuse instead. Only forecast and historical API responses (which are small and per-point) use localStorage.

---

## Conventions and Priorities

- **No framework, no build step** — plain HTML/CSS/JS only, deployable as static files
- **Static data and UI code are strictly separate** — data files in `data/`, logic in `js/app.js`
- **`trails/*/data/archive/` must be preserved** — never delete archive directories
- **Leaflet 1.9.4 via CDN** — tiles from OpenStreetMap
- **Open-Meteo attribution** belongs in the page header, not the footer
- **Prefer minimal DOM and data transformations** in `app.js`
- **`trailSlug`-based dynamic loading** — all paths are built dynamically from `trailSlug`

### UI Conventions (all trails)

- **Duration Calculator input order:** Miles Per Day → Direction/Route → Start Date
- **Two status divs per page:** `durStatus` (Duration Calculator errors only) and `weatherStatus` (Weather Planner errors only) — never share them
- **`durResult` and `durStatus`** must have `style="width:100%"` to prevent flex indentation inside `.controls`
- **Current Conditions box:** show wind speed only — no wind direction
- **Temperature advisories:** heat index advisory at apparent high ≥ 100 °F; wind chill advisory at apparent low ≤ 20 °F (20 °F chosen as typical gear rating floor for sleeping bags/insulation). These fire **only in the Weather Planner** (via `el("weatherStatus").innerHTML` — **not** `setWeatherStatus`, which uses `textContent` and strips HTML). In `computeAndRenderDurationExtremes`, `warningHtml` is set to `""` — no advisory logic runs in the Duration Calculator.
- **Apparent temperature** uses Steadman methodology (built into Open-Meteo `apparent_temperature_*` fields)
- **Extremes output format (all trails):** the unified `renderDurExtremesBlocksShared` renderer outputs three blocks inside `durExtremesHot`: (1) a 4-column duration summary table (Start Date / End Date / Distance / Duration), (2) a **Thermal Stress and Comfort Profile: Days on Trail** table (9 category columns showing day counts), (3) side-by-side Hottest Day / Coldest Night extremes tables with Date, Location, Actual Temp, Apparent Temp, Relative Humidity rows. `durExtremesCold` is cleared (legacy div kept for compatibility). Each trail's `renderDurExtremesBlocks` is a thin wrapper calling `renderDurExtremesBlocksShared` with a `formatLocation` callback.
- **`durExtremesMap` placement (all trails):** `<div id="durExtremesMap" style="margin-top:16px;"></div>` must appear AFTER `durExtremesHot` and `durExtremesCold` inside `durExtremesWrap`, followed by the map attribution `<p>`. The map is the last visible output, not the first. All trail `index.html` files follow this order: data tables → map div → attribution.
- **BestStart! button:** `<button id="bestStartBtn" type="button" class="btn-best-start"><em>BestStart!</em></button>` placed immediately after `durBtn` inside the same wrapper div. CSS class `.btn-best-start` defined in `css/styles.css` (green #2e7a2e/#235823).
- **BestStart! result div:** `<div id="bestStartResult"></div>` placed after `durResult`. `renderDurExtremesBlocksShared` clears it on every render.
- **`bestStartBtn` wiring:** `el("bestStartBtn")?.addEventListener("click", runBestStart)` in `initDurationUI()`.
- **Mile inputs:** always use `type="text" inputmode="numeric" pattern="[0-9]*"` (or `[0-9.]*` for decimal miles). Never `type="number"` — number inputs enforce browser spinner constraints and block free text entry. JS handles range validation.
- **Trail nav:** every trail page uses `<div id="trail-nav-mount"></div>` in `.header-actions` — never inline the `<details>` nav HTML. The canonical trail list lives only in `js/trail-nav.js`.
- **Shared CSS:** `.control-row`, `.ft-select-col`, `.btn-primary`, `.feels-hotter`, `.feels-cooler`, `.alt-group-block`, `.alt-options`, `.alt-delta` are defined in `css/styles.css`. Do not redeclare them inline. Trail-specific ID rules (e.g. `#atMileInput`, `#nttSectionInfo`) stay inline in the trail's `index.html`.
- **Alternate route UI pattern:** Use `<fieldset class="alt-group-block">` with `<legend>`, `<div class="alt-options">`, radio `<input>` labels, and `<span class="alt-delta">` for the mileage note. The delta should show segment miles only (not cumulative totals), plus the differential vs. main. See FT or AZT as reference. Direction dropdown contains only direction (NOBO/SOBO); alternates are separate fieldsets below.
- **`getSelectedAlts()`** — trails with radio-based alternates implement this function to return a plain object keyed by alt group id. `calcTotalMiles()` takes both direction and selectedAlts. `buildHikePoints()` and `getNearestPoint()` also take selectedAlts.
- **Alt passage points** use `passage_mile` (0-based within the passage) rather than spine `mile`. `getNearestPoint()` must convert accordingly when selecting alt segment points.
- **Normals load status message:** "Historical weather data loaded (...)" — not "planning normals" or "precomputed normals". On AT, IAT, PCT, and PHT, a `setTimeout(() => setDurStatus(""), 4000)` clears this message after 4 seconds.
- **Weather Planner cold advisory injection point:** In every trail's `runWeather`, after `renderPlanningSummary(...)` and before `} catch (err)`, check `forecastData.daily?.apparent_temperature_min` and `avgs.avgAppLow` (or `appLow` for AT) against ≤ 20 °F and set `el("weatherStatus").innerHTML` with a styled `<p>` tag. AT uses `appLow` (local variable from precomputed normals); all other trails use `avgs.avgAppLow`.

---

## BestStart! Feature

All active trail pages except NCT include the green *BestStart!* button. It scans all 365 possible start dates and recommends the one producing the highest cumulative UTCI thermal comfort score across the full hike. NCT BestStart! is not yet implemented.

### Shared Utility Functions (in `js/shared-utils.js`)

**`runBestStartShared({ durationDays, getHikePoints, getNormals, eliminator = null })`**
- Iterates all 365 start dates (REF_YEAR = 2025 fixed non-leap year)
- Calls `getHikePoints(startDate)` → `[{date, point}, ...]` per candidate
- Calls `getNormals(point)` → `{ app_hi:[365], app_lo:[365] }` per point
- Scores each day via UTCI tier; any day scoring 0 (Extreme stress) eliminates the candidate
- Optional `eliminator(startDate, endDate)` callback skips candidates (used for AT Katahdin snow season)
- Returns `{ bestStartDate: Date|null, bestCounts: object|null }`

**`renderDurExtremesBlocksShared(hottest, coldest, opts = {})`**
- `opts`: `{ startDate, endDate, distanceMiles, durationDays, startDateLabel="Start Date", utciCounts, formatLocation, durationNote, warningHtml }`
- Renders into `durExtremesHot`: duration table + UTCI profile + side-by-side extremes
- Clears `durResult` and `bestStartResult` on every call

**`computeUtciCounts(hikePoints, getNormals)`**
- `hikePoints`: `[{date, point}, ...]`; `getNormals`: `(point) => {app_hi, app_lo}|null`
- Returns counts object with 9 category keys

**`dayIndexFromMonthDay(monthDay)`** — maps `"MM-DD"` to 0–364 index using fixed non-leap year 2021

### UTCI Scoring Tiers

| Category | Apparent High | Apparent Low | Score |
|----------|--------------|-------------|-------|
| Extreme Heat | > 115 °F | — | 0 (eliminates) |
| Very Strong Heat | 101–115 °F | — | 2 |
| Strong Heat | 91–100 °F | — | 5 |
| Moderate Heat | 80–90 °F | — | 8 |
| Comfort Zone | ≤ 79 °F | ≥ 48 °F | 10 |
| Moderate Cold | — | 32–47 °F | 8 |
| Strong Cold | — | 9–31 °F | 5 |
| Very Strong Cold | — | −17–8 °F | 2 |
| Extreme Cold | — | < −17 °F | 0 (eliminates) |

Each day's score is `(heat score + cold score) / 2`. Scoring is symmetric — heat and cold stress are weighted equally. The combined per-day score is summed across the hike; highest total wins.

### Per-Trail Implementation Pattern

Each trail's `app.js` has:
1. **`renderDurExtremesBlocks(hottest, coldest, opts = {})`** — thin wrapper calling `renderDurExtremesBlocksShared` with a `formatLocation` callback specific to that trail's point label format
2. **`computeAndRenderDurationExtremes(params)`** — computes `utciCounts = computeUtciCounts(hikePoints, getNearestNormals)` and `endDate`, then passes all to `renderDurExtremesBlocks`
3. **`runBestStart()`** — reads inputs (mpd, direction, alts), calls `runBestStartShared`, then calls `computeAndRenderDurationExtremes` with `startDateLabel: "<em>BestStart!</em> Date"`

### Normals Key Convention

All trails normalize normals to `app_hi` / `app_lo` at load time. **Exception:** AT and PHT `historical_weather.json` store keys as `hi_app` / `lo_app`. AT uses a `getAtNormals` wrapper; PHT's `loadPrecomputedNormals()` remaps `hi_app`/`lo_app` → `app_hi`/`app_lo` directly on load.

### Alternate Route Bug — Critical Notes

**FT `ALT_GROUP_DEFAULTS`:** The fallback constant (used before `ft_meta.json` loads) must include `section_id` fields matching the radio button values (`"eastern_corridor"`, `"western_corridor"`, `"okeechobee_west"`, `"okee_east"`). Without these, `calcTotalMiles` falls through to the default option regardless of the user's selection on first page load.

**IAT `buildHikePoints` / `calcTotalMiles`:** Both use hardcoded fallback values for branch/rejoin miles (`branch_axis_mile: 617.2`, `rejoin_axis_mile: 640.5`) via `?? 617.2` / `?? 640.5`. These ensure correct alt routing even before `iat_meta.json` loads. Do not change these values without re-measuring from DNR geometry. `calcTotalMiles` applies the East Alt delta (`ag?.east_alt?.delta_miles ?? -12.7`) unconditionally — no early return for missing meta.

### NTT Special Case

NTT `runBestStart` uses `calcNttDuration(mpd).totalDays` for `durationDays` (not `Math.ceil(totalMiles / mpd)`), because NTT duration includes 4 travel days between disconnected sections. `buildHikePoints` takes `{directionId, startDate, milesPerDay}` — no `totalMiles` param.

---

## Appalachian Trail (AT) — Reference Implementation

- **Status:** Stable and live. Upgraded to 5-mile resolution with apparent temperature support (April 2026).
- **Point ID format:** `at-main-mi0000000` (thousandth-mile precision)
- **Data files:** `points.json`, `historical_weather.json`, `trail.geojson`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024)
- **Weather resolution:** 5-mile intervals (439 points, miles 0–2190)
  - Old 10-mile anchor points preserved exactly; 5-mile points extracted from `trail.geojson` geometry
  - Backup of old 10-mile points saved as `data/points_10mi_backup.json`
- **Temperature markers:** Red = hottest, Blue = coldest (upside-down teardrop style); ranked by apparent temperature
- **Distance:** Mile axis only; no alternates modeled
- **Weather Planner UI:** Planning Date → State (with mile ranges in labels) → Northbound Mile typed input (0–2190, validated against selected state's range)
  - Replaced old State + Mile dropdown with typed mile input
  - Functions: `getStateMileRange()`, `getSelectedPointFromMileInput()`
- **Apparent temperature:** full support — `hi_app`/`lo_app` shown in forecast table, planning summary, and duration extremes; heat index advisory (≥ 100 °F) and wind chill advisory (≤ 20 °F) both active
- **`historical_weather.json`:** rebuilt with 7 arrays per point: `hi`, `lo`, `hi_app`, `lo_app`, `rh_hi`, `rh_lo`, `ws` (365 values each); file is ~28 MB — too large for localStorage; uses HTTP cache instead (see localStorage / HTTP caching note below)
- **`NORMALS_CACHE_VERSION`:** `"v3"` — bump whenever `historical_weather.json` is rebuilt
- **Extremes output format:** matches FT — single Date/Location header row spanning all columns, then Actual Temp / Apparent Temp / Relative Humidity column headers, then High and Low rows. Helpers: `fmtTemp()`, `fmtRh()`, inner `extremeTable()` function inside `renderDurExtremesBlocks()`

### AT Tools

Located in `trails/appalachian-trail/tools/`:

- **`build-points-at.js`** — Extracts true 5-mile GPS coordinates from `trail.geojson` (skips degenerate segments), merges with existing 10-mile anchor points, writes 439-point `points.json`. Re-run if trail geometry changes.
- **`generate-normals-at.js`** — Fetches ERA5-Land normals from Open-Meteo for all 439 points; outputs `hi`, `lo`, `hi_app`, `lo_app`, `rh_hi`, `rh_lo`, `ws` arrays; resume-safe; 15-second throttle between requests; full run takes ~1h 50m.

---

## Florida Trail (FT) — Live

- **Status:** Fully live. Weather, extremes, alternates, and UI all working.
- **Point ID format:** `ft-main-mi{7digits}` / `ft-{section_id}-mi{7digits}`
- **Data files:** `points.json`, `ft_meta.json`, `trail.geojson`, `trail_backbone.geojson`, `historical_weather.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024)
- **Weather resolution:** ~1-mile intervals
- **Section selector:** Region → Section → Section Mile
- **Alternates:** 2 mutually exclusive swap groups (Okeechobee crossing, Ocala-Orlando loop); terminus variant (Blackwater) encoded in direction dropdown
- **Notable:** Heat index is primary concern; wind chill also computed via Steadman

### FT Hierarchy
Region → Section → Point
`axis_mile` = authoritative spine position (0–1204); `sec_mile` = miles from section south edge

### FT Alternate Groups — LOCKED

**Okeechobee Crossing (`alt-okee`):** branch 94, rejoin 150; west (default, 56 mi) vs. east (+64 mi)

**Ocala-Orlando Loop (`alt-orlando-ocala-loop`):** branch 240, rejoin 438; eastern corridor (default, 198 mi) vs. western corridor (−36 mi)

**Blackwater terminus:** encoded in direction dropdown (NOBO/SOBO × Pickens/Blackwater); Blackwater ends at axis_mile 1080 (different physical terminus — handle subtly in UI)

---

## New England Trail (NET) — Live

- **Status:** Fully live as of April 2026.
- **Point ID format:** `net-main-mi{7digits}` (main spine), `net-spur-mi{7digits}` (Middletown spur)
- **Data files:** `points.json`, `net_meta.json`, `trail.geojson`, `historical_weather.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024), generated via `tools/generate-normals-net.js`
- **Weather resolution:** 5-mile intervals (50 points: 43 main + 7 spur)
- **Total spine:** 208.3 miles (Guilford, CT → Royalston Falls, MA); CT/MA border between miles 109–110

### NET Sections (3)

| id | Name | mile_type | Range |
|----|------|-----------|-------|
| `ct_guilford` | Connecticut — Main Spine | spine | 1–109 |
| `ct_middletown` | Connecticut — Middletown Spur | spur | 0–28 |
| `ma` | Massachusetts — Main Spine | spine | 110–208 |

### NET Spur

The Middletown Connector spur (28 miles) runs from Middletown, CT and joins the main spine at **mile 38**. It is an alternate southern start, not an alternate through-route. It is not included in the official 208.3-mile distance.

### NET Direction Options

| id | Label | Miles | Uses spur |
|----|-------|-------|-----------|
| `nobo_main` | Northbound — Guilford → Royalston Falls (Main) | 208.3 | No |
| `nobo_alt` | Northbound — Middletown → Royalston Falls (Alt.) | 198.3 | Yes |
| `sobo_main` | Southbound — Royalston Falls → Guilford (Main) | 208.3 | No |
| `sobo_alt` | Southbound — Royalston Falls → Middletown (Alt.) | 198.3 | Yes |

Alt mileage: 28 (spur) + (208.3 − 38) = 198.3 miles

### NET `net_meta.json` Structure

```json
{
  "trail": { "name", "spine_miles", "map_center", "map_zoom", "termini" },
  "sections": [ { "id", "name", "mile_type", "mile_start", "mile_end" } ],
  "spur": { "name", "start_terminus", "length_miles", "junction_spine_mile" },
  "direction_options": [ { "id", "label", "total_miles", "uses_spur", "is_nobo" } ]
}
```

### NET `points.json` Schema

Main spine points:
```json
{ "id": "net-main-mi0050000", "mile": 50, "lat": ..., "lon": ..., "state": "CT" }
```

Spur points:
```json
{ "id": "net-spur-mi0015000", "spur_mile": 15, "lat": ..., "lon": ..., "state": "CT", "spur": true }
```

### NET `historical_weather.json` Schema (per point)

```json
{
  "id": "...", "lat": ..., "lon": ...,
  "hi": [365 values],     "lo": [365 values],
  "hi_app": [365 values], "lo_app": [365 values],
  "rh_hi": [365 values],  "rh_lo": [365 values],
  "ws": [365 values]
}
```
`ws` = avg daily max wind speed (mph), used for wind chill context. Keys match FT convention (`hi_app`/`lo_app`) for app.js reuse.

### NET Notable Features

- **Wind chill advisory** (first on any TrailTemps trail): fires when apparent low ≤ 20 °F during hike
- **Roadway gaps and river crossings** documented in Notes section (Connecticut River ~mile 120, Westfield River, Plainville Gap)
- **Weather planner section info** displays as "Section Range: X-Y Miles"

---

## Natchez Trace Trail (NTT) — Live

- **Status:** Fully live as of April 2026.
- **Point ID format:** `ntt-{section_id}-mi{4digits}` (tenths-mile precision, section-relative)
- **Data files:** `points.json`, `ntt_meta.json`, `trail.geojson`, `historical_weather.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024), generated via `tools/generate-normals-ntt.js`
- **Points resolution:** 0.1-mile intervals (692 points total); normals at ~5-mile intervals (15 points)
- **Trail geometry source:** NPS Public Trails ArcGIS FeatureServer (fetched via `tools/build-points-ntt.js`)

### NTT Unique Architecture — Discontinuous Sections

The NTT is **not a continuous trail**. It consists of five separate hiking sections along the ~444-mile Natchez Trace Parkway corridor. Each section starts at mile 0 (section-relative). The duration calculator adds **1 travel day between each consecutive section pair** (4 travel days total). Hiking days are **ceilinged per-section independently** — unused miles do not carry over between sections.

### NTT Sections (5) — NOBO order

| id | Name | State | Section miles | Axis start → end |
|----|------|-------|--------------|-----------------|
| `portkopinu` | Portkopinu | MS | 0–3.44 | 0.00 → 3.44 |
| `rocky-springs` | Rocky Springs | MS | 0–8.99 | 3.44 → 12.43 |
| `yockanookany` | Yockanookany | MS | 0–25.73 | 12.43 → 38.16 |
| `blackland-prairie` | Blackland Prairie | MS | 0–6.11 | 38.16 → 44.27 |
| `highland-rim` | Highland Rim | TN | 0–24.63 | 44.27 → 68.89 |

**Total trail miles: 68.89** (measured from NPS GIS data)

### NTT `points.json` Schema

```json
{ "id": "ntt-yockanookany-mi0126", "section": "yockanookany", "state": "MS",
  "mile": 12.6, "axis_mile": 25.0, "lat": ..., "lon": ... }
```

### NTT `ntt_meta.json` Structure

```json
{
  "trail": { "name", "total_trail_miles", "travel_days_between_sections", "map_center", "map_zoom", "termini" },
  "sections": [ { "id", "name", "state", "mile_start", "mile_end", "axis_start", "axis_end" } ],
  "direction_options": [ { "id", "label", "total_miles", "is_nobo" } ]
}
```

### NTT Tools

- **`build-points-ntt.js`** — Fetches NPS ArcGIS geometry for all 5 sections (16 feature IDs), stitches multi-segment sections using nearest-endpoint matching, interpolates at 0.1-mile intervals, writes `points.json` and `trail.geojson`. Re-run if NPS source data changes.
- **`generate-normals-ntt.js`** — Fetches ERA5-Land normals for 15 target points (~5-mile spacing across all sections), writes `historical_weather.json`. Resume-safe.

### NTT Notable Features

- **Discontinuous trail** — only hiking miles are counted; parkway driving between sections is not modeled
- **Travel days** — 4 travel days added to duration (1 per section gap); shown separately in duration result table
- **Per-section mileage ceiling** — `Math.ceil(secLen / mpd)` computed independently per section
- **Heat index primary concern** — MS sections can exceed 100 °F apparent temperature in summer
- **Wind chill advisory** — TN Highland Rim section can reach ≤ 20 °F in winter
- **NPS data gap** — Rocky Springs has a ~0.54-mile straight-line bridge between two NPS segments (parking area gap); acceptable for weather interpolation purposes
- **Trail color:** `#e06060` (salmon/red), matching FT and NET

---

## Arizona Trail (AZT) — Live

- **Status:** Fully live as of April 2026.
- **Point ID format:** `azt-main-mi{5digits}` (main spine, tenths-mile precision); `azt-p11e-mi{4digits}` / `azt-p33-mi{4digits}` (alt passages, passage_mile-relative)
- **Data files:** `points.json`, `azt_meta.json`, `trail.geojson`, `historical_weather.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024)
- **Points resolution:** 0.5-mile intervals (1,766 main spine + 36 P11e + 31 P33 alt points)
- **Trail geometry source:** USFS ArcGIS FeatureServer (Layer 3, fetched via `fetch-geojson-azt.js`); alt passage GPX from ATA website
- **Weather resolution:** 5-mile intervals for normals (178 target points on main spine)
- **Passage selector:** Region (Southern/Central/Northern) → Passage → Passage Mile
- **Trail color:** same `#e06060` as FT, NET, NTT

### AZT Regions (3)

| id | Name | Passages |
|----|------|----------|
| `south` | Southern Arizona | P1–P13 |
| `central` | Central Arizona | P14–P26 |
| `north` | Northern Arizona | P27–P43 |

### AZT Alternate Groups — LOCKED

**Pusch Ridge (`pusch`):** branch 164.0, rejoin 183.0; P11 Santa Catalinas main (19.0 mi) vs. P11e bypass alt (17.6 mi, −1.4 mi). Both shown in passage selector. P11e points sourced from ATA GPX.

**Flagstaff (`flagstaff`):** branches **mid-P31** at Fisher Point (spine mile ~568.3), rejoin 596.3 (P34 start). P32 Elden Mountain main (28.1 mi through split) vs. P33 Flagstaff Urban alt (15.4 mi, −12.6 mi). P33 controlled via radio fieldset only (not in passage selector). P33 points sourced from ATA GPX.

**Critical:** The Flagstaff branch is inside P31 at Fisher Point — NOT at the P31/P32 boundary. P33 shares no USFS geometry (city streets); its `passage_mile` is 0-based from Fisher Point. Do not change these values without re-measuring from ATA GPX geometry.

### AZT Direction Options (2)

| id | Label | Base miles |
|----|-------|-----------|
| `nobo` | Northbound — Coronado Memorial/Mexico → Utah Border | 882.5 |
| `sobo` | Southbound — Utah Border → Coronado Memorial/Mexico | 882.5 |

Total miles computed at runtime: `calcTotalMiles(directionId, selectedAlts)` applies `delta_miles` from each alt_group (`−1.4` for P11e, `−12.6` for P33).

### AZT Elevation Correction

Applied to apparent temperatures using `trail_elev` (feet, from ArcGIS Z coords) vs. `grid_elev` (feet, converted from Open-Meteo meters × 3.28084):

- Trail above grid (diff > +300 ft): apparent high **−3.5 °F per 1000 ft**, apparent low **−2.0 °F per 1000 ft**
- Trail below grid (diff < −300 ft): apparent high **+3.5 °F per 1000 ft only** (no change to low)
- Threshold: ±300 ft before any correction fires
- ArcGIS Z coords are already in feet — do NOT multiply by 3.28084 for `trail_elev`
- Open-Meteo `elevation` field IS in meters — multiply by 3.28084 for `grid_elev`

### AZT `azt_meta.json` Structure

```json
{
  "trail": { "name", "spine_miles", "map_center", "map_zoom", "termini" },
  "regions": [ { "id", "name", "passage_start", "passage_end" } ],
  "passages": [ { "region", "id", "num", "name", "mile_start", "mile_end",
                  "alt_group"(optional), "alt_variant"(optional) } ],
  "alt_groups": [ { "id", "label", "branch_mile", "rejoin_mile",
                    "main_passage", "alt_passage", "delta_miles", "note" } ],
  "direction_options": [ { "id", "label", "total_miles", "is_nobo" } ]
}
```

### AZT `points.json` Schema

Main spine points:
```json
{ "id": "azt-main-mi00500", "mile": 50.0, "lat": ..., "lon": ...,
  "passage_id": "p10", "trail_elev": 4822 }
```

Alt passage points (P11e, P33):
```json
{ "id": "azt-p11e-mi0050", "passage_id": "p11e", "passage_mile": 5.0,
  "lat": ..., "lon": ..., "trail_elev": 7214 }
```

Alt points use `passage_mile` (0-based within the passage), not spine `mile`. `getNearestPoint()` converts spine mile to local passage mile before lookup.

### AZT `historical_weather.json`

Same 7-array schema as other trails (`hi`, `lo`, `hi_app`, `lo_app`, `rh_hi`, `rh_lo`, `ws`). Normals points are on the **main spine only** at 5-mile intervals; alt passage points fall back to nearest main-spine normal (acceptable — elevations are similar enough for P11e; P33 through Flagstaff is the weakest approximation).

### AZT Tools

Located in `trails/arizona-trail/tools/`:

- **`fetch-geojson-azt.js`** — Fetches USFS ArcGIS Layer 3, sorts features by passage number (using `passageNumericKey()` so "11e" → 11.5), writes `trail.geojson`. Re-run if USFS source changes.
- **`fetch-points-azt.js`** — Fetches USFS polyline (main spine only, no P11e/P33), interpolates at 0.5-mile intervals with Z elevation preserved, assigns `passage_id` from meta mile ranges. Re-run if geometry changes.
- **`import-alt-gpx.js`** — Fetches ATA GPX track files for P11e and P33 (URLs hardcoded), interpolates at 0.5-mile intervals, appends points to `points.json`. Safe to re-run (skips existing IDs). GPX elevation is in meters and converted with × 3.28084.
- **`generate-normals-azt.js`** — Auto-resumes: reads existing `historical_weather.json`, fetches only missing normals points, 15-second rate limit, saves after every point. Run with `--dry-run` to preview. Full run ~44 min (178 points).

### AZT Notes on Map Data

- **P33 (Flagstaff Urban Route) is absent from the trail map.** City streets and parks are not in the USFS layer. Hikers on P33 should use the ATA Farout/Guthook app for navigation.
- **The Flagstaff branch point (Fisher Point, ~mile 568.3) is approximate**, derived by matching ATA GPS coordinates to nearest main-route geometry vertex.
- **P11e geometry** sourced from ATA GPX (`pass-11e.gpx`), not USFS ArcGIS.

---

## Pacific Northwest Trail (PNT) — Live

- **Status:** Fully live as of April 2026.
- **Point ID format:** `pnt-main-mi0000000` (thousandth-mile precision, zero-padded to 7 digits)
- **Data files:** `points.json`, `pnt_meta.json`, `trail.geojson`, `historical_weather.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024)
- **Weather resolution:** 5-mile intervals (245 points, miles 0–1,217.77)
- **Trail geometry source:** USFS Region 6 ArcGIS Feature Service (`services1.arcgis.com/gGHDlz6USftL5Pau`)
- **Trail color:** `#e06060` (same salmon/red as FT, NET, NTT)
- **Direction convention:** WEBO (westbound, Chief Mountain → Cape Alava) / EABO (eastbound); uses `is_webo` flag in meta (vs `is_nobo` on other trails); app checks `directionId === "webo"` directly

### PNT Geographic Sections (5)

| id | Name | States | Mile range |
|----|------|--------|-----------|
| `rocky-mountains` | Rocky Mountains | MT/ID | 0–310 |
| `columbia-mountains` | Columbia Mountains | WA | 310–621 |
| `north-cascades` | North Cascades | WA | 621–853 |
| `puget-sound` | Puget Sound | WA | 853–1,001 |
| `olympic-peninsula` | Olympic Peninsula | WA | 1,001–1,218 |

Sections match the five USFS geographic areas. Rocky Mountains section spans MT (miles 0–220) and ID (miles 220–310); `pnt_meta.json` records `"state": "MT/ID"`.

### PNT Ferry Crossing

The only saltwater ferry crossing on any National Scenic Trail. The trail crosses Puget Sound from the Keystone/Fort Casey terminal (Whidbey Island) to Port Townsend (Olympic Peninsula) — a ~30-minute crossing.

**In `trail.geojson`:** 6 features total — 5 trail section `LineString`s + 1 ferry `LineString`. The ferry feature has `"segment_type": "ferry"` and geometry extracted from the USFS source data (not hand-placed). The Puget Sound section ends at the Fort Casey terminal; the Olympic Peninsula section begins at Port Townsend. Ferry miles are **not** counted in `total_trail_miles`.

**In `app.js`:** `applyTrailOverlay()` reads `feature.properties.segment_type`:
- `"trail"` → `TRAIL_STYLE` (`#e06060`, weight 3.25, solid)
- `"ferry"` → `FERRY_STYLE` (`#e06060`, weight 2, opacity 0.45, `dashArray: "8, 12"`)

### PNT Notable Features

- **No alternates** — single-spine trail; no `getSelectedAlts()` needed
- **No elevation adjustment** — ERA5-Land grid points are sufficient given the PNT's terrain profile (no isolated summits or deep canyons creating abrupt micro-climate breaks); unlike AZT
- **`fix-ferry-geometry.js`** — must be re-run after any rebuild of `trail.geojson` from `build-pnt-data.js`, as it splits the Puget Sound section at the largest coordinate jump (water crossing) and converts that portion to the ferry feature
- **`_raw_usfs.json`** — cached USFS source data; delete it to force a fresh fetch on next `build-pnt-data.js` run

### PNT Tools

- **`build-pnt-data.js`** — Fetches all 456 USFS features, merges by section, interpolates at 5-mile intervals, writes `trail.geojson`, `points.json`, and `pnt_meta.json`. Caches raw USFS data in `_raw_usfs.json`. Re-run if trail geometry changes, then re-run `fix-ferry-geometry.js`.
- **`fix-ferry-geometry.js`** — Splits the Puget Sound `LineString` at the largest coordinate gap (the water crossing), keeps the land portion as the trail section, converts the water-crossing portion to the `segment_type: "ferry"` dashed feature. Replaces any hand-placed ferry connector.
- **`generate-normals-pnt.js`** — Fetches ERA5-Land normals for all 245 points; resume-safe (saves after each point); 15-second throttle; full run ~61 minutes.

---

## Pacific Crest Trail (PCT) — Live

- **Status:** Fully live as of April 2026.
- **Point ID format:** `pct-main-mi0000000` (thousandth-mile precision, zero-padded to 7 digits)
- **Data files:** `points.json`, `pct_meta.json`, `trail.geojson`, `historical_weather.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024)
- **Weather resolution:** 5-mile intervals (532 points, miles 0–2,653)
- **Normals count:** 384 points at ~7-mile intervals; wrapped in `{ meta, points }` object
- **Trail geometry source:** USFS / PCTA geometry
- **Trail color:** `#e06060` (same salmon/red as FT, NET, NTT, AZT, IAT)
- **Direction convention:** NOBO (northbound, Campo → Manning Park) / SOBO (southbound); uses `is_nobo` flag
- **Elevation source:** `trail_elev` per point from SRTM via OpenTopoData (feet); `grid_elev` from `historical_weather.json` (Open-Meteo ERA5-Land, stored in feet)

### PCT Geographic Sections (5)

| id | Name | State | Mile range |
|----|------|-------|-----------|
| `socal` | Southern California | CA | 0–702 |
| `central-cal` | Central California | CA | 702–1,092 |
| `norcal` | Northern California | CA | 1,092–1,702 |
| `oregon` | Oregon | OR | 1,702–2,147 |
| `washington` | Washington | WA | 2,147–2,653 |

### PCT Direction Options (2)

| id | Label | Total miles |
|----|-------|------------|
| `nobo` | Northbound — Campo (Mexican Border) → Manning Park (Canadian Border) | 2,653.0 |
| `sobo` | Southbound — Manning Park (Canadian Border) → Campo (Mexican Border) | 2,653.0 |

### PCT Elevation Correction

Same logic as AZT (applied to apparent temperatures only):

- Trail above grid (diff > +300 ft): apparent high **−3.5 °F per 1000 ft**, apparent low **−2.0 °F per 1000 ft**
- Trail below grid (diff < −300 ft): apparent high **+3.5 °F per 1000 ft only** (no change to low)
- `ELEV_THRESHOLD_FT = 300` — deadband before any correction fires
- `trail_elev` from `points.json` (SRTM via OpenTopoData, in feet — do NOT re-multiply)
- `grid_elev` from `historical_weather.json` normals entries (stored in feet, already converted from Open-Meteo meters)
- Applied in both the hike duration extremes and the weather planner point lookup

### PCT Notable Features

- **No alternates** — single continuous spine; no `getSelectedAlts()` needed
- **BestStart!** — fully implemented: button, `bestStartResult` div, `runBestStart()`, `bestStartBtn` wired in `initDurationUI()`
- **`NORMALS_CACHE_VERSION`:** `"v1"` — bump whenever `historical_weather.json` is rebuilt
- **`{ meta, points }` wrapper** — same structure as IAT; `historical_weather.json` is not a flat array
- **Katahdin-style eliminator not used** — unlike AT, no seasonal snow-closure eliminator is applied; BestStart! relies on UTCI scoring alone
- **Heat/cold advisories via `warningHtml`:** PCT's `computeAndRenderDurationExtremes` builds advisory HTML strings (heat index ≥ 100 °F; wind chill ≤ 20 °F) and passes them as `warningHtml` to `renderDurExtremesBlocks`. Do not append advisories to `durResult` directly — `renderDurExtremesBlocksShared` clears it on every call.

### PCT Tools

Located in `trails/pacific-crest-trail/tools/`:

- **`build-geojson-pct.js`** — Fetches USFS/PCTA geometry, writes `trail.geojson` (5 section `LineString` features). Re-run if trail geometry changes.
- **`build-points-pct.js`** — Interpolates points at 5-mile intervals, fetches SRTM elevation via OpenTopoData for each point (stored as `trail_elev` in feet), writes `points.json`. Re-run if geometry changes.
- **`generate-normals-pct.js`** — Fetches ERA5-Land normals for all 384 target points; resume-safe (saves after each point); 15-second throttle. Stores `grid_elev` (feet) alongside normals for elevation correction. Outputs `{ meta, points }` wrapped `historical_weather.json`.
- **`check-normals-pct.js`** — Utility script to verify coverage and completeness of `historical_weather.json` without fetching new data.

---

## Ice Age Trail (IAT) — Live

- **Status:** Fully live as of April 2026.
- **Point ID format:** `iat-{section-slug}-mi{4digits}` (main spine, tenths-mile precision); `iat-east-alt-mi{5digits}` (East Alt, hundredths-mile precision)
- **Data files:** `points.json`, `iat_meta.json`, `trail.geojson`, `trail_roadwalk.geojson`, `historical_weather.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024)
- **Points resolution:** 0.5-mile intervals (2,687 main + 130 East Alt = 2,817 total)
- **Trail geometry source:** Wisconsin DNR ArcGIS MapServer (Layer 2); roadwalk from IATA FeatureServer
- **Weather resolution:** ~5-mile intervals (469 normals points: 451 main + 18 East Alt)
- **Segment selector:** Region (Western/Central/Eastern) → Segment → Segment Mile
- **Trail color:** `#e06060` (same salmon/red as FT, NET, NTT, AZT)
- **Axis-mile system:** Total ~1,315.6 miles (West Alt) / ~1,302.9 miles (East Alt). Each of 124 named segments absorbs the roadwalk distance to neighboring segments — every axis mile maps to exactly one segment with no gaps.

### IAT Regions (3)

| id | Name | Segments |
|----|------|---------|
| `western` | Western | 44 segments (St. Croix Falls → Antigo Heights) |
| `central` | Central | 44 segments (Plover River → Clover Valley) |
| `eastern` | Eastern | 36 segments (Whitewater Lake → Sturgeon Bay) |

### IAT Alternate Group — LOCKED

One route choice exists in the Baraboo Hills / Portage area:

**Dells-Baraboo/Portage (`dells-baraboo-portage`):** branches mid-Devil's Lake segment at `branch_axis_mile: 617.2`, rejoins at Chaffee Creek (`rejoin_axis_mile: 640.5`).

| Alt | Label | Miles (in alt zone) | Note |
|-----|-------|---------------------|------|
| `west` (default) | Dells-Baraboo (West Alt.) | 83.7 mi | Scenic route through Baraboo Hills; Baraboo segment is the only certified trail; remainder is roadwalk |
| `east` | Portage (East Alt.) | 71 mi (−12.7 mi) | Devil's Lake north portion + Sauk Point → Portage Canal → John Muir Park → Montello → Karner Blue |

The Devil's Lake segment (10.9 mi total) is **split at 7.0 mi** (`DL_MAIN_MILES`): the south 7 mi are on the main spine (shared); the north ~4 mi become the first leg of the East Alt. The West Alt (Baraboo + roadwalk) stays on the main spine axis_mile coordinate system. East Alt points have `alt_id: "east"` and `alt_mile` (0-based from branch) instead of `axis_mile`.

**Do not change branch/rejoin miles without re-measuring from DNR geometry.**

### IAT Data Coordinate Systems

- **Main spine points:** `{ id, section, region, state, mile, axis_mile, lat, lon }` — axis_mile is cumulative from western terminus (0 at St. Croix Falls)
- **East Alt points:** `{ id, section, region, state, mile, alt_mile, alt_id: "east", lat, lon }` — alt_mile is 0-based from the Devil's Lake branch point
- **`buildHikePoints()`** is zone-aware: pre-branch → `getNearestPointByAxisMile()`; East Alt zone → `getNearestEastAltPoint(alt_mile)`; West Alt zone → proportional mapping onto branch→rejoin spine range; post-rejoin → `getNearestPointByAxisMile()`

### IAT `iat_meta.json` Structure

```json
{
  "trail": { "name", "total_trail_miles", "map_center", "map_zoom", "termini" },
  "sections": [ { "id", "name", "region", "state", "certified_miles", "ui_mile_start", "ui_mile_end" } ],
  "east_alt_sections": [ { "id", "name", "alt_mile_start", "alt_mile_end" } ],
  "alt_groups": [ { "id", "label", "branch_axis_mile", "rejoin_axis_mile",
                    "west_alt": { "id", "label", "total_miles", "segments" },
                    "east_alt": { "id", "label", "total_miles", "delta_miles", "segments" } } ],
  "direction_options": [ { "id", "label", "total_miles", "is_wte" } ]
}
```

### IAT `index.html` Bootstrap

`IAT_SECTIONS_BOOTSTRAP` is hardcoded in `index.html` as a JSON array matching `iat_meta.json` sections, with `{ id, name, region, s, e }` (s = ui_mile_start, e = ui_mile_end). **Must be regenerated whenever `build-points-iat.js` is re-run**, since axis_mile ranges shift when trail geometry changes. Generate with:
```bash
node -e "const m=require('./trails/ice-age-trail/data/iat_meta.json'); console.log(JSON.stringify(m.sections.map(s=>({id:s.id,name:s.name,region:s.region,s:Math.round(s.ui_mile_start*10)/10,e:Math.round(s.ui_mile_end*10)/10}))));"
```

### IAT Roadwalk Display

`trail_roadwalk.geojson` (97 features) is fetched from the IATA ArcGIS FeatureServer and rendered as a **dotted line** on both maps (`dashArray: "1 9"`, opacity 0.65). Display-only — no weather data or points are generated for roadwalk geometry. Both the weather planner map and the duration extremes map load this overlay via `fetchRoadwalkGeojson()`.

### IAT `historical_weather.json`

Same 7-array schema as other trails (`hi`, `lo`, `hi_app`, `lo_app`, `rh_hi`, `rh_lo`, `ws`). Wrapped in `{ meta, points }` object (unlike flat arrays on older trails). 469 total normals:
- 451 main spine points at ~5-mile axis_mile intervals — used for both main spine and West Alt lookups
- 18 East Alt points at ~5-mile alt_mile intervals — used when hiker is in the East Alt zone
- East Alt points fall back to nearest main-spine normal via lat/lon distance when no direct match (most East Alt points are geographically close to main-spine normals)

### IAT Notable Features

- **Roadwalk absorption** — the only trail where roadwalk distances are systematically absorbed into named segments rather than modeled as separate sections
- **Stitching algorithm** — `build-points-iat.js` uses greedy nearest-endpoint stitching with `findTerminalHint()` to identify true chain endpoints before stitching (prevents mid-chain starts at junction points, e.g. Kewaunee River)
- **Outlier path filtering** — `filterOutlierPaths()` drops DNR paths outside Wisconsin's bounding box and applies a statistical median-distance filter to handle bad-data segments
- **East Alt stitching** — Devil's Lake split at 7.0 mi; north portion + Sauk Point → Portage Canal → John Muir Park → Montello → Karner Blue stitched in order into East Alt chain
- **Normals reuse** — `generate-normals-iat.js` skips API calls when a new target point is within 1.0 mile of an existing normals entry (ERA5-Land grid resolution ~9 km ≈ 5.6 mi; nearby points return identical data)
- **Heat index and wind chill** — both active; heat advisory ≥ 100 °F, cold advisory ≤ 20 °F
- **Stale normals cleanup** — on resume, `generate-normals-iat.js` strips entries whose IDs are no longer in `points.json` (IDs shift when trail geometry changes)

### IAT Tools

Located in `trails/ice-age-trail/tools/`:

- **`build-points-iat.js`** — Fetches all Wisconsin DNR features (2,620 paths, paginated), groups by segment name, stitches using `findTerminalHint()` + greedy nearest-endpoint, interpolates at 0.5-mile intervals, splits Devil's Lake for East Alt, fetches IATA roadwalk geometry. Writes `points.json`, `trail.geojson`, `trail_roadwalk.geojson`, and `iat_meta.json`. Re-run if trail geometry changes; then regenerate bootstrap in `index.html` and re-run `generate-normals-iat.js`.
- **`generate-normals-iat.js`** — Selects target points at ~5-mile intervals (main spine by axis_mile, East Alt by alt_mile); strips stale entries; reuses nearby existing normals (within 1 mi) instead of re-fetching; fetches remaining from Open-Meteo archive; resume-safe (saves after each point); 15-second throttle.

---

## North Country Trail (NCT) — Live

- **Status:** Live (April 2026). `historical_weather.json` normals generation underway (resume-safe; use Open-Meteo Professional API).
- **Point ID format:** `nct-{state_id}-mi{7digits}` (thousandth-mile precision, zero-padded to 7 digits; state_id is lowercase, e.g. `nct-mn-mi3533803`)
- **Data files:** `points.json`, `nct_meta.json`, `trail.geojson`, `historical_weather.json` (in progress), `_raw_nct.json`, `_raw_sht.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024), via `generate-normals-nct.js`; uses Professional API (`customer-archive-api.open-meteo.com`, 2-second throttle)
- **Weather resolution:** 5-mile intervals (977 points, miles 0–4,877.03, WEBO order)
- **Trail geometry sources:**
  - NCTA ArcGIS FeatureServer Layer 2 — main source for all 8 states
  - OSM Overpass API — Superior Hiking Trail (relation 1612587, 480 ways) injected for northeastern MN (Duluth → Silver Bay corridor, ~100 miles omitted from NCTA FeatureServer)
- **Trail color:** `#e06060` (same salmon/red as FT, NET, NTT, AZT, IAT, PCT)
- **Direction convention:** WEBO (westbound, Crown Point NY/Vermont → Lake Sakakawea ND) / EABO (eastbound); uses `is_webo` flag in meta
- **Cache files:** `_raw_nct.json` (NCTA ArcGIS, cached to avoid repeated fetches); `_raw_sht.json` (OSM SHT ways, cached similarly). Delete either to force a fresh fetch on next build run.

### NCT Geographic Sections (8 States)

| State | Name | Axis start | Axis end | Miles |
|-------|------|-----------|---------|-------|
| `vt` | Vermont | 0 | 70.583 | 70.6 |
| `ny` | New York | 70.583 | 775.202 | 704.6 |
| `pa` | Pennsylvania | 775.202 | 1,059.746 | 284.5 |
| `oh` | Ohio | 1,059.746 | 2,132.692 | 1,072.9 |
| `mi` | Michigan | 2,132.692 | 3,318.58 | 1,185.9 |
| `wi` | Wisconsin | 3,318.58 | 3,533.803 | 215.2 |
| `mn` | Minnesota | 3,533.803 | 4,410.87 | 877.1 |
| `nd` | North Dakota | 4,410.87 | 4,877.027 | 466.2 |

**Total trail miles: 4,877.03** (as built from NCTA ArcGIS + SHT injection)

These values are the `NCT_STATES_BOOTSTRAP` in `index.html` and must match `nct_meta.json`. **Re-run `build-points-nct.js` and update both places whenever geometry changes.**

### NCT Direction Options (2)

| id | Label | Total miles |
|----|-------|------------|
| `webo` | Westbound — Crown Point, NY / Vermont → Lake Sakakawea, ND | 4,877.03 |
| `eabo` | Eastbound — Lake Sakakawea, ND → Crown Point, NY / Vermont | 4,877.03 |

### NCT `nct_meta.json` Structure

```json
{
  "trail": { "name", "total_trail_miles", "map_center", "map_zoom", "termini" },
  "states": [ { "id", "name", "axis_start", "axis_end" } ],
  "direction_options": [ { "id", "label", "total_miles", "is_webo" } ]
}
```

### NCT `index.html` Bootstrap

`NCT_STATES_BOOTSTRAP` is hardcoded in `index.html` for immediate UI population before `nct_meta.json` loads. It is a JS array with `{ state, name, axis_start, axis_end }` per state. **Must be updated after every `build-points-nct.js` run** — the script prints exact values to the console. The UI uses this to compute each state's max mile (`axis_end - axis_start`) and set the mile input placeholder.

### NCT Build Pipeline — Key Parameters

The `build-points-nct.js` script has several non-obvious parameters that were tuned during the initial build. Do not change without re-measuring:

- **`MAX_STEP_MI = 8.0`** — Drops any NCTA feature whose coordinates include a single step > 8 miles (filters teleporting ArcGIS artifacts). Raised from 3.0 after legitimate rural roadwalk features in MN (Red River Valley, Cr-88, 4.7 mi step) and ND (New Rockford → Lake Ashtabula, 6.94 mi step) were incorrectly excluded. Bad ArcGIS artifacts are 50–300 miles; real steps are ≤ 7 miles.
- **`MAX_MERGE_GAP_MI = 2.0`** — Adjacent same-`trail_stat` segments within 2 miles of each other are merged into one run. Unchanged from initial value.
- **`chainStateFeatures()`** — Greedy nearest-endpoint stitching: for each state, visits ~4,000 features by always connecting to the feature whose nearest endpoint is closest to the current chain tail.
- **`reorderToWesternTerminus(runs)`** — Post-processing step applied after greedy stitching. Identifies the run with the westernmost endpoint as the true terminus, moves any "orphan" runs that ended up appended after it to just before it. Prevents greedy orphans from displacing the western terminus.
- **`interpolateAtAcrossRuns(runs, targetDist)`** — Replaces a previous `interpolateAt(flatCoords, ...)` approach. Iterates each run independently and teleports across inter-run gaps (rather than counting gap distance toward the target). This is critical: the old approach caused 5-mile interpolation points to be placed at wrong (eastern) locations whenever large gaps existed between stitched runs.
- **`stateMiles`** — Computed as `runs.reduce((sum, r) => sum + pathLen(r.coords), 0)` — excludes inter-run bridge/gap distances. Must match the denominator used by `interpolateAtAcrossRuns`.

### NCT SHT Injection (northeastern Minnesota)

The NCTA ArcGIS FeatureServer omits the lower Superior Hiking Trail (SHT) corridor through northeastern Minnesota (roughly Duluth to Silver Bay, ~100 miles along the Lake Superior North Shore). This section is co-managed by the Superior Hiking Trail Association (SHTA).

`build-points-nct.js` fetches the SHT geometry separately from the OSM Overpass API:
- **Relation:** OSM relation 1612587 (Superior Hiking Trail)
- **Request method:** POST to `https://overpass-api.de/api/interpreter` with URL-encoded `data=` body
- **Cache:** `data/_raw_sht.json` (480 ways). Delete to force a fresh fetch.
- The SHT features are injected into the Minnesota feature set alongside the NCTA features before stitching.

If the Overpass API returns an HTML error (transient overload), simply re-run the script — `_raw_sht.json` will be re-fetched.

### NCT Notable Features

- **Longest National Scenic Trail** — ~4,877 miles across 8 states (Vermont through North Dakota)
- **No alternates** — single-spine trail; no `getSelectedAlts()` needed
- **Large `historical_weather.json`** (~55–60 MB when complete) — will exceed localStorage quota; browser HTTP cache handles reuse, same as AT
- **Significant roadwalk sections** — roughly half of Ohio and parts of New York are on-road; shown as dashed lines on the map (`trail_stat: "Roadwalk"` or similar NCTA classification). The NCT `index.html` notes section explains this.
- **Ohio heat concern** — Ohio and parts of New York are the primary heat stress states (low elevation, high humidity, roadwalk)
- **MN/ND cold concern** — Western MN and ND can see very cold nights into May and again in September
- **Weather Planner UI:** State selector → State Mile typed input (0 to state's max mile, computed from `NCT_STATES_BOOTSTRAP`)
- **BestStart!** — not yet implemented; to be added to `app.js` following the same `runBestStartShared` pattern as other trails

### NCT Tools

Located in `trails/north-country-trail/tools/`:

- **`build-points-nct.js`** — Fetches all NCTA ArcGIS Layer 2 features (paginated), fetches SHT OSM ways (Overpass API, cached), stitches per-state feature chains using greedy nearest-endpoint algorithm, applies `reorderToWesternTerminus`, interpolates at 5-mile intervals using `interpolateAtAcrossRuns`, writes `points.json`, `trail.geojson`, and `nct_meta.json`. Caches raw source data in `_raw_nct.json` and `_raw_sht.json`. Re-run if NCTA geometry changes; always update `NCT_STATES_BOOTSTRAP` in `index.html` afterward.
- **`generate-normals-nct.js`** — Fetches ERA5-Land normals for all 977 target points at 5-mile intervals; resume-safe (saves after each point); 2-second throttle (Open-Meteo Professional subscription — `customer-archive-api.open-meteo.com`, `apikey=TTyLPYLitRdmWqlF`); full run ~82 minutes at 2-second delay. Output is a `{ meta, points }` wrapped `historical_weather.json` (same schema as IAT/PCT).

---

## Potomac Heritage Trail (PHT) — Live

- **Status:** Fully live (April 2026). `app.js`, `index.html`, and `historical_weather.json` all complete.
- **Point ID format:** `pht-{section_id}-mi{8digits}` (e.g. `pht-southern-maryland-mi00000000`); DC alt points include alt_id in ID (e.g. `pht-dc-river-trail-river-trail-mi02165860`)
- **Data files:** `points.json`, `pht_meta.json`, `trail.geojson`, `historical_weather.json`, `_raw_pht.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024)
- **Points resolution:** 0.1-mile intervals (8,888 total: 5,410 spine + DC alt points + 3,064 WP-only)
- **Weather resolution:** ~5-mile intervals per (section_id, alt_id) group
- **Trail geometry source:** NPS Federal Trail Data Standards (FTDS) ArcGIS FeatureServer
- **Trail color:** `#e06060` (same salmon/red as all other active trails)
- **Direction convention:** Westbound (Point Lookout, MD → Laurel Ridge, PA) / Eastbound; uses `is_westbound` flag

### PHT Dual-Mode Architecture

The PHT has two distinct modes that share the same data files:

**Through-hike spine** (Duration Calculator + BestStart! + Extremes):
- Southern Maryland (Tidewater Potomac On-Road Bicycle Route) → DC alternate → C&O Canal Towpath → Great Allegheny Passage → Laurel Highlands Hiking Trail
- `on_spine: true` points and GeoJSON features only
- Total: ~553 miles (River Trail) or ~570 miles (City Park Trail)

**Weather Planner only** (not on through-hike):
- Northern Virginia (Mount Vernon Trail, W&OD Trail, Mason Neck Heritage Trail, Neabsco Creek Boardwalk, and ~40 other named segments)
- Northern Neck of Virginia (Dahlgren Railroad Heritage Trail + roads, ~95 miles)
- Eastern Continental Divide Loop (~60 miles)
- `on_spine: false` in both points.json and trail.geojson; shown at reduced opacity on maps

### PHT Through-Hike Spine Sections

| id | Name | Region | Spine miles |
|----|------|--------|------------|
| `southern-maryland` | Southern Maryland | southern-maryland | 0–216.6 |
| `dc-river-trail` | DC River Trail | washington-dc | 216.6–228.9 (12.3 mi section) |
| `dc-city-park-trail` | DC City Park Trail | washington-dc | 216.6–245.6 (29.0 mi section) |
| `co-canal` | C&O Canal Towpath | co-canal-nhp | 228.9–413.6 (184.6 mi section) |
| `great-allegheny-passage` | Great Allegheny Passage | great-allegheny-passage | 413.6–485.6 (72.0 mi section) |
| `laurel-highlands` | Laurel Highlands Trail | laurel-highlands | 485.6–553.0 (67.4 mi section) |

### PHT DC Alternate Group — LOCKED

One route choice through Washington D.C.:

**DC Route (`dc-route`):** branch at spine mile 216.586 (Anacostia/South Capitol St Bridge), rejoin at 228.914 (Georgetown / C&O Canal mile 0).

| Alt | id | Section length | Delta |
|-----|-----|---------------|-------|
| DC River Trail (main) | `river-trail` | 12.3 mi | 0 |
| DC City Park Trail | `city-park-trail` | 29.0 mi | +16.71 mi |

- DC River Trail: Anacostia Riverwalk Trail → Half St SW → V St SW → 2nd St SW → P St SW → Waterfront Park → Maine Ave SW → L'Enfant Prom SW → Francis Case Memorial Bridge → Buckeye Dr SW Sidewalk → Potomac River Trail
- DC City Park Trail: Civil War Defenses of Washington → Fort Circle Hiker-Biker Trail → Georgetown

**Do not change branch/rejoin miles without re-measuring from NPS geometry.**

### PHT `buildHikePoints` DC Routing Logic — Critical

The DC alt zone uses hike-mile `h` (cumulative distance from start):

**Westbound:**
- `h < DC_BRANCH_MILE (216.586)`: Southern Maryland — `spineMile = h`
- `h ∈ [216.586, 216.586 + dcAltLen]`: DC zone — `secMile = h - 216.586`; look up by section_id + secMile
- `h > DC exit`: C&O/GAP/LHHT — `spineMile = h - altDelta`

**Eastbound:**
- `h < BASE_SPINE_MILES - DC_REJOIN_MILE (≈324.046)`: LHHT/GAP/C&O — `spineMile = BASE_SPINE_MILES - h`
- `h ∈ [324.046, 324.046 + dcAltLen]`: DC zone — `secMile = dcAltLen - (h - 324.046)` (traversed backwards)
- `h > DC exit`: Southern Maryland — `spineMile = totalMiles - h`

Key constants: `DC_BRANCH_MILE = 216.586`, `DC_REJOIN_MILE = 228.914`, `PHT_BASE_SPINE_MILES = 552.96`, `DC_RIVER_LEN = 12.328`, `DC_CITY_PARK_LEN = 29.043`, `DC_CITY_PARK_DELTA = 16.71`.

### PHT `pht_meta.json` Structure

```json
{
  "trail": { "name", "spine_miles", "map_center", "map_zoom", "termini" },
  "regions": [ { "id", "name", "on_spine" } ],
  "sections": [ { "id", "name", "region", "on_spine", "mile_start", "mile_end", "alt_id"(optional) } ],
  "alt_groups": [ { "id", "label", "branch_mile", "rejoin_mile",
                    "main": { "id", "label", "total_miles", "note" },
                    "alt":  { "id", "label", "total_miles", "delta_miles", "note" } } ],
  "direction_options": [ { "id", "label", "total_miles", "is_westbound" } ]
}
```

**Important:** `mile_start` and `mile_end` in sections are **spine-absolute positions**, not section-relative. Section length = `mile_end - mile_start`. `getSectionLength(sec)` in app.js computes this. The Weather Planner displays section miles from 0 to `getSectionLength(sec)`.

### PHT `points.json` Schema

Spine points:
```json
{ "id": "pht-southern-maryland-mi00000000", "mile": 0, "lat": ..., "lon": ...,
  "region": "southern-maryland", "section_id": "southern-maryland", "section_mile": 0 }
```

DC alt points:
```json
{ "id": "pht-dc-river-trail-river-trail-mi02165860", "mile": 216.586, "lat": ..., "lon": ...,
  "region": "washington-dc", "section_id": "dc-river-trail", "section_mile": 0, "alt_id": "river-trail" }
```

WP-only points (no `mile` field):
```json
{ "id": "pht-mount-vernon-trail-mi00000000", "lat": ..., "lon": ...,
  "region": "northern-virginia", "section_id": "mount-vernon-trail", "section_mile": 0, "on_spine": false }
```

### PHT `historical_weather.json`

`{ meta, points }` wrapped (same as IAT/PCT). Keys: `hi`, `lo`, `hi_app`, `lo_app`, `rh_hi`, `rh_lo`, `ws` — note `hi_app`/`lo_app` (AT-style), not `app_hi`/`app_lo`. `loadPrecomputedNormals()` in app.js remaps them on load. Normals entries include `section_id`, `alt_id`, `section_mile`, `on_spine` but no global `mile`. Normals are looked up by `normalsBySectionMile` (Map of section_id → [{id, section_mile}] sorted).

### PHT Weather Planner UI

Two-level selector: Region → Section → Section Mile. Regions correspond to `pht_meta.json` regions. The section select is populated dynamically by `populateSectionSelect(regionId)` using `phtMeta?.sections` (or `PHT_SECTIONS_BOOTSTRAP` before meta loads).

**UI-only overrides** (data files unchanged):
- `SECTION_DISPLAY_NAMES` map in app.js overrides long section names for display
- `SECTION_UI_HIDDEN` set in app.js hides sections from the selector (data still accessible for lookups)
- Current overrides:
  - `"ent-to-red-rock-wilderness-overlook-regional-park"` → `"Red Rock Wilderness Overlook"`
  - `"belmont-ferry-farm-trail-to-rappahannock-river-heritage-trail-connector"` → `"Belmont Ferry to Rappahannock Trail"`
  - `"northern-virginia-unnamed"` — hidden from UI
  - Region `"co-canal-nhp"` displays as `"C&O Canal"` (hardcoded in `<select>` option and bootstrap)

Both the app.js overrides and their matching bootstrap equivalents (`PHT_SECTION_DISPLAY_NAMES`, `PHT_SECTION_UI_HIDDEN`) in index.html must be kept in sync when adding new overrides.

### PHT Trail Overlay

`applyTrailOverlay()` reads `feature.properties.on_spine`:
- `on_spine: true` → `TRAIL_STYLE` (`#e06060`, weight 3.25, opacity 0.85)
- `on_spine: false` (VA/ECD sections) → `TRAIL_STYLE_WP` (`#e06060`, weight 2, opacity 0.45)

### PHT Notable Features

- **Highest point resolution** — 0.1-mile intervals (vs. 0.5 mi for IAT, 5 mi for most others); higher resolution for potential secondary application use
- **Dual-mode sections** — same points.json and trail.geojson serve both the through-hike tools and the VA/ECD Weather Planner sections
- **Road segments in Southern Maryland** — the Tidewater Potomac On-Road Bicycle Route is on-road; shown as solid trail color (not dashed) with a map note explaining this
- **No elevation correction** — PHT is a low-elevation trail; no `applyElevationCorrection()` logic
- **`NORMALS_CACHE_VERSION`:** `"v1"` — bump whenever `historical_weather.json` is rebuilt
- **`{ meta, points }` wrapper** — same structure as IAT/PCT

### PHT Tools

Located in `trails/potomac-heritage-trail/tools/`:

- **`build-points-pht.js`** — Fetches NPS FTDS ArcGIS features (614 features), classifies by REGION/MAPLABEL, assigns unclassified DC features spatially, stitches chains with greedy nearest-endpoint algorithm (per-call `maxGap` parameter: `DC_MAX_GAP_MI = 0.02` for DC chains to prevent straight-line artifacts, `MAX_MERGE_GAP_MI = 1.0` for others), interpolates at 0.1-mile intervals, writes `points.json`, `trail.geojson`, `pht_meta.json`. DC River Trail seeds: Anacostia Riverwalk Trail, Half St SW, V St SW, 2nd St SW, P St SW, Waterfront Park, Maine Ave SW, L'Enfant Prom SW, Francis Case Memorial Bridge, Buckeye Dr SW Sidewalk, Potomac River Trail.
- **`generate-normals-pht.js`** — Selects target points at ~5-mile intervals per (section_id, alt_id) group; fetches ERA5-Land normals; resume-safe; 2-second throttle (Open-Meteo Professional — `customer-archive-api.open-meteo.com`, `apikey=TTyLPYLitRdmWqlF`); `{ meta, points }` output with `hi_app`/`lo_app` keys.

---

## Continental Divide Trail (CDT) — Live

- **Status:** Live (April 2026). All data complete; fully functional weather planner with BestStart!, duration extremes, elevation correction, and 4 alternate routes.
- **Point ID format:** `cdt-main-mi{7digits}` (main spine, thousandth-mile precision); `cdt-{alt_id}-mi{7digits}` (alt points, e.g. `cdt-gila-mi0000000`)
- **Data files:** `points.json` (657 total: spine + alt points), `cdt_meta.json`, `trail.geojson`, `historical_weather.json`, `_raw_arcgis.json`, `_raw_osm_gila.json`, `_raw_osm_rmnp.json`, `_raw_osm_anaconda.json`, `_raw_osm_spotted-bear.json`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024), via `generate-normals-cdt.js`; uses Professional API (`customer-archive-api.open-meteo.com`, 2-second throttle, ~24 min for ~700 points)
- **Weather resolution:** 5-mile intervals (main spine)
- **Trail geometry sources:**
  - USFS ArcGIS FeatureServer (`services1.arcgis.com/gGHDlz6USftL5Pau/.../ContinentalDivideNST/FeatureServer/0`) — main route, RMNP Loop ArcGIS variant, Chief Mountain alternate. Label field: `CDT Primary Route`, `Rocky Mountain National Park Loop Alternate`, `Chief Mountain Border Crossing Alternate`
  - OSM Overpass API — Gila River Route (relation 7917427), RMNP Loop / North Inlet / Tonahutu Creek (relation 6747529), Anaconda Cutoff (relation 8107272), Spotted Bear Route (relation 8034122)
- **Trail color:** `#e06060` (same salmon/red as all other active trails)
- **Direction convention:** NOBO (Antelope Wells, NM → Waterton Lake or Chief Mountain, MT) / SOBO; `is_nobo` flag; terminus variant controls northern end
- **Elevation correction:** same logic as AZT/PCT (`ELEV_THRESHOLD_FT = 300`; `trail_elev` from OpenTopoData SRTM, `grid_elev` from ERA5-Land stored in feet)

### CDT Geographic Sections (4 States)

Idaho (near Yellowstone) is absorbed into Wyoming for weather-planner purposes.

| State | Name | Axis start | Axis end | Miles |
|-------|------|-----------|---------|-------|
| `NM` | New Mexico | 0 | 795 | ~795 |
| `CO` | Colorado | 800 | 1,525 | ~725 |
| `WY` | Wyoming | 1,530 | 2,300 | ~770 |
| `MT` | Montana | 2,305 | 3,025.1 | ~720 |

**Total trail miles: 3,025.1** (Antelope Wells → Waterton Lake). Chief Mountain variant: 3,012.15 mi (−8 mi for alternate northern terminus).

State assignment is by latitude: NM < 37°, CO < 41°, WY < 45°, MT otherwise.

### CDT Direction Options (4)

| id | Label | Total miles |
|----|-------|------------|
| `nobo_waterton` | Northbound — Antelope Wells → Waterton Lake | 3,025.1 |
| `nobo_chief_mtn` | Northbound — Antelope Wells → Chief Mountain | 3,012.15 |
| `sobo_waterton` | Southbound — Waterton Lake → Antelope Wells | 3,025.1 |
| `sobo_chief_mtn` | Southbound — Chief Mountain → Antelope Wells | 3,012.15 |

### CDT Alternate Groups — Current State

**Gila River Route (`gila`):** branch 175, rejoin 355. OSM relation 7917427, `maxGapMi=1.0`. Alternate: 104.9 mi (delta −75.1 mi). Chain confirmed clean; branch and rejoin are correct.

**RMNP Loop — North Inlet / Tonahutu Creek (`rmnp`):** branch 1,355, rejoin 1,370. OSM relation 6747529, `maxGapMi=2.0`, `splitStepMi=0.5`. OSM coverage is partial (3 segments totaling 40.0 mi, delta +27.9 mi). The two artifact straight lines (1.6 mi and 1.2 mi) were removed by splitting at steps > 0.5 mi — each valid segment is written as a separate GeoJSON Feature. The ArcGIS data contains only the short western bypass connector (~4.2 mi, labeled `Rocky Mountain National Park Loop Alternate`); the main CDT route goes through the park interior via the longer south/east/north legs. OSM gaps in the map are expected; see "Notes on Map Data" in index.html. Do not change `maxGapMi` or `splitStepMi` without re-verifying the step distance distribution.

**Anaconda Cutoff (`anaconda`):** branch 2,475, rejoin 2,610. OSM relation 8107272, `maxGapMi=5.0`. Alternate: 57.6 mi (delta −77.4 mi). `maxGapMi=5.0` needed because the relation has a legitimate internal gap of ~4.5 mi.

**Spotted Bear Route (`spotted-bear`):** branch 2,845, rejoin 2,860. OSM relation 8034122, `maxGapMi=10.0`, `splitStepMi=0.5`. 2 segments totaling 26.6 mi (delta +20.5 mi, scenic detour). `maxGapMi=10.0` needed to stitch across the internal OSM gap; `splitStepMi=0.5` then removes the resulting 8.875 mi artifact straight line, preserving both legitimate segments.

### CDT Build Script — Key Parameters

`build-points-cdt.js` has several non-obvious parameters:

- **`chainPaths(allPaths, maxGapMi)`** — greedy nearest-endpoint stitching with gap cutoff. Stops when the next way endpoint is farther than `maxGapMi`. Without this, errant distant OSM ways create straight-line artifacts or cause loops.
- **`longestContinuousSegment(chain, maxStepMi)`** — splits the chain at any step > `maxStepMi`, returns only the longest piece. Used when you want to discard all but the primary segment.
- **`splitContinuousSegments(chain, maxStepMi)`** — splits the chain at any step > `maxStepMi`, returns ALL valid segments. Used for RMNP where legitimate trail segments exist on both sides of a coverage gap. Each segment is written as a separate GeoJSON Feature with identical properties; Leaflet renders them all as the same dotted line. Set via `splitStepMi` in `OSM_ALTS`.
- **`OSM_ALTS`** — per-alternate config array. Current values:
  ```javascript
  { id: 'gila',         relation: 7917427, state: 'NM', maxGapMi: 1.0,  trimStepMi: null, splitStepMi: null }
  { id: 'rmnp',         relation: 6747529, state: 'CO', maxGapMi: 2.0,  trimStepMi: null, splitStepMi: 0.5  }
  { id: 'anaconda',     relation: 8107272, state: 'MT', maxGapMi: 5.0,  trimStepMi: null, splitStepMi: null }
  { id: 'spotted-bear', relation: 8034122, state: 'MT', maxGapMi: 10.0, trimStepMi: null, splitStepMi: 0.5  }
  ```
- **State assignment by latitude:** ANTELOPE_WELLS (31.335°N) orients the main chain S→N; states split at 37°, 41°, 45°.
- **Cache files:** `_raw_arcgis.json` (USFS), `_raw_osm_*.json` (OSM per-alternate). Delete to force a fresh fetch.

### CDT `CDT_STATES_BOOTSTRAP`

Hardcoded in `index.html` for immediate UI population. **Must be updated after every `build-points-cdt.js` run** — the script prints exact values to the console.

```javascript
window.CDT_STATES_BOOTSTRAP = [
  { state: "NM", name: "New Mexico", axis_start: 0,      axis_end: 795    },
  { state: "CO", name: "Colorado",   axis_start: 800,    axis_end: 1525   },
  { state: "WY", name: "Wyoming",    axis_start: 1530,   axis_end: 2300   },
  { state: "MT", name: "Montana",    axis_start: 2305,   axis_end: 3025.1 }
];
```

### CDT `cdt_meta.json` Structure

```json
{
  "trail": { "name", "total_trail_miles", "map_center", "map_zoom", "termini" },
  "sections": [ { "id", "name", "state", "axis_start", "axis_end" } ],
  "alt_groups": [ { "id", "label", "branch_mile", "rejoin_mile",
                    "main": { "id", "label", "total_miles" },
                    "alt":  { "id", "label", "total_miles", "delta_miles" } } ],
  "direction_options": [ { "id", "label", "total_miles", "is_nobo", "terminus" } ]
}
```

### CDT `points.json` Schema

Main spine points:
```json
{ "id": "cdt-main-mi0000000", "mile": 0, "lat": ..., "lon": ..., "state": "NM", "trail_elev": 4531 }
```

Alt points:
```json
{ "id": "cdt-gila-mi0000000", "alt_id": "gila", "mile": 0, "lat": ..., "lon": ..., "state": "NM", "trail_elev": 4200 }
```

### CDT Notable Features

- **Longest continuous National Scenic Trail** at 3,025 miles
- **BestStart!** — fully implemented: button, `bestStartResult` div, `runBestStart()`, `bestStartBtn` wired in `initDurationUI()`
- **No advisory logic in Duration Calculator** — `warningHtml = ""` in `computeAndRenderDurationExtremes`; advisories only in Weather Planner
- **`NORMALS_CACHE_VERSION`:** `"v1"` — bump whenever `historical_weather.json` is rebuilt
- **`{ meta, points }` wrapper** — same structure as IAT/PCT/PHT
- **`historical_weather.json` complete** — 657 points (607 spine + 21 Gila + 12 Anaconda + 8 Spotted Bear + 9 RMNP); generated April 2026 via Professional API
- **Chief Mountain alternate terminus** — 13 miles shorter than Waterton Lake terminus; both NOBO and SOBO have dual terminus options
- **RMNP loop pending** — do not change RMNP modeling without consulting session history and analyzing ArcGIS vs. OSM routing

### CDT Tools

Located in `trails/continental-divide-trail/tools/`:

- **`build-points-cdt.js`** — Fetches USFS ArcGIS features (main route, RMNP ArcGIS variant, Chief Mountain alternate), fetches OSM Overpass ways for Gila/RMNP/Anaconda/Spotted Bear alternates (cached per-alternate in `_raw_osm_*.json`), stitches chains with greedy nearest-endpoint algorithm + `maxGapMi` cutoff, fetches SRTM elevation via OpenTopoData for all points, writes `points.json`, `trail.geojson` (main spine thinned to 20m), `trail_hires.geojson` (full ArcGIS resolution, for future use), and `cdt_meta.json`. Re-run if trail geometry changes; update `CDT_STATES_BOOTSTRAP` in `index.html` afterward.
- **`generate-normals-cdt.js`** — Fetches ERA5-Land normals for all ~700 points (main spine + alt points); resume-safe (saves after each point); 2-second throttle (Open-Meteo Professional — `customer-archive-api.open-meteo.com`, `apikey=TTyLPYLitRdmWqlF`); `{ meta, points }` output. Estimated ~24 minutes for full run. Stores `grid_elev` (feet) for elevation correction.

---

## Trail Hub and Nav Ordering

**`js/trail-nav.js`** is the single source of truth for trail ordering and status badges. The hub `index.html` must match. Order convention:

1. **Live trails** — alphabetical
2. **Coming Next** — one trail at a time (currently none)
3. **Coming Soon** — alphabetical (currently none)

Current order: AT, AZT, CDT, FT, IAT, NTT, NET, NCT, PCT, PNT, PHT

All eleven trails are fully live. No Coming Next or Coming Soon trails currently.

When promoting a trail from Coming Next to live: remove the badge in `trail-nav.js`, update the tile in `index.html` (remove `coming` class and badge div, update description), and move it to its alphabetical position in both files.

---

## Adding a New Trail

Follow the AZT/NET/FT pattern (not AT — AT predates current conventions):
1. Create `trails/<trail-name>/data/points.json`
2. Create `trails/<trail-name>/data/trail.geojson`
3. Create `trails/<trail-name>/data/<slug>_meta.json` — sections, direction options, any alternates
4. Write and run `trails/<trail-name>/tools/generate-normals-<slug>.js` — fetches ERA5-Land normals at 5-mile intervals, outputs `historical_weather.json`
5. Copy and adapt `index.html` and `js/app.js` from NET (simplest), FT (if section-based alternates), or AZT (if passage-based with GPX alts and elevation correction)
   - `index.html` must include `<div id="trail-nav-mount">` and load `trail-nav.js` + `shared-utils.js` before `app.js`
   - Remove all shared utility functions from `app.js` — they are provided by `shared-utils.js`
   - If trail has alternates: use `<fieldset class="alt-group-block">` radio pattern (styles in `css/styles.css`); add `getSelectedAlts()`, pass to `calcTotalMiles()` and `buildHikePoints()`
   - If alternate route is missing from USFS/NPS data (e.g. urban routes, private land): fetch GPX from official trail association website and use `import-alt-gpx.js` pattern
6. Add a tile in the root `index.html` trail selector grid
7. Add the new trail to the `TRAILS` array in `js/trail-nav.js` — this automatically updates the nav on all pages
