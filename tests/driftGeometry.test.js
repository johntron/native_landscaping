import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allDrifts,
  clampGroup,
  clumpPositions,
  convexHull,
  distanceToHull,
  driftCentroid,
  driftMembers,
  driftOutline,
  driftsOfSpecies,
  driftSpacing,
  isPointInDriftOutline,
  memberRadiusFt,
  memberToRemove,
  nextMemberPosition,
  spreadPositions,
  suggestClusters,
  DEFAULT_MEMBER_RADIUS_FT,
  HULL_PADDING_FT,
  MIN_SPREAD_FACTOR,
  MIN_SUGGESTION_CLUSTER_SIZE,
  SPACING_FACTOR,
  SUGGEST_K,
} from '../src/state/driftGeometry.js';

// --- membership and grouping -------------------------------------------------

test('driftMembers returns only plants sharing a driftId, in their given order', () => {
  const plants = [
    { id: 'a', driftId: 'x' },
    { id: 'b', driftId: 'y' },
    { id: 'c', driftId: 'x' },
    { id: 'd' },
  ];
  assert.deepStrictEqual(driftMembers(plants, 'x').map((p) => p.id), ['a', 'c']);
  assert.deepStrictEqual(driftMembers(plants, 'y').map((p) => p.id), ['b']);
  assert.deepStrictEqual(driftMembers(plants, 'none'), []);
  assert.deepStrictEqual(driftMembers(plants, ''), []);
  assert.deepStrictEqual(driftMembers(null, 'x'), []);
});

test('allDrifts groups by driftId, in first-appearance order; driftsOfSpecies filters by species', () => {
  const plants = [
    { id: 'a', speciesId: 'wc', driftId: 'strip' },
    { id: 'b', speciesId: 'hh', driftId: 'carpet' },
    { id: 'c', speciesId: 'wc', driftId: 'strip' },
    { id: 'd', speciesId: 'wc' }, // not in a drift
    { id: 'e', speciesId: 'wc', driftId: 'strip-2' },
  ];
  const drifts = allDrifts(plants);
  assert.deepStrictEqual(
    drifts.map((d) => [d.driftId, d.speciesId, d.members.map((m) => m.id)]),
    [
      ['strip', 'wc', ['a', 'c']],
      ['carpet', 'hh', ['b']],
      ['strip-2', 'wc', ['e']],
    ]
  );
  assert.deepStrictEqual(
    driftsOfSpecies(plants, 'wc').map((d) => d.driftId),
    ['strip', 'strip-2']
  );
  assert.deepStrictEqual(driftsOfSpecies(plants, 'hh').map((d) => d.driftId), ['carpet']);
});

test('driftCentroid is the arithmetic mean; null for an empty drift', () => {
  assert.deepStrictEqual(driftCentroid([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 6 }]), { x: 2, y: 2 });
  assert.equal(driftCentroid([]), null);
  assert.equal(driftCentroid(null), null);
});

test('memberRadiusFt is half the width, falling back when width is missing or invalid', () => {
  assert.equal(memberRadiusFt({ width: 4 }), 2);
  assert.equal(memberRadiusFt({ width: 0 }), DEFAULT_MEMBER_RADIUS_FT);
  assert.equal(memberRadiusFt({ width: -1 }), DEFAULT_MEMBER_RADIUS_FT);
  assert.equal(memberRadiusFt({}), DEFAULT_MEMBER_RADIUS_FT);
  assert.equal(memberRadiusFt({ width: 'wide' }), DEFAULT_MEMBER_RADIUS_FT);
});

// --- spacing -----------------------------------------------------------------

test('driftSpacing is the median nearest-neighbour distance among members', () => {
  // A row of 4 at 0,1,2,4: nearest-neighbour distances are 1,1,1,2 -> median 1.
  const members = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }];
  assert.equal(driftSpacing(members, 10), 1);
});

test('driftSpacing falls back to width * SPACING_FACTOR for fewer than two members', () => {
  assert.equal(driftSpacing([], 4), 4 * SPACING_FACTOR);
  assert.equal(driftSpacing([{ x: 0, y: 0 }], 4), 4 * SPACING_FACTOR);
});

test('driftSpacing falls back when members are stacked (a median of 0 would poison every derived distance)', () => {
  const stacked = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
  assert.equal(driftSpacing(stacked, 4), 4 * SPACING_FACTOR);
});

// --- convex hull and hit-testing ---------------------------------------------

test('convexHull: a square with an interior point drops the interior point', () => {
  const hull = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
  assert.equal(hull.length, 4);
  assert.ok(!hull.some((p) => p.x === 5 && p.y === 5));
});

test('convexHull: degenerate inputs (0, 1, and collinear points)', () => {
  assert.deepStrictEqual(convexHull([]), []);
  assert.deepStrictEqual(convexHull([{ x: 3, y: 4 }]), [{ x: 3, y: 4 }]);
  const collinear = convexHull([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
  assert.deepStrictEqual(collinear, [{ x: 0, y: 0 }, { x: 2, y: 0 }]);
});

test('distanceToHull: 0 inside or on the hull, the real distance outside it, for every degenerate shape too', () => {
  assert.equal(distanceToHull({ x: 5, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), 0);
  assert.equal(distanceToHull({ x: 15, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), 5);
  // a single point
  assert.equal(distanceToHull({ x: 3, y: 4 }, [{ x: 0, y: 0 }]), 5);
  // a segment
  assert.equal(distanceToHull({ x: 5, y: 3 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 3);
  // no hull at all
  assert.equal(distanceToHull({ x: 0, y: 0 }, []), Infinity);
});

test('driftOutline pads the hull by the largest member radius plus HULL_PADDING_FT', () => {
  const members = [{ x: 0, y: 0, width: 2 }, { x: 4, y: 0, width: 6 }, { x: 2, y: 3, width: 2 }];
  const outline = driftOutline(members);
  assert.equal(outline.radiusFt, 3); // half of the widest member (6)
  assert.equal(outline.paddingFt, HULL_PADDING_FT);
  assert.equal(outline.offsetFt, 3 + HULL_PADDING_FT);
  assert.equal(outline.hull.length, 3);
});

test('isPointInDriftOutline: inside the hull, within padding of an edge, and clearly outside', () => {
  const members = [{ x: 0, y: 0, width: 2 }, { x: 10, y: 0, width: 2 }, { x: 5, y: 8, width: 2 }];
  const outline = driftOutline(members, { paddingFt: 0.5 });
  assert.equal(isPointInDriftOutline({ x: 5, y: 3 }, outline), true, 'well inside the triangle');
  assert.equal(isPointInDriftOutline({ x: -1.2, y: 0 }, outline), true, 'just outside the hull, within radius+padding');
  assert.equal(isPointInDriftOutline({ x: -3, y: 0 }, outline), false, 'well outside');
  assert.equal(isPointInDriftOutline({ x: 0, y: 0 }, { hull: [], offsetFt: 5 }), false, 'no members, no outline');
});

// --- phyllotaxis clump ---------------------------------------------------------

test('clumpPositions: 0 plants is [], 1 plant sits exactly at the centre', () => {
  assert.deepStrictEqual(clumpPositions(0, 2, { x: 3, y: 4 }, null), []);
  assert.deepStrictEqual(clumpPositions(1, 2, { x: 3, y: 4 }, null), [{ x: 3, y: 4 }]);
});

test('clumpPositions keeps the median (and minimum) nearest-neighbour distance close to the requested spacing, for a wide range of N', () => {
  // Property test, not an exact-constant test: golden-angle phyllotaxis is not
  // a perfect hexagonal lattice, so nearest-neighbour distance is consistently
  // a bit under the target rather than exactly on it. Empirically ~0.8-0.95x
  // across N; the tolerance below is deliberately generous around that.
  for (const n of [2, 3, 5, 8, 13, 21, 34, 40]) {
    const spacing = 2;
    const points = clumpPositions(n, spacing, { x: 0, y: 0 }, null);
    assert.equal(points.length, n);
    const nn = points.map((p, i) =>
      Math.min(...points.filter((_, j) => j !== i).map((q) => Math.hypot(p.x - q.x, p.y - q.y)))
    );
    const sorted = [...nn].sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    assert.ok(median > spacing * 0.7 && median < spacing * 1.05, `n=${n}: median nn ${median} not close to spacing ${spacing}`);
    assert.ok(Math.min(...nn) > spacing * 0.5, `n=${n}: some pair much closer than spacing (min nn ${Math.min(...nn)})`);
  }
});

test('clumpPositions is deterministic: the same inputs always give the same layout', () => {
  const a = clumpPositions(12, 1.5, { x: 5, y: 5 }, null);
  const b = clumpPositions(12, 1.5, { x: 5, y: 5 }, null);
  assert.deepStrictEqual(a, b);
});

test('clumpPositions translates the whole clump to fit bounds, keeping its shape (never clamping points individually)', () => {
  const bounds = { x: { min: 0, max: 5 }, y: { min: 0, max: 5 } };
  const raw = clumpPositions(6, 1, { x: -2, y: -2 }, null);
  const clamped = clumpPositions(6, 1, { x: -2, y: -2 }, bounds);
  assert.equal(clamped.length, raw.length);
  clamped.forEach((p) => {
    assert.ok(p.x >= bounds.x.min - 1e-9 && p.x <= bounds.x.max + 1e-9);
    assert.ok(p.y >= bounds.y.min - 1e-9 && p.y <= bounds.y.max + 1e-9);
  });
  // Shape preserved: pairwise distances are identical to the unclamped layout.
  for (let i = 0; i < raw.length; i++) {
    for (let j = i + 1; j < raw.length; j++) {
      const rawDist = Math.hypot(raw[i].x - raw[j].x, raw[i].y - raw[j].y);
      const clampedDist = Math.hypot(clamped[i].x - clamped[j].x, clamped[i].y - clamped[j].y);
      assert.ok(Math.abs(rawDist - clampedDist) < 1e-9);
    }
  }
});

test('clampGroup pins the low edge, best-effort, when a group is wider than the bounds', () => {
  const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
  const shifted = clampGroup(points, { x: { min: 0, max: 5 }, y: { min: 0, max: 5 } });
  assert.equal(shifted[0].x, 0);
  assert.equal(shifted[1].x, 20); // overhangs; a 20 ft-wide group cannot fit a 5 ft yard
});

test('clampGroup preserves extra fields (like an id) on each point', () => {
  const points = [{ id: 'a', x: -1, y: -1 }];
  const shifted = clampGroup(points, { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } });
  assert.deepStrictEqual(shifted, [{ id: 'a', x: 0, y: 0 }]);
});

// --- "+" next member position --------------------------------------------------

test('nextMemberPosition: a single member grows in a fixed default direction, at the given spacing', () => {
  const result = nextMemberPosition([{ x: 5, y: 5 }], 3, null);
  assert.equal(result.reason, null);
  assert.equal(Math.hypot(result.position.x - 5, result.position.y - 5), 3);
});

test('nextMemberPosition: the new point is never closer than spacing to any existing member', () => {
  // Three members clustered together (small gaps between them) and one far
  // off to the north, leaving one obviously largest gap on the far side.
  const members = [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 10 }];
  const spacing = 2;
  const { position, reason } = nextMemberPosition(members, spacing, null);
  assert.equal(reason, null);
  const distances = members.map((m) => Math.hypot(position.x - m.x, position.y - m.y));
  assert.ok(distances.every((d) => d >= spacing - 1e-9), 'never closer than spacing to any existing member');
});

test('nextMemberPosition: tangent to spacing from whichever member actually constrains the chosen direction', () => {
  // An equilateral triangle has three equal 120-degree gaps: (0,0),(2,0),(1,sqrt3).
  // Each gap's bisector points straight through the midpoint of the two
  // members it sits between, at exactly `spacing` from each of them.
  const members = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: Math.sqrt(3) }];
  const spacing = 2;
  const { position, reason } = nextMemberPosition(members, spacing, null);
  assert.equal(reason, null);
  const distances = members.map((m) => Math.hypot(position.x - m.x, position.y - m.y));
  const sorted = [...distances].sort((a, b) => a - b);
  assert.ok(Math.abs(sorted[0] - spacing) < 1e-6, `nearest member should be exactly spacing away, got ${sorted[0]}`);
  assert.ok(Math.abs(sorted[1] - spacing) < 1e-6, `two members tie for nearest on this symmetric case, got ${sorted[1]}`);
});

test('nextMemberPosition tries the next-biggest gap when the biggest one is out of bounds', () => {
  // The same equilateral triangle: three equal candidate points, each just
  // outside the triangle through one of its edges' midpoints.
  const members = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: Math.sqrt(3) }];
  const spacing = 2;
  const unbounded = nextMemberPosition(members, spacing, null);
  assert.ok(unbounded.position.y < 0, 'sanity: the largest gap is the one below the triangle\'s base');
  // Bounds generous enough for either "side" candidate but excluding the "below" one.
  const bounds = { x: { min: -1, max: 3 }, y: { min: -1, max: 3 } };
  const bounded = nextMemberPosition(members, spacing, bounds);
  assert.equal(bounded.reason, null);
  assert.notDeepStrictEqual(bounded.position, unbounded.position);
  assert.ok(bounded.position.y >= bounds.y.min && bounded.position.y <= bounds.y.max);
  const distances = members.map((m) => Math.hypot(bounded.position.x - m.x, bounded.position.y - m.y));
  assert.ok(distances.every((d) => d >= spacing - 1e-9));
});

test('nextMemberPosition returns a reason instead of a position when nothing fits inside bounds', () => {
  const members = [{ x: 5, y: 5 }];
  const tight = { x: { min: 4.9, max: 5.1 }, y: { min: 4.9, max: 5.1 } };
  const result = nextMemberPosition(members, 3, tight);
  assert.equal(result.position, null);
  assert.match(result.reason, /no room/);
});

test('nextMemberPosition on an empty drift', () => {
  const result = nextMemberPosition([], 2, null);
  assert.equal(result.position, null);
  assert.match(result.reason, /no members/);
});

// --- "-" which member to remove ------------------------------------------------

test('memberToRemove picks the planned member farthest from the centroid', () => {
  // centroid = ((0+10-100)/3, 0) = (-30, 0): the planted outlier pulls the
  // centroid, but only the two planned members are eligible for removal, and
  // between them 'far' (distance 40) beats 'near' (distance 30).
  const members = [
    { id: 'near', x: 0, y: 0 },
    { id: 'far', x: 10, y: 0 },
    { id: 'planted', x: -100, y: 0, status: 'planted' },
  ];
  const { member, reason } = memberToRemove(members);
  assert.equal(reason, null);
  assert.equal(member.id, 'far');
});

test('memberToRemove refuses when only planted members remain, and on an empty drift', () => {
  assert.match(memberToRemove([{ id: 'a', x: 0, y: 0, status: 'planted' }]).reason, /only planted/);
  assert.equal(memberToRemove([]).member, null);
  assert.match(memberToRemove([]).reason, /no members/);
});

test('memberToRemove breaks a distance tie by the smaller id', () => {
  const members = [
    { id: 'b', x: 2, y: 0 },
    { id: 'a', x: -2, y: 0 },
  ];
  assert.equal(memberToRemove(members).member.id, 'a');
});

// --- spread ---------------------------------------------------------------------

test('spreadPositions scales every member about the centroid by the same applied factor', () => {
  const members = [{ id: 'a', x: 4, y: 5 }, { id: 'b', x: 6, y: 5 }, { id: 'c', x: 5, y: 6 }];
  const { positions, appliedFactor } = spreadPositions(members, 2, null);
  assert.equal(appliedFactor, 2);
  assert.deepStrictEqual(positions.find((p) => p.id === 'a'), { id: 'a', x: 3, y: 4 + 2 / 3 });
});

test('spreadPositions clamps the factor (not individual members) so the whole group stays in bounds', () => {
  const members = [{ id: 'a', x: 4, y: 5 }, { id: 'b', x: 6, y: 5 }];
  // centroid x=5; b is 1 ft from it and the wall is 1.5 ft from the centroid,
  // so the largest safe factor is 1.5 (a's own wall is 5 ft away: not binding).
  const bounds = { x: { min: 0, max: 6.5 }, y: { min: 0, max: 10 } };
  const { positions, appliedFactor } = spreadPositions(members, 10, bounds);
  assert.equal(appliedFactor, 1.5);
  assert.equal(positions.find((p) => p.id === 'a').x, 3.5);
  assert.equal(positions.find((p) => p.id === 'b').x, 6.5);
});

test('spreadPositions never lets the applied factor reach zero (never squashes the drift to a point)', () => {
  const members = [{ id: 'a', x: 0, y: 5 }, { id: 'b', x: 10, y: 5 }];
  const bounds = { x: { min: 4.99, max: 5.01 }, y: { min: 0, max: 10 } }; // almost no room at all
  const { appliedFactor } = spreadPositions(members, 5, bounds);
  assert.ok(appliedFactor >= MIN_SPREAD_FACTOR);
});

test('spreadPositions on an empty or invalid input changes nothing', () => {
  assert.deepStrictEqual(spreadPositions([], 2, null), { positions: [], appliedFactor: 1 });
  const members = [{ id: 'a', x: 1, y: 1 }];
  assert.deepStrictEqual(spreadPositions(members, NaN, null).positions, [{ id: 'a', x: 1, y: 1 }]);
});

// --- suggestion clusters ----------------------------------------------------------

test('suggestClusters links same-species plants within k * width, ignores other species and plants already in a drift', () => {
  const plants = [
    { id: 'a', speciesId: 'wc', x: 0, y: 0, width: 3 },
    { id: 'b', speciesId: 'wc', x: 2, y: 0, width: 3 }, // within 1.25*3=3.75 of a
    { id: 'c', speciesId: 'wc', x: 20, y: 20, width: 3 }, // far away: its own (too-small) cluster
    { id: 'd', speciesId: 'hh', x: 0.5, y: 0.5, width: 3 }, // different species, would be close by distance alone
    { id: 'e', speciesId: 'wc', x: 1, y: 0.5, width: 3, driftId: 'already' }, // already in a drift: excluded
  ];
  const clusters = suggestClusters(plants);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].speciesId, 'wc');
  assert.deepStrictEqual(clusters[0].members.map((m) => m.id), ['a', 'b']);
});

test('suggestClusters requires at least MIN_SUGGESTION_CLUSTER_SIZE members', () => {
  const plants = [{ id: 'a', speciesId: 'wc', x: 0, y: 0, width: 3 }];
  assert.equal(suggestClusters(plants).length, 0);
  assert.ok(MIN_SUGGESTION_CLUSTER_SIZE >= 2);
});

test('suggestClusters order is deterministic: by each cluster\'s first member\'s original position', () => {
  const plants = [
    { id: 'early-1', speciesId: 'wc', x: 0, y: 0, width: 3 },
    { id: 'late-1', speciesId: 'hh', x: 100, y: 100, width: 2 },
    { id: 'early-2', speciesId: 'wc', x: 1, y: 0, width: 3 },
    { id: 'late-2', speciesId: 'hh', x: 101, y: 100, width: 2 },
  ];
  const clusters = suggestClusters(plants);
  assert.deepStrictEqual(clusters.map((c) => c.speciesId), ['wc', 'hh']);
});

// --- the two judgement constants agree with each other -----------------------

test('cross-check: a clump generated at the default spacing comes back as exactly one suggestion cluster', () => {
  const width = 3;
  const spacing = width * SPACING_FACTOR;
  for (const n of [2, 5, 10, 20]) {
    const points = clumpPositions(n, spacing, { x: 10, y: 10 }, null);
    const plants = points.map((p, i) => ({ id: `p${i}`, speciesId: 'sp', x: p.x, y: p.y, width }));
    const clusters = suggestClusters(plants);
    assert.equal(clusters.length, 1, `n=${n}`);
    assert.equal(clusters[0].members.length, n, `n=${n}`);
  }
});
