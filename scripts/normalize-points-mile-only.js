// scripts/normalize-points-mile-only.js
//
// Ensures every point has a numeric "mile" field (derived from mile or mile_est),
// then removes "mile_est" everywhere.
// Creates a timestamped .bak backup before overwriting.
//
// Run from repo root:
//   node scripts/normalize-points-mile-only.js
//
// Expected location of points file:
//   trails/appalachian-trail/data/points.json

const fs = require("fs");
const path = require("path");

const POINTS_PATH = path.join("trails", "appalachian-trail", "data", "points.json");

function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function normalizePoint(pt, idx) {
  const mile =
    (pt.mile != null && pt.mile !== "" && Number.isFinite(Number(pt.mile)))
      ? Number(pt.mile)
      : Number(pt.mile_est);

  if (!Number.isFinite(mile)) {
    throw new Error(`Point[${idx}] id=${pt.id || "(no id)"} has no valid mile or mile_est`);
  }

  const out = { ...pt, mile };
  delete out.mile_est;
  return out;
}

function main() {
  if (!fs.existsSync(POINTS_PATH)) {
    throw new Error(`Cannot find points file at: ${POINTS_PATH}`);
  }

  const data = readJson(POINTS_PATH);

  // points.json may be either:
  //  - an array of points
  //  - or an object like { meta, points:[...] }
  const isArray = Array.isArray(data);
  const points = isArray ? data : (data.points || []);

  if (!Array.isArray(points)) {
    throw new Error(`Unexpected points.json shape. Expected array or {points:[...]}.`);
  }

  const normalized = points.map(normalizePoint);

  const backupPath = `${POINTS_PATH}.${timestampTag()}.bak`;
  fs.copyFileSync(POINTS_PATH, backupPath);

  const out = isArray ? normalized : { ...data, points: normalized };
  writeJson(POINTS_PATH, out);

  console.log("✔ points.json normalized to mile-only.");
  console.log("Backup created:", backupPath);
  console.log("Records:", normalized.length);
}

main();