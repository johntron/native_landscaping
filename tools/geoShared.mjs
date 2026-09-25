/**
 * Small geometry helpers shared by the anchor-data fetch tools
 * (fetch-nhd-creeks.mjs, fetch-osm-greenspace.mjs). Pure, no network — the
 * point of factoring these out is that "distance to a line is not distance
 * to a centroid" (nl-3hi.7.1/.7.2) is easy to get wrong twice.
 */

const EARTH_RADIUS_MI = 3958.8;

/** Great-circle distance between two lat/lng points, in miles. */
export function haversineMi(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Shortest distance in miles from a point to a line segment, both given as
 * [lng, lat]. Projects onto a local flat approximation (fine at the
 * sub-10-mile scale these tools operate at) rather than true geodesics on a
 * segment, which is not worth the complexity here.
 */
function pointToSegmentMi(point, a, b) {
  const [px, py] = point;
  const [ax, ay] = a;
  const [bx, by] = b;
  // Degrees-to-miles scale factors at this latitude, so x/y are comparable.
  const milesPerDegLat = 69.0;
  const milesPerDegLng = 69.0 * Math.cos((py * Math.PI) / 180);

  const toMiles = ([x, y]) => [(x - px) * milesPerDegLng, (y - py) * milesPerDegLat];
  const [ax2, ay2] = toMiles([ax, ay]);
  const [bx2, by2] = toMiles([bx, by]);

  const dx = bx2 - ax2;
  const dy = by2 - ay2;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : (-ax2 * dx + -ay2 * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax2 + t * dx;
  const cy = ay2 + t * dy;
  return Math.hypot(cx, cy);
}

/**
 * Shortest distance in miles from a point to an Esri-style polyline
 * (`geometry.paths`: array of paths, each an array of [lng, lat] vertices).
 */
export function pointToPolylineMi(point, paths) {
  let min = Infinity;
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i += 1) {
      const d = pointToSegmentMi(point, path[i], path[i + 1]);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Area in acres of a polygon ring given as [lng, lat] vertices, via the
 * shoelace formula on the same local flat projection as pointToSegmentMi.
 * Approximate — fine for a park-sized size floor, not for cadastral use.
 */
export function ringAreaAcres(ring) {
  if (ring.length < 3) return 0;
  const originLat = ring[0][1];
  const milesPerDegLat = 69.0;
  const milesPerDegLng = 69.0 * Math.cos((originLat * Math.PI) / 180);
  const pts = ring.map(([lng, lat]) => [lng * milesPerDegLng, lat * milesPerDegLat]);
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  const sqMiles = Math.abs(sum) / 2;
  return sqMiles * 640; // 640 acres per square mile
}

/** Round a distance to the nearest quarter mile — precision floor for a yard's habitat anchors (nl-3hi.7.1). */
export function roundDistanceMi(mi, step = 0.25) {
  return Math.round(mi / step) * step;
}
