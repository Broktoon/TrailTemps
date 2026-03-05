const fs = require("fs");
const turf = require("@turf/turf");

const segs = JSON.parse(
  fs.readFileSync(
    "trails/florida-trail/data/okee_east_segments.geojson",
    "utf8"
  )
);

let merged = null;

for (const f of segs.features) {
  if (!merged) {
    merged = f;
  } else {
    merged = turf.lineMerge(
      turf.featureCollection([merged, f])
    );
  }
}

if (!merged) {
  console.log("MERGE FAILED");
  process.exit(1);
}

fs.writeFileSync(
  "trails/florida-trail/data/trail_okeechobee_east_backbone.geojson",
  JSON.stringify(merged)
);

console.log("WROTE dissolved backbone");