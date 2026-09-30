import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeGroupSources,
  seedGroupProposal,
  summarizeGroupSources,
  toggleGroupMember,
} from '../src/state/driftGroup.js';

// botanicalName defaults to the bare speciesId so driftLabel (used by
// summarizeGroupSources/describeGroupSources) has something to initial from
// — 'winecup' -> 'W', one token, no space to split on.
function p(id, speciesId, x, y, extra = {}) {
  return { id, speciesId, x, y, width: 3, botanicalName: speciesId, ...extra };
}

// --- seedGroupProposal ---------------------------------------------------

test('seedGroupProposal seeds a one-member proposal from a plant in no drift', () => {
  const seed = p('wc-1', 'winecup', 10, 10);
  assert.deepStrictEqual(seedGroupProposal(seed), { speciesId: 'winecup', members: [seed] });
});

test('seedGroupProposal refuses a plant already in a drift, or no plant at all', () => {
  assert.equal(seedGroupProposal(p('wc-1', 'winecup', 10, 10, { driftId: 'existing' })), null);
  assert.equal(seedGroupProposal(null), null);
  assert.equal(seedGroupProposal({ id: 'no-species', x: 0, y: 0 }), null);
});

// --- toggleGroupMember -----------------------------------------------------

test('toggleGroupMember adds a same-species, undrifted plant', () => {
  const seed = p('wc-1', 'winecup', 10, 10);
  const candidate = p('wc-2', 'winecup', 11, 10);
  const plants = [seed, candidate];
  const { members, reason } = toggleGroupMember('winecup', [seed], 'wc-2', plants);
  assert.equal(reason, null);
  assert.deepStrictEqual(members, [seed, candidate]);
});

test('toggleGroupMember adds a same-species plant EVEN IF it already belongs to another drift (it will move)', () => {
  const seed = p('wc-1', 'winecup', 10, 10);
  const inOtherDrift = p('wc-2', 'winecup', 30, 30, { driftId: 'front-edge' });
  const plants = [seed, inOtherDrift];
  const { members, reason } = toggleGroupMember('winecup', [seed], 'wc-2', plants);
  assert.equal(reason, null);
  assert.deepStrictEqual(members, [seed, inOtherDrift]);
});

test('toggleGroupMember removes an existing member, unless it is the last one', () => {
  const seed = p('wc-1', 'winecup', 10, 10);
  const other = p('wc-2', 'winecup', 11, 10);
  const plants = [seed, other];

  const removed = toggleGroupMember('winecup', [seed, other], 'wc-2', plants);
  assert.equal(removed.reason, null);
  assert.deepStrictEqual(removed.members, [seed]);

  const refused = toggleGroupMember('winecup', [seed], 'wc-1', plants);
  assert.deepStrictEqual(refused.members, [seed]);
  assert.match(refused.reason, /at least one/);
});

test('toggleGroupMember is a silent no-op with a reason for a different species, and no reason for an unknown plant', () => {
  const seed = p('wc-1', 'winecup', 10, 10);
  const otherSpecies = p('hh-1', 'horseherb', 20, 20);
  const plants = [seed, otherSpecies];

  const wrongSpecies = toggleGroupMember('winecup', [seed], 'hh-1', plants);
  assert.deepStrictEqual(wrongSpecies.members, [seed]);
  assert.match(wrongSpecies.reason, /different species/);

  const unknown = toggleGroupMember('winecup', [seed], 'nope', plants);
  assert.deepStrictEqual(unknown.members, [seed]);
  assert.equal(unknown.reason, null);

  const emptyId = toggleGroupMember('winecup', [seed], '', plants);
  assert.deepStrictEqual(emptyId.members, [seed]);
  assert.equal(emptyId.reason, null);
});

// --- summarizeGroupSources / describeGroupSources ---------------------------

test('summarizeGroupSources is empty when nothing in the proposal belongs to another drift', () => {
  const seed = p('wc-1', 'winecup', 10, 10);
  const plants = [seed];
  assert.deepStrictEqual(summarizeGroupSources([seed], plants), []);
  assert.equal(describeGroupSources([]), '');
});

test('summarizeGroupSources groups members by their CURRENT other drift, labelled with its full membership', () => {
  const seed = p('wc-1', 'winecup', 10, 10);
  const movingA = p('wc-2', 'winecup', 30, 30, { driftId: 'front-edge' });
  const stayingBehind = p('wc-3', 'winecup', 31, 30, { driftId: 'front-edge' });
  const plants = [seed, movingA, stayingBehind];

  const groups = summarizeGroupSources([seed, movingA], plants);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].driftId, 'front-edge');
  assert.equal(groups[0].movingCount, 1);
  // driftLabel is built from the SOURCE drift's own full current membership
  // (both movingA and stayingBehind), not just what is about to move.
  assert.equal(groups[0].label, 'W (2x)');
  assert.equal(describeGroupSources(groups), '1 from W (2x)');
});

test('describeGroupSources joins more than one source drift, and orders by first appearance', () => {
  const seed = p('wc-1', 'winecup', 10, 10);
  const fromA1 = p('wc-2', 'winecup', 30, 30, { driftId: 'drift-a' });
  const fromA2 = p('wc-3', 'winecup', 31, 30, { driftId: 'drift-a' });
  const fromB1 = p('wc-4', 'winecup', 50, 50, { driftId: 'drift-b' });
  const fromB2 = p('wc-5', 'winecup', 51, 50, { driftId: 'drift-b' });
  const plants = [seed, fromA1, fromA2, fromB1, fromB2];

  const groups = summarizeGroupSources([seed, fromA1, fromB1], plants);
  assert.deepStrictEqual(
    groups.map((g) => g.driftId),
    ['drift-a', 'drift-b']
  );
  assert.equal(describeGroupSources(groups), '1 from W (2x), 1 from W (2x)');
});
