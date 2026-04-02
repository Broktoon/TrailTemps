# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

---

## Project Overview

**TrailTemps** (trailtemps.info) is a web-based weather planning platform for long-distance hikers. It provides:

1. Weather Planner — lookup by section/mile + date, with live 5-day forecast and 7-year planning average
2. Hike Duration Planner — start date → projected end date with temperature extremes map
3. Historical Temperature Extremes — pre-computed normals per waypoint (ERA5-Land, 2018–2024)
4. Alternate route selection — mutually exclusive swap alternates (FT-specific)
5. Interactive Leaflet map display
6. Multi-trail architecture — Appalachian Trail, Florida Trail, and New England Trail all live

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

AT scripts (root `scripts/` folder):
```bash
node scripts/generate-missing-normals-at.js
node scripts/migrate-historical-ids-mixed.js
node scripts/migrate-ids-at-main.js
node scripts/normalize-points-mile-only.js
```

Trail-specific generation tools live in `trails/*/tools/`:
```bash
node trails/new-england-trail/tools/generate-normals-net.js
```

There are no tests, no linter, and no build step.

---

## Site Architecture

### File Structure

```
index.html                          ← Landing page, 6-tile trail selector grid
css/styles.css                      ← Shared styles (980px max-width via --maxw CSS var)
scripts/                            ← Node utilities for AT data normalization
trails/
  appalachian-trail/
    index.html
    js/app.js                       ← Single-file client app
    data/
      points.json
      historical_weather.json
      trail.geojson
      archive/                      ← PRESERVE — do not delete
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
- **Temperature advisories:** heat index advisory at apparent high ≥ 100 °F; wind chill advisory at apparent low ≤ 20 °F (20 °F chosen as typical gear rating floor for sleeping bags/insulation)
- **Apparent temperature** uses Steadman methodology (built into Open-Meteo `apparent_temperature_*` fields)

---

## Appalachian Trail (AT) — Reference Implementation

- **Status:** Stable and live.
- **Point ID format:** `at-main-mi0000000` (thousandth-mile precision)
- **Data files:** `points.json`, `historical_weather.json`, `trail.geojson`
- **Normals source:** Open-Meteo ERA5-Land archive (2018–2024)
- **Weather resolution:** 1-mile intervals
- **Temperature markers:** Red = hottest, Blue = coldest (upside-down teardrop style)
- **Distance:** Mile axis only; no alternates modeled
- **Section selector:** State → Mile

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

## Adding a New Trail

Follow the NET/FT pattern (not AT — AT predates current conventions):
1. Create `trails/<trail-name>/data/points.json`
2. Create `trails/<trail-name>/data/trail.geojson`
3. Create `trails/<trail-name>/data/<slug>_meta.json` — sections, direction options, any alternates
4. Write and run `trails/<trail-name>/tools/generate-normals-<slug>.js` — fetches ERA5-Land normals at 5-mile intervals, outputs `historical_weather.json`
5. Copy and adapt `index.html` and `js/app.js` from NET (simplest) or FT (if alternates needed)
6. Add a tile in the root `index.html` trail selector grid
7. Update trail selector menus in all existing trail `index.html` files
