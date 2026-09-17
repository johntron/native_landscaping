import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMi,
  pointToPolylineMi,
  ringAreaAcres,
  roundDistanceMi,
} from '../tools/geoShared.mjs';

test('haversineMi is ~0 for the same point and positive otherwise', () => {
  assert.ok(haversineMi(32.81, -96.79, 32.81, -96.79) < 1e-9);
  assert.ok(haversineMi(32.81, -96.79, 32.82, -96.79) > 0);
});

test('pointToPolylineMi measures to the nearest point on the line, not a centroid', () => {
  // A north-south line at lng=-96.79 running past the point; the point sits
  // due east of the line's midpoint, roughly 1 mile away (~1/69 deg lng at
  // this latitude, corrected for cos(lat)).
  const lat = 32.81;
  const milesPerDegLng = 69.0 * Math.cos((lat * Math.PI) / 180);
  const offsetDeg = 1 / milesPerDegLng;
  const paths = [
    [
      [-96.79, 32.0],
      [-96.79, 33.6],
    ],
  ];
  const point = [-96.79 + offsetDeg, lat];
  const distance = pointToPolylineMi(point, paths);
  assert.ok(Math.abs(distance - 1) < 0.05, `expected ~1mi, got ${distance}`);

  // A point due south of the line's start (not between its endpoints)
  // should measure to that endpoint, not the perpendicular projection onto
  // an infinitely-extended line — proving this clamps to the segment.
  const southOfStart = [-96.79, 31.5];
  const distanceToEnd = pointToPolylineMi(southOfStart, paths);
  const expected = (32.0 - 31.5) * 69.0;
  assert.ok(Math.abs(distanceToEnd - expected) < 1, `expected ~${expected}mi, got ${distanceToEnd}`);
});

test('ringAreaAcres computes a roughly correct area for a simple square', () => {
  // ~1 mile square (640 acres) centered near Dallas.
  const lat = 32.81;
  const milesPerDegLat = 69.0;
  const milesPerDegLng = 69.0 * Math.cos((lat * Math.PI) / 180);
  const halfLat = 0.5 / milesPerDegLat;
  const halfLng = 0.5 / milesPerDegLng;
  const ring = [
    [-96.79 - halfLng, lat - halfLat],
    [-96.79 + halfLng, lat - halfLat],
    [-96.79 + halfLng, lat + halfLat],
    [-96.79 - halfLng, lat + halfLat],
  ];
  const acres = ringAreaAcres(ring);
  assert.ok(Math.abs(acres - 640) < 20, `expected ~640 acres, got ${acres}`);
});

test('roundDistanceMi rounds to the nearest step', () => {
  assert.equal(roundDistanceMi(0.42), 0.5);
  assert.equal(roundDistanceMi(0.37), 0.25);
  assert.equal(roundDistanceMi(1.1, 0.5), 1.0);
});
