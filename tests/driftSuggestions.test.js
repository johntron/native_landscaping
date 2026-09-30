import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeLifecycleChoice,
  orderedSuggestions,
  pendingSuggestions,
  summarizeStatusCounts,
  summarizeSuggestionLifecycle,
  suggestionKey,
  toggleSuggestionMember,
} from '../src/state/driftSuggestions.js';
import { MIN_SUGGESTION_CLUSTER_SIZE } from '../src/state/driftGeometry.js';

function p(id, speciesId, x, y, extra = {}) {
  return { id, speciesId, x, y, width: 3, ...extra };
}

// A yard with two undrifted same-species masses (winecup: 3, horseherb: 5)
// well apart, plus one plant already in a real drift (excluded) and one lone
// carex (below MIN_SUGGESTION_CLUSTER_SIZE, excluded).
function yard() {
  return [
    p('wc-1', 'winecup', 0, 0),
    p('wc-2', 'winecup', 1, 0),
    p('wc-3', 'winecup', 0, 1),
    p('hh-1', 'horseherb', 40, 40),
    p('hh-2', 'horseherb', 41, 40),
    p('hh-3', 'horseherb', 40, 41),
    p('hh-4', 'horseherb', 41, 41),
    p('hh-5', 'horseherb', 40.5, 40.5),
    p('carex-1', 'carex', 80, 80),
    p('already-1', 'winecup', 100, 100, { driftId: 'front-edge' }),
    p('already-2', 'winecup', 101, 100, { driftId: 'front-edge' }),
  ];
}

test('orderedSuggestions sorts clusters largest first', () => {
  const ordered = orderedSuggestions(yard());
  assert.deepStrictEqual(
    ordered.map((s) => s.speciesId),
    ['horseherb', 'winecup']
  );
  assert.equal(ordered[0].members.length, 5);
  assert.equal(ordered[1].members.length, 3);
});

test('suggestionKey is stable for the same species+members and differs otherwise', () => {
  const [a, b] = orderedSuggestions(yard());
  assert.equal(suggestionKey(a), suggestionKey(a));
  assert.notEqual(suggestionKey(a), suggestionKey(b));
  // Order of members must not matter.
  const reordered = { speciesId: a.speciesId, members: [...a.members].reverse() };
  assert.equal(suggestionKey(a), suggestionKey(reordered));
});

test('pendingSuggestions excludes a skipped key and nothing else', () => {
  const plants = yard();
  const [biggest, smaller] = orderedSuggestions(plants);
  const skipped = new Set([suggestionKey(biggest)]);
  const pending = pendingSuggestions(plants, skipped);
  assert.deepStrictEqual(
    pending.map((s) => s.speciesId),
    [smaller.speciesId]
  );
});

test('pendingSuggestions with no skips equals orderedSuggestions', () => {
  const plants = yard();
  assert.deepStrictEqual(pendingSuggestions(plants, new Set()), orderedSuggestions(plants));
  assert.deepStrictEqual(pendingSuggestions(plants, []), orderedSuggestions(plants));
});

// --- toggleSuggestionMember --------------------------------------------------

test('toggleSuggestionMember removes an existing member when above the floor', () => {
  const plants = yard();
  const [horseherb] = orderedSuggestions(plants);
  const { members, reason } = toggleSuggestionMember(horseherb.members, 'hh-1', plants);
  assert.equal(reason, null);
  assert.equal(members.length, 4);
  assert.ok(!members.some((m) => m.id === 'hh-1'));
});

test('toggleSuggestionMember refuses to drop below MIN_SUGGESTION_CLUSTER_SIZE, with a reason, and leaves members untouched', () => {
  const plants = yard();
  const two = [p('a', 'winecup', 0, 0), p('b', 'winecup', 1, 0)];
  const { members, reason } = toggleSuggestionMember(two, 'a', plants);
  assert.equal(members, two);
  assert.match(reason, new RegExp(String(MIN_SUGGESTION_CLUSTER_SIZE)));
});

test('toggleSuggestionMember adds a same-species, undrifted candidate not already a member', () => {
  const plants = yard();
  const [, winecup] = orderedSuggestions(plants); // the 3-member winecup cluster
  // A lone winecup plant elsewhere in the yard, not part of any cluster or drift.
  const extended = [...plants, p('wc-loner', 'winecup', 500, 500)];
  const { members, reason } = toggleSuggestionMember(winecup.members, 'wc-loner', extended);
  assert.equal(reason, null);
  assert.equal(members.length, 4);
  assert.ok(members.some((m) => m.id === 'wc-loner'));
});

test('toggleSuggestionMember does nothing for a different species', () => {
  const plants = yard();
  const [horseherb] = orderedSuggestions(plants);
  const { members, reason } = toggleSuggestionMember(horseherb.members, 'wc-1', plants);
  assert.equal(reason, null);
  assert.deepStrictEqual(members, horseherb.members);
});

test('toggleSuggestionMember does nothing for a plant already in another drift', () => {
  const plants = yard();
  const [, winecup] = orderedSuggestions(plants);
  const { members, reason } = toggleSuggestionMember(winecup.members, 'already-1', plants);
  assert.equal(reason, null);
  assert.deepStrictEqual(members, winecup.members);
});

test('toggleSuggestionMember does nothing for an id that names no plant', () => {
  const plants = yard();
  const [horseherb] = orderedSuggestions(plants);
  const { members, reason } = toggleSuggestionMember(horseherb.members, 'nope', plants);
  assert.equal(reason, null);
  assert.deepStrictEqual(members, horseherb.members);
});

// --- lifecycle summary --------------------------------------------------------

test('summarizeSuggestionLifecycle reports uniform when every member matches', () => {
  const members = [p('a', 'winecup', 0, 0), p('b', 'winecup', 1, 0)];
  const { uniform, groups } = summarizeSuggestionLifecycle(members);
  assert.equal(uniform, true);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].lifecycle.status, 'planned');
});

test('summarizeSuggestionLifecycle groups distinct lifecycles, first-appearance order', () => {
  const members = [
    p('a', 'winecup', 0, 0, { status: 'planted', plantedOn: '2026-03-01' }),
    p('b', 'winecup', 1, 0),
    p('c', 'winecup', 2, 0, { status: 'planted', plantedOn: '2026-03-01' }),
    p('d', 'winecup', 3, 0),
    p('e', 'winecup', 4, 0),
  ];
  const { uniform, groups } = summarizeSuggestionLifecycle(members);
  assert.equal(uniform, false);
  assert.deepStrictEqual(
    groups.map((g) => [g.lifecycle.status, g.count]),
    [
      ['planted', 2],
      ['planned', 3],
    ]
  );
});

test('summarizeStatusCounts renders the compact "N planned, N planted" line', () => {
  const members = [
    p('a', 'winecup', 0, 0, { status: 'planted' }),
    p('b', 'winecup', 1, 0),
    p('c', 'winecup', 2, 0),
  ];
  // Order is "planned" then "planted" when both are present.
  assert.equal(summarizeStatusCounts(members), '2 planned, 1 planted');
});

test('summarizeStatusCounts omits a zero side', () => {
  const allPlanned = [p('a', 'winecup', 0, 0), p('b', 'winecup', 1, 0)];
  assert.equal(summarizeStatusCounts(allPlanned), '2 planned');
  const allPlanted = [p('a', 'winecup', 0, 0, { status: 'planted' })];
  assert.equal(summarizeStatusCounts(allPlanted), '1 planted');
});

test('describeLifecycleChoice labels a planned and a planted+ecotype group', () => {
  assert.equal(
    describeLifecycleChoice({ lifecycle: { status: 'planned', plantedOn: '', localEcotype: false }, count: 12 }),
    'Planned (12)'
  );
  assert.equal(
    describeLifecycleChoice(
      { lifecycle: { status: 'planted', plantedOn: '2026-03-01', localEcotype: true }, count: 5 }
    ),
    'Planted, 2026-03-01, local ecotype (5)'
  );
});
