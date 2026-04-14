/**
 * check-normals-pct.js
 *
 * Audits historical_weather.json for missing elevation fields (grid_elev, trail_elev)
 * and repairs them in place without re-fetching normals data.
 *
 * - grid_elev : from Open-Meteo ERA5-Land (meters → feet). A minimal 2-day archive
 *               request is made for each missing point — Open-Meteo returns `elevation`
 *               at the top level of every response regardless of date range.
 * - trail_elev: looked up from points.json (already populated from OpenTopoData SRTM).
 *
 * The script is resume-safe: re-run at any time. Already-correct records are skipped.
 * Saves historical_weather.json after every repaired point.
 *
 * Run from repo root:
 *   node trails/pacific-crest-trail/tools/check-normals-pct.js
 *
 * Options:
 *   --dry-run   Print what would be changed without writing anything.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join('trails', 'pacific-crest-trail', 'data');
const HIST_PATH   = path.join(DATA_DIR, 'historical_weather.json');
const POINTS_PATH = path.join(DATA_DIR, 'points.json');

// Minimal date range — just enough for Open-Meteo to return an elevation field
const PROBE_START = '2022-06-15';
const PROBE_END   = '2022-06-16';

const SLEEP_MS    = 1100; // stay under 1 req/sec
const API_BASE    = 'https://archive-api.open-meteo.com/v1/archive';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Utilities ─────────────────────────────────────────────────────────────────

function readJson(p)       { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function sleep(ms)         { return new Promise(r => setTimeout(r, ms)); }

async function fetchGridElev(lat, lon) {
  const url = new URL(API_BASE);
  url.searchParams.set('latitude',   String(lat));
  url.searchParams.set('longitude',  String(lon));
  url.searchParams.set('start_date', PROBE_START);
  url.searchParams.set('end_date',   PROBE_END);
  url.searchParams.set('daily',      'temperature_2m_max'); // minimal payload
  url.searchParams.set('timezone',   'auto');

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data.elevation == null) throw new Error('No elevation in response');
  return Math.round(data.elevation * 3.28084); // meters → feet
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== PCT check-normals-pct.js' + (DRY_RUN ? ' [DRY RUN]' : '') + ' ===\n');

  if (!fs.existsSync(HIST_PATH)) {
    console.log('historical_weather.json not found — nothing to check yet.');
    return;
  }
  if (!fs.existsSync(POINTS_PATH)) {
    throw new Error(`Missing: ${POINTS_PATH}`);
  }

  const hist       = readJson(HIST_PATH);
  const allPts     = readJson(POINTS_PATH);
  const ptsByid    = new Map(allPts.map(p => [String(p.id), p]));
  const normPoints = hist.points || [];

  // ── Audit ────────────────────────────────────────────────────────────────

  console.log(`Records in historical_weather.json : ${normPoints.length}`);

  const missingGrid   = normPoints.filter(p => p.grid_elev  == null);
  const missingTrail  = normPoints.filter(p => p.trail_elev == null);
  const missingBoth   = normPoints.filter(p => p.grid_elev == null && p.trail_elev == null);
  const complete      = normPoints.filter(p => p.grid_elev != null && p.trail_elev != null);

  console.log(`Complete (grid_elev + trail_elev)  : ${complete.length}`);
  console.log(`Missing grid_elev                  : ${missingGrid.length}`);
  console.log(`Missing trail_elev                 : ${missingTrail.length}`);
  console.log(`Missing both                       : ${missingBoth.length}`);

  if (missingGrid.length === 0 && missingTrail.length === 0) {
    console.log('\n✔ All records are complete. Nothing to repair.');
    return;
  }

  // ── Repair trail_elev from points.json (no API needed) ───────────────────

  let trailElevFixed = 0;
  for (const rec of normPoints) {
    if (rec.trail_elev != null) continue;
    const pt = ptsByid.get(String(rec.id));
    if (pt?.trail_elev != null) {
      if (!DRY_RUN) rec.trail_elev = pt.trail_elev;
      trailElevFixed++;
    } else {
      console.warn(`  ⚠ No trail_elev in points.json for ${rec.id}`);
    }
  }
  if (trailElevFixed > 0) {
    console.log(`\nFixed trail_elev for ${trailElevFixed} records from points.json (no API needed).`);
    if (!DRY_RUN) writeJson(HIST_PATH, hist);
  }

  // ── Repair grid_elev via Open-Meteo (minimal probe requests) ─────────────

  const needGrid = normPoints.filter(p => p.grid_elev == null);
  if (needGrid.length === 0) {
    console.log('\n✔ All grid_elev values already present.');
  } else {
    console.log(`\nFetching grid_elev for ${needGrid.length} records via Open-Meteo...`);
    if (DRY_RUN) {
      console.log('  [dry-run] Would fetch:', needGrid.map(p => p.id).join(', '));
    } else {
      let fixed = 0;
      for (let i = 0; i < needGrid.length; i++) {
        const rec = needGrid[i];
        const lat = Number(rec.lat);
        const lon = Number(rec.lon);

        process.stdout.write(`  [${i + 1}/${needGrid.length}] ${rec.id}  `);

        let attempt = 0;
        let gridElev = null;
        while (attempt < 3) {
          try {
            gridElev = await fetchGridElev(lat, lon);
            break;
          } catch (e) {
            attempt++;
            console.warn(`attempt ${attempt} failed: ${e.message}`);
            if (attempt < 3) await sleep(3000);
          }
        }

        if (gridElev == null) {
          console.log(`FAILED after 3 attempts — skipping`);
        } else {
          rec.grid_elev = gridElev;
          fixed++;

          // Also set trail_elev now if still missing
          if (rec.trail_elev == null) {
            const pt = ptsByid.get(String(rec.id));
            if (pt?.trail_elev != null) rec.trail_elev = pt.trail_elev;
          }

          const diff = rec.trail_elev != null
            ? ` | trail=${rec.trail_elev} ft, grid=${gridElev} ft, diff=${rec.trail_elev - gridElev} ft`
            : ` | grid=${gridElev} ft`;
          console.log(`grid_elev=${gridElev} ft${diff}`);
          writeJson(HIST_PATH, hist);
        }

        if (i < needGrid.length - 1) await sleep(SLEEP_MS);
      }

      console.log(`\n✔ Repaired grid_elev for ${fixed}/${needGrid.length} records.`);
    }
  }

  // ── Final summary ─────────────────────────────────────────────────────────

  if (!DRY_RUN) {
    const reloaded   = readJson(HIST_PATH).points || [];
    const nowMissing = reloaded.filter(p => p.grid_elev == null || p.trail_elev == null);
    console.log(`\nFinal state: ${reloaded.length} records, ${nowMissing.length} still incomplete.`);
    if (nowMissing.length === 0) {
      console.log('✔ All records complete. Ready to continue with generate-normals-pct.js.');
    } else {
      console.log('Still incomplete:', nowMissing.map(p => p.id));
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
