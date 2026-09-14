#!/usr/bin/env node
/**
 * migrate-nct-canonical.js
 *
 * Brings the NCT's TrailTemps data in line with the canonical points.json
 * rebuilt in SectionsHiked (scripts/build-nct-data.js) from NCTA's own GIS.
 *
 * points.json, trail.geojson and nct_meta.json are copied over from
 * SectionsHiked unchanged; this tool fixes up the one file that is
 * TrailTemps-only:
 *
 *   historical_weather.json  The normals join to points by `id`, and the
 *                            rebuild changed everything about that key: the id
 *                            format (nct-vt-mi0000000 -> nct-main-mi0000000),
 *                            the point set (977 at 5mi -> 9,671 at 0.5mi) and
 *                            the mile axis itself (0-4,877.03 -> 0-4,834.95).
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
 * Simpler than the CDT migration in two ways: NCT has no alternates, so there
 * is no alt_id/alt_mile pair to retire and every record lands on route_id
 * "main"; and the old records carry only id/lat/lon plus the normals arrays,
 * so there is no stale `mile` or `state` on them to correct.
 *
 * One NCT-specific thing to expect in the output. The rebuild left 43.4mi of
 * side material off the spine and re-sourced the Superior Hiking Trail from
 * NCTA's own layer instead of OpenStreetMap, so a handful of old normals
 * records sampled at points that are no longer on the trail will show up as
 * having moved more than a mile. Those are the records worth eyeballing; the
 * build's own off-spine list says what is there.
 *
 * Writes weather_id_remap.json alongside, as an audit record of how far each
 * normals point moved. Mirrors the NET, PCT and CDT rebuilds.
 *
 * Run: node trails/north-country-trail/tools/migrate-nct-canonical.js
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
  console.log('=== NCT migrate-nct-canonical.js ===\n');

  const points = JSON.parse(fs.readFileSync(POINTS, 'utf8'));
  console.log('points.json: ' + points.length + ' points, axis '
    + points[0].mile + ' - ' + points[points.length - 1].mile);
  if (!points[0].region_id) {
    throw new Error('points.json is not the canonical rebuild — copy it from '
      + 'SectionsHiked/public/trails/north-country-trail/data/ first');
  }

  if (!fs.existsSync(OLD_WX)) {
    throw new Error('missing ' + path.basename(OLD_WX)
      + ' — back up historical_weather.json before running this');
  }

  const wx = JSON.parse(fs.readFileSync(OLD_WX, 'utf8'));
  console.log('normals: ' + wx.points.length + ' records\n');

  // Bucket the new points by rounded latitude so each lookup scans a short list
  // instead of all 9,671.
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
      remap_note: 'Point ids re-keyed to the NCTA-based canonical points.json by '
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
      + '(expect the off-spine material and the re-sourced SHT here):');
    far.sort((a, b) => b.moved_mi - a.moved_mi).forEach(r =>
      console.log('    ' + r.old_id + ' -> ' + r.new_id
        + '  ' + r.moved_mi.toFixed(2) + ' mi  (' + r.region + ')'));
  }

  // Every new point should be reachable from some normals record, but only
  // ~1 in 10 carries its own; app.js interpolates the rest by mile.
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
