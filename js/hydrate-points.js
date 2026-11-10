// hydrate-points.js — the shared loader for the 7-field canonical schema.
//
// Canonical points.json carries only:
//     required   lat, lon, mile, route_id
//     optional   trail_elev, route_type, state
//
// Everything the apps used to read off every point is rebuilt here from the
// trail's *_meta.json, which holds each value once instead of per point:
//
//     id             composed from meta.hydrate.id
//     sec_mile       mile - the start of the containing section or region
//     section_id     the range table in meta.sections
//     section_name   looked up from section_id        (1:1 on all 11 trails)
//     region_id      from `state`, from the section, or from meta.regions
//     region_name    looked up from region_id         (1:1 on all 11 trails)
//     route_kind     from meta.routes
//     alt_of         from meta.routes
//     junction_mile  from meta.routes   (constant within a route on every
//     junction_sec_mile                  trail that has them — verified)
//
// The output object is byte-for-byte what the apps read today. That is the
// point: `verify-schema-roundtrip.js` asserts it before any file is rewritten.
//
// Nothing here is trail-specific. The three things that genuinely vary per
// trail live in meta.hydrate as data:
//
//   id.token_by     "route" | "section"   which field supplies the middle token
//   id.tokens       {key value: token}    the literal token, so a trail whose
//                                         id says "main" while route_id says
//                                         "main-spine" still reproduces exactly
//   id.from         "mile" | "sec_mile"   which number the numeric tail encodes
//   id.scale/width  10 | 100 | 1000       AT uses mile x1000 w7, Natchez
//                                         sec_mile x10 w4
//   sec_mile_from   "section" | "region"  section-local on AT/CDT/PCT/...,
//                                         region-local on NCT/PNT/PHT
//   region_from     "state" | "section" | "ranges"
//
// Used by both repos. SectionsHiked calls it once in the shared map.js;
// TrailTemps calls it from each trail's own app.js.

'use strict';

const SPINE_ROUTE = 'main';

// ---------------------------------------------------------------- range index

// Ranges tile the axis in order, so a point normally lands in one by binary
// search on its mile. Kept because callers outside this module use it.
function makeRangeIndex(ranges) {
  const sorted = [...ranges].sort((a, b) => a.mile_start - b.mile_start);
  return function lookup(mile) {
    if (!sorted.length) return null;
    let lo = 0, hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sorted[mid].mile_start <= mile) lo = mid; else hi = mid - 1;
    }
    return sorted[lo];
  };
}

// Assign a range to every point of one route by walking both in order.
//
// Mile alone is not always enough. Where a trail is disconnected, the last
// point of one section and the first point of the next carry the SAME mile —
// no distance accrues across a gap with no trail in it. Natchez does this at
// two of its four section boundaries (miles 3.4 and 44.3), so a lookup keyed
// only on mile has to pick one of two right answers and is wrong half the
// time. Position is what distinguishes them.
//
// The walk advances when the mile passes the current range's end, or when it
// sits exactly on that end and a point there has already been assigned. With
// no shared boundary miles this behaves exactly like the plain lookup.
function assignRangesInOrder(points, indices, ranges) {
  const sorted = [...ranges].sort((a, b) => a.mile_start - b.mile_start);
  const out = new Map();
  if (!sorted.length) return out;

  let r = 0;
  let touchedEnd = false;
  for (const i of indices) {
    const mile = points[i].mile;
    if (typeof mile === 'number') {
      while (r + 1 < sorted.length
        && (mile > sorted[r].mile_end
          || (mile === sorted[r].mile_end && touchedEnd && sorted[r + 1].mile_start <= mile))) {
        r++;
        touchedEnd = false;
      }
      if (mile === sorted[r].mile_end) touchedEnd = true;
    }
    out.set(i, sorted[r]);
  }
  return out;
}

// ---------------------------------------------------------------- id composer

function padNum(value, scale, width) {
  // Round before padding: 0.1 * 1000 is 100.00000000000001 in binary floating
  // point, and String() of that is not a run of digits.
  return String(Math.round(value * scale)).padStart(width, '0');
}

function makeIdComposer(spec) {
  if (!spec) return () => null;
  const tokens = spec.tokens || {};
  return function composeId(point, derived) {
    const keyValue = spec.token_by === 'section'
      ? derived.section_id
      : (point.route_id ?? SPINE_ROUTE);
    // An explicit token wins; otherwise the key value is the token.
    const token = Object.prototype.hasOwnProperty.call(tokens, keyValue)
      ? tokens[keyValue]
      : keyValue;
    const basis = spec.from === 'sec_mile' ? derived.sec_mile : point.mile;
    if (basis === null || basis === undefined) return null;
    return spec.prefix + '-' + token + '-mi' + padNum(basis, spec.scale, spec.width);
  };
}

// ---------------------------------------------------------------------- main

/**
 * Rebuild the full point records the apps read, from slim points plus meta.
 * Returns a new array; the input is not modified.
 */
function hydratePoints(points, meta) {
  if (!Array.isArray(points)) throw new TypeError('hydratePoints: points must be an array');
  if (!meta || typeof meta !== 'object') throw new TypeError('hydratePoints: meta is required');

  const h = meta.hydrate || {};
  const regions = meta.regions || [];
  const sections = meta.sections || [];
  const routes = meta.routes || [];

  const regionById = new Map(regions.map(r => [r.id, r]));
  const sectionById = new Map(sections.map(s => [s.id, s]));
  const routeById = new Map(routes.map(r => [r.id, r]));

  // Range tables are built per route: an alternate has its own sections, and
  // its miles overlap the spine's, so one shared index would mis-assign them.
  //
  // Each table row names its own route explicitly. Defaulting to the spine
  // here instead would silently mis-key every trail whose spine route_id is
  // still `main-spine` rather than `main`, which is five of the eleven today.
  const groupRows = (rows) => {
    const m = new Map();
    for (const row of rows) {
      const rid = row.route_id ?? SPINE_ROUTE;
      if (!m.has(rid)) m.set(rid, []);
      m.get(rid).push(row);
    }
    return m;
  };
  const sectionRows = groupRows(sections);
  const regionRows = groupRows(regions);

  // Point indices grouped by route, in file order — the order the walk needs.
  const indicesByRoute = new Map();
  for (let i = 0; i < points.length; i++) {
    const rid = points[i].route_id ?? SPINE_ROUTE;
    if (!indicesByRoute.has(rid)) indicesByRoute.set(rid, []);
    indicesByRoute.get(rid).push(i);
  }

  const sectionFor = new Map();
  const regionForByRange = new Map();
  for (const [rid, indices] of indicesByRoute) {
    const secs = sectionRows.get(rid);
    if (secs) {
      for (const [i, row] of assignRangesInOrder(points, indices, secs)) sectionFor.set(i, row);
    }
    const regs = regionRows.get(rid);
    if (regs) {
      for (const [i, row] of assignRangesInOrder(points, indices, regs)) regionForByRange.set(i, row);
    }
  }

  const composeId = makeIdComposer(h.id);

  // How the region is recovered, overridable per route. An off-spine route
  // sits in exactly one region, so its route row names it directly; only the
  // spine needs a range table, because only the spine crosses regions.
  const regionFromFor = (routeId) => {
    const r = routeById.get(routeId);
    return (r && r.region_from) || h.region_from || 'ranges';
  };

  // The sec_mile basis can differ per route, so a route row may override the
  // trail default. PHT needs this: its spine measures sec_mile from the
  // region start, while every off-spine route carries a route-local mile that
  // already starts at zero.
  const secMileFromFor = (routeId) => {
    const r = routeById.get(routeId);
    return (r && r.sec_mile_from) || h.sec_mile_from || 'section';
  };

  // Base mile per route, for routes measuring sec_mile from their own start.
  const routeBase = new Map();
  for (const [rid, indices] of (function groupIdx() {
    const m = new Map();
    for (let i = 0; i < points.length; i++) {
      const rid = points[i].route_id ?? SPINE_ROUTE;
      if (!m.has(rid)) m.set(rid, []);
      m.get(rid).push(i);
    }
    return m;
  })()) {
    let min = Infinity;
    for (const i of indices) {
      const v = points[i].mile;
      if (typeof v === 'number' && v < min) min = v;
    }
    routeBase.set(rid, min === Infinity ? 0 : min);
  }

  const out = new Array(points.length);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const routeId = p.route_id ?? SPINE_ROUTE;
    const route = routeById.get(routeId) || null;

    // --- section ---------------------------------------------------------
    const section = sections.length ? (sectionFor.get(i) || null) : null;

    // --- region ----------------------------------------------------------
    const regionFrom = regionFromFor(routeId);
    let region = null;
    if (regionFrom === 'state') {
      region = regionById.get(p.state) || null;
    } else if (regionFrom === 'section') {
      if (section && section.region_id) region = regionById.get(section.region_id) || null;
    } else if (regionFrom === 'route') {
      if (route && route.region_id) region = regionById.get(route.region_id) || null;
    } else {
      region = regionForByRange.get(i) || null;
    }

    // --- sec_mile --------------------------------------------------------
    // Section-local on most trails; region-local where a trail has no honest
    // section scheme (NCT, PNT, PHT); route-local on a route whose own mile
    // already starts at zero. Rounded to the stored precision so the output
    // matches the file it is checked against.
    const basis = secMileFromFor(routeId);
    const base = basis === 'region'
      ? (region ? region.mile_start : null)
      : basis === 'route'
        ? (routeBase.get(routeId) ?? 0)
        : (section ? section.mile_start : null);
    let secMile = null;
    if (p.mile !== null && p.mile !== undefined && base !== null && base !== undefined) {
      const dp = h.sec_mile_decimals ?? 1;
      const f = Math.pow(10, dp);
      secMile = Math.round((p.mile - base) * f) / f;
    }

    const derived = {
      section_id: section ? section.id : null,
      sec_mile: secMile,
    };

    // --- assemble --------------------------------------------------------
    // Key order follows the files as they ship today, so a JSON diff of the
    // round-trip is empty rather than a reordering.
    const rec = {
      id: composeId(p, derived),
      lat: p.lat,
      lon: p.lon,
    };
    if (p.mile !== undefined) rec.mile = p.mile;
    rec.region_id = region ? region.id : null;
    rec.region_name = region ? region.name : null;
    rec.section_id = section ? section.id : null;
    rec.section_name = section ? section.name : null;
    rec.sec_mile = secMile;
    rec.route_id = p.route_id ?? null;

    if (p.state !== undefined) rec.state = p.state;
    if (p.trail_elev !== undefined) rec.trail_elev = p.trail_elev;
    if (p.route_type !== undefined) rec.route_type = p.route_type;
    // Carried, not derived: legacy_id varies per point, so it cannot live in
    // meta. It moves to weather_id_remap.json in Phase 4, not here.
    if (p.legacy_id !== undefined) rec.legacy_id = p.legacy_id;

    // Only the route fields the trail actually carries. `emit` is recorded at
    // extraction time, so hydrating never *adds* a field the file did not
    // have — route_kind in particular is being introduced per trail, and
    // inventing it here would make the round trip pass against the wrong
    // target.
    if (route) {
      const emit = h.emit || {};
      if (emit.route_kind && route.kind !== undefined) rec.route_kind = route.kind;
      if (emit.alt_of && route.alt_of !== undefined && route.alt_of !== null) {
        rec.alt_of = route.alt_of;
      }
      if (emit.junction_mile && route.junction_mile !== undefined && route.junction_mile !== null) {
        rec.junction_mile = route.junction_mile;
      }
      if (emit.junction_sec_mile && route.junction_sec_mile !== undefined
          && route.junction_sec_mile !== null) {
        rec.junction_sec_mile = route.junction_sec_mile;
      }
    }

    out[i] = rec;
  }

  return out;
}

/**
 * Strip a full record down to what the canonical file stores.
 *
 * legacy_id is kept: it is per-point data with no source in meta, so dropping
 * it here would lose it rather than move it. Phase 4 relocates it to
 * weather_id_remap.json, and it leaves the record then.
 */
function slimPoint(p) {
  const out = { lat: p.lat, lon: p.lon, mile: p.mile, route_id: p.route_id };
  if (p.trail_elev !== undefined && p.trail_elev !== null) out.trail_elev = p.trail_elev;
  if (p.route_type !== undefined && p.route_type !== null) out.route_type = p.route_type;
  if (p.state !== undefined && p.state !== null) out.state = p.state;
  if (p.legacy_id !== undefined && p.legacy_id !== null) out.legacy_id = p.legacy_id;
  return out;
}

// Dual-mode on purpose: this one file is loaded as a classic <script> by
// app.html (its top-level functions become globals) and required by the
// build scripts under Node. There is no bundler in this project, so a
// second browser copy would be a second thing to keep in sync.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hydratePoints, slimPoint, makeRangeIndex, SPINE_ROUTE };
}
