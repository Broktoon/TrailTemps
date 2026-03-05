const fs = require("fs");
const turf = require("@turf/turf");

const base = "trails/florida-trail/data/";
const extractPath = base + "okee_ne_lake_arcgis_extract.geojson";
const masterPath = base + "points_all_plus_namedsections_merged.json";

const outBackbone = base + "trail_named_okee_ne_lake_backbone.geojson";
const outPoints = base + "points_named_okee_ne_lake.json";
const outTSV = base + "points_named_okee_ne_lake_review.tsv";

const ROUTE = "named-okeechobee-east-ne-lake";
const SECTION_CODE = "okeechobee_east";
const SEGMENT_CODE = "central";
const CORRIDOR = "Eastern";
const STEP_MILES = 1;
const ID_SCALE = 1000;

// Use these Trail_Name values (per your Step 3 summary)
const ALLOW = new Set([
  "Okeechobee East",
  "US 98/441",
  "US 441/Taylor Creek Lock Bypass",
  "Nubbin Slough Spur Trail",
]);
const EXCLUDE = new Set([]); // keep none excluded

if (!fs.existsSync(extractPath)) throw new Error("Missing " + extractPath);
if (!fs.existsSync(masterPath)) throw new Error("Missing " + masterPath);

const extract = JSON.parse(fs.readFileSync(extractPath, "utf8"));
const master = JSON.parse(fs.readFileSync(masterPath, "utf8"));
master.points = master.points || [];

const existing = new Set(master.points.map((p) => p.id));

// Pull candidate LineStrings from extract
let segs = [];
for (const f of extract.features || []) {
  const p = f.properties || {};
  const name = String(p.Trail_Name || "");
  if (!ALLOW.has(name) || EXCLUDE.has(name)) continue;

  const g = f.geometry;
  if (!g) continue;
  if (g.type === "LineString") segs.push(g.coordinates);
  else if (g.type === "MultiLineString") for (const c of g.coordinates || []) segs.push(c);
}
segs = segs.filter((c) => Array.isArray(c) && c.length >= 2);

if (!segs.length) throw new Error("No segments after filtering Trail_Name allowlist");

// Build a graph using quantized endpoints; choose longest path (same idea you used earlier)
const q = (pt) => {
  const k = 1e5;
  return (Math.round(pt[0] * k) / k) + "," + (Math.round(pt[1] * k) / k);
};

const nodes = new Map();
const edges = [];

function addNode(k, pt) {
  if (!nodes.has(k)) nodes.set(k, { k, pt, edges: [] });
  return nodes.get(k);
}

for (const coords of segs) {
  const a = coords[0];
  const b = coords[coords.length - 1];
  const ka = q(a), kb = q(b);
  const na = addNode(ka, a), nb = addNode(kb, b);
  const f = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
  const w = turf.length(f, { units: "miles" });
  const e = { a: ka, b: kb, w, coords };
  edges.push(e);
  na.edges.push(e);
  nb.edges.push(e);
}

const nodeKeys = [...nodes.keys()];
if (nodeKeys.length < 2) throw new Error("Not enough graph nodes");

function dijkstra(start) {
  const dist = new Map();
  const prev = new Map();
  const seen = new Set();
  for (const k of nodeKeys) dist.set(k, Infinity);
  dist.set(start, 0);

  while (true) {
    let u = null, best = Infinity;
    for (const [k, v] of dist) if (!seen.has(k) && v < best) { best = v; u = k; }
    if (u === null) break;
    seen.add(u);
    const nu = nodes.get(u);
    for (const e of nu.edges) {
      const v = (e.a === u ? e.b : e.a);
      const nd = best + e.w;
      if (nd < dist.get(v)) { dist.set(v, nd); prev.set(v, { u, e }); }
    }
  }
  return { dist, prev };
}

function pickFarthest(start) {
  const { dist } = dijkstra(start);
  let fk = start, fd = -1;
  for (const [k, v] of dist) if (v < Infinity && v > fd) { fd = v; fk = k; }
  return { fk, fd };
}

const A = pickFarthest(nodeKeys[0]).fk;
const B = pickFarthest(A).fk;

const { prev } = dijkstra(A);
if (!prev.has(B)) throw new Error("No path found between endpoints in NE-lake extract");

const pathEdges = [];
let cur = B;
while (cur !== A) {
  const step = prev.get(cur);
  pathEdges.push(step.e);
  cur = step.u;
}
pathEdges.reverse();

// Stitch coordinates into one LineString
let stitched = [];
let cursor = null;
for (const e of pathEdges) {
  let c = e.coords;
  const ca = q(c[0]), cb = q(c[c.length - 1]);

  if (cursor === null) {
    stitched = stitched.concat(c);
    cursor = q(stitched[stitched.length - 1]);
    continue;
  }
  if (ca === cursor) stitched = stitched.concat(c.slice(1));
  else if (cb === cursor) stitched = stitched.concat(c.slice(0, -1).reverse());
  else {
    // fallback: attach by nearest end
    const last = stitched[stitched.length - 1];
    const d0 = turf.distance(turf.point(last), turf.point(c[0]), { units: "miles" });
    const d1 = turf.distance(turf.point(last), turf.point(c[c.length - 1]), { units: "miles" });
    stitched = stitched.concat((d0 <= d1) ? c.slice(1) : c.slice(0, -1).reverse());
  }
  cursor = q(stitched[stitched.length - 1]);
}

const backbone = {
  type: "Feature",
  properties: {
    route: ROUTE,
    corridor: CORRIDOR,
    segment_code: SEGMENT_CODE,
    section_code: SECTION_CODE,
    source: "raw-ft-arcgis.geojson (extract)",
    trail_names_used: [...ALLOW].join(" | "),
    spur_excluded: [...EXCLUDE].join(" | "),
    graph_nodes: nodes.size,
    graph_edges: edges.length,
  },
  geometry: { type: "LineString", coordinates: stitched },
};

fs.writeFileSync(outBackbone, JSON.stringify(backbone));
const L = turf.length(backbone, { units: "miles" });

// Sample 1-mile points
const pts = [];
for (let m = 0; m <= L + 1e-9; m += STEP_MILES) {
  const p = turf.along(backbone, m, { units: "miles" });
  const mi = Math.round(m * ID_SCALE) / ID_SCALE;
  const miInt = Math.round(mi * ID_SCALE);
  const id = `ft-named-okee-ne-lake-mi${String(miInt).padStart(7, "0")}`;
  pts.push({
    route: ROUTE,
    needs_review: true,
    mile: Math.floor(m), // integer mile index along this mini-route
    axis_mile: "",
    id,
    lat: p.geometry.coordinates[1],
    lon: p.geometry.coordinates[0],
    corridor: CORRIDOR,
    segment_code: SEGMENT_CODE,
    section_code: SECTION_CODE,
    segment_name: "",
    section_name: "Lake Okeechobee NE Shore",
    include: true,
    notes: "generated_from_arcgis_extract",
  });
}

// Write standalone points file + TSV
fs.writeFileSync(outPoints, JSON.stringify({ meta: { route: ROUTE, step_miles: STEP_MILES, generated_on: new Date().toISOString().slice(0,10), length_miles: +L.toFixed(2) }, points: pts }, null, 2));

const header = ["route","needs_review","mile","id","lat","lon","corridor","segment_code","section_code","segment_name","section_name","include","notes"];
const esc = (v) => String(v ?? "").replace(/\r/g,"").replace(/\n/g," ").replace(/\t/g," ");
let tsv = header.join("\t") + "\n";
for (const r of pts) tsv += header.map(h => esc(h==="needs_review" ? (r.needs_review?1:0) : r[h])).join("\t") + "\n";
fs.writeFileSync(outTSV, tsv);

console.log("OK backbone_miles", L.toFixed(2), "points", pts.length, "WROTE", outBackbone, outPoints, outTSV);