import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateSize, formatDistance, groupAnchors, kindLabel } from '../src/analysis/anchors.js';

const rows = [
  { kind: 'park', name: 'Far Park', status: 'candidate', distance_mi: '1', detail: 'leisure=park, ~6 acres', fetched_on: '2026-09-17', source: 'OSM' },
  { kind: 'stream', name: 'Near Creek', status: 'anchor', distance_mi: '0.75', detail: 'channel', fetched_on: '2026-09-17', source: 'NHD' },
  { kind: 'park', name: 'Close Park', status: 'candidate', distance_mi: '0.25', detail: 'leisure=park, ~8 acres', fetched_on: '2026-09-18', source: 'OSM' },
  { kind: 'cemetery', name: 'Also Close', status: 'candidate', distance_mi: '0.25', detail: '', fetched_on: '2026-09-17', source: 'OSM' },
  { kind: 'park', name: '', status: 'candidate', distance_mi: '0.5', detail: '', fetched_on: '2026-09-17', source: 'OSM' },
  { kind: 'park', name: 'No Distance', status: 'candidate', distance_mi: '', detail: '', fetched_on: '2026-09-17', source: 'OSM' },
];

// One yard's rows, as /api/ecosystem/site sends them (nl-3s5.31): no place label to select by.
test('groupAnchors splits mapped anchors from unchecked candidates', () => {
  const { anchors, candidates } = groupAnchors(rows);
  assert.deepEqual(anchors.map((a) => a.name), ['Near Creek']);
  assert.deepEqual(candidates.map((c) => c.name), ['Also Close', 'Close Park', 'Far Park']);
});

test('groupAnchors orders by distance only, ties by name, and drops rows it cannot show honestly', () => {
  const { candidates } = groupAnchors(rows);
  assert.deepEqual(candidates.map((c) => c.distanceMi), [0.25, 0.25, 1]);
  assert.ok(!candidates.some((c) => c.name === 'No Distance' || c.name === ''));
});

test('groupAnchors reports the newest fetch date, and nothing for no rows', () => {
  assert.equal(groupAnchors(rows).fetchedOn, '2026-09-18');
  assert.deepEqual(groupAnchors([]), { anchors: [], candidates: [], fetchedOn: '' });
  assert.deepEqual(groupAnchors(null), { anchors: [], candidates: [], fetchedOn: '' });
});

test('display helpers', () => {
  assert.equal(formatDistance(0.75), '0.75 mi');
  assert.equal(formatDistance(1), '1 mi');
  assert.equal(kindLabel('nature_reserve'), 'nature reserve');
  assert.equal(kindLabel('something_new'), 'something new');
  assert.equal(candidateSize('leisure=park, ~8 acres'), '~8 acres');
  assert.equal(candidateSize('landuse=cemetery, ~29 acres'), '~29 acres');
  assert.equal(candidateSize('channel'), '');
});
