const fs = require("fs");
const turf = require("@turf/turf");

const base = "trails/florida-trail/data/";
const inPath = base + "raw-ft-arcgis.geojson";
const outPath = base + "okee_ne_lake_arcgis_extract.geojson";

const targets = [
  [26.995881, -80.619822],
  [27.077393, -80.657981],
  [27.099398, -80.658096],
  [27.149520, -80.698256],
  [27.185249, -80.741416],
  [27.194898, -80.764726],
  [27.208241, -80.792884],
  [27.204546, -80.811810],
].map(([lat, lon]) => turf.point([lon, lat]));

// radius in miles to keep geometry around each target
const R = 3;

if (!fs.existsSync(inPath)) throw new Error("Missing " + inPath);
const gj = JSON.parse(fs.readFileSync(inPath, "utf8"));

const keep = [];
for (const f of gj.features || []) {
  if (!f || !f.geometry) continue;
  const g = f.geometry;
  if (g.type !== "LineString" && g.type !== "MultiLineString") continue;

  // quick accept if any vertex is within R miles of any target (sample for speed)
  const coordsList =
    g.type === "LineString" ? [g.coordinates] : (g.coordinates || []);
  let hit = false;

  for (const coords of coordsList) {
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const step = Math.max(1, Math.floor(coords.length / 500));
    for (let i = 0; i < coords.length; i += step) {
      const xy = coords[i];
      if (!xy || xy.length < 2) continue;
      const P = turf.point([+xy[0], +xy[1]]);
      for (const t of targets) {
        if (turf.distance(P, t, { units: "miles" }) <= R) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) break;
  }

  if (hit) keep.push(f);
}

fs.writeFileSync(outPath, JSON.stringify({ type: "FeatureCollection", features: keep }));
console.log("WROTE", outPath, "features", keep.length);