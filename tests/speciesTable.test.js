import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSpeciesDrifts } from '../src/render/speciesTable.js';

function plant(id, speciesId, driftId) {
  return { id, speciesId, driftId };
}

test('groupSpeciesDrifts splits a species’ plants into its drifts and its singles (nl-o47.6.7)', () => {
  const plants = [
    plant('a', 'winecup', 'winecup-drift'),
    plant('b', 'winecup', 'winecup-drift'),
    plant('c', 'winecup', 'winecup-2'),
    plant('d', 'winecup', null),
    plant('e', 'horseherb', 'horseherb-drift'), // a different species, must not leak in
  ];

  const result = groupSpeciesDrifts(plants, 'winecup');
  assert.deepEqual(result.drifts, [
    { driftId: 'winecup-drift', count: 2 },
    { driftId: 'winecup-2', count: 1 },
  ]);
  assert.equal(result.singleCount, 1);
  assert.equal(result.totalCount, 4);
});

test('groupSpeciesDrifts orders drifts by first appearance among that species’ plants', () => {
  const plants = [
    plant('a', 'winecup', 'winecup-2'),
    plant('b', 'winecup', 'winecup-drift'),
    plant('c', 'winecup', 'winecup-2'),
  ];
  const result = groupSpeciesDrifts(plants, 'winecup');
  assert.deepEqual(
    result.drifts.map((d) => d.driftId),
    ['winecup-2', 'winecup-drift']
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
