const fs = require("fs");
const turf = require("@turf/turf");

const base = "trails/florida-trail/data/";
const files = [
  { name: "arcgis", path: base + "raw-ft-arcgis.geojson" },
  { name: "osm", path: base + "raw-ft-osm.geojson" },
];

const targets = [
  { name: "T1", lat: 26.995881, lon: -80.619822 },
  { name: "T2", lat: 27.077393, lon: -80.657981 },
  { name: "T3", lat: 27.099398, lon: -80.658096 },
  { name: "T4", lat: 27.14952, lon: -80.698256 },
  { name: "T5", lat: 27.185249, lon: -80.741416 },
  { name: "T6", lat: 27.194898, lon: -80.764726 },
  { name: "T7", lat: 27.208241, lon: -80.792884 },
  { name: "T8a", lat: 27.204546, lon: -80.81181 }, // likely correct
  { name: "T8b", lat: 7.204546, lon: -80.81181 },  // as provided (probably typo)
];

// miles
const RADIUS = 5; // change to 2 or 10 if you want
const MAX_HITS_PER_TARGET = 10;

// For performance: sample vertices rather than iterate every point in giant files.
// sampleStep=1 means every vertex; bigger means fewer checks.
// We'll auto-scale per-linestring.
function sampleStep(n) {
  if (n <= 2000) return 1;
  if (n <= 10000) return 3;
  if (n <= 50000) return 10;
  return 25;
}

function addHit(arr, hit) {
  arr.push(hit);
  arr.sort((a, b) => a.d - b.d);
  if (arr.length > MAX_HITS_PER_TARGET) arr.length = MAX_HITS_PER_TARGET;
}

function scanFile(file) {
  if (!fs.existsSync(file.path)) {
    console.log("MISSING", file.path);
    return;
  }
  console.log("SCAN", file.name, file.path, "bytes", fs.statSync(file.path).size);

  const gj = JSON.parse(fs.readFileSync(file.path, "utf8"));
  const feats = gj.features || [];

  const hits = new Map(targets.map(t => [t.name, []]));
  let lines = 0, verts = 0;

  for (const f of feats) {
    if (!f || !f.geometry) continue;
    const g = f.geometry;
    const props = f.properties || {};

    const tag = file.name === "arcgis"
      ? {
          Corridor: props.Corridor ?? "",
          FNST_Rank: props.FNST_Rank ?? "",
          Trail_Name: props.Trail_Name ?? "",
          Designatio: props.Designatio ?? "",
        }
      : {
          name: props.name ?? "",
          ref: props.ref ?? "",
          route: props.route ?? "",
          network: props.network ?? "",
        };

    const consumeLine = (coords) => {
      if (!Array.isArray(coords) || coords.length < 2) return;
      lines++;
      const step = sampleStep(coords.length);
      for (let i = 0; i < coords.length; i += step) {
        const xy = coords[i];
        if (!xy || xy.length < 2) continue;
        const lon = +xy[0], lat = +xy[1];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        verts++;

        for (const t of targets) {
          // quick bbox filter (very rough): 1 deg lat ~ 69 mi, lon scaled by cos(lat) ~ ok enough
          const dLat = Math.abs(lat - t.lat) * 69;
          const dLon = Math.abs(lon - t.lon) * 69;
          if (dLat > RADIUS * 1.5 || dLon > RADIUS * 1.5) continue;

          const d = turf.distance(turf.point([t.lon, t.lat]), turf.point([lon, lat]), { units: "miles" });
          if (d <= RADIUS) {
            addHit(hits.get(t.name), {
              d,
              lat,
              lon,
              tag,
            });
          }
        }
      }
    };

    if (g.type === "LineString") consumeLine(g.coordinates);
    else if (g.type === "MultiLineString") for (const c of g.coordinates || []) consumeLine(c);
  }

  console.log("DONE", file.name, "lines", lines, "sampled_verts", verts);

  // Print hits
  for (const t of targets) {
    const arr = hits.get(t.name);
    console.log(`\n=== ${t.name} (${t.lat}, ${t.lon}) hits<=${RADIUS}mi: ${arr.length}`);
    for (const h of arr) {
      if (file.name === "arcgis") {
        console.log(
          `${h.d.toFixed(3)} mi\t${h.lat.toFixed(6)},${h.lon.toFixed(6)}\t${h.tag.Corridor} | ${h.tag.FNST_Rank}\t${h.tag.Trail_Name}`
        );
      } else {
        console.log(
          `${h.d.toFixed(3)} mi\t${h.lat.toFixed(6)},${h.lon.toFixed(6)}\t${h.tag.route || h.tag.network || ""}\t${h.tag.name || ""}`
        );
      }
    }
  }
}

// Run scans
for (const f of files) scanFile(f);
console.log("\nALL_DONE");