/**
 * build-points-ntt.js
 *
 * Fetches NPS ArcGIS trail geometry for the five Natchez Trace Trail hiking
 * sections, stitches multi-segment sections into continuous polylines,
 * interpolates waypoints at 0.1-mile intervals, and writes:
 *   - trails/natchez-trace-trail/data/points.json
 *   - trails/natchez-trace-trail/data/trail.geojson
 *
 * Run: node trails/natchez-trace-trail/tools/build-points-ntt.js
 *
 * Data source: NPS Public Trails ArcGIS FeatureServer
 * https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0
 *
 * Point schema written:
 *   { id, section, mile, axis_mile, lat, lon, state }
 *
 * "mile"      = distance from section start (0-based)
 * "axis_mile" = cumulative trail mile across all five sections (NOBO order)
 *
 * Section NOBO order and axis offsets:
 *   Portkopinu        axis 0.0  → ~3.5
 *   Rocky Springs     axis 3.5  → ~10.0
 *   Yockanookany      axis 10.0 → ~33.0
 *   Blackland Prairie axis 33.0 → ~39.0
 *   Highland Rim      axis 39.0 → ~59.0
 */

const fs   = require("fs");
const path = require("path");

// ─── OUTPUT PATHS ─────────────────────────────────────────────────────────────

const DATA_DIR    = path.join("trails", "natchez-trace-trail", "data");
const POINTS_PATH = path.join(DATA_DIR, "points.json");
const GEOJSON_PATH = path.join(DATA_DIR, "trail.geojson");

// ─── NPS API ──────────────────────────────────────────────────────────────────

const NPS_BASE = "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0/query";

// ─── SECTION DEFINITIONS ──────────────────────────────────────────────────────
//
// featureIds: NPS ArcGIS OBJECTID values belonging to this section.
//   Listed in approximate NOBO (south→north) order where possible.
//   The stitching algorithm will re-order by nearest-endpoint matching.
//
// axisOffset: cumulative trail miles at the START of this section (NOBO).
//
// isNoboAscending: if true, the stitched polyline should run
//   south-to-north (ascending latitude for MS sections; ascending for TN).
//   Used to orient the polyline before interpolation.
//   Set to null to disable orientation check (uses raw stitch order).

const SECTIONS = [
  {
    id:        "portkopinu",
    name:      "Portkopinu",
    state:     "MS",
    axisOffset: 0.0,
    // NA National Scenic Trail (Potkopinu) — single segment, S→N
    featureIds: [31704],
    // Southern terminus ~(31.745, -91.156), northern ~(31.704, -91.177)
    // Actually runs south (lat 31.745) toward NW — orient by lon (west = south end)
    southEnd:  [-91.156, 31.745],  // [lon, lat]
  },
  {
    id:        "rocky-springs",
    name:      "Rocky Springs",
    state:     "MS",
    axisOffset: null,  // computed from Portkopinu actual length
    // Multiple PG segments, S→N along trail
    // 29079: Owens Creek S terminus → MP ~54
    // 30146: continues N
    // 32552: gap bridge (east side)
    // 33240: continues north from campground
    // 33238: PG NST main northern stretch → Fisher Ferry Road
    // 32551 excluded — campground spur, not part of through-route
    featureIds: [29079, 30146, 32552, 33240, 33238],
    southEnd:  [-90.826, 32.061],
  },
  {
    id:        "yockanookany",
    name:      "Yockanookany",
    state:     "MS",
    axisOffset: null,
    // 29080: small southern connector at West Florida Boundary trailhead
    // 28070: RI National Scenic Trail (main 1181-vertex section, ~30 mi)
    featureIds: [29080, 28070],
    southEnd:  [-90.056, 32.467],
  },
  {
    id:        "blackland-prairie",
    name:      "Blackland Prairie",
    state:     "MS",
    axisOffset: null,
    // 32561: NST - Blackland Prairie Section (southern portion)
    // 29607: TU National Scenic Trail (connector)
    // 32575: TU National Scenic Trail (main northern stretch to Visitor Center)
    featureIds: [32561, 29607, 32575],
    southEnd:  [-88.753, 34.265],
  },
  {
    id:        "highland-rim",
    name:      "Highland Rim",
    state:     "TN",
    axisOffset: null,
    // 29889: main 563-vertex section (SW→NE: south MP408 → north Garrison Creek)
    // 29067: small segment near N terminus
    // 32548: northernmost connector to Garrison Creek trailhead
    // 29890: Grigg Springs Spur (excluded from main route — see note below)
    // Note: 29068 appears to be an alternate of 29067; using 29067 only.
    featureIds: [29889, 29067, 32548],
    southEnd:  [-87.261, 35.723],
  },
];

// ─── INTERPOLATION ────────────────────────────────────────────────────────────

const INTERVAL_MILES = 0.1;

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Haversine distance in miles between two [lon, lat] points. */
function haversineMiles(p1, p2) {
  const R   = 3958.8; // Earth radius in miles
  const lat1 = p1[1] * Math.PI / 180;
  const lat2 = p2[1] * Math.PI / 180;
  const dLat = (p2[1] - p1[1]) * Math.PI / 180;
  const dLon = (p2[0] - p1[0]) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Linearly interpolate between two [lon, lat] points at fraction t. */
function lerp(p1, p2, t) {
  return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
}

/**
 * Given a polyline (array of [lon, lat]), return an array of cumulative
 * distances (miles) from the first vertex. Result has same length as coords.
 */
function cumulativeDist(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i-1] + haversineMiles(coords[i-1], coords[i]));
  }
  return cum;
}

/**
 * Interpolate a polyline at regular mile intervals.
 * Returns [{lon, lat, mile}] where mile is distance from start.
 */
function interpolatePolyline(coords, intervalMiles) {
  const cum  = cumulativeDist(coords);
  const total = cum[cum.length - 1];
  const pts  = [];

  let segIdx = 0; // index into coords / cum

  for (let d = 0; d <= total + intervalMiles * 0.01; d += intervalMiles) {
    const targetDist = Math.min(d, total);

    // Advance segIdx until cum[segIdx+1] >= targetDist
    while (segIdx < cum.length - 2 && cum[segIdx + 1] < targetDist) {
      segIdx++;
    }

    const segLen = cum[segIdx + 1] - cum[segIdx];
    const t      = segLen > 0
      ? (targetDist - cum[segIdx]) / segLen
      : 0;

    const interp = lerp(coords[segIdx], coords[Math.min(segIdx + 1, coords.length - 1)], t);
    pts.push({ lon: interp[0], lat: interp[1], mile: targetDist });
  }

  return pts;
}

// ─── NPS API FETCH ────────────────────────────────────────────────────────────

async function fetchFeatureCoords(objectId) {
  const params = new URLSearchParams({
    objectIds:      String(objectId),
    outFields:      "OBJECTID,TRLNAME",
    returnGeometry: "true",
    f:              "geojson",
  });
  const url = `${NPS_BASE}?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NPS API error ${res.status} for OBJECTID ${objectId}`);

  const gj = await res.json();
  const features = gj.features || [];
  if (!features.length) throw new Error(`No feature returned for OBJECTID ${objectId}`);

  const geom = features[0].geometry;
  if (!geom) throw new Error(`No geometry for OBJECTID ${objectId}`);

  // Normalize to flat array of [lon, lat]
  if (geom.type === "LineString") {
    return geom.coordinates; // already [[lon, lat], ...]
  }
  if (geom.type === "MultiLineString") {
    // Flatten sub-lines
    return geom.coordinates.flat();
  }
  throw new Error(`Unsupported geometry type ${geom.type} for OBJECTID ${objectId}`);
}

// ─── SEGMENT STITCHING ────────────────────────────────────────────────────────

/**
 * Stitch an array of coordinate arrays (each a polyline) into a single
 * continuous polyline by greedily connecting nearest endpoints.
 *
 * Algorithm:
 * 1. Start with the segment whose start point is nearest to `southEndLonLat`.
 * 2. At each step, find the remaining segment whose nearest endpoint is
 *    closest to the current end of the growing polyline.
 * 3. Reverse that segment if its end (not start) is the closer endpoint.
 * 4. Append (dropping the duplicate connecting vertex).
 */
function stitchSegments(allCoords, southEndLonLat) {
  if (!allCoords.length) return [];
  if (allCoords.length === 1) return allCoords[0];

  // Find best starting segment (closest start OR end to southEnd)
  let bestIdx = 0;
  let bestDist = Infinity;
  let bestReverse = false;

  for (let i = 0; i < allCoords.length; i++) {
    const seg = allCoords[i];
    const dStart = haversineMiles(seg[0], southEndLonLat);
    const dEnd   = haversineMiles(seg[seg.length - 1], southEndLonLat);
    if (dStart < bestDist) { bestDist = dStart; bestIdx = i; bestReverse = false; }
    if (dEnd   < bestDist) { bestDist = dEnd;   bestIdx = i; bestReverse = true;  }
  }

  const remaining = allCoords.map((c, i) => ({ coords: c, used: false }));
  remaining[bestIdx].used = true;

  let result = bestReverse
    ? [...remaining[bestIdx].coords].reverse()
    : [...remaining[bestIdx].coords];

  let iterations = allCoords.length - 1;
  while (iterations-- > 0) {
    const tail = result[result.length - 1];
    let nextIdx   = -1;
    let nextDist  = Infinity;
    let nextFlip  = false;

    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].used) continue;
      const seg = remaining[i].coords;
      const dStart = haversineMiles(seg[0], tail);
      const dEnd   = haversineMiles(seg[seg.length - 1], tail);
      if (dStart < nextDist) { nextDist = dStart; nextIdx = i; nextFlip = false; }
      if (dEnd   < nextDist) { nextDist = dEnd;   nextIdx = i; nextFlip = true;  }
    }

    if (nextIdx === -1) break;

    remaining[nextIdx].used = true;
    const next = nextFlip
      ? [...remaining[nextIdx].coords].reverse()
      : [...remaining[nextIdx].coords];

    // Warn if gap is large
    const gap = haversineMiles(tail, next[0]);
    if (gap > 0.1) {
      console.warn(`  [stitch] Gap of ${gap.toFixed(3)} miles between segment ${nextIdx} and previous end`);
    }

    // Append, dropping duplicate first point if it's very close to tail
    const skipFirst = haversineMiles(tail, next[0]) < 0.01;
    result = result.concat(skipFirst ? next.slice(1) : next);
  }

  return result;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`ERROR: ${DATA_DIR} not found.`);
    process.exit(1);
  }

  console.log("[NTT] Building points.json and trail.geojson from NPS ArcGIS data\n");

  const allPoints      = [];
  const geojsonFeatures = [];

  // Collect actual section lengths so axis offsets can be computed cumulatively
  const sectionLengths = [];
  const FIXED_AXIS_OFFSETS = [0.0, null, null, null, null]; // only Portkopinu is known a priori

  for (let si = 0; si < SECTIONS.length; si++) {
    const sec = SECTIONS[si];
    console.log(`\n─── ${sec.name.toUpperCase()} (${sec.featureIds.length} feature(s)) ───`);

    // Fetch all segments
    const allCoords = [];
    for (const fid of sec.featureIds) {
      process.stdout.write(`  Fetching OBJECTID ${fid}… `);
      try {
        const coords = await fetchFeatureCoords(fid);
        console.log(`${coords.length} pts`);
        allCoords.push(coords);
      } catch (err) {
        console.error(`FAILED: ${err.message}`);
      }
      await sleep(1000); // polite rate limiting
    }

    if (!allCoords.length) {
      console.error(`  No segments fetched for ${sec.name} — skipping`);
      continue;
    }

    // Stitch segments into single polyline
    console.log(`  Stitching ${allCoords.length} segment(s)…`);
    const stitched = stitchSegments(allCoords, sec.southEnd);
    const totalMiles = cumulativeDist(stitched).pop();
    console.log(`  Stitched length: ${totalMiles.toFixed(2)} miles  (${stitched.length} vertices)`);
    sectionLengths.push(totalMiles);

    // Compute axis offset for this section
    let axisOffset;
    if (si === 0) {
      axisOffset = 0.0;
    } else {
      axisOffset = FIXED_AXIS_OFFSETS[si - 1] !== null
        ? FIXED_AXIS_OFFSETS[si - 1] + sectionLengths[si - 1]
        : (FIXED_AXIS_OFFSETS[si - 1] ?? 0) + sectionLengths.slice(0, si).reduce((a, b) => a + b, 0);
    }
    // Actually compute from cumulative sectionLengths
    axisOffset = sectionLengths.slice(0, si).reduce((a, b) => a + b, 0);
    FIXED_AXIS_OFFSETS[si] = axisOffset;

    console.log(`  Axis offset: ${axisOffset.toFixed(2)} miles`);

    // Interpolate at 0.1-mile intervals
    const interpPts = interpolatePolyline(stitched, INTERVAL_MILES);
    console.log(`  Interpolated: ${interpPts.length} points at ${INTERVAL_MILES}-mile intervals`);

    // Build point records
    for (const pt of interpPts) {
      const secMileRounded  = Math.round(pt.mile * 10) / 10;
      const axisMileRounded = Math.round((axisOffset + pt.mile) * 10) / 10;
      const id = `ntt-${sec.id}-mi${String(Math.round(pt.mile * 10)).padStart(4, "0")}`;

      allPoints.push({
        id,
        section:   sec.id,
        state:     sec.state,
        mile:      secMileRounded,
        axis_mile: axisMileRounded,
        lat:       Math.round(pt.lat * 1e6) / 1e6,
        lon:       Math.round(pt.lon * 1e6) / 1e6,
      });
    }

    // Add GeoJSON feature for this section
    geojsonFeatures.push({
      type: "Feature",
      properties: { name: sec.name, section: sec.id },
      geometry: {
        type: "LineString",
        coordinates: stitched,
      },
    });

    console.log(`  Section complete: ${interpPts.length} points written`);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n─── SUMMARY ───`);
  console.log(`Total points:  ${allPoints.length}`);
  for (let si = 0; si < SECTIONS.length; si++) {
    const secPts = allPoints.filter(p => p.section === SECTIONS[si].id);
    console.log(`  ${SECTIONS[si].name}: ${secPts.length} points, ${sectionLengths[si]?.toFixed(2) ?? "?"} miles`);
  }

  // ─── Write points.json ────────────────────────────────────────────────────
  fs.writeFileSync(POINTS_PATH, JSON.stringify(allPoints, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${POINTS_PATH}`);

  // ─── Write trail.geojson ──────────────────────────────────────────────────
  const geojson = {
    type: "FeatureCollection",
    features: geojsonFeatures,
  };
  fs.writeFileSync(GEOJSON_PATH, JSON.stringify(geojson) + "\n", "utf8");
  console.log(`Wrote ${GEOJSON_PATH}`);

  console.log("\nDone.");
}

main().catch(err => { console.error(err); process.exit(1); });
