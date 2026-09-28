import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeciesCsv, createPlantFromSpecies } from '../src/data/plantParser.js';
import {
  addDriftMember,
  cloneDrift,
  dissolveDrift,
  removeDriftMember,
  removePlantFromDrift,
  renameDrift,
  spreadDrift,
} from '../src/state/driftEdits.js';

const speciesHeader = 'id,common_name,botanical_name,growing_season_months,flowering_season_months,foliage_color_spring,foliage_color_summer,foliage_color_fall,foliage_color_winter,flower_color,width_ft,height_ft,growth_shape';
const species = parseSpeciesCsv(
  `${speciesHeader}\n` +
    'winecup,Winecup,Callirhoe involucrata,2-7,3-6,#6fa45f,#4d8c4d,#c08050,#917447,purple,3,0.5,creeping\n' +
    'horseherb,Horseherb,Calyptocarpus vialis,4-10,5-10,#6fa45f,#4d8c4d,#c08050,#917447,yellow,3,0.3,creeping'
);
const winecup = species.find((s) => s.speciesId === 'winecup');
const horseherb = species.find((s) => s.speciesId === 'horseherb');

const YARD = { yardFt: { width: 40, depth: 40 } };

function plant(speciesEntry, id, x, y, extra = {}) {
  return createPlantFromSpecies(speciesEntry, { id, x, y, ...extra });
}

function makeState(plants) {
  return { plants, species, project: YARD };
}

/** Deep-freezes a fixture so any in-place mutation throws (strict-mode ES modules). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// A small drift of 3 winecup plus one unrelated horseherb plant, for every test to build on.
function baseDrift() {
  return [
    plant(winecup, 'wc-1', 10, 10, { driftId: 'winecup-strip' }),
    plant(winecup, 'wc-2', 12, 10, { driftId: 'winecup-strip' }),
    plant(winecup, 'wc-3', 11, 11.7, { driftId: 'winecup-strip', status: 'planted' }),
    plant(horseherb, 'hh-1', 30, 30),
  ];
}

// --- addDriftMember ("+") ------------------------------------------------------

test('addDriftMember adds one plant of the drift\'s species, labelled with its driftId, without mutating the input', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  const { plant: added, reason } = addDriftMember(state, 'winecup-strip');
  assert.equal(reason, null);
  assert.equal(added.speciesId, 'winecup');
  assert.equal(added.driftId, 'winecup-strip');
  assert.ok(Number.isFinite(added.x) && Number.isFinite(added.y));
  assert.equal(state.plants.length, 5);
  assert.notEqual(state.plants, plants, 'a new array, not the frozen input');
  assert.equal(plants.length, 4, 'the input array itself is untouched');
});

test('addDriftMember keeps the new member inside the declared yard', () => {
  // A drift pinned in a corner, spaced widely, so "+" has to clamp against the edge.
  const plants = [
    plant(winecup, 'a', 1, 1, { driftId: 'corner' }),
    plant(winecup, 'b', 1, 5, { driftId: 'corner' }),
  ];
  const state = makeState(plants);
  const { plant: added, reason } = addDriftMember(state, 'corner');
  assert.equal(reason, null);
  assert.ok(added.x >= 0 && added.x <= YARD.yardFt.width);
  assert.ok(added.y >= 0 && added.y <= YARD.yardFt.depth);
});

test('addDriftMember refuses a driftId with no members, or one whose species left the catalog', () => {
  assert.deepStrictEqual(addDriftMember(makeState(baseDrift()), 'no-such-drift'), { plant: null, reason: 'no such drift' });
  // A raw placement (not built by createPlantFromSpecies, which would always
  // resolve speciesId from the real catalog row) naming a species that is no
  // longer in it.
  const orphan = [{ id: 'a', speciesId: 'extinct-species', x: 5, y: 5, width: 2, driftId: 'x' }];
  const result = addDriftMember(makeState(orphan), 'x');
  assert.equal(result.plant, null);
  assert.match(result.reason, /no longer in the catalog/);
});

// --- removeDriftMember ("-") ---------------------------------------------------

test('removeDriftMember removes the planned member farthest from the centroid, leaving everything else untouched', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  const { plant: removed, reason } = removeDriftMember(state, 'winecup-strip');
  assert.equal(reason, null);
  assert.equal(removed.status ?? undefined, undefined, 'never removes the planted member automatically');
  assert.equal(state.plants.length, 3);
  assert.ok(state.plants.some((p) => p.id === 'hh-1'), 'the unrelated plant is untouched');
  assert.ok(!state.plants.some((p) => p.id === removed.id));
});

test('removeDriftMember refuses when only planted members remain, or the drift does not exist', () => {
  const allPlanted = [
    plant(winecup, 'a', 0, 0, { driftId: 'x', status: 'planted' }),
    plant(winecup, 'b', 3, 0, { driftId: 'x', status: 'planted' }),
  ];
  const state = makeState(allPlanted);
  const result = removeDriftMember(state, 'x');
  assert.equal(result.plant, null);
  assert.match(result.reason, /only planted/);
  assert.equal(state.plants.length, 2, 'nothing removed');
  assert.deepStrictEqual(removeDriftMember(makeState(baseDrift()), 'nope'), { plant: null, reason: 'no such drift' });
});

// --- spreadDrift ----------------------------------------------------------------

test('spreadDrift scales the drift\'s members about their centroid, leaving other plants alone', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  const before = state.plants.find((p) => p.id === 'hh-1');
  const { members, appliedFactor, reason } = spreadDrift(state, 'winecup-strip', 2);
  assert.equal(reason, null);
  assert.equal(appliedFactor, 2);
  assert.equal(members.length, 3);
  const untouched = state.plants.find((p) => p.id === 'hh-1');
  assert.deepStrictEqual(untouched, before, 'a plant outside the drift never moves');
});

test('spreadDrift clamps the applied factor to the yard, and reports "no such drift" for an unknown id', () => {
  const plants = [
    plant(winecup, 'a', 5, 20, { driftId: 'edge' }),
    plant(winecup, 'b', 35, 20, { driftId: 'edge' }), // centroid x=20, near both edges of a 40 ft yard
  ];
  const state = makeState(plants);
  const { appliedFactor } = spreadDrift(state, 'edge', 5);
  assert.ok(appliedFactor < 5);
  state.plants.forEach((p) => assert.ok(p.x >= 0 && p.x <= 40));
  assert.deepStrictEqual(spreadDrift(makeState(baseDrift()), 'nope', 2), { members: [], appliedFactor: 1, reason: 'no such drift' });
});

// --- renameDrift ------------------------------------------------------------------

test('renameDrift rewrites driftId on every member, and only those members', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  const { driftId, reason } = renameDrift(state, 'winecup-strip', 'Front Bed Winecups');
  assert.equal(reason, null);
  assert.equal(driftId, 'front-bed-winecups');
  const renamed = state.plants.filter((p) => p.driftId === 'front-bed-winecups');
  assert.equal(renamed.length, 3);
  assert.equal(state.plants.find((p) => p.id === 'hh-1').driftId, undefined);
});

test('renameDrift refuses a name that collides with a different drift, and no-ops onto its own current name', () => {
  const plants = [
    plant(winecup, 'a', 0, 0, { driftId: 'north-bed' }),
    plant(winecup, 'b', 2, 0, { driftId: 'north-bed' }),
    plant(horseherb, 'c', 20, 20, { driftId: 'south-bed' }),
  ];
  const state = makeState(plants);
  const collision = renameDrift(state, 'north-bed', 'South Bed');
  assert.equal(collision.driftId, null);
  assert.match(collision.reason, /already the name/);
  assert.equal(state.plants.find((p) => p.id === 'a').driftId, 'north-bed', 'refused, so nothing changed');

  const noop = renameDrift(state, 'north-bed', 'North Bed');
  assert.equal(noop.driftId, 'north-bed');
  assert.equal(noop.reason, null);
});

test('renameDrift on an unknown driftId', () => {
  assert.deepStrictEqual(renameDrift(makeState(baseDrift()), 'nope', 'Anything'), { driftId: null, reason: 'no such drift' });
});

// --- cloneDrift ---------------------------------------------------------------------

test('cloneDrift copies every member under one new driftId, with fresh ids and lifecycle dropped', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  const { driftId: newDriftId, plants: clones, reason } = cloneDrift(state, 'winecup-strip');
  assert.equal(reason, null);
  assert.notEqual(newDriftId, 'winecup-strip');
  assert.equal(clones.length, 3);
  const originalIds = new Set(plants.map((p) => p.id));
  clones.forEach((clone) => {
    assert.ok(!originalIds.has(clone.id), 'a fresh id, never reusing an original');
    assert.equal(clone.speciesId, 'winecup');
    assert.equal(clone.status ?? undefined, undefined, 'a clone starts planned');
    assert.equal(clone.plantedOn ?? undefined, undefined);
    assert.equal(clone.source ?? undefined, undefined);
  });
  // Nothing about the original drift changed.
  assert.equal(state.plants.filter((p) => p.driftId === 'winecup-strip').length, 3);
  assert.equal(state.plants.length, 4 + 3);
});

test('cloneDrift keeps the copy inside the declared yard', () => {
  const plants = [
    plant(winecup, 'a', 39, 39, { driftId: 'corner' }),
    plant(winecup, 'b', 39.5, 38, { driftId: 'corner' }),
  ];
  const state = makeState(plants);
  const { plants: clones } = cloneDrift(state, 'corner');
  clones.forEach((clone) => {
    assert.ok(clone.x <= 40 && clone.y <= 40, `clone ${clone.id} at (${clone.x},${clone.y}) escaped the yard`);
  });
});

test('cloneDrift offsets the whole copy clear of the original, not by a fixed nudge that would interleave a multi-member drift', () => {
  // Members ~1-2 ft apart (a realistic groundcover spacing); a fixed 1.1 ft
  // nudge would land clones on top of or between the originals.
  const plants = [
    plant(winecup, 'a', 10, 10, { driftId: 'strip' }),
    plant(winecup, 'b', 11.5, 10, { driftId: 'strip' }),
    plant(winecup, 'c', 10.75, 11.5, { driftId: 'strip' }),
  ];
  const state = makeState(plants);
  const { plants: clones } = cloneDrift(state, 'strip');
  const minGap = Math.min(
    ...clones.flatMap((clone) => plants.map((original) => Math.hypot(clone.x - original.x, clone.y - original.y)))
  );
  // These 3 members' own median nearest-neighbour distance is exactly 1.5 ft
  // (a-b); the offset is the members' own x-spread plus that spacing, so the
  // closest an original and a clone ever land is exactly that spacing.
  assert.ok(minGap >= 1.5 - 1e-9, `clone landed only ${minGap} ft from an original`);
});

test('cloneDrift on an unknown driftId', () => {
  assert.deepStrictEqual(cloneDrift(makeState(baseDrift()), 'nope'), { driftId: null, plants: [], reason: 'no such drift' });
});

// --- removePlantFromDrift ------------------------------------------------------------

test('removePlantFromDrift takes one plant out of its drift without touching the rest', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  const { plant: updated, reason } = removePlantFromDrift(state, 'wc-2');
  assert.equal(reason, null);
  assert.equal(updated.driftId, undefined);
  assert.equal(state.plants.find((p) => p.id === 'wc-1').driftId, 'winecup-strip');
  assert.equal(state.plants.find((p) => p.id === 'wc-3').driftId, 'winecup-strip');
});

test('removePlantFromDrift is a no-op for a plant already in no drift, and reports an unknown id', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  const { plant: unchanged, reason } = removePlantFromDrift(state, 'hh-1');
  assert.equal(reason, null);
  assert.equal(unchanged.driftId, undefined);
  assert.deepStrictEqual(removePlantFromDrift(makeState(baseDrift()), 'nope'), { plant: null, reason: 'no such plant' });
});

// --- dissolveDrift ------------------------------------------------------------------

test('dissolveDrift removes driftId from every member, leaving positions and everything else exactly as they were', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  const before = plants.filter((p) => p.driftId === 'winecup-strip');
  const { members, reason } = dissolveDrift(state, 'winecup-strip');
  assert.equal(reason, null);
  assert.equal(members.length, 3);
  members.forEach((m) => assert.equal(m.driftId, undefined));
  // Positions unchanged.
  before.forEach((original) => {
    const now = state.plants.find((p) => p.id === original.id);
    assert.equal(now.x, original.x);
    assert.equal(now.y, original.y);
  });
  assert.equal(state.plants.find((p) => p.id === 'hh-1').driftId, undefined);
});

test('dissolveDrift on an unknown driftId', () => {
  assert.deepStrictEqual(dissolveDrift(makeState(baseDrift()), 'nope'), { members: [], reason: 'no such drift' });
});
