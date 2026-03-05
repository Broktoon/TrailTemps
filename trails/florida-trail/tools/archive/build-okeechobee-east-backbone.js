const fs = require("fs");

const rawPath = "trails/florida-trail/data/raw-ft-arcgis.geojson";
const outPath = "trails/florida-trail/data/trail_okeechobee_east_backbone.geojson";

const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));

const matches = (raw.features || []).filter(f => {
  const p = f.properties || {};
  return (
    p.Trail_Name === "Okeechobee East" &&
    p.Corridor === "Eastern" &&
    p.FNST_Rank === "PRIORITY"
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

fs.writeFileSync(outPath, JSON.stringify(fc));
console.log("WROTE", outPath, "features:", matches.length);