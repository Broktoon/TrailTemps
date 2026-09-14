#!/usr/bin/env node
/**
 * migrate-pnt-canonical.js
 *
 * Brings the PNT's TrailTemps data in line with the canonical points.json
 * rebuilt in SectionsHiked (scripts/build-pnt-data.js) from the USFS Region 6
 * centerline.
 *
 * points.json, trail.geojson and pnt_meta.json are copied over from
 * SectionsHiked unchanged; this tool fixes up the one file that is
 * TrailTemps-only:
 *
 *   historical_weather.json  The normals join to points by `id`, and the
 *                            rebuild changed the point set (245 at 5mi ->
 *                            2,423 at 0.5mi) and the mile axis itself
 *                            (0-1,217.767 -> 0-1,210.95), so every id in the
 *                            file is now either missing or - worse - lands on
 *                            a different part of the trail, because the ids
 *                            encode the mile and the mile moved.
 *
 *                            Matching by id would not merely fail, it would
 *                            fail SILENTLY and completely: app.js builds its
 *                            nearest-by-mile fallback index from the points
 *                            that already have normals, so with every id
 *                            missing that index comes out empty and the page
 *                            shows no normals at all rather than degraded ones.
 *
 *                            Each record is instead re-keyed to the new point
 *                            nearest its OWN lat/lon, which is where ERA5-Land
 *                            was actually sampled.
 *
 *                            The normals are NOT refetched and NOT densified.
 *                            ERA5-Land's grid is ~9km, so sampling finer than
 *                            ~5 miles returns the same cell; app.js falls back
 *                            to nearest-by-mile for the ~90% of new points
 *                            that have no normals of their own.
 *
 * TWO THINGS TO EXPECT IN THE OUTPUT, both specific to this trail.
 *
 *   1. The single largest mover is the old on-the-ferry sample. The old axis
 *      ran across the Puget Sound crossing and counted it, so old mile 1000
 *      sat out in Admiralty Inlet. No new point is on the water, so it re-keys
 *      to the Port Townsend landing - 0.698mi, the largest move in the file.
 *      Its normals were an ERA5-Land sample over open saltwater, which is not a
 *      useful figure for a hiker anyway, and 0.7mi is an eighth of an
 *      ERA5-Land cell, so the substitution changes nothing material.
 *
 *   2. Everything after the crossing shifts about 6.8mi EARLIER on the axis
 *      (5.79 of ferry, the rest side material the rebuild left off the spine),
 *      against about 1mi before it. That shows up in the remap as a change in
 *      `mile`, not as distance moved - the records themselves barely move on
 *      the ground, which is the whole point of re-keying by lat/lon.
 *
 * Writes weather_id_remap.json alongside, as an audit record of how far each
 * normals point moved. Mirrors the NET, PCT, CDT and NCT rebuilds.
 *
 * Run: node trails/pacific-northwest-trail/tools/migrate-pnt-canonical.js
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
  console.log('=== PNT migrate-pnt-canonical.js ===\n');

  const points = JSON.parse(fs.readFileSync(POINTS, 'utf8'));
  console.log('points.json: ' + points.length + ' points, axis '
    + points[0].mile + ' - ' + points[points.length - 1].mile);
  if (!points[0].region_id) {
    throw new Error('points.json is not the canonical rebuild — copy it from '
      + 'SectionsHiked/public/trails/pacific-northwest-trail/data/ first');
  }

  if (!fs.existsSync(OLD_WX)) {
    throw new Error('missing ' + path.basename(OLD_WX)
      + ' — back up historical_weather.json before running this');
  }

  const wx = JSON.parse(fs.readFileSync(OLD_WX, 'utf8'));
  console.log('normals: ' + wx.points.length + ' records\n');

  // Bucket the new points by rounded latitude so each lookup scans a short list.
  const byLat = new Map();
  points.forEach(p => {
    const k = Math.round(p.lat * 10);
    if (!byLat.has(k)) byLat.set(k, []);
    byLat.get(k).push(p);
  });
  const nearest = (lat, lon) => {
    let best = null, bd = Infinity;
    const k = Math.round(lat * 10);
    for (let d = 0; d <= 5 && best === null; d++) {
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

    // Two old records can only land on the same new point where the trail
    // doubles back on itself; keep the closer one so no id carries two normals.
    const clash = used.get(point.id);
    if (clash && clash.dist <= dist) {
      remap.push({ old_id: rec.id, new_id: null, moved_mi: +dist.toFixed(3), dropped: true });
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
      old_id  : rec.id,
      new_id  : point.id,
      moved_mi: +dist.toFixed(3),
      mile    : point.mile,
      region  : point.region_id,
      dropped : false,
    });

    const out = Object.assign({}, rec, {
      id: point.id, lat: point.lat, lon: point.lon,
      mile: point.mile, route_id: point.route_id,
    });
    if (point.state) out.state = point.state;
    outPoints.push(out);
  }

  outPoints.sort((a, b) => (mileById.get(a.id) - mileById.get(b.id)));

  const newWx = {
    meta: Object.assign({}, wx.meta, {
      remapped: new Date().toISOString().slice(0, 10),
      remap_note: 'Point ids re-keyed to the USFS-based canonical points.json by '
        + 'nearest location. Normals values themselves are unchanged.',
    }),
    points: outPoints,
  };
  fs.writeFileSync(NEW_WX, JSON.stringify(newWx));
  fs.writeFileSync(REMAP, JSON.stringify(remap));

  console.log('  re-keyed ' + outPoints.length + ' normals records'
    + (dropped ? ', dropped ' + dropped + ' as duplicates' : ''));

  // How far records moved matters only against ERA5-Land's ~9km (5.6mi) grid:
  // a record that moves less than a cell is still describing its own cell.
  const moves = remap.filter(r => !r.dropped).map(r => r.moved_mi).sort((a, b) => a - b);
  const pct = q => moves[Math.min(moves.length - 1, Math.floor(q * moves.length))];
  console.log('  moved: median ' + pct(0.5).toFixed(3)
    + ' mi, 95th ' + pct(0.95).toFixed(3)
    + ' mi, max ' + moves[moves.length - 1].toFixed(3) + ' mi');
  const far = remap.filter(r => !r.dropped && r.moved_mi > 1);
  if (far.length) {
    console.log('  ' + far.length + ' record(s) moved over 1 mi '
      + '(expect the old on-the-ferry sample here):');
    far.sort((a, b) => b.moved_mi - a.moved_mi).forEach(r =>
      console.log('    ' + r.old_id + ' -> ' + r.new_id
        + '  ' + r.moved_mi.toFixed(2) + ' mi  (' + r.region + ')'));
  }

  const covered = new Set(outPoints.map(p => p.id));
  console.log('\n  coverage: ' + covered.size + ' of ' + points.length
    + ' points carry their own normals ('
    + (100 * covered.size / points.length).toFixed(1) + '%); the rest fall back '
    + 'to nearest-by-mile, as before');

  const gaps = [];
  for (let i = 1; i < outPoints.length; i++) {
    const g = mileById.get(outPoints[i].id) - mileById.get(outPoints[i - 1].id);
    if (g > 8) gaps.push({ from: mileById.get(outPoints[i - 1].id), to: mileById.get(outPoints[i].id), g });
  }
  if (gaps.length) {
    console.log('  gaps over 8 mi between consecutive normals records: ' + gaps.length);
    gaps.sort((a, b) => b.g - a.g).slice(0, 6).forEach(x =>
      console.log('    mile ' + x.from + ' -> ' + x.to + '  (' + x.g.toFixed(1) + ' mi)'));
  } else {
    console.log('  no gap over 8 mi between consecutive normals records');
  }

  console.log('\n  wrote historical_weather.json + weather_id_remap.json');
  console.log('\nDone.');
}

main();
