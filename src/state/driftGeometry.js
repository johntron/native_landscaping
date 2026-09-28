/**
 * Pure geometry for drifts (nl-o47.6): a drift is a label on plants
 * (`driftId`, src/data/driftId.js), never a stored shape, so everything here
 * is DERIVED from a drift's current members and recomputed every time. No
 * DOM, no fetch; every function takes plain plant/placement-shaped objects
 * and plain points, and returns plain data.
 *
 * `bounds` throughout is the shape src/render/yardBounds.js's
 * resolveYardBounds returns: `{ x: { min, max }, y: { min, max } }`, or
 * null/undefined for "no declared yard, don't clamp".
 *
 * Every authored constant below is OUR JUDGEMENT, not a sourced fact
 * (AGENTS.md "Label judgement calls"), picked by measuring
 * projects/backyard/planting_layout.csv's already-planted masses (never read
 * from a test — docs/testing.md) rather than guessed: horseherb (width 3 ft)
 * and winecup (width 3 ft) sit at a median nearest-neighbour distance of
 * roughly 0.53-0.57x their width, so SPACING_FACTOR = 0.5 lands close to how
 * the seed yard's own groundcovers were actually planted. SUGGEST_K = 1.25
 * was chosen by running single-linkage clustering over that same yard's
 * horseherb/winecup/Carex blanda masses at a few candidate values: 1.25
 * recognised the visually separate sub-masses (e.g. two stray horseherb
 * plants well off the main bed came back as their own small cluster) without
 * either fragmenting into singletons or fusing everything within a species
 * into one implausible yard-spanning cluster.
 */
import { lifecycleOf } from '../data/plantLifecycle.js';

/** Default spacing factor for a drift with fewer than two members to measure a real spacing from. */
export const SPACING_FACTOR = 0.5;

/** How far outside a drift's member discs its drawn/hit-tested outline extends, in feet. */
export const HULL_PADDING_FT = 0.5;

/** A member with no usable width still gets an outline and a hit target, in feet of radius. */
export const DEFAULT_MEMBER_RADIUS_FT = 0.5;

/** Single-linkage suggestion clustering links two same-species plants within this many widths. */
export const SUGGEST_K = 1.25;

/** A suggested cluster has to be at least this many plants to be worth proposing as a drift. */
export const MIN_SUGGESTION_CLUSTER_SIZE = 2;

/** Never scale a drift down to a single collapsed point. */
export const MIN_SPREAD_FACTOR = 0.05;

/**
 * Vogel/sunflower phyllotaxis spiral constant. The starting point is derived
 * so that at spacing `s` a clump's points come out close to a hexagonal
 * packing (each point's area, pi*c^2, matches a hexagonal lattice's area per
 * point, (sqrt(3)/2)*s^2):
 *   pi*c^2 = (sqrt(3)/2)*s^2  =>  c = s * sqrt(sqrt(3) / (2*pi)) =~ 0.525*s
 * A golden-angle spiral is not actually a hexagonal lattice, though, and
 * measuring clumpPositions' own output (median nearest-neighbour distance
 * over N = 2..100 points) showed that theoretical c realises a median spacing
 * of only about 0.87-0.88x the target, consistently across N. PHYLLOTAXIS_C
 * is that theoretical value scaled up by the measured correction (1/0.875
 * =~ 1.143) so the clump's own measured spacing lands within about 1% of
 * what was asked for; tests/driftGeometry.test.js checks the property this
 * constant exists to satisfy, not the constant's value itself. See
 * clumpPositions, which multiplies this by spacingFt and sqrt(i + 0.5).
 */
const PHYLLOTAXIS_C = 0.6;

/** The golden angle, in radians: successive points never re-align radially. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * A plant's footprint radius in feet, for hull padding and spacing disc math.
 * @param {{ width?: number }} plant
 * @returns {number}
 */
export function memberRadiusFt(plant) {
  const width = Number(plant?.width);
  return Number.isFinite(width) && width > 0 ? width / 2 : DEFAULT_MEMBER_RADIUS_FT;
}

/**
 * The members of one drift, in the array's own order.
 * @param {Array<{driftId?: string}>} plants
 * @param {string} driftId
 * @returns {Array<object>}
 */
export function driftMembers(plants, driftId) {
  if (!driftId || !Array.isArray(plants)) return [];
  return plants.filter((plant) => plant?.driftId === driftId);
}

/**
 * Every drift among `plants`, grouped by driftId (nl-o47.6: one species per
 * drift is a convention the UI keeps, not something this groups by, so a
 * drift here is simply "every plant sharing one driftId").
 * @param {Array<object>} plants
 * @returns {Array<{ driftId: string, speciesId: string|null, members: object[] }>}
 *   in the order each driftId first appears in `plants`
 */
export function allDrifts(plants) {
  if (!Array.isArray(plants)) return [];
  const order = [];
  const byId = new Map();
  plants.forEach((plant) => {
    const driftId = plant?.driftId;
    if (!driftId) return;
    if (!byId.has(driftId)) {
      byId.set(driftId, { driftId, speciesId: plant.speciesId ?? null, members: [] });
      order.push(driftId);
    }
    byId.get(driftId).members.push(plant);
  });
  return order.map((id) => byId.get(id));
}

/**
 * The drifts of one species, grouped by driftId.
 * @param {Array<object>} plants
 * @param {string} speciesId
 * @returns {Array<{ driftId: string, speciesId: string, members: object[] }>}
 */
export function driftsOfSpecies(plants, speciesId) {
  return allDrifts(plants).filter((drift) => drift.speciesId === speciesId);
}

/**
 * The centre of a drift's members, in yard feet.
 * @param {Array<{x: number, y: number}>} members
 * @returns {{x: number, y: number}|null} null for an empty drift
 */
export function driftCentroid(members) {
  if (!Array.isArray(members) || !members.length) return null;
  const sum = members.reduce((acc, m) => ({ x: acc.x + Number(m.x), y: acc.y + Number(m.y) }), { x: 0, y: 0 });
  return { x: sum.x / members.length, y: sum.y / members.length };
}

/**
 * A drift's spacing: the median nearest-neighbour distance among its members.
 * Falls back to `speciesWidthFt * SPACING_FACTOR` for a drift with fewer than
 * two members (nothing to measure), and for one whose members are stacked on
 * each other (a median of 0, which would otherwise poison every distance
 * that is derived from it).
 * @param {Array<{x: number, y: number}>} members
 * @param {number} speciesWidthFt
 * @returns {number}
 */
export function driftSpacing(members, speciesWidthFt) {
  const fallback = (Number(speciesWidthFt) || DEFAULT_MEMBER_RADIUS_FT * 2) * SPACING_FACTOR;
  if (!Array.isArray(members) || members.length < 2) return fallback;
  const nearest = members.map((m, i) => {
    let best = Infinity;
    members.forEach((other, j) => {
      if (i === j) return;
      best = Math.min(best, Math.hypot(m.x - other.x, m.y - other.y));
    });
    return best;
  });
  const median = medianOf(nearest);
  return median > 0 ? median : fallback;
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The convex hull of a set of points (monotone chain / Andrew's algorithm),
 * counter-clockwise, with no repeated closing point. Degenerate inputs are
 * kept rather than thrown on, since a drift may have 0, 1, or 2 members:
 *   0 points -> []
 *   1 point  -> [that point]
 *   collinear points (2+ members in a line) -> the two endpoints
 * @param {Array<{x: number, y: number}>} points
 * @returns {Array<{x: number, y: number}>}
 */
export function convexHull(points) {
  const pts = (points || [])
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length <= 1) return pts;
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const buildHalf = (points_) => {
    const half = [];
    for (const p of points_) {
      while (half.length >= 2 && cross(half[half.length - 2], half[half.length - 1], p) <= 0) {
        half.pop();
      }
      half.push(p);
    }
    half.pop();
    return half;
  };
  const lower = buildHalf(sorted);
  const upper = buildHalf([...sorted].reverse());
  const hull = [...lower, ...upper];
  // A single point, or every point collinear, collapses buildHalf to nothing
  // useful on one side; fall back to the two extreme points (a segment).
  if (hull.length < 2 && sorted.length >= 2) {
    return [sorted[0], sorted[sorted.length - 1]];
  }
  return hull;
}

/**
 * Shortest distance from `point` to the closed polygon `hull` (0 when the
 * point is inside or on it). Degenerate hulls are handled explicitly: a
 * single point is a point distance, two points are a segment distance.
 * @param {{x: number, y: number}} point
 * @param {Array<{x: number, y: number}>} hull
 * @returns {number}
 */
export function distanceToHull(point, hull) {
  if (!Array.isArray(hull) || hull.length === 0) return Infinity;
  if (hull.length === 1) return Math.hypot(point.x - hull[0].x, point.y - hull[0].y);
  if (hull.length === 2) return distanceToSegment(point, hull[0], hull[1]);
  if (pointInPolygon(point, hull)) return 0;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    best = Math.min(best, distanceToSegment(point, a, b));
  }
  return best;
}

function distanceToSegment(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * abx + (point.y - a.y) * aby) / lenSq, 0, 1);
  const projX = a.x + t * abx;
  const projY = a.y + t * aby;
  return Math.hypot(point.x - projX, point.y - projY);
}

function pointInPolygon(point, polygon) {
  // Standard ray-casting test; a hull from convexHull is already CCW with no
  // repeated closing vertex.
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > point.y !== b.y > point.y;
    if (crosses) {
      const atX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < atX) inside = !inside;
    }
  }
  return inside;
}

/**
 * A drift's outline for drawing and hit-testing: the convex hull of its
 * members' centres, plus how far outward it is padded (each member's own
 * radius, at most, plus HULL_PADDING_FT). Approximates the true hull of
 * member discs (the bead's own call: "hull of member centres, offset outward
 * by each member's radius + padding is fine") rather than a per-vertex
 * Minkowski sum, which the one-species-per-drift rule makes unnecessary in
 * practice: every member shares the species' width, so every member's radius
 * already agrees.
 * @param {Array<{x: number, y: number, width?: number}>} members
 * @param {{ paddingFt?: number }} [options]
 * @returns {{ hull: Array<{x:number,y:number}>, radiusFt: number, paddingFt: number, offsetFt: number }}
 */
export function driftOutline(members, { paddingFt = HULL_PADDING_FT } = {}) {
  const list = Array.isArray(members) ? members : [];
  const hull = convexHull(list);
  const radiusFt = list.reduce((max, m) => Math.max(max, memberRadiusFt(m)), 0);
  return { hull, radiusFt, paddingFt, offsetFt: radiusFt + paddingFt };
}

/**
 * Whether `point` falls inside a drift's outline: its distance to the hull of
 * member centres is within the outline's offset (radius + padding).
 * @param {{x: number, y: number}} point
 * @param {{ hull: Array<{x:number,y:number}>, offsetFt: number }} outline from driftOutline
 * @returns {boolean}
 */
export function isPointInDriftOutline(point, outline) {
  if (!outline || !Array.isArray(outline.hull) || !outline.hull.length) return false;
  return distanceToHull(point, outline.hull) <= outline.offsetFt;
}

/**
 * How many points sample the circle drawn around each hull vertex when
 * building driftOutlinePolygon's padded shape — a judgement call: enough to
 * read as round once smoothed (buildSmoothPath, src/render/pathUtils.js),
 * cheap enough to compute for every render.
 */
export const OUTLINE_SAMPLES_PER_VERTEX = 12;

/**
 * The actual polygon to DRAW for a drift's outline (nl-o47.6.2): the
 * Minkowski sum of the member-centre hull with a disk of the outline's own
 * offset (radius + padding), approximated by ringing every hull vertex with
 * OUTLINE_SAMPLES_PER_VERTEX points at that radius and re-hulling the lot.
 * This is deliberately the same shape isPointInDriftOutline's own
 * distanceToHull(point, hull) <= offsetFt test describes — a point exactly
 * offsetFt from some hull vertex is exactly what that test accepts — so the
 * drawn outline and the hit-tested one agree everywhere: along a long
 * straight bed edge (where a plain radial push of the hull's own vertices
 * would fall short of the padding at the edge's midpoint), and for the
 * degenerate 1- or 2-member hulls (a point or a segment) a real drift edit
 * routinely produces, which need no special case here because a circle
 * (or a stadium) is exactly what ringing 1 or 2 vertices already yields.
 * @param {Array<{x: number, y: number, width?: number}>} members
 * @param {{ paddingFt?: number }} [options]
 * @returns {Array<{x:number,y:number}>} empty for an empty drift
 */
export function driftOutlinePolygon(members, options = {}) {
  const { hull, offsetFt } = driftOutline(members, options);
  if (!hull.length) return [];
  const samples = [];
  hull.forEach((vertex) => {
    for (let i = 0; i < OUTLINE_SAMPLES_PER_VERTEX; i += 1) {
      const angle = (2 * Math.PI * i) / OUTLINE_SAMPLES_PER_VERTEX;
      samples.push({ x: vertex.x + offsetFt * Math.cos(angle), y: vertex.y + offsetFt * Math.sin(angle) });
    }
  });
  return convexHull(samples);
}

/**
 * Positions for a fresh clump of `n` plants at roughly `spacingFt` apart,
 * centred on `centre`: Vogel/sunflower phyllotaxis (the golden angle), so the
 * clump reads as an organic mass rather than a grid. Point i sits at
 * angle i*GOLDEN_ANGLE and radius PHYLLOTAXIS_C*spacingFt*sqrt(i + 0.5); the
 * + 0.5 (rather than Vogel's usual sqrt(i)) keeps the first two points about
 * spacingFt apart instead of about half that — starting the spiral one
 * half-step out avoids bunching its own centre.
 *
 * The whole clump is translated (never each point clamped on its own, which
 * would flatten the pattern's edge against the boundary) to fit `bounds`; a
 * clump wider than the yard on some axis is shifted to overhang as little as
 * possible rather than distorted to fit.
 * @param {number} n
 * @param {number} spacingFt
 * @param {{x: number, y: number}} centre
 * @param {{x:{min,max},y:{min,max}}|null} [bounds]
 * @returns {Array<{x: number, y: number}>}
 */
export function clumpPositions(n, spacingFt, centre, bounds = null) {
  const count = Math.max(0, Math.trunc(n) || 0);
  if (count === 0) return [];
  const spacing = Number(spacingFt) > 0 ? Number(spacingFt) : DEFAULT_MEMBER_RADIUS_FT * 2 * SPACING_FACTOR;
  const cx = Number(centre?.x) || 0;
  const cy = Number(centre?.y) || 0;
  if (count === 1) return clampGroup([{ x: cx, y: cy }], bounds);
  const points = [];
  for (let i = 0; i < count; i++) {
    const radius = PHYLLOTAXIS_C * spacing * Math.sqrt(i + 0.5);
    const angle = i * GOLDEN_ANGLE;
    points.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  }
  return clampGroup(points, bounds);
}

/**
 * Translate every point by the same amount so the group's bounding box fits
 * inside `bounds`, keeping the group's shape. Best effort: a group wider or
 * taller than `bounds` overhangs as little as possible rather than being
 * distorted. `null`/undefined bounds means "no declared yard": unclamped.
 * @param {Array<{x: number, y: number}>} points
 * @param {{x:{min,max},y:{min,max}}|null} bounds
 * @returns {Array<{x: number, y: number}>}
 */
export function clampGroup(points, bounds) {
  if (!Array.isArray(points) || !points.length || !bounds) return points;
  const axisShift = (values, { min, max }) => {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    if (hi - lo > max - min) return min - lo; // wider than the yard: pin the low edge
    if (lo < min) return min - lo;
    if (hi > max) return max - hi;
    return 0;
  };
  const dx = axisShift(points.map((p) => p.x), bounds.x);
  const dy = axisShift(points.map((p) => p.y), bounds.y);
  if (dx === 0 && dy === 0) return points;
  // Spread first so any other field a caller's point carries (an id, say) rides along.
  return points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
}

/**
 * Where "+" places a new member: on the drift's edge, in the biggest angular
 * gap between existing members (seen from the centroid), at the drift's own
 * spacing from its nearest neighbour there.
 *
 * For each candidate gap (largest first), the direction `u` bisects it, and
 * the point c + t*u is pushed out along `u` until it clears every member
 * whose perpendicular distance to that ray is under `spacingFt`: for such a
 * member m, the point on the ray at distance `t = (m-c)-u + sqrt(spacingFt^2
 * - d_perp^2)` is exactly `spacingFt` from m (Pythagoras on the right
 * triangle m makes with the ray); taking the largest such t clears every
 * member at once, one arithmetic step, no search. A single member has no
 * angular gap to speak of, so a fixed direction (+x) is used.
 *
 * Gaps are tried largest-first, and a gap whose point would land outside
 * `bounds` is skipped for the next one, so the result is always inside the
 * yard when any placement is possible at all. Ties (equal gap size) break by
 * the smaller of the two bounding angles, for a deterministic result.
 * @param {Array<{x:number,y:number}>} members
 * @param {number} spacingFt
 * @param {{x:{min,max},y:{min,max}}|null} [bounds]
 * @returns {{ position: {x:number,y:number}, reason: null } | { position: null, reason: string }}
 */
export function nextMemberPosition(members, spacingFt, bounds = null) {
  if (!Array.isArray(members) || !members.length) {
    return { position: null, reason: 'the drift has no members to grow from' };
  }
  const spacing = Number(spacingFt) > 0 ? Number(spacingFt) : DEFAULT_MEMBER_RADIUS_FT * 2 * SPACING_FACTOR;
  const centroid = driftCentroid(members);

  if (members.length === 1) {
    // No angular gap to speak of with only one member: try the four cardinal
    // directions, in a fixed order, before giving up — a member sitting
    // within spacing of one fence should still find room on another side,
    // rather than "no room" the instant its one fixed direction is blocked.
    for (const dir of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }]) {
      const point = { x: centroid.x + spacing * dir.x, y: centroid.y + spacing * dir.y };
      if (withinBounds(point, bounds)) return { position: point, reason: null };
    }
    return { position: null, reason: 'no room for another member inside the yard' };
  }

  const angles = members
    .map((m) => Math.atan2(m.y - centroid.y, m.x - centroid.x))
    .sort((a, b) => a - b);
  const gaps = angles.map((angle, i) => {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
    return { from: angle, size: next - angle };
  });
  gaps.sort((a, b) => b.size - a.size || a.from - b.from);

  for (const gap of gaps) {
    const direction = gap.from + gap.size / 2;
    const u = { x: Math.cos(direction), y: Math.sin(direction) };
    let t = spacing;
    members.forEach((m) => {
      const vx = m.x - centroid.x;
      const vy = m.y - centroid.y;
      const parallel = vx * u.x + vy * u.y;
      const perp = Math.hypot(vx - parallel * u.x, vy - parallel * u.y);
      if (perp < spacing) {
        t = Math.max(t, parallel + Math.sqrt(spacing * spacing - perp * perp));
      }
    });
    const point = { x: centroid.x + t * u.x, y: centroid.y + t * u.y };
    // `point` is guaranteed >= spacing from every member (that's what `t` was
    // chosen for), but in a wide gap (a ring of members with one open side,
    // say) it can land much farther than spacing from its nearest one. Pull
    // it in along the line from that member, to "at the drift's spacing",
    // not just "at least" it — but only if doing so still respects spacing to
    // every OTHER member; otherwise the original, farther point is used.
    const pulled = pullTowardNearestMember(point, members, spacing);
    for (const candidate of pulled ? [pulled, point] : [point]) {
      if (withinBounds(candidate, bounds)) return { position: candidate, reason: null };
    }
  }
  return { position: null, reason: 'no room for another member inside the yard' };
}

/**
 * `point`, pulled along the line from its nearest member (ties broken by id)
 * until it is exactly `spacing` away — or null if it already is (nothing to
 * pull) or pulling it would land closer than `spacing` to some OTHER member.
 */
function pullTowardNearestMember(point, members, spacing) {
  let nearest = null;
  let nearestDist = Infinity;
  members.forEach((m) => {
    const d = Math.hypot(point.x - m.x, point.y - m.y);
    if (d < nearestDist - 1e-9 || (Math.abs(d - nearestDist) <= 1e-9 && (!nearest || String(m.id) < String(nearest.id)))) {
      nearest = m;
      nearestDist = d;
    }
  });
  if (!(nearestDist > spacing) || nearestDist === 0) return null;
  const pulled = {
    x: nearest.x + (spacing * (point.x - nearest.x)) / nearestDist,
    y: nearest.y + (spacing * (point.y - nearest.y)) / nearestDist,
  };
  const EPSILON = 1e-6;
  const respectsEveryMember = members.every((m) => Math.hypot(pulled.x - m.x, pulled.y - m.y) >= spacing - EPSILON);
  return respectsEveryMember ? pulled : null;
}

function withinBounds(point, bounds) {
  if (!bounds) return true;
  return (
    point.x >= bounds.x.min && point.x <= bounds.x.max && point.y >= bounds.y.min && point.y <= bounds.y.max
  );
}

/**
 * Which member "-" removes: the PLANNED member farthest from the centroid
 * (an owner's-choice rule — a planted member is never removed automatically).
 * Ties break by id, ascending, for a deterministic result.
 * @param {Array<object>} members full plant objects (lifecycleOf reads status)
 * @returns {{ member: object, reason: null } | { member: null, reason: string }}
 */
export function memberToRemove(members) {
  if (!Array.isArray(members) || !members.length) {
    return { member: null, reason: 'the drift has no members' };
  }
  const centroid = driftCentroid(members);
  const planned = members.filter((m) => lifecycleOf(m).status !== 'planted');
  if (!planned.length) {
    return { member: null, reason: 'only planted members remain; remove one by hand first' };
  }
  const distance = (m) => Math.hypot(m.x - centroid.x, m.y - centroid.y);
  const farthest = planned.reduce((best, m) => {
    if (!best) return m;
    const d = distance(m);
    const bestD = distance(best);
    if (d > bestD) return m;
    if (d === bestD && String(m.id) < String(best.id)) return m;
    return best;
  }, null);
  return { member: farthest, reason: null };
}

/**
 * Scale a drift's members about their centroid by `factor` (>1 spreads out,
 * <1 draws in), clamped as a GROUP so the shape survives: every member is
 * scaled by the same applied factor, chosen as the largest value at most
 * `factor` that keeps every member inside `bounds`. A member exactly at the
 * centroid imposes no constraint (it does not move). Never lets the applied
 * factor reach 0 (which would collapse every member onto one point).
 * @param {Array<{id: string, x: number, y: number}>} members
 * @param {number} factor
 * @param {{x:{min,max},y:{min,max}}|null} [bounds]
 * @returns {{ positions: Array<{id: string, x: number, y: number}>, appliedFactor: number }}
 */
export function spreadPositions(members, factor, bounds = null) {
  const requested = Number(factor);
  const list = Array.isArray(members) ? members : [];
  if (!list.length || !Number.isFinite(requested)) {
    return { positions: list.map((m) => ({ id: m.id, x: m.x, y: m.y })), appliedFactor: 1 };
  }
  const centroid = driftCentroid(list);
  let applied = Math.max(requested, MIN_SPREAD_FACTOR);
  if (bounds) {
    list.forEach((m) => {
      ['x', 'y'].forEach((axis) => {
        const delta = m[axis] - centroid[axis];
        if (delta === 0) return;
        const { min, max } = bounds[axis];
        const boundA = (min - centroid[axis]) / delta;
        const boundB = (max - centroid[axis]) / delta;
        const upper = Math.max(boundA, boundB);
        if (upper < applied) applied = Math.max(upper, MIN_SPREAD_FACTOR);
      });
    });
  }
  const positions = list.map((m) => ({
    id: m.id,
    x: centroid.x + applied * (m.x - centroid.x),
    y: centroid.y + applied * (m.y - centroid.y),
  }));
  return { positions, appliedFactor: applied };
}

/**
 * Single-linkage clusters of same-species plants that are NOT already in a
 * drift, for "suggest drifts from an existing yard": two plants link when
 * they are within SUGGEST_K times the species' width of each other, and a
 * cluster is proposed only once it has at least MIN_SUGGESTION_CLUSTER_SIZE
 * members. Order is deterministic: clusters come back in the order their
 * first (lowest-index) member appears in `plants`, and each cluster's own
 * members keep that same relative order.
 * @param {Array<{id: string, speciesId: string, x: number, y: number, width?: number, driftId?: string}>} plants
 * @param {{ k?: number, minSize?: number }} [options]
 * @returns {Array<{ speciesId: string, members: object[] }>}
 */
export function suggestClusters(plants, { k = SUGGEST_K, minSize = MIN_SUGGESTION_CLUSTER_SIZE } = {}) {
  if (!Array.isArray(plants)) return [];
  const candidates = plants
    .map((plant, index) => ({ plant, index }))
    .filter(({ plant }) => plant?.speciesId && !plant.driftId);

  const bySpecies = new Map();
  candidates.forEach((entry) => {
    const list = bySpecies.get(entry.plant.speciesId) || [];
    list.push(entry);
    bySpecies.set(entry.plant.speciesId, list);
  });

  const clusters = [];
  bySpecies.forEach((entries, speciesId) => {
    const width = entries.reduce((max, e) => Math.max(max, memberRadiusFt(e.plant) * 2), 0);
    const maxDist = k * width;
    const parent = entries.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (i, j) => {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    };
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const d = Math.hypot(entries[i].plant.x - entries[j].plant.x, entries[i].plant.y - entries[j].plant.y);
        if (d <= maxDist) union(i, j);
      }
    }
    const groups = new Map();
    entries.forEach((entry, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(entry);
    });
    groups.forEach((group) => {
      if (group.length < minSize) return;
      clusters.push({
        speciesId,
        firstIndex: Math.min(...group.map((e) => e.index)),
        members: group.sort((a, b) => a.index - b.index).map((e) => e.plant),
      });
    });
  });

  return clusters.sort((a, b) => a.firstIndex - b.firstIndex).map(({ speciesId, members }) => ({ speciesId, members }));
}
