/**
 * build-points-iat.js
 *
 * Fetches Wisconsin DNR ArcGIS trail geometry for the Ice Age National Scenic Trail,
 * stitches certified segments with straight-line roadwalk connectors,
 * interpolates waypoints at 0.5-mile intervals, and writes:
 *   - trails/ice-age-trail/data/points.json
 *   - trails/ice-age-trail/data/trail.geojson
 *   - trails/ice-age-trail/data/iat_meta.json
 *
 * Run: node trails/ice-age-trail/tools/build-points-iat.js
 *
 * Data source: Wisconsin DNR ArcGIS MapServer (Layer 2 — Ice Age Trail)
 * https://dnrmaps.wi.gov/arcgis/rest/services/LF_DML/LF_DNR_MGD_Recreational_Opp_WTM_Ext/MapServer/2
 *
 * Point schema written:
 *   { id, section, region, state, mile, axis_mile, lat, lon }
 *
 * "mile"      = distance from start of segment's UI territory (includes absorbed roadwalk)
 * "axis_mile" = cumulative trail mile from western terminus (Interstate SP)
 *
 * Roadwalk handling (Option A):
 *   The DNR layer contains only certified hiking segments. Gaps between segment
 *   endpoints represent roadwalk connectors. Each named segment absorbs the
 *   roadwalk up to the halfway point toward the previous/next segment, so every
 *   axis mile maps to exactly one named segment. No roadwalk is surfaced to the user.
 */

const fs   = require("fs");
const path = require("path");

// ─── OUTPUT PATHS ─────────────────────────────────────────────────────────────

const DATA_DIR            = path.join("trails", "ice-age-trail", "data");
const POINTS_PATH         = path.join(DATA_DIR, "points.json");
const GEOJSON_PATH        = path.join(DATA_DIR, "trail.geojson");
const META_PATH           = path.join(DATA_DIR, "iat_meta.json");
const ROADWALK_GEOJSON_PATH = path.join(DATA_DIR, "trail_roadwalk.geojson");

// ─── IATA CONNECTING ROUTE API ────────────────────────────────────────────────
// Roadwalk (connecting route) geometry from the official IATA ArcGIS service.
// Display-only — no weather data is generated for these points.
const IATA_ROADWALK_BASE = "https://services.arcgis.com/EeCmkqXss9GYEKIZ/arcgis/rest/services/IAT_Connecting_Route/FeatureServer/0/query";

// ─── DNR API ──────────────────────────────────────────────────────────────────

const DNR_BASE = "https://dnrmaps.wi.gov/arcgis/rest/services/LF_DML/LF_DNR_MGD_Recreational_Opp_WTM_Ext/MapServer/2/query";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const INTERVAL_MILES = 0.5;

// Western terminus: Interstate State Park, St. Croix Falls, WI
const WESTERN_TERMINUS = [-92.889, 45.411]; // [lon, lat]

// ─── ALTERNATE ROUTE CONSTANTS ────────────────────────────────────────────────
// East Alt segments in WTE order (Sauk Point → Karner Blue).
// These run PARALLEL to the West Alt (Baraboo + roadwalk) between the
// Devil's Lake split (north visitors center) and the Chaffee Creek rejoin.
// They are NOT included in the main spine REGIONS list.
const EAST_ALT_ORDER       = ["Sauk Point", "Portage Canal", "John Muir Park", "Montello", "Karner Blue"];
const EAST_ALT_SEGMENT_SET = new Set(EAST_ALT_ORDER);

// Miles of Devil's Lake on the shared pre-split spine.
// The remaining ~4mi (north portion) become the first leg of the East Alt.
const DL_MAIN_MILES        = 7.0;
const WEST_ALT_TOTAL_MILES = 83.7;
const EAST_ALT_TOTAL_MILES = 71.0;

// ─── REGION / SEGMENT DEFINITIONS ────────────────────────────────────────────
//
// Segments listed west-to-east within each region, matching IATA naming.
// The SEGMENT_NAME_TEXT values from the DNR layer will be matched against
// these names (case-insensitive, substring allowed).
//
// If the script reports unmatched segments, add them here.

const REGIONS = [
  {
    id:   "western",
    name: "Western",
    segments: [
      // Polk/Burnett counties → northern highlands → Langlade County
      "St. Croix Falls", "Gandy Dancer", "Trade River", "Straight Lake",
      "Straight River", "Pine Lake", "McKenzie Creek", "Indian Creek",
      "Sand Creek", "Timberland Hills", "Grassy Lake", "Bear Lake",
      "Tuscobia", "Hemlock Creek", "Northern Blue Hills", "Southern Blue Hills",
      "Chippewa Moraine", "Harwood Lakes", "Firth Lake", "Chippewa River",
      "Cornell", "Otter Lake", "Lake Eleven", "Jerry Lake", "Mondeaux Esker",
      "Pine Line", "East Lake", "Rib Lake", "Wood Lake",
      "Timberland Wilderness", "Camp 27", "New Wood", "Averill-Kelly Creek Wilderness",
      "Turtle Rock", "Grandfather Falls", "Underdown", "Alta Junction",
      "Harrison Hills", "Parrish Hills", "Highland Lakes", "Summit Moraine",
      "Lumbercamp", "Kettlebowl", "Antigo Heights",
    ],
  },
  {
    id:   "central",
    name: "Central",
    segments: [
      // Marathon County → Waupaca → Portage County — approach leg going south
      "Plover River", "Dells of the Eau Claire", "Thornapple Creek", "Ringle",
      "White Cedar", "New Hope", "Iola Ski Hill", "Skunk and Foster Lakes",
      "Waupaca River", "Hartman Creek", "Emmons Creek", "Deerfield",

      // ── PRE-SPLIT: Devil's Lake (full segment fetched here; split in step 5b) ──
      // The first ~7mi is main spine shared by both alts.
      // The remaining ~4mi (north portion, past visitors center) is East Alt only.
      // build-points-iat.js splits the stitched coords at DL_MAIN_MILES.
      "Devil's Lake",

      // ── WEST ALT (Dells-Baraboo, 83.7 mi): Baraboo + roadwalk to Chaffee ──
      // East Alt segments (Sauk Point → Karner Blue) are in EAST_ALT_ORDER,
      // stitched separately in step 5b, and written with alt_mile / alt_id fields.
      "Baraboo",

      // ── REJOIN at Chaffee Creek (near Pleasant Lake / 3rd Ave) ───────────
      "Chaffee Creek",

      // ── POST-REJOIN SHARED SPINE ──────────────────────────────────────────
      "Wedde Creek", "Mecan River", "Greenwood", "Bohn Lake",

      // Continuing south through Columbia/Sauk/Dane counties
      "Merrimac", "Gibraltar Rock",
      "Fern Glen", "Lodi", "Lodi Marsh", "Springfield Hill",
      "Indian Lake", "Table Bluff", "Cross Plains", "Valley View",
      "Madison", "Verona", "Montrose", "Brooklyn Wildlife",
      "Monticello", "Albany", "Evansville", "Gibbs Lake",
      "Arbor Ridge", "Devil's Staircase", "Janesville", "Janesville to Milton",
      "Milton", "Storrs Lake", "Clover Valley",
    ],
  },
  {
    id:   "eastern",
    name: "Eastern",
    segments: [
      // Walworth/Waukesha → Washington/Ozaukee → Sheboygan → Manitowoc → Kewaunee → Door
      "Whitewater Lake", "Blackhawk", "Blue Spring Lake", "Stony Ridge",
      "Eagle", "Scuppernong", "Lapham Peak", "Holy Hill",
      "Delafield", "Waterville", "Hartland", "Merton",
      "Pike Lake", "Monches", "Loew Lake", "Slinger",
      "Cedar Lakes", "West Bend", "Kewaskum",
      "Greenbush", "Parnell",
      "Milwaukee River (Washington Co)", "Milwaukee River (Fond du Lac Co)",
      "LaBudde Creek", "Walla Hi", "Manitowoc", "Dunes",
      "Two Rivers", "Point Beach", "Mishicot", "East Twin River",
      "Tisch Mills", "Kewaunee River", "Algoma", "Forestville", "Sturgeon Bay",
    ],
  },
];

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Haversine distance in miles between two [lon, lat] points. */
function haversineMiles(p1, p2) {
  const R    = 3958.8;
  const lat1 = p1[1] * Math.PI / 180;
  const lat2 = p2[1] * Math.PI / 180;
  const dLat = (p2[1] - p1[1]) * Math.PI / 180;
  const dLon = (p2[0] - p1[0]) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function lerp(p1, p2, t) {
  return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
}

function cumulativeDist(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i-1] + haversineMiles(coords[i-1], coords[i]));
  }
  return cum;
}

/**
 * Interpolate a polyline at regular mile intervals.
 * Returns [{lon, lat, mile}].
 */
function interpolatePolyline(coords, intervalMiles) {
  const cum   = cumulativeDist(coords);
  const total = cum[cum.length - 1];
  const pts   = [];
  let segIdx  = 0;

  for (let d = 0; d <= total + intervalMiles * 0.01; d += intervalMiles) {
    const targetDist = Math.min(d, total);
    while (segIdx < cum.length - 2 && cum[segIdx + 1] < targetDist) segIdx++;
    const segLen = cum[segIdx + 1] - cum[segIdx];
    const t      = segLen > 0 ? (targetDist - cum[segIdx]) / segLen : 0;
    const interp = lerp(coords[segIdx], coords[Math.min(segIdx + 1, coords.length - 1)], t);
    pts.push({ lon: interp[0], lat: interp[1], mile: targetDist });
  }
  return pts;
}

/** Midpoint [lon, lat] of a polyline. */
function midpoint(coords) {
  const cum   = cumulativeDist(coords);
  const half  = cum[cum.length - 1] / 2;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < half) i++;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 0 ? (half - cum[i]) / segLen : 0;
  return lerp(coords[i], coords[i + 1], t);
}

/**
 * Split a polyline at `splitMiles` from its start.
 * Returns { mainCoords, altCoords } — both include the interpolated split point.
 */
function splitCoordsAt(coords, splitMiles) {
  const cum = cumulativeDist(coords);
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < splitMiles) i++;
  const segLen  = cum[i + 1] - cum[i];
  const t       = segLen > 0 ? (splitMiles - cum[i]) / segLen : 0;
  const splitPt = lerp(coords[i], coords[Math.min(i + 1, coords.length - 1)], t);
  return {
    mainCoords: [...coords.slice(0, i + 1), splitPt],
    altCoords:  [splitPt, ...coords.slice(i + 1)],
  };
}

/** Vertex centroid [lon, lat] of a polyline (simple average of all vertices). */
function centroid(coords) {
  let sumLon = 0, sumLat = 0;
  for (const [lon, lat] of coords) { sumLon += lon; sumLat += lat; }
  return [sumLon / coords.length, sumLat / coords.length];
}

// If the stitched endpoint is more than this many miles from the segment's
// vertex centroid, the endpoint is considered corrupted (e.g., by chained
// bad-data paths) and we snap currentEnd to the centroid for ordering purposes.
const MAX_ENDPOINT_CENTROID_MILES = 30;

// ─── WISCONSIN BOUNDING BOX ───────────────────────────────────────────────────
// The IAT is entirely within Wisconsin. Any path with an endpoint outside
// these bounds is definitively bad coordinate data (DNR data entry errors).
// Buffer is generous (+0.5 deg each side) to avoid clipping edge segments.
const WI_LON_MIN = -93.5;
const WI_LON_MAX = -86.2;
const WI_LAT_MIN = 42.4;
const WI_LAT_MAX = 47.2;

function coordInWisconsin([lon, lat]) {
  return lon >= WI_LON_MIN && lon <= WI_LON_MAX &&
         lat >= WI_LAT_MIN && lat <= WI_LAT_MAX;
}

// ─── OUTLIER PATH FILTER ──────────────────────────────────────────────────────

/**
 * Remove paths that contain coordinates outside Wisconsin's bounding box.
 * These are definitively bad data (DNR coordinate errors) — one endpoint may
 * lie near the real trail while the other is hundreds of miles away, which
 * causes the stitched segment to end at the wrong location.
 *
 * Falls back to a statistical filter (median endpoint distance) for any
 * remaining outliers that are within WI bounds but far from the cluster.
 */
// Maximum credible length for a single path within a named IAT segment.
// The longest certified segments are ~25 miles. A single path longer than
// this is almost certainly bad coordinate data spanning across Wisconsin.
const MAX_SINGLE_PATH_MILES = 40.0;

function filterOutlierPaths(paths, { multiplier = 5, hardMinMiles = 15 } = {}) {
  if (paths.length <= 1) return paths;

  // Step 1: Drop paths whose total length exceeds MAX_SINGLE_PATH_MILES.
  // These are definitively bad data — a single path fragment in a named segment
  // should never be longer than the segment itself.
  const notTooLong = paths.filter(p => {
    const len = cumulativeDist(p).pop();
    return len <= MAX_SINGLE_PATH_MILES;
  });
  const nDroppedLen = paths.length - notTooLong.length;
  if (nDroppedLen > 0) {
    const dropped = paths.filter(p => cumulativeDist(p).pop() > MAX_SINGLE_PATH_MILES);
    for (const p of dropped) {
      const len = cumulativeDist(p).pop();
      console.warn(
        `    [outlier-filter] Dropped path: len=${len.toFixed(2)} mi` +
        `  start=[${p[0][0].toFixed(4)},${p[0][1].toFixed(4)}]` +
        `  end=[${p[p.length-1][0].toFixed(4)},${p[p.length-1][1].toFixed(4)}]`
      );
    }
  }
  if (!notTooLong.length) return paths;

  // Step 2: Drop paths with any coordinate outside Wisconsin.
  const inWI = notTooLong.filter(p => p.every(coord => coordInWisconsin(coord)));
  const nDroppedGeo = notTooLong.length - inWI.length;
  if (nDroppedGeo > 0) {
    console.warn(
      `    [outlier-filter] Dropped ${nDroppedGeo} path(s) with coordinates outside Wisconsin`
    );
  }
  if (!inWI.length) return notTooLong;

  // Step 3: Statistical filter — worst endpoint distance from centroid.
  if (inWI.length <= 1) return inWI;

  const allEndpoints = inWI.flatMap(p => [p[0], p[p.length - 1]]);
  const centLon   = allEndpoints.reduce((s, m) => s + m[0], 0) / allEndpoints.length;
  const centLat   = allEndpoints.reduce((s, m) => s + m[1], 0) / allEndpoints.length;
  const centroid  = [centLon, centLat];

  const dists     = inWI.map(p => Math.max(
    haversineMiles(p[0],            centroid),
    haversineMiles(p[p.length - 1], centroid)
  ));
  const sorted    = [...dists].sort((a, b) => a - b);
  const median    = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(hardMinMiles, median * multiplier);

  const kept         = inWI.filter((_, i) => dists[i] <= threshold);
  const nDroppedStat = inWI.length - kept.length;
  if (nDroppedStat > 0) {
    console.warn(
      `    [outlier-filter] Dropped ${nDroppedStat} in-bounds path(s)` +
      ` (median: ${median.toFixed(2)} mi, threshold: ${threshold.toFixed(2)} mi)`
    );
  }
  return kept.length > 0 ? kept : inWI;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the terminal endpoints of a set of paths (endpoints not shared with
 * any other path within `epsilon` degrees). In a proper chain, there are
 * exactly two terminals — one at each end. Returns the terminal nearest to
 * `startHint`, or `startHint` itself if no terminals are found (circular).
 *
 * This prevents the greedy stitch from starting mid-chain when currentEnd
 * happens to be closest to a junction point rather than a chain terminus.
 * (e.g. Kewaunee River: paths chain perfectly but currentEnd is closest to
 *  the junction between paths 94418/94419, not the true NW or SE terminus.)
 */
function findTerminalHint(paths, startHint, epsilon = 0.001) {
  if (paths.length <= 1) return startHint;

  const close = (a, b) =>
    Math.abs(a[0] - b[0]) < epsilon && Math.abs(a[1] - b[1]) < epsilon;

  // Collect every endpoint with its path index and direction
  const endpoints = paths.flatMap((p, i) => [
    { pt: p[0],            pathIdx: i },
    { pt: p[p.length - 1], pathIdx: i },
  ]);

  // A terminal is an endpoint that has no matching endpoint on ANY OTHER path
  const terminals = endpoints.filter(ep =>
    !endpoints.some(other => other.pathIdx !== ep.pathIdx && close(other.pt, ep.pt))
  );

  if (!terminals.length) return startHint; // circular — fall back

  // Return the terminal point nearest to startHint
  let bestPt = startHint, bestDist = Infinity;
  for (const t of terminals) {
    const d = haversineMiles(t.pt, startHint);
    if (d < bestDist) { bestDist = d; bestPt = t.pt; }
  }
  return bestPt;
}

/**
 * Stitch an array of coordinate arrays into a single polyline using
 * nearest-endpoint greedy matching, starting closest to `startLonLat`.
 *
 * maxGapMiles: stop stitching if the nearest remaining path is farther than
 * this distance. Prevents bad-coordinate outlier paths from being appended
 * even when filterOutlierPaths didn't catch them (e.g. a path whose midpoint
 * is within range but whose endpoint is hundreds of miles away).
 */
function stitchSegments(allCoords, startLonLat, maxGapMiles = 8.0) {
  if (!allCoords.length) return [];
  if (allCoords.length === 1) return [...allCoords[0]];

  let bestIdx = 0, bestDist = Infinity, bestReverse = false;
  for (let i = 0; i < allCoords.length; i++) {
    const seg = allCoords[i];
    const dS  = haversineMiles(seg[0], startLonLat);
    const dE  = haversineMiles(seg[seg.length - 1], startLonLat);
    // Prefer forward (non-reverse) when distances are tied — avoids starting
    // mid-chain in reverse when a path's end and the next path's start share
    // the exact same coordinate (e.g. Kewaunee River paths 94418/94419).
    if (dS < bestDist || (bestReverse && dS <= bestDist)) { bestDist = dS; bestIdx = i; bestReverse = false; }
    if (dE < bestDist) { bestDist = dE; bestIdx = i; bestReverse = true;  }
  }

  const remaining = allCoords.map(c => ({ coords: c, used: false }));
  remaining[bestIdx].used = true;
  let result = bestReverse
    ? [...remaining[bestIdx].coords].reverse()
    : [...remaining[bestIdx].coords];

  let iters = allCoords.length - 1;
  while (iters-- > 0) {
    const tail = result[result.length - 1];
    let nextIdx = -1, nextDist = Infinity, nextFlip = false;

    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].used) continue;
      const seg = remaining[i].coords;
      const dS  = haversineMiles(seg[0], tail);
      const dE  = haversineMiles(seg[seg.length - 1], tail);
      // Same forward-preference tie-breaking in the inner loop.
      if (dS < nextDist || (nextFlip && dS <= nextDist)) { nextDist = dS; nextIdx = i; nextFlip = false; }
      if (dE < nextDist) { nextDist = dE; nextIdx = i; nextFlip = true;  }
    }

    // Stop if no remaining paths, or nearest is beyond the gap cap.
    // Paths beyond maxGapMiles are outliers or belong to a different part of
    // the trail — better to stop here and let roadwalk absorption handle it.
    if (nextIdx === -1 || nextDist > maxGapMiles) {
      if (nextIdx !== -1) {
        console.warn(`    [stitch-cap] Stopped at gap of ${nextDist.toFixed(3)} mi (cap: ${maxGapMiles} mi) — ${remaining.filter(r => !r.used).length} path(s) not stitched`);
      }
      break;
    }

    remaining[nextIdx].used = true;
    const next = nextFlip
      ? [...remaining[nextIdx].coords].reverse()
      : [...remaining[nextIdx].coords];

    const gap = haversineMiles(tail, next[0]);
    if (gap > 0.1) {
      console.warn(`    [stitch-internal] Gap of ${gap.toFixed(3)} mi within group`);
    }
    const skipFirst = haversineMiles(tail, next[0]) < 0.01;
    result = result.concat(skipFirst ? next.slice(1) : next);
  }
  return result;
}

// ─── DNR API FETCH ────────────────────────────────────────────────────────────

/**
 * Fetch a page of features from the DNR layer.
 * Returns the parsed JSON response.
 */
async function fetchPage(offset, count = 1000) {
  const params = new URLSearchParams({
    // Exclude only code=2 (proposed/future trail not yet built).
    // Code=0 (uncertified/unclassified) includes many real certified segments
    // (e.g. Gandy Dancer, Harrison Hills) that the DNR hasn't fully classified.
    // Outlier paths in code=0 are handled by filterOutlierPaths() below.
    // Fetch all features (cert codes 0, 1, 2).
    // Code=2 (proposed/future) paths act as geometric guides for stitching
    // and are needed to correctly orient some segment endpoints. They are not
    // interpolated into points.json since we only interpolate the main cert
    // geometry; large-gap capping in stitchSegments prevents bad cert=2 paths
    // from pulling endpoints hundreds of miles away.
    where:           "1=1",
    outFields:       "OBJECTID,SEGMENT_NAME_TEXT,TRAIL_COMPLETION_STATUS_CODE,TRAIL_CONNECTOR_STATUS_CODE,NPS_CERTIFICATION_STATUS_CODE,LENGTH_METER_AMT,COMMENT_TEXT",
    returnGeometry:  "true",
    outSR:           "4326",
    resultOffset:    String(offset),
    resultRecordCount: String(count),
    f:               "json",
  });
  const url = `${DNR_BASE}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DNR API HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch ALL features via pagination.
 * Returns array of raw feature objects.
 */
async function fetchAllFeatures() {
  const allFeatures = [];
  let offset = 0;
  const pageSize = 1000;

  console.log("Fetching features from Wisconsin DNR ArcGIS...");
  while (true) {
    process.stdout.write(`  Page offset ${offset}… `);
    const data = await fetchPage(offset, pageSize);

    if (!data.features || data.features.length === 0) {
      console.log("done (no more features)");
      break;
    }

    console.log(`${data.features.length} features`);
    allFeatures.push(...data.features);

    if (data.features.length < pageSize) break;     // last page
    if (!data.exceededTransferLimit) break;          // server says all done
    offset += pageSize;
    await sleep(500);
  }

  return allFeatures;
}

// ─── FEATURE PROCESSING ───────────────────────────────────────────────────────

/**
 * Extract coordinate paths from an ArcGIS JSON geometry (paths-based polyline).
 * Returns array of [[lon, lat], ...] arrays.
 */
function extractPaths(geometry) {
  if (!geometry || !geometry.paths) return [];
  return geometry.paths.map(path => path.map(([x, y]) => [x, y]));
}

// ─── KNOWN NON-SEGMENT DNR NAMES (skip without warning) ───────────────────────
// These appear in the DNR layer but are not IATA trail segments.
const SKIP_NAMES = new Set([
  "ice override",  // DNR internal editing artifact
]);

// ─── SEGMENT-TO-REGION LOOKUP ─────────────────────────────────────────────────

/** Build a flat lookup: normalizedName → { regionId, segmentName } */
function buildRegionLookup() {
  const lookup = new Map();
  for (const region of REGIONS) {
    for (const seg of region.segments) {
      lookup.set(seg.toLowerCase(), { regionId: region.id, segmentName: seg });
    }
  }
  // East Alt segments are not in REGIONS (they're built separately in step 5b),
  // but they must be in the lookup so grouping in step 3 captures their paths.
  for (const seg of EAST_ALT_ORDER) {
    if (!lookup.has(seg.toLowerCase())) {
      lookup.set(seg.toLowerCase(), { regionId: "central", segmentName: seg });
    }
  }
  return lookup;
}

/**
 * Match a raw DNR segment name to a canonical segment name.
 * Tries exact match first, then substring match.
 */
function matchSegmentName(rawName, lookup) {
  const norm = rawName.toLowerCase().trim();
  if (lookup.has(norm)) return lookup.get(norm);
  // Substring: canonical contains raw, or raw contains canonical
  for (const [key, val] of lookup) {
    if (norm.includes(key) || key.includes(norm)) return val;
  }
  return null;
}

// ─── ROADWALK FETCH ───────────────────────────────────────────────────────────

/**
 * Fetch all connecting-route (roadwalk) features from the IATA FeatureServer
 * and return a GeoJSON FeatureCollection in WGS-84.
 */
async function fetchRoadwalkGeojson() {
  const features = [];
  let offset = 0;
  const pageSize = 1000;

  console.log("\nFetching roadwalk geometry from IATA FeatureServer…");
  while (true) {
    const params = new URLSearchParams({
      where:              "1=1",
      outFields:          "OBJECTID",
      returnGeometry:     "true",
      outSR:              "4326",
      resultOffset:       String(offset),
      resultRecordCount:  String(pageSize),
      f:                  "geojson",
    });
    const url = `${IATA_ROADWALK_BASE}?${params.toString()}`;
    process.stdout.write(`  offset ${offset}… `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IATA roadwalk HTTP ${res.status}`);
    const gj = await res.json();
    const batch = (gj.features || []).filter(f => f.geometry);
    console.log(`${batch.length} features`);
    features.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    await sleep(500);
  }

  // Simplify: drop all properties, keep only geometry
  return {
    type: "FeatureCollection",
    features: features.map(f => ({
      type:       "Feature",
      properties: {},
      geometry:   f.geometry,
    })),
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`ERROR: ${DATA_DIR} not found. Run from repo root.`);
    process.exit(1);
  }

  // ── 1. Fetch all features ──────────────────────────────────────────────────
  const rawFeatures = await fetchAllFeatures();
  console.log(`\nTotal features fetched: ${rawFeatures.length}`);

  // ── 2. Inspect field values ────────────────────────────────────────────────
  console.log("\n─── FIELD VALUE REPORT ───");
  const nameCounts      = {};
  const completionCodes = {};
  const connectorCodes  = {};
  const npsCertCodes    = {};

  for (const f of rawFeatures) {
    const a = f.attributes;
    const name = a.SEGMENT_NAME_TEXT || "(null)";
    nameCounts[name]      = (nameCounts[name] || 0) + 1;

    const cc = String(a.TRAIL_COMPLETION_STATUS_CODE ?? "null");
    completionCodes[cc]   = (completionCodes[cc] || 0) + 1;

    const con = String(a.TRAIL_CONNECTOR_STATUS_CODE ?? "null");
    connectorCodes[con]   = (connectorCodes[con] || 0) + 1;

    const nps = String(a.NPS_CERTIFICATION_STATUS_CODE ?? "null");
    npsCertCodes[nps]     = (npsCertCodes[nps] || 0) + 1;
  }

  const uniqueNames = Object.keys(nameCounts).sort();
  console.log(`\nUnique SEGMENT_NAME_TEXT values (${uniqueNames.length}):`);
  for (const n of uniqueNames) {
    console.log(`  [${nameCounts[n]} features]  ${n}`);
  }

  console.log("\nTRAIL_COMPLETION_STATUS_CODE distribution:");
  for (const [k, v] of Object.entries(completionCodes)) console.log(`  ${k}: ${v}`);

  console.log("\nTRAIL_CONNECTOR_STATUS_CODE distribution:");
  for (const [k, v] of Object.entries(connectorCodes)) console.log(`  ${k}: ${v}`);

  console.log("\nNPS_CERTIFICATION_STATUS_CODE distribution:");
  for (const [k, v] of Object.entries(npsCertCodes)) console.log(`  ${k}: ${v}`);

  // ── 3. Group paths by segment name ────────────────────────────────────────
  console.log("\n─── GROUPING BY SEGMENT NAME ───");
  const regionLookup = buildRegionLookup();
  const segmentGroups = new Map(); // segmentName → { regionId, paths: [[lon,lat],...] }
  const unmatchedNames = new Set();

  for (const f of rawFeatures) {
    const rawName = (f.attributes.SEGMENT_NAME_TEXT || "").trim();
    if (!rawName) {
      console.warn(`  Skipping feature OBJECTID ${f.attributes.OBJECTID} — no segment name`);
      continue;
    }

    if (SKIP_NAMES.has(rawName.toLowerCase())) continue;

    const match = matchSegmentName(rawName, regionLookup);
    if (!match) {
      unmatchedNames.add(rawName);
      continue;
    }

    const paths = extractPaths(f.geometry);
    if (!paths.length) continue;

    if (!segmentGroups.has(match.segmentName)) {
      segmentGroups.set(match.segmentName, { regionId: match.regionId, paths: [] });
    }
    segmentGroups.get(match.segmentName).paths.push(...paths);
  }

  if (unmatchedNames.size > 0) {
    console.log(`\n⚠  UNMATCHED segment names (${unmatchedNames.size}) — add to REGIONS if IAT segments:`);
    for (const n of [...unmatchedNames].sort()) console.log(`  "${n}"`);
  }
  console.log(`\nMatched ${segmentGroups.size} named segments`);

  // ── 4. Build ordered list of segments preserving REGIONS order ───────────
  //
  // We defer stitching to step 5 so each segment is stitched starting from
  // the correct geographic location (currentEnd of the previous segment).
  // Using a random path's coordinate as the hint (old approach) could cause
  // stitching to start from a bad-data path, landing the endpoint hundreds
  // of miles from the real trail geography.

  const orderedSegments = [];
  for (const region of REGIONS) {
    for (const segName of region.segments) {
      if (segmentGroups.has(segName)) {
        const { regionId, paths } = segmentGroups.get(segName);
        orderedSegments.push({ name: segName, regionId, paths });
      }
    }
  }

  // ── 5. Stitch + order segments using REGIONS list as authoritative sequence ─
  //
  // For each segment, stitch its paths using currentEnd as the start hint.
  // This ensures stitching begins from the closest path to the previous
  // segment's end — critical for segments with many bad-data paths (e.g.,
  // St. Croix Falls has 66 paths including planned-trail fragments across WI).
  console.log("\n─── STITCHING + ORDERING SEGMENTS FROM WESTERN TERMINUS (REGIONS-defined order) ───");

  const ordered = [];
  let currentEnd = WESTERN_TERMINUS;
  let step = 0;

  for (const seg of orderedSegments) {
    // Filter outlier paths before stitching (WI bbox + statistical).
    const cleanPaths = filterOutlierPaths(seg.paths);

    // Geographic pre-filter: keep only paths that have at least one endpoint
    // within MAX_SEGMENT_RADIUS_MILES of currentEnd. This removes planned-trail
    // fragments scattered across WI that would otherwise chain the stitch into
    // the wrong geography (e.g. St. Croix Falls has 66 features including
    // planned-trail fragments in central/eastern WI, each < 8 mi apart — they
    // would chain 265 miles without this filter).
    const MAX_SEGMENT_RADIUS_MILES = 40;
    const nearPaths = cleanPaths.filter(p =>
      haversineMiles(p[0],            currentEnd) <= MAX_SEGMENT_RADIUS_MILES ||
      haversineMiles(p[p.length - 1], currentEnd) <= MAX_SEGMENT_RADIUS_MILES
    );
    const localPaths = nearPaths.length > 0 ? nearPaths : cleanPaths;
    if (nearPaths.length < cleanPaths.length) {
      console.warn(
        `    [geo-filter] ${seg.name}: dropped ${cleanPaths.length - nearPaths.length} path(s) >` +
        ` ${MAX_SEGMENT_RADIUS_MILES} mi from currentEnd — kept ${nearPaths.length}`
      );
    }

    // Stitch using currentEnd as the geographic start hint — this selects the
    // path endpoint nearest to the previous segment's end.
    let coords;
    if (localPaths.length === 1) {
      coords = localPaths[0];
      // Flip single-path segments if their end is closer to currentEnd.
      const dS = haversineMiles(coords[0], currentEnd);
      const dE = haversineMiles(coords[coords.length - 1], currentEnd);
      if (dE < dS) coords = [...coords].reverse();
    } else {
      const stitchHint = findTerminalHint(localPaths, currentEnd);
      coords = stitchSegments(localPaths, stitchHint);
    }

    process.stdout.write(`  ${seg.name}: ${seg.paths.length} paths → ${coords.length} pts, `);
    const len = cumulativeDist(coords).pop();
    console.log(`${len.toFixed(2)} mi`);

    const gapFromPrev = haversineMiles(currentEnd, coords[0]);

    ordered.push({
      name:      seg.name,
      regionId:  seg.regionId,
      coords,
      gapBefore: step === 0 ? 0 : gapFromPrev,
    });

    currentEnd = coords[coords.length - 1];
    console.log(
      `  [${String(step + 1).padStart(3)}] ${seg.name.padEnd(40)} ` +
      `gap: ${gapFromPrev.toFixed(2)} mi  cert: ${len.toFixed(2)} mi`
    );
    step++;
  }

  console.log(`\nOrdered ${ordered.length} segments`);

  // ── 5b. Split Devil's Lake and stitch East Alt chain ──────────────────────
  // Devil's Lake is split at DL_MAIN_MILES: main spine gets the south portion,
  // East Alt gets the north portion plus Sauk Point → Karner Blue.

  const eastAltOrdered = [];
  const dlEntry = ordered.find(s => s.name === "Devil's Lake");

  if (dlEntry) {
    const dlTotal = cumulativeDist(dlEntry.coords).pop();
    console.log(`\nDevil's Lake total stitched length: ${dlTotal.toFixed(2)} mi`);

    if (dlTotal <= DL_MAIN_MILES) {
      console.warn(`  ⚠  Devil's Lake shorter than ${DL_MAIN_MILES} mi — using full segment on main spine`);
    } else {
      const { mainCoords, altCoords } = splitCoordsAt(dlEntry.coords, DL_MAIN_MILES);
      dlEntry.coords = mainCoords;
      const dlAltLen = cumulativeDist(altCoords).pop();
      console.log(`  Split: ${DL_MAIN_MILES} mi → main spine | ${dlAltLen.toFixed(2)} mi → East Alt`);

      // First East Alt leg = north portion of Devil's Lake
      eastAltOrdered.push({
        name:     "Devil's Lake (East Alt)",
        section:  "devils-lake",
        isAltDL:  true,
        coords:   altCoords,
        gapBefore: 0,
      });

      // Stitch remaining East Alt segments from end of DL north portion
      let altCurrentEnd = altCoords[altCoords.length - 1];
      console.log("\n─── STITCHING EAST ALT SEGMENTS ───");

      for (const segName of EAST_ALT_ORDER) {
        if (!segmentGroups.has(segName)) {
          console.warn(`  ⚠  East Alt segment not found: ${segName}`);
          continue;
        }
        const { paths } = segmentGroups.get(segName);
        const cleanPaths = filterOutlierPaths(paths);
        const MAX_SEGMENT_RADIUS_MILES = 40;
        const nearPaths = cleanPaths.filter(p =>
          haversineMiles(p[0],            altCurrentEnd) <= MAX_SEGMENT_RADIUS_MILES ||
          haversineMiles(p[p.length - 1], altCurrentEnd) <= MAX_SEGMENT_RADIUS_MILES
        );
        const localPaths = nearPaths.length > 0 ? nearPaths : cleanPaths;

        let coords;
        if (localPaths.length === 1) {
          coords = localPaths[0];
          const dS = haversineMiles(coords[0], altCurrentEnd);
          const dE = haversineMiles(coords[coords.length - 1], altCurrentEnd);
          if (dE < dS) coords = [...coords].reverse();
        } else {
          const stitchHint = findTerminalHint(localPaths, altCurrentEnd);
          coords = stitchSegments(localPaths, stitchHint);
        }

        const len = cumulativeDist(coords).pop();
        const gap = haversineMiles(altCurrentEnd, coords[0]);
        console.log(`  ${segName}: ${paths.length} paths → ${coords.length} pts, ${len.toFixed(2)} mi, gap: ${gap.toFixed(2)} mi`);

        eastAltOrdered.push({
          name:     segName,
          section:  slugify(segName),
          isAltDL:  false,
          coords,
          gapBefore: gap,
        });
        altCurrentEnd = coords[coords.length - 1];
      }
    }
  } else {
    console.warn("⚠  Devil's Lake segment not found — East Alt chain cannot be built");
  }

  // ── 5c. Compute East Alt half-gap absorption (same pattern as main spine) ──
  const eastAltMeta = eastAltOrdered.map((seg, i) => {
    const certLen  = cumulativeDist(seg.coords).pop();
    const gapAfter = i < eastAltOrdered.length - 1
      ? haversineMiles(seg.coords[seg.coords.length - 1], eastAltOrdered[i + 1].coords[0])
      : 0;
    return { ...seg, certLen, gapAfter };
  });

  let eastAltOffset = 0;
  for (let i = 0; i < eastAltMeta.length; i++) {
    const prevGapHalf = i === 0 ? 0 : eastAltMeta[i - 1].gapAfter / 2;
    eastAltMeta[i].altMileStart = eastAltOffset + prevGapHalf;
    const nextGapHalf = eastAltMeta[i].gapAfter / 2;
    eastAltMeta[i].altMileLen = prevGapHalf + eastAltMeta[i].certLen + nextGapHalf;
    eastAltMeta[i].altMileEnd  = eastAltOffset + prevGapHalf + eastAltMeta[i].altMileLen;
    eastAltOffset = eastAltMeta[i].altMileEnd;
  }
  const eastAltCertTotal = eastAltOffset;
  console.log(`\nEast Alt total (cert + gaps): ${eastAltCertTotal.toFixed(2)} mi`);

  // ── 6. Build full trail polyline with straight-line roadwalk connectors ───
  // Compute per-segment certified length and gap lengths
  const segMeta = ordered.map((seg, i) => {
    const certLen  = cumulativeDist(seg.coords).pop();
    const gapAfter = i < ordered.length - 1
      ? haversineMiles(seg.coords[seg.coords.length - 1], ordered[i + 1].coords[0])
      : 0;
    return { ...seg, certLen, gapAfter };
  });

  // Each segment absorbs: half of gapBefore (from prev) + certLen + half of gapAfter (to next)
  // ui_start (axis_mile) = cumulative sum up to start of this segment's territory
  let axisOffset = 0;
  for (let i = 0; i < segMeta.length; i++) {
    const prevGapHalf = i === 0 ? 0 : segMeta[i - 1].gapAfter / 2;
    segMeta[i].uiAxisStart = axisOffset;
    segMeta[i].uiMileStart = 0; // relative mile at start of UI territory
    segMeta[i].certAxisStart = axisOffset + prevGapHalf; // where certified trail begins
    const nextGapHalf = segMeta[i].gapAfter / 2;
    segMeta[i].uiLen = prevGapHalf + segMeta[i].certLen + nextGapHalf;
    segMeta[i].uiAxisEnd = axisOffset + segMeta[i].uiLen;
    axisOffset = segMeta[i].uiAxisEnd;
  }
  const totalAxisMiles = axisOffset;
  console.log(`\nTotal trail (axis miles, incl roadwalk): ${totalAxisMiles.toFixed(2)}`);

  // ── 7. Interpolate along each segment's full UI territory ─────────────────
  console.log("\n─── INTERPOLATING POINTS ───");
  const allPoints       = [];
  const geojsonFeatures = [];

  for (let i = 0; i < segMeta.length; i++) {
    const seg = segMeta[i];
    const slug = slugify(seg.name);

    // Build UI polyline: connector-in + certified + connector-out
    const uiCoords = [];

    // Connector from previous segment end (straight line)
    if (i > 0) {
      const prevEnd   = segMeta[i - 1].coords[segMeta[i - 1].coords.length - 1];
      const certStart = seg.coords[0];
      const halfGap   = seg.gapBefore / 2;
      if (halfGap > 0.001) {
        // Interpolate along the connector to find the midpoint
        const connector = [prevEnd, certStart];
        const cum       = cumulativeDist(connector);
        const totalConn = cum[cum.length - 1];
        // The start of our UI territory is at the midpoint of the gap
        const midT      = totalConn > 0 ? halfGap / totalConn : 0;
        const midPt     = lerp(prevEnd, certStart, midT);
        uiCoords.push(midPt, ...seg.coords);
      } else {
        uiCoords.push(...seg.coords);
      }
    } else {
      uiCoords.push(...seg.coords);
    }

    // Connector to next segment start (straight line, first half only)
    if (i < segMeta.length - 1) {
      const certEnd   = seg.coords[seg.coords.length - 1];
      const nextStart = segMeta[i + 1].coords[0];
      const halfGap   = seg.gapAfter / 2;
      if (halfGap > 0.001) {
        const midT  = segMeta[i].gapAfter > 0 ? halfGap / segMeta[i].gapAfter : 0;
        const midPt = lerp(certEnd, nextStart, midT);
        uiCoords.push(midPt);
      }
    }

    const interpPts = interpolatePolyline(uiCoords, INTERVAL_MILES);
    const axisStart = seg.uiAxisStart;

    for (const pt of interpPts) {
      const mileRounded     = Math.round(pt.mile * 10) / 10;
      const axisMileRounded = Math.round((axisStart + pt.mile) * 10) / 10;
      const idMile          = String(Math.round(mileRounded * 10)).padStart(4, "0");

      allPoints.push({
        id:        `iat-${slug}-mi${idMile}`,
        section:   slug,
        region:    seg.regionId,
        state:     "WI",
        mile:      mileRounded,
        axis_mile: axisMileRounded,
        lat:       Math.round(pt.lat * 1e6) / 1e6,
        lon:       Math.round(pt.lon * 1e6) / 1e6,
      });
    }

    // GeoJSON: just the certified segment geometry (clean for display)
    geojsonFeatures.push({
      type: "Feature",
      properties: { name: seg.name, section: slug, region: seg.regionId },
      geometry: { type: "LineString", coordinates: seg.coords },
    });

    console.log(
      `  ${seg.name.padEnd(40)} ui: ${seg.uiLen.toFixed(2)} mi  pts: ${interpPts.length}`
    );
  }

  // ── 7b. Interpolate East Alt points ───────────────────────────────────────
  console.log("\n─── INTERPOLATING EAST ALT POINTS ───");
  const eastAltPoints = [];

  for (let i = 0; i < eastAltMeta.length; i++) {
    const seg  = eastAltMeta[i];
    const slug = seg.section;

    // Build UI polyline with gap absorption (same pattern as main spine)
    const uiCoords = [];
    if (i > 0) {
      const prevEnd = eastAltMeta[i - 1].coords[eastAltMeta[i - 1].coords.length - 1];
      const halfGap = seg.gapBefore / 2;
      if (halfGap > 0.001) {
        const midT  = seg.gapBefore > 0 ? halfGap / seg.gapBefore : 0;
        const midPt = lerp(prevEnd, seg.coords[0], midT);
        uiCoords.push(midPt, ...seg.coords);
      } else {
        uiCoords.push(...seg.coords);
      }
    } else {
      uiCoords.push(...seg.coords);
    }
    if (i < eastAltMeta.length - 1) {
      const certEnd  = seg.coords[seg.coords.length - 1];
      const nextStart = eastAltMeta[i + 1].coords[0];
      const halfGap  = seg.gapAfter / 2;
      if (halfGap > 0.001) {
        const midT  = seg.gapAfter > 0 ? halfGap / seg.gapAfter : 0;
        const midPt = lerp(certEnd, nextStart, midT);
        uiCoords.push(midPt);
      }
    }

    const interpPts   = interpolatePolyline(uiCoords, INTERVAL_MILES);
    const altMileBase = seg.altMileStart;

    for (const pt of interpPts) {
      const altMileRounded = Math.round((altMileBase + pt.mile) * 10) / 10;
      const mileRounded    = Math.round(pt.mile * 10) / 10;
      const idStr          = String(Math.round(altMileRounded * 10)).padStart(5, "0");

      eastAltPoints.push({
        id:       `iat-east-alt-mi${idStr}`,
        section:  slug,
        region:   "central",
        state:    "WI",
        mile:     mileRounded,
        alt_mile: altMileRounded,
        alt_id:   "east",
        lat:      Math.round(pt.lat * 1e6) / 1e6,
        lon:      Math.round(pt.lon * 1e6) / 1e6,
      });
    }

    // Add East Alt certified geometry to geojson (skip the DL portion —
    // it's part of the devil's lake feature already on the main spine)
    if (!seg.isAltDL) {
      geojsonFeatures.push({
        type: "Feature",
        properties: { name: seg.name, section: slug, region: "central", alt_id: "east" },
        geometry: { type: "LineString", coordinates: seg.coords },
      });
    }

    console.log(`  ${seg.name.padEnd(40)} alt: ${seg.altMileLen.toFixed(2)} mi  pts: ${interpPts.length}`);
  }

  console.log(`East Alt: ${eastAltPoints.length} points`);

  // ── 8. Build iat_meta.json ─────────────────────────────────────────────────
  console.log("\n─── BUILDING iat_meta.json ───");

  const metaSections = segMeta.map(seg => ({
    id:              slugify(seg.name),
    name:            seg.name,
    region:          seg.regionId,
    state:           "WI",
    certified_miles: Math.round(seg.certLen * 10) / 10,
    ui_mile_start:   Math.round(seg.uiAxisStart * 10) / 10,
    ui_mile_end:     Math.round(seg.uiAxisEnd   * 10) / 10,
  }));

  // ── Compute alt_group branch/rejoin axis_miles ────────────────────────────
  // Branch: end of Devil's Lake main spine (after the 7mi split) = start of alt zone
  // Rejoin: start of Chaffee Creek on the main spine
  const devilsLakeSeg   = metaSections.find(s => s.id === "devils-lake");
  const chaffeeCreekSeg = metaSections.find(s => s.id === "chaffee-creek");

  // Branch = ui_mile_end of the (now-shortened) DL main spine segment.
  // This is where both alts diverge from the shared trail.
  const branchAxisMile = devilsLakeSeg
    ? Math.round(devilsLakeSeg.ui_mile_end * 10) / 10
    : null;

  // Rejoin = ui_mile_start of Chaffee Creek.
  const rejoinAxisMile = chaffeeCreekSeg
    ? Math.round(chaffeeCreekSeg.ui_mile_start * 10) / 10
    : null;

  const ALT_DELTA_MILES = Math.round((EAST_ALT_TOTAL_MILES - WEST_ALT_TOTAL_MILES) * 10) / 10;

  console.log(`\nAlt group:`);
  console.log(`  Branch (end of DL main spine): axis_mile ${branchAxisMile}`);
  console.log(`  Rejoin (Chaffee Creek start):  axis_mile ${rejoinAxisMile}`);
  console.log(`  West Alt: ${WEST_ALT_TOTAL_MILES} mi | East Alt: ${EAST_ALT_TOTAL_MILES} mi | delta: ${ALT_DELTA_MILES} mi`);

  // East Alt sections for iat_meta (excluding the DL portion, which is in main sections)
  const eastAltSections = eastAltMeta
    .filter(seg => !seg.isAltDL)
    .map(seg => ({
      id:              seg.section,
      name:            seg.name,
      region:          "central",
      state:           "WI",
      alt_id:          "east",
      certified_miles: Math.round(seg.certLen * 10) / 10,
      alt_mile_start:  Math.round(seg.altMileStart * 10) / 10,
      alt_mile_end:    Math.round(seg.altMileEnd   * 10) / 10,
    }));

  const meta = {
    trail: {
      name:             "Ice Age Trail",
      total_trail_miles: Math.round(totalAxisMiles * 10) / 10,
      map_center:       [44.5, -90.0],
      map_zoom:         7,
      termini: {
        west: { name: "Interstate State Park", location: "St. Croix Falls, WI" },
        east: { name: "Potawatomi State Park",  location: "Sturgeon Bay, WI"   },
      },
    },
    regions: REGIONS.map(r => ({ id: r.id, name: r.name })),
    sections:          metaSections,
    east_alt_sections: eastAltSections,
    alt_groups: [
      {
        id:               "dells-baraboo-portage",
        label:            "Route through Baraboo Hills / Portage",
        branch_axis_mile: branchAxisMile,
        rejoin_axis_mile: rejoinAxisMile,
        west_alt: {
          id:          "west",
          label:       "Dells-Baraboo (West Alt.)",
          total_miles: WEST_ALT_TOTAL_MILES,
          note:        "Scenic route through the Baraboo Hills via the Baraboo segment and roadwalk",
          segments:    ["baraboo"],
        },
        east_alt: {
          id:          "east",
          label:       "Portage (East Alt.)",
          total_miles: EAST_ALT_TOTAL_MILES,
          delta_miles: ALT_DELTA_MILES,
          note:        "Flatter route via Devil's Lake (north), Sauk Point, Portage Canal, John Muir Park, Montello, and Karner Blue",
          segments:    ["sauk-point", "portage-canal", "john-muir-park", "montello", "karner-blue"],
        },
      },
    ],
    direction_options: [
      { id: "west_to_east", label: "West to East — St. Croix Falls → Sturgeon Bay", total_miles: Math.round(totalAxisMiles * 10) / 10, is_west_to_east: true  },
      { id: "east_to_west", label: "East to West — Sturgeon Bay → St. Croix Falls", total_miles: Math.round(totalAxisMiles * 10) / 10, is_west_to_east: false },
    ],
  };

  // ── 9. Write outputs ───────────────────────────────────────────────────────
  console.log("\n─── WRITING OUTPUT FILES ───");

  const allOutputPoints = [...allPoints, ...eastAltPoints];
  fs.writeFileSync(POINTS_PATH,  JSON.stringify(allOutputPoints, null, 2) + "\n", "utf8");
  console.log(`Wrote ${POINTS_PATH}  (${allPoints.length} main + ${eastAltPoints.length} East Alt = ${allOutputPoints.length} total points)`);

  const geojson = { type: "FeatureCollection", features: geojsonFeatures };
  fs.writeFileSync(GEOJSON_PATH, JSON.stringify(geojson) + "\n", "utf8");
  console.log(`Wrote ${GEOJSON_PATH}  (${geojsonFeatures.length} features)`);

  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + "\n", "utf8");
  console.log(`Wrote ${META_PATH}`);

  // ── 10. Fetch and write roadwalk (connecting route) geometry ──────────────
  const roadwalkGeojson = await fetchRoadwalkGeojson();
  fs.writeFileSync(ROADWALK_GEOJSON_PATH, JSON.stringify(roadwalkGeojson) + "\n", "utf8");
  console.log(`Wrote ${ROADWALK_GEOJSON_PATH}  (${roadwalkGeojson.features.length} features)`);

  // ── 12. Summary ────────────────────────────────────────────────────────────
  console.log("\n─── SUMMARY ───");
  console.log(`Total axis miles:  ${totalAxisMiles.toFixed(2)}`);
  console.log(`Total points:      ${allPoints.length}`);
  console.log(`Segments built:    ${segMeta.length}`);
  for (const r of REGIONS) {
    const rSegs = segMeta.filter(s => s.regionId === r.id);
    const rPts  = allPoints.filter(p => p.region === r.id);
    console.log(`  ${r.name}: ${rSegs.length} segments, ${rPts.length} points`);
  }

  if (unmatchedNames.size > 0) {
    console.log(`\n⚠  ${unmatchedNames.size} unmatched segment name(s) were skipped.`);
    console.log("   Add them to the REGIONS array and re-run.");
  }

  console.log("\nDone.");
}

main().catch(err => { console.error(err); process.exit(1); });
