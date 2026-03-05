const fs = require("fs");

const raw = JSON.parse(
  fs.readFileSync(
    "trails/florida-trail/data/raw-ft-arcgis.geojson",
    "utf8"
  )
);

const matches = (raw.features || []).filter(f => {
  const p = f.properties || {};
  return (
    p.Corridor === "Eastern" &&
    p.FNST_Rank === "PRIORITY" &&
    p.Trail_Name === "Okeechobee East"
  );
});

if (!matches.length) {
  console.log("NO MATCHES FOUND");
  process.exit(1);
}

const fc = {
  type: "FeatureCollection",
  features: matches
};

fs.writeFileSync(
  "trails/florida-trail/data/okee_east_segments.geojson",
  JSON.stringify(fc)
);

console.log("WROTE okeechobee east segments:", matches.length);
