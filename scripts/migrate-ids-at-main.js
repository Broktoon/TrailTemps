/**
 * migrate-ids-at-main.js
 *
 * Migrates TrailTemps AT point IDs to:
 *   at-main-mi<mile_thousandths_padded>
 *
 * Updates BOTH:
 *   ./trails/appalachian-trail/data/points.json
 *   ./trails/appalachian-trail/data/historical_weather.json
 *
 * Adds:
 *   legacy_id (previous id) to both datasets
 *
 * Creates timestamped backups before overwriting.
 */

const fs = require("fs");
const path = require("path");

// ---------- CONFIG ----------
const TRAIL_CODE = "at";
const ALIGNMENT = "main";
const SCALE = 1000;          // thousandths of a mile
const PAD_WIDTH = 7;         // 2190.300 -> 2190300 (fits in 7 digits)
// If you ever support a trail > 9999.999 miles, bump PAD_WIDTH to 8.
const DATA_DIR = path.join("trails", "appalachian-trail", "data");

const POINTS_PATH = path.join(DATA_DIR, "points.json");
const NORMALS_PATH = path.join(DATA_DIR, "historical_weather.json");
// ---------------------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backupFile(p) {
  const tag = timestampTag();
  const bak = `${p}.${tag}.bak`;
  fs.copyFileSync(p, bak);
  return bak;
}

function mileFromPoint(p) {
  // Prefer `mile` (new), fall back to `mile_est` (legacy)
  const v = (p.mile != null && p.mile !== "") ? Number(p.mile) : Number(p.mile_est);
  if (!Number.isFinite(v)) {
    throw new Error(`Point id=${p.id} is missing numeric mile/mile_est`);
  }
  return v;
}

function mileToToken(mile) {
  const n = Math.round(Number(mile) * SCALE);
  if (!Number.isFinite(n)) throw new Error(`Bad mile value: ${mile}`);
  return String(n).padStart(PAD_WIDTH, "0");
}

function toNewId(mile) {
  return `${TRAIL_CODE}-${ALIGNMENT}-mi${mileToToken(mile)}`;
}

function getNormalsArray(normalsRoot) {
  // Support either:
  //  - { meta: {...}, points: [...] }  (preferred)
  //  - [...] (raw array, less common)
  if (Array.isArray(normalsRoot)) return { arr: normalsRoot, mode: "rootArray" };
  if (normalsRoot && Array.isArray(normalsRoot.points)) return { arr: normalsRoot.points, mode: "pointsArray" };

  const keys = normalsRoot ? Object.keys(normalsRoot) : [];
  throw new Error(
    `Unexpected historical_weather.json format. Expected an array or an object with "points: []". Top-level keys: ${keys.join(", ")}`
  );
}

function ensureUniqueIds(ids, label) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate ${label} id detected: ${id}`);
    seen.add(id);
  }
}

function main() {
  if (!fs.existsSync(POINTS_PATH)) throw new Error(`Missing: ${POINTS_PATH}`);
  if (!fs.existsSync(NORMALS_PATH)) throw new Error(`Missing: ${NORMALS_PATH}`);

  console.log("Reading:", POINTS_PATH);
  const points = readJson(POINTS_PATH);
  if (!Array.isArray(points)) throw new Error("points.json is not an array");

  // Build mapping legacy -> new
  const legacyToNew = new Map();

  const updatedPoints = points.map((p) => {
    const legacyId = String(p.id);
    const mile = mileFromPoint(p);
    const newId = toNewId(mile);

    legacyToNew.set(legacyId, newId);

    return {
      ...p,
      legacy_id: p.legacy_id ?? legacyId,
      id: newId
    };
  });

  // Validate uniqueness of new ids
  ensureUniqueIds(updatedPoints.map(p => p.id), "points");

  // Read normals and re-key ids
  console.log("Reading:", NORMALS_PATH);
  const normalsRoot = readJson(NORMALS_PATH);
  const { arr: normalsArr, mode } = getNormalsArray(normalsRoot);

  const updatedNormalsArr = normalsArr.map((rec) => {
    if (!rec || rec.id == null) throw new Error("Found normals record without id");
    const legacyId = String(rec.id);
    const newId = legacyToNew.get(legacyId);

    if (!newId) {
      throw new Error(`Normals id=${legacyId} has no matching point in points.json`);
    }

    return {
      ...rec,
      legacy_id: rec.legacy_id ?? legacyId,
      id: newId
    };
  });

  // Validate uniqueness of new normals ids
  ensureUniqueIds(updatedNormalsArr.map(r => r.id), "normals");

  // Ensure normals coverage count matches points count (optional but good sanity check)
  // Not strictly required, but most of your workflows assume 1:1.
  if (updatedNormalsArr.length !== updatedPoints.length) {
    console.warn(
      `WARNING: points count (${updatedPoints.length}) != normals count (${updatedNormalsArr.length}).`
    );
  }

  // Build updated normals root (preserve meta if present)
  let updatedNormalsRoot;
  if (mode === "rootArray") {
    updatedNormalsRoot = updatedNormalsArr;
  } else {
    updatedNormalsRoot = {
      ...normalsRoot,
      meta: {
        ...(normalsRoot.meta || {}),
        id_format: `${TRAIL_CODE}-${ALIGNMENT}-mi${"0".repeat(PAD_WIDTH)} (mile*${SCALE})`,
        id_scale: SCALE,
        id_alignment: ALIGNMENT,
        id_trail_code: TRAIL_CODE,
        id_migration_note: "IDs migrated; legacy_id preserved"
      },
      points: updatedNormalsArr
    };
  }

  // Backups
  const pointsBak = backupFile(POINTS_PATH);
  const normalsBak = backupFile(NORMALS_PATH);

  // Write
  writeJson(POINTS_PATH, updatedPoints);
  writeJson(NORMALS_PATH, updatedNormalsRoot);

  // Report
  console.log("✔ Migration complete.");
  console.log("Backups:");
  console.log(" -", pointsBak);
  console.log(" -", normalsBak);

  const ex = updatedPoints[0];
  console.log("Example mapping:");
  console.log(` - ${ex.legacy_id} -> ${ex.id}`);
}

main();