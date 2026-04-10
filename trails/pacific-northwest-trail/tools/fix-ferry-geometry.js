/**
 * fix-ferry-geometry.js
 *
 * Fixes the Puget Sound ferry segment in trail.geojson.
 *
 * Problem: the USFS source geometry already contains the water crossing as a
 * solid line embedded in the puget-sound section (a large coordinate jump at
 * index 4557). A separate hand-placed Coupeville connector was also added,
 * creating two overlapping/crossing dashed lines.
 *
 * Fix:
 *   1. Split the puget-sound LineString at index 4557:
 *      - coords[0..4556]  → remains puget-sound trail (land, down Whidbey Island)
 *      - coords[4557..end] → becomes the ferry feature (dashed, water crossing)
 *   2. Replace the old hand-placed Coupeville→Port Townsend ferry feature
 *      with the geometry extracted from the actual trail data.
 *
 * Run from repo root:
 *   node trails/pacific-northwest-trail/tools/fix-ferry-geometry.js
 */

const fs   = require("fs");
const path = require("path");

const GEOJSON_PATH = path.join(
  "trails", "pacific-northwest-trail", "data", "trail.geojson"
);

function main() {
  const gj = JSON.parse(fs.readFileSync(GEOJSON_PATH, "utf8"));

  const psIdx    = gj.features.findIndex(f => f.properties.section === "puget-sound");
  const ferryIdx = gj.features.findIndex(f => f.properties.segment_type === "ferry");

  if (psIdx === -1) { console.error("ERROR: puget-sound feature not found"); process.exit(1); }
  if (ferryIdx === -1) { console.error("ERROR: ferry feature not found"); process.exit(1); }

  const psCoords = gj.features[psIdx].geometry.coordinates;

  // Find the largest single-step coordinate jump — that's the water crossing
  let maxDist = 0, splitIdx = 0;
  for (let i = 1; i < psCoords.length; i++) {
    const dLat = psCoords[i][1] - psCoords[i-1][1];
    const dLon = psCoords[i][0] - psCoords[i-1][0];
    const dist = Math.sqrt(dLat*dLat + dLon*dLon);
    if (dist > maxDist) { maxDist = dist; splitIdx = i; }
  }

  console.log(`Largest jump at index ${splitIdx} (distance ${maxDist.toFixed(6)} deg)`);
  console.log(`  Land side ends at:   ${psCoords[splitIdx-1]}`);
  console.log(`  Water side begins at: ${psCoords[splitIdx]}`);

  const landCoords  = psCoords.slice(0, splitIdx);
  const ferryCoords = psCoords.slice(splitIdx - 1); // include last land point so line is continuous

  console.log(`  Land coords:  ${landCoords.length}`);
  console.log(`  Ferry coords: ${ferryCoords.length}`);

  // Update puget-sound section to land portion only
  gj.features[psIdx].geometry.coordinates = landCoords;

  // Replace ferry feature with geometry from actual trail data
  gj.features[ferryIdx] = {
    type: "Feature",
    properties: {
      segment_type: "ferry",
      name: "Puget Sound Ferry (Keystone/Fort Casey → Port Townsend)"
    },
    geometry: {
      type: "LineString",
      coordinates: ferryCoords
    }
  };

  fs.writeFileSync(GEOJSON_PATH, JSON.stringify(gj, null, 2) + "\n", "utf8");
  console.log("\n✔ trail.geojson updated.");
  console.log(`  puget-sound section: ${landCoords.length} coords (land only)`);
  console.log(`  ferry feature:       ${ferryCoords.length} coords (water crossing)`);
}

main();
