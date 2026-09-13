#!/usr/bin/env node
/**
 * migrate-cdt-canonical.js
 *
 * Brings the CDT's TrailTemps data in line with the canonical points.json
 * rebuilt in SectionsHiked (scripts/build-cdt-data.js) from CDTC's own GIS.
 *
 * points.json, trail.geojson and cdt_meta.json are copied over from
 * SectionsHiked unchanged; this tool fixes up the one file that is
 * TrailTemps-only:
 *
 *   historical_weather.json  The normals join to points by `id`, and the
 *                            rebuild changed both the id set (657 points at
 *                            5mi -> 6,523 at 0.5mi) and the mile axis itself
 *                            (0-3,025.10 -> 0-3,039.979). Matching ids by name
 *                            would therefore silently attach a normals record
 *                            to the wrong place on the trail. Each record is
 *                            instead re-keyed to the new point nearest its OWN
 *                            lat/lon, which is where ERA5-Land was sampled.
 *
 *                            The normals are NOT refetched and NOT densified.
 *                            ERA5-Land's grid is ~9km, so sampling finer than
 *                            ~5 miles returns the same cell; app.js already
 *                            falls back to nearest-by-mile for points with no
 *                            normals of their own.
 *
 * Two CDT-specific wrinkles the PCT migration did not have:
 *
 *   The 9 normals records tagged alt_id "rmnp" belong to a route that is no
 *   longer an alternate. The old build ran the mile axis along the western
 *   bypass and modelled the real route through Rocky Mountain National Park as
 *   a 40-mile alternate; CDTC has it the other way round, so those records
 *   now re-key onto the main spine. That is correct, not a loss.
 *
 *   The old records carry `alt_id` and `alt_mile`. Those fields do not exist
 *   in the canonical schema — an alternate's points now carry `route_id` and
 *   a `mile` on the main axis — so they are dropped and replaced with the new
 *   point's `route_id`.
 *
 * Writes weather_id_remap.json alongside, as an audit record of how far each
 * normals point moved. Mirrors the NET and PCT rebuilds.
 *
 * Run: node trails/continental-divide-trail/tools/migrate-cdt-canonical.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA   = path.join(__dirname, '..', 'data');
const POINTS = path.join(DATA, 'points.json');
const OLD_WX = path.join(DATA, 'historical_weather_backup.json');
const NEW_WX = path.join(DATA, 'historical_weather.json');
const REMAP  = path.join(DATA, 'weather_id_remap.json');

function haversine(la1, lo1, la2, lo2) {
  const R = 3958.8, t = Math.PI / 180;
  const dLa = (la2 - la1) * t, dLo = (lo2 - lo1) * t;
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function main() {
  console.log('=== CDT migrate-cdt-canonical.js ===\n');

  const points = JSON.parse(fs.readFileSync(POINTS, 'utf8'));
  const spine  = points.filter(p => p.route_id === 'main');
  console.log('points.json: ' + points.length + ' points ('
    + spine.length + ' spine), axis ' + spine[0].mile + ' - ' + spine[spine.length - 1].mile);

  if (!fs.existsSync(OLD_WX)) {
    throw new Error('missing ' + path.basename(OLD_WX)
      + ' — back up historical_weather.json before running this');
  }

  const wx = JSON.parse(fs.readFileSync(OLD_WX, 'utf8'));
  console.log('normals: ' + wx.points.length + ' records\n');

  // Bucket the new points by rounded latitude so each lookup scans a short list
  // instead of all 6,523.
  const byLat = new Map();
  points.forEach(p => {
    const k = Math.round(p.lat * 10);
    if (!byLat.has(k)) byLat.set(k, []);
    byLat.get(k).push(p);
  });
  const nearest = (lat, lon) => {
    let best = null, bd = Infinity;
    const k = Math.round(lat * 10);
    for (let d = 0; d <= 3 && best === null; d++) {
      for (const kk of (d === 0 ? [k] : [k - d, k + d])) {
        for (const p of (byLat.get(kk) || [])) {
          const dist = haversine(lat, lon, p.lat, p.lon);
          if (dist < bd) { bd = dist; best = p; }
        }
      }
    }
    return { point: best, dist: bd };
  };

  const mileById = new Map(points.map(p => [p.id, p.mile]));
  const remap = [];
  const used = new Map();   // new id -> { dist } of the record already holding it
  const outPoints = [];
  let dropped = 0;

  for (const rec of wx.points) {
    const { point, dist } = nearest(rec.lat, rec.lon);
    if (!point) throw new Error('no new point near normals record ' + rec.id);

    // Two old records can only land on the same new point if the old 5-mile
    // spacing collapsed there; keep the closer one so no id carries two normals.
    const clash = used.get(point.id);
    if (clash && clash.dist <= dist) {
      remap.push({ old_id: rec.id, old_alt_id: rec.alt_id ?? null, new_id: null,
        moved_mi: +dist.toFixed(3), dropped: true });
      dropped++;
      continue;
    }
    if (clash) {
      const i = outPoints.findIndex(p => p.id === point.id);
      if (i >= 0) outPoints.splice(i, 1);
      const r = remap.find(r => r.new_id === point.id);
      if (r) { r.new_id = null; r.dropped = true; }
      dropped++;
    }

    used.set(point.id, { dist });
    remap.push({
      old_id    : rec.id,
      old_alt_id: rec.alt_id ?? null,
      new_id    : point.id,
      new_route : point.route_id,
      moved_mi  : +dist.toFixed(3),
      mile      : point.mile,
      dropped   : false,
    });

    // Drop the retired alt_id/alt_mile pair; carry the canonical route_id.
    const out = Object.assign({}, rec, {
      id: point.id, lat: point.lat, lon: point.lon,
      mile: point.mile, route_id: point.route_id,
    });
    delete out.alt_id;
    delete out.alt_mile;
    delete out.state;
    if (point.state) out.state = point.state;
    outPoints.push(out);
  }

  outPoints.sort((a, b) => (mileById.get(a.id) - mileById.get(b.id)));

  const newWx = {
    meta: Object.assign({}, wx.meta, {
      remapped: new Date().toISOString().slice(0, 10),
      remap_note: 'Point ids re-keyed to the CDTC-based canonical points.json by '
        + 'nearest location. Normals values themselves are unchanged.',
    }),
    points: outPoints,
  };
  fs.writeFileSync(NEW_WX, JSON.stringify(newWx));
  fs.writeFileSync(REMAP, JSON.stringify(remap));

  console.log('  re-keyed ' + outPoints.length + ' normals records'
    + (dropped ? ', dropped ' + dropped + ' as duplicates' : ''));

  // How far records moved matters only against ERA5-Land's ~9km (5.6mi) grid:
  // a record that moves less than a cell is still describing its own cell. The
  // few that move further sit where CDTC's 2026 route and the 2019 USFS line
  // genuinely differ — reroutes, not mis-joins — and the northern terminus,
  // which CDTC places 3.3mi from where the old axis ended.
  const moves = remap.filter(r => !r.dropped).map(r => r.moved_mi).sort((a, b) => a - b);
  const pct = q => moves[Math.min(moves.length - 1, Math.floor(q * moves.length))];
  console.log('  moved: median ' + pct(0.5).toFixed(3)
    + ' mi, 95th ' + pct(0.95).toFixed(3)
    + ' mi, max ' + moves[moves.length - 1].toFixed(3) + ' mi');
  const far = remap.filter(r => !r.dropped && r.moved_mi > 3);
  if (far.length) {
    console.log('  ' + far.length + ' record(s) moved over 3 mi:');
    far.sort((a, b) => b.moved_mi - a.moved_mi).forEach(r =>
      console.log('    ' + r.old_id + ' -> ' + r.new_id + '  ' + r.moved_mi.toFixed(2) + ' mi'));
  }

  const byRoute = {};
  for (const r of remap) {
    if (r.dropped) continue;
    const k = (r.old_alt_id || 'main') + ' -> ' + r.new_route;
    byRoute[k] = (byRoute[k] || 0) + 1;
  }
  console.log('\n  route mapping:');
  Object.entries(byRoute).sort().forEach(([k, v]) =>
    console.log('    ' + k.padEnd(34) + v));
  console.log('\n  wrote historical_weather.json + weather_id_remap.json');
  console.log('\nDone.');
}

main();
