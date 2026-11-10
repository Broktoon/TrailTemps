#!/usr/bin/env node
/**
 * migrate-pht-canonical.js
 *
 * Brings the Potomac Heritage Trail's TrailTemps data in line with the
 * canonical points.json rebuilt in SectionsHiked (scripts/build-pht-data.js)
 * from the NPS POHE Trail Centerline.
 *
 * points.json, trail.geojson and pht_meta.json are copied over from
 * SectionsHiked unchanged. This tool fixes up the one file that is
 * TrailTemps-only:
 *
 *   historical_weather.json  The normals join to points by `id`. The rebuild
 *                            replaced every id on this trail: the old ids
 *                            were keyed on a section slug and a section mile
 *                            (pht-southern-maryland-mi02165860), the new ones
 *                            on a route and a route mile (pht-main-mi0509850).
 *                            The axis itself also reversed. Mile 0 used to be
 *                            Point Lookout and is now Laurel Ridge.
 *
 *                            So no old id survives, and an id join would find
 *                            nothing at all. Each record is instead re-keyed
 *                            to the new point nearest its OWN lat/lon, which
 *                            is where ERA5-Land was actually sampled.
 *
 *                            The normals are NOT refetched and NOT densified.
 *                            ERA5-Land's grid is about 9km, so sampling finer
 *                            than about 5 miles returns the same cell.
 *
 * THREE THINGS SPECIFIC TO THIS TRAIL.
 *
 *   1. `lat`/`lon` on each record stay the ORIGINAL sample location. The PNT
 *      migration overwrote them with the new point's coordinates, which was
 *      harmless there (largest move 0.7mi on a single line). Here app.js
 *      finds normals for a point with none of its own by nearest LOCATION,
 *      not nearest mile, because this trail is a network: 171 side routes
 *      each restart at mile 0, so "nearest by mile" has no meaning across
 *      them. A spatial lookup must be told where the weather was really
 *      sampled, so that is what the record keeps.
 *
 *   2. A record more than FAR_MI from every modelled point is DROPPED rather
 *      than re-keyed. NPS republished this layer between April and October
 *      2026 and removed geometry, so a few old samples now sit miles from any
 *      trail. Re-keying one would attach an id to weather sampled somewhere
 *      else. The threshold sits in a natural gap in the data (see the run
 *      output), and the coverage check at the end confirms nothing is left
 *      uncovered by dropping them.
 *
 *   3. The legacy fields section_id, alt_id, section_mile and on_spine are
 *      removed from each record. They described the old section scheme, which
 *      no longer exists. Each record gains mile and route_id instead.
 *
 * Writes weather_id_remap.json alongside, as an audit record of where each
 * normals record went. Mirrors the NET, PCT, CDT, NCT and PNT rebuilds.
 *
 * Input is historical_weather_backup.json (kept locally, gitignored), so the
 * tool can be re-run without compounding its own output.
 *
 * Run: node trails/potomac-heritage-trail/tools/migrate-pht-canonical.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA   = path.join(__dirname, '..', 'data');
const POINTS = path.join(DATA, 'points.json');
const META   = path.join(DATA, 'pht_meta.json');
const OLD_WX = path.join(DATA, 'historical_weather_backup.json');
const NEW_WX = path.join(DATA, 'historical_weather.json');
const REMAP  = path.join(DATA, 'weather_id_remap.json');

const { hydratePoints } = require(path.join(__dirname, '..', '..', '..', 'js', 'hydrate-points.js'));

// A record farther than this from every modelled point is dropped, not moved.
// Half an ERA5-Land cell, and it lands in a gap in the measured distances.
const FAR_MI = 3;

// ERA5-Land's cell is about 9km. A point farther than this from its nearest
// kept sample would be reading a neighbouring cell, so the run fails on it.
const CELL_MI = 5.6;

const LEGACY_FIELDS = ['section_id', 'alt_id', 'section_mile', 'on_spine'];

function haversine(la1, lo1, la2, lo2) {
  const R = 3958.8, t = Math.PI / 180;
  const dLa = (la2 - la1) * t, dLo = (lo2 - lo1) * t;
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function main() {
  console.log('=== PHT migrate-pht-canonical.js ===\n');

  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  if (!meta.hydrate) {
    throw new Error('pht_meta.json has no hydrate block. Copy the canonical files from '
      + 'SectionsHiked/public/trails/potomac-heritage-trail/data/ first');
  }
  const points = hydratePoints(JSON.parse(fs.readFileSync(POINTS, 'utf8')), meta);
  const spine  = points.filter(p => p.route_kind === 'spine');
  console.log('points.json: ' + points.length + ' points on '
    + new Set(points.map(p => p.route_id)).size + ' routes; spine '
    + spine.length + ' points, mile ' + spine[0].mile + ' to ' + spine[spine.length - 1].mile);

  if (!fs.existsSync(OLD_WX)) {
    throw new Error('missing ' + path.basename(OLD_WX)
      + '. Back up historical_weather.json before running this');
  }
  const wx = JSON.parse(fs.readFileSync(OLD_WX, 'utf8'));
  console.log('normals: ' + wx.points.length + ' records\n');

  const nearestPoint = (lat, lon) => {
    let best = null, bd = Infinity;
    for (const p of points) {
      const d = haversine(lat, lon, p.lat, p.lon);
      if (d < bd) { bd = d; best = p; }
    }
    return { point: best, dist: bd };
  };

  const remap = [];
  const kept  = new Map();   // new id -> { rec, dist, entry }
  let droppedFar = 0, droppedDup = 0;

  for (const rec of wx.points) {
    const { point, dist } = nearestPoint(rec.lat, rec.lon);
    const entry = {
      old_id  : rec.id,
      new_id  : point.id,
      moved_mi: +dist.toFixed(3),
      mile    : point.mile,
      route_id: point.route_id,
      region  : point.region_id,
      dropped : false,
    };
    remap.push(entry);

    if (dist > FAR_MI) {
      entry.new_id = null; entry.dropped = true; entry.reason = 'no modelled trail within ' + FAR_MI + ' mi';
      droppedFar++;
      continue;
    }

    // Two old records land on one new point where the old data described the
    // same ground twice. Keep the closer so no id carries two sets of normals.
    const clash = kept.get(point.id);
    if (clash && clash.dist <= dist) {
      entry.new_id = null; entry.dropped = true; entry.reason = 'duplicate of ' + clash.entry.old_id;
      droppedDup++;
      continue;
    }
    if (clash) {
      clash.entry.new_id = null; clash.entry.dropped = true; clash.entry.reason = 'duplicate of ' + rec.id;
      droppedDup++;
    }

    const out = { id: point.id, lat: rec.lat, lon: rec.lon, mile: point.mile, route_id: point.route_id };
    if (point.state) out.state = point.state;
    for (const k of Object.keys(rec)) {
      if (k === 'id' || k === 'lat' || k === 'lon' || LEGACY_FIELDS.includes(k)) continue;
      out[k] = rec[k];
    }
    kept.set(point.id, { rec: out, dist, entry });
  }

  // Spine first in axis order, then the other routes, each in its own order.
  const routeRank = id => (id === 'main' ? 0 : id.startsWith('alt-') ? 1 : 2);
  const outPoints = [...kept.values()].map(k => k.rec).sort((a, b) =>
    routeRank(a.route_id) - routeRank(b.route_id)
    || a.route_id.localeCompare(b.route_id, undefined, { numeric: true })
    || a.mile - b.mile);

  const newWx = {
    meta: Object.assign({}, wx.meta, {
      remapped: new Date().toISOString().slice(0, 10),
      remap_note: 'Point ids re-keyed to the NPS-based canonical points.json by nearest '
        + 'location. lat/lon remain the original ERA5-Land sample location. Normals '
        + 'values themselves are unchanged.',
    }),
    points: outPoints,
  };
  fs.writeFileSync(NEW_WX, JSON.stringify(newWx));
  fs.writeFileSync(REMAP, JSON.stringify(remap));

  console.log('  re-keyed ' + outPoints.length + ' of ' + wx.points.length + ' normals records');
  console.log('  dropped  ' + droppedFar + ' with no modelled trail within ' + FAR_MI + ' mi, '
    + droppedDup + ' as duplicates');
  for (const r of remap.filter(r => r.dropped)) {
    console.log('    ' + r.old_id + '  ' + r.moved_mi.toFixed(2) + ' mi  (' + r.reason + ')');
  }

  // The threshold is only honest if it falls in a gap, so show the distances
  // either side of it every run.
  const all = remap.map(r => r.moved_mi).sort((a, b) => a - b);
  const below = all.filter(d => d <= FAR_MI), above = all.filter(d => d > FAR_MI);
  console.log('\n  distance to nearest modelled point, all ' + all.length + ' records:');
  console.log('    median ' + all[all.length >> 1].toFixed(3) + ' mi, 95th '
    + all[Math.floor(0.95 * (all.length - 1))].toFixed(3) + ' mi');
  console.log('    largest kept ' + (below.length ? below[below.length - 1].toFixed(2) : 'n/a')
    + ' mi, smallest dropped ' + (above.length ? above[0].toFixed(2) : 'n/a') + ' mi');

  // What the planner will actually experience: for every point on the trail,
  // how far away is the weather it will be shown?
  console.log('\n  every point to its nearest KEPT sample:');
  let worstOverall = 0;
  const report = (label, sel) => {
    if (!sel.length) return;
    const dd = [];
    let worst = null;
    for (const p of sel) {
      let bd = Infinity;
      for (const w of outPoints) {
        const d = haversine(p.lat, p.lon, w.lat, w.lon);
        if (d < bd) bd = d;
      }
      dd.push(bd);
      if (!worst || bd > worst.d) worst = { d: bd, p };
    }
    dd.sort((a, b) => a - b);
    if (worst.d > worstOverall) worstOverall = worst.d;
    console.log('    ' + label.padEnd(28) + String(sel.length).padStart(6) + ' pts   median '
      + dd[dd.length >> 1].toFixed(2) + '   95th ' + dd[Math.floor(0.95 * (dd.length - 1))].toFixed(2)
      + '   max ' + worst.d.toFixed(2) + ' mi');
  };
  report('main spine', points.filter(p => p.route_kind === 'spine'));
  report('alternate', points.filter(p => p.route_kind === 'alternate'));
  report('side routes', points.filter(p => p.route_kind === 'side'));
  for (const r of meta.regions) report('  ' + r.name, points.filter(p => p.region_id === r.id));

  if (worstOverall > CELL_MI) {
    throw new Error('a point sits ' + worstOverall.toFixed(2) + ' mi from its nearest sample, '
      + 'more than one ERA5-Land cell (' + CELL_MI + ' mi). Normals need generating there.');
  }
  console.log('\n  every point is within one ERA5-Land cell (' + CELL_MI + ' mi) of a sample');

  const own = new Set(outPoints.map(p => p.id));
  console.log('  ' + own.size + ' of ' + points.length + ' points carry their own normals ('
    + (100 * own.size / points.length).toFixed(1) + '%); the rest use the nearest sample by location');

  console.log('\n  wrote historical_weather.json + weather_id_remap.json');
  console.log('\nDone.');
}

main();
