import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSpeciesDrifts } from '../src/render/speciesTable.js';

function plant(id, speciesId, driftId, x = 0, y = 0) {
  return { id, speciesId, driftId, x, y };
}

test('groupSpeciesDrifts splits a species’ plants into its drifts and its singles (nl-o47.6.7)', () => {
  const plants = [
    plant('a', 'winecup', 'winecup-drift', 0, 0),
    plant('b', 'winecup', 'winecup-drift', 2, 0),
    plant('c', 'winecup', 'winecup-2', 10, 0),
    plant('d', 'winecup', null),
    plant('e', 'horseherb', 'horseherb-drift'), // a different species, must not leak in
  ];

  const result = groupSpeciesDrifts(plants, 'winecup');
  assert.deepEqual(
    result.drifts.map((d) => ({ driftId: d.driftId, count: d.members.length })),
    [
      { driftId: 'winecup-drift', count: 2 },
      { driftId: 'winecup-2', count: 1 },
    ]
  );
  assert.equal(result.singleCount, 1);
  assert.equal(result.totalCount, 4);
});

test('groupSpeciesDrifts orders drifts west to east, then south to north, by centroid — not first appearance (nl-o47.6.11)', () => {
  const plants = [
    // Listed east-first in the array; the west one must still sort first.
    plant('a', 'winecup', 'east-drift', 20, 0),
    plant('b', 'winecup', 'east-drift', 22, 0),
    plant('c', 'winecup', 'west-drift', 0, 5),
    plant('d', 'winecup', 'west-drift', 2, 5),
  ];
  const result = groupSpeciesDrifts(plants, 'winecup');
  assert.deepEqual(
    result.drifts.map((d) => d.driftId),
    ['west-drift', 'east-drift']
  );
});

test('groupSpeciesDrifts breaks a west/east tie south to north', () => {
  const plants = [
    plant('a', 'winecup', 'north-drift', 0, 20),
    plant('b', 'winecup', 'north-drift', 0, 22),
    plant('c', 'winecup', 'south-drift', 0, 0),
    plant('d', 'winecup', 'south-drift', 0, 2),
  ];
  const result = groupSpeciesDrifts(plants, 'winecup');
  assert.deepEqual(
    result.drifts.map((d) => d.driftId),
    ['south-drift', 'north-drift']
  );
});

test('groupSpeciesDrifts returns no drifts and every plant as single when none carry a driftId', () => {
  const plants = [plant('a', 'winecup', null), plant('b', 'winecup', undefined)];
  const result = groupSpeciesDrifts(plants, 'winecup');
  assert.deepEqual(result.drifts, []);
  assert.equal(result.singleCount, 2);
  assert.equal(result.totalCount, 2);
});

test('groupSpeciesDrifts keys off the lower-cased species key, not a raw speciesId', () => {
  const plants = [plant('a', 'Winecup', 'winecup-drift'), plant('b', 'winecup', 'winecup-drift')];
  const result = groupSpeciesDrifts(plants, 'winecup');
  assert.equal(result.totalCount, 2, 'both plants match the lower-cased key regardless of speciesId casing');
});

test('groupSpeciesDrifts ignores plants of other species entirely', () => {
  const plants = [plant('a', 'horseherb', 'horseherb-drift')];
  const result = groupSpeciesDrifts(plants, 'winecup');
  assert.deepEqual(result.drifts, []);
  assert.equal(result.singleCount, 0);
  assert.equal(result.totalCount, 0);
});
