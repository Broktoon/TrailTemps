const fs = require("fs");
const path = require("path");

// ---- CONFIG ----
const DATA_DIR = path.join("trails", "appalachian-trail", "data");
const POINTS_PATH = path.join(DATA_DIR, "points.json");
const HIST_PATH   = path.join(DATA_DIR, "historical_weather.json");
// ---------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function backupFile(p) {
  const bak = `${p}.${timestampTag()}.bak`;
  fs.copyFileSync(p, bak);
  return bak;
}
function isNewId(id) {
  return typeof id === "string" && id.startsWith("at-main-mi");
}

function main() {
  if (!fs.existsSync(POINTS_PATH)) throw new Error(`Missing: ${POINTS_PATH}`);
  if (!fs.existsSync(HIST_PATH)) throw new Error(`Missing: ${HIST_PATH}`);

  const points = readJson(POINTS_PATH);
  if (!Array.isArray(points)) throw new Error("points.json is not an array");

  // Build both-direction maps from points.json
  const legacyToNew = new Map(); // GA_0010_0 -> at-main-mi0010000
  const newToLegacy = new Map(); // at-main-mi0010000 -> GA_0010_0

  for (const p of points) {
    const newId = String(p.id);
    const legacyId = p.legacy_id != null ? String(p.legacy_id) : null;
    if (!legacyId) throw new Error(`Point ${newId} missing legacy_id`);

    legacyToNew.set(legacyId, newId);
    newToLegacy.set(newId, legacyId);
  }

  const histRoot = readJson(HIST_PATH);
  if (!histRoot || !Array.isArray(histRoot.points)) {
    const keys = histRoot ? Object.keys(histRoot) : [];
    throw new Error(`Unexpected historical_weather.json format. Expected { points: [...] }. Top-level keys: ${keys.join(", ")}`);
  }

  let changed = 0;
  let alreadyNew = 0;

  const updated = histRoot.points.map((rec) => {
    const currentId = String(rec.id);

    // Case 1: already new ID
    if (isNewId(currentId)) {
      alreadyNew++;
      // Add legacy_id if we can
      const legacy = rec.legacy_id ?? newToLegacy.get(currentId);
      if (legacy && rec.legacy_id == null) {
        changed++;
        return { ...rec, legacy_id: legacy, id: currentId };
      }
      return rec;
    }

    // Case 2: legacy ID -> map to new
    const mapped = legacyToNew.get(currentId);
    if (!mapped) {
      throw new Error(`Historical record legacy id=${currentId} has no match in points.json legacy_id values.`);
    }
    changed++;
    return {
      ...rec,
      legacy_id: rec.legacy_id ?? currentId,
      id: mapped
    };
  });

  const bak = backupFile(HIST_PATH);

  const updatedRoot = {
    ...histRoot,
    meta: {
      ...(histRoot.meta || {}),
      id_migration_note: "Historical IDs normalized to at-main-mi...; legacy_id preserved/filled where possible."
    },
    points: updated
  };

  writeJson(HIST_PATH, updatedRoot);

  console.log("✔ Historical normalization complete.");
  console.log(`Records: ${updated.length}`);
  console.log(`Already new IDs: ${alreadyNew}`);
  console.log(`Records changed: ${changed}`);
  console.log("Backup created:");
  console.log(" -", bak);
}

main();