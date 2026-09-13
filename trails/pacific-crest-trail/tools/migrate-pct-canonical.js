#!/usr/bin/env node
/**
 * migrate-pct-canonical.js
 *
 * Brings the PCT's TrailTemps data in line with the canonical points.json
 * rebuilt in SectionsHiked (scripts/build-pct-data.js) from PCTA's own GIS.
 *
 * points.json and trail.geojson are copied over from SectionsHiked unchanged;
 * this tool fixes up the two files that are TrailTemps-only:
 *
 *   historical_weather.json  The normals join to points by `id`, and the
 *                            rebuild changed both the id set (532 points at
 *                            5mi -> 5,313 at 0.5mi) and the mile axis itself
 *                            (the old axis drifted up to 7mi). Matching ids
 *                            by name would therefore silently attach a
 *                            normals record to the wrong place on the trail.
 *                            Each normals record is instead re-keyed to the
 *                            new point nearest its OWN lat/lon, which is the
 *                            location ERA5-Land was actually sampled at.
 *
 *                            The normals are NOT refetched and NOT densified.
 *                            ERA5-Land's grid is ~9km, so sampling finer than
 *                            ~5 miles returns the same cell; app.js already
 *                            falls back to nearest-by-mile for points with no
 *                            normals of their own.
 *
 *   pct_meta.json            Rewritten from the new points. `regions` (6, from
 *                            PCTA) drives the section dropdown — the UI calls
 *                            these "Region" already. `sections` (29 PCTA
 *                            letter sections) drives point labelling.
 *
 * Writes weather_id_remap.json alongside, as an audit record of how far each
 * normals point moved. Mirrors the NET rebuild's approach.
 *
 * Run: node trails/pacific-crest-trail/tools/migrate-pct-canonical.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

const POINTS   = path.join(DATA, 'points.json');
const OLD_WX   = path.join(DATA, 'historical_weather_backup.json');
const NEW_WX   = path.join(DATA, 'historical_weather.json');
const REMAP    = path.join(DATA, 'weather_id_remap.json');
const META     = path.join(DATA, 'pct_meta.json');
const OLD_META = path.join(DATA, 'pct_meta_backup.json');

function haversine(la1, lo1, la2, lo2) {
  const R = 3958.8, t = Math.PI / 180;
  const dLa = (la2 - la1) * t, dLo = (lo2 - lo1) * t;
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function main() {
  console.log('=== PCT migrate-pct-canonical.js ===\n');

  const points = JSON.parse(fs.readFileSync(POINTS, 'utf8'));
  console.log('points.json: ' + points.length + ' points, miles '
    + points[0].mile + ' - ' + points[points.length - 1].mile);

  if (!fs.existsSync(OLD_WX)) {
    throw new Error('missing ' + path.basename(OLD_WX)
      + ' — back up historical_weather.json before running this');
  }

  // ── 1. Re-key the normals by location ──────────────────────────────────────
  const wx = JSON.parse(fs.readFileSync(OLD_WX, 'utf8'));
  console.log('normals: ' + wx.points.length + ' records\n');

  // Bucket the new points by rounded latitude so each lookup scans a short list
  // instead of all 5,313.
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

  const remap = [];
  const used = new Map(); // new id -> the normals record already holding it
  const outPoints = [];
  let maxMoved = 0, dropped = 0;

  for (const rec of wx.points) {
    const { point, dist } = nearest(rec.lat, rec.lon);
    if (!point) throw new Error('no new point near normals record ' + rec.id);

    // Two old records can land on the same new point only if the old spacing
    // collapsed there; keep the closer one so no new id carries two normals.
    const clash = used.get(point.id);
    if (clash && clash.dist <= dist) {
      remap.push({ old_id: rec.id, new_id: null, moved_mi: +dist.toFixed(3), mile: point.mile, dropped: true });
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
    maxMoved = Math.max(maxMoved, dist);
    remap.push({
      old_id  : rec.id,
      new_id  : point.id,
      moved_mi: +dist.toFixed(3),
      route_id: point.route_id,
      mile    : point.mile,
      dropped : false,
    });
    outPoints.push(Object.assign({}, rec, { id: point.id, lat: point.lat, lon: point.lon }));
  }

  outPoints.sort((a, b) => {
    const ma = points.find(p => p.id === a.id).mile;
    const mb = points.find(p => p.id === b.id).mile;
    return ma - mb;
  });

  const newWx = {
    meta: Object.assign({}, wx.meta, {
      remapped: new Date().toISOString().slice(0, 10),
      remap_note: 'Point ids re-keyed to the PCTA-based canonical points.json by '
        + 'nearest location. Normals values themselves are unchanged.',
    }),
    points: outPoints,
  };
  fs.writeFileSync(NEW_WX, JSON.stringify(newWx));
  fs.writeFileSync(REMAP, JSON.stringify(remap));
  console.log('  re-keyed ' + outPoints.length + ' normals records'
    + (dropped ? ', dropped ' + dropped + ' as duplicates' : ''));
  console.log('  max distance a record moved: ' + maxMoved.toFixed(3) + 'mi');
  console.log('  wrote historical_weather.json + weather_id_remap.json');

  // ── 2. Rebuild pct_meta.json ───────────────────────────────────────────────
  const oldMeta = JSON.parse(fs.readFileSync(OLD_META, 'utf8'));
  const totalMiles = points[points.length - 1].mile;

  const groupBy = (idKey, nameKey) => {
    const out = [];
    for (const p of points) {
      let g = out.find(x => x.id === p[idKey]);
      if (!g) {
        g = { id: p[idKey], name: p[nameKey], mile_start: p.mile, mile_end: p.mile, states: [] };
        out.push(g);
      }
      g.mile_end = p.mile;
      if (p.state && !g.states.includes(p.state)) g.states.push(p.state);
    }
    return out;
  };

  const regions  = groupBy('region_id', 'region_name');
  const sections = groupBy('section_id', 'section_name').map(s => {
    const first = points.find(p => p.section_id === s.id);
    return Object.assign({}, s, { region: first.region_id });
  });

  const meta = {
    trail: {
      name: 'Pacific Crest Trail',
      total_trail_miles: totalMiles,
      map_center: oldMeta.trail.map_center,
      map_zoom: oldMeta.trail.map_zoom,
      termini: oldMeta.trail.termini,
      source: 'Pacific Crest Trail Association — PCT Mile Markers 2026, '
        + 'PCT Letter Sections, PCTA Centerline Regions',
      rebuilt: new Date().toISOString().slice(0, 10),
    },
    // The section dropdown is populated from `regions`: the UI labels it
    // "Region", and PCTA's 6 regions are the closest thing to the 5 ad-hoc
    // divisions it used to list.
    regions,
    // PCTA's 29 lettered sections, used for point labelling. These deliberately
    // do not follow state lines — CA Section R runs ~27mi into Oregon — so
    // `states` here can hold more than one entry.
    sections,
    direction_options: (oldMeta.direction_options || []).map(o =>
      Object.assign({}, o, { total_miles: totalMiles })),
  };
  fs.writeFileSync(META, JSON.stringify(meta, null, 2));
  console.log('\n  pct_meta.json: ' + regions.length + ' regions, ' + sections.length + ' sections, '
    + meta.direction_options.length + ' direction options');
  regions.forEach(r => console.log('    ' + r.id.padEnd(18)
    + String(r.mile_start).padStart(7) + ' - ' + String(r.mile_end).padStart(7)
    + '  ' + r.states.join('/')));

  console.log('\nDone.');
}

main();
