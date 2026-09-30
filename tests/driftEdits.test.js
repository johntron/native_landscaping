import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeciesCsv, createPlantFromSpecies } from '../src/data/plantParser.js';
import {
  acceptDriftSuggestion,
  addDriftFromCatalog,
  addDriftMember,
  cloneDrift,
  cloneDriftAwarePlant,
  MAX_DRIFT_COUNT,
  removeDrift,
  removeDriftAwarePlant,
  removeDriftMember,
  removePlantFromDrift,
  setDriftLifecycle,
  spreadDrift,
} from '../src/state/driftEdits.js';
import { clumpPositions, driftSpacing, SPACING_FACTOR } from '../src/state/driftGeometry.js';

const speciesHeader = 'id,common_name,botanical_name,growing_season_months,flowering_season_months,foliage_color_spring,foliage_color_summer,foliage_color_fall,foliage_color_winter,flower_color,width_ft,height_ft,growth_shape';
const species = parseSpeciesCsv(
  `${speciesHeader}\n` +
    'winecup,Winecup,Callirhoe involucrata,2-7,3-6,#6fa45f,#4d8c4d,#c08050,#917447,purple,3,0.5,creeping\n' +
    'horseherb,Horseherb,Calyptocarpus vialis,4-10,5-10,#6fa45f,#4d8c4d,#c08050,#917447,yellow,3,0.3,creeping'
);
const winecup = species.find((s) => s.speciesId === 'winecup');
const horseherb = species.find((s) => s.speciesId === 'horseherb');

const YARD = { yardFt: { width: 40, depth: 40 } };

// A plan view + declared yard, for addDriftFromCatalog (nl-o47.6.3), which
// calls addPlantFromCatalog (src/state/plantEdits.js) and needs one to place
// anything at all — mirrors tests/plantEdits.test.js's own fixture.
const PLAN_VIEW = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 400, height: 400 },
  extentFt: { width: 40, height: 40 },
  originFt: { x: 0, y: 0 },
};
const YARD_WITH_PLAN = { views: [PLAN_VIEW], yardFt: { width: 40, depth: 40 } };

function plant(speciesEntry, id, x, y, extra = {}) {
  return createPlantFromSpecies(speciesEntry, { id, x, y, ...extra });
}

function makeState(plants) {
  return { plants, species, project: YARD };
}

function makePlanState(plants) {
  return { plants, species, project: YARD_WITH_PLAN };
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
  assert.deepStrictEqual(addDriftMember(makeState(baseDrift()), 'no-such-drift'), {
    plant: null,
    driftId: null,
    reason: 'no such drift',
  });
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

// --- addDriftFromCatalog (nl-o47.6.3, the Add plant sheet's "How many?") ------------

test('addDriftFromCatalog with count=1 behaves exactly like addPlantFromCatalog: no driftId', () => {
  const state = makePlanState([]);
  const { plants: created, driftId } = addDriftFromCatalog(state, 'winecup', 1, { at: { x: 5, y: 6 } });
  assert.equal(driftId, null);
  assert.equal(created.length, 1);
  assert.equal(created[0].x, 5);
  assert.equal(created[0].y, 6);
  assert.equal(created[0].driftId, undefined);
  assert.equal(state.plants.length, 1);
  assert.equal(state.plants[0], created[0]);
});

test('addDriftFromCatalog treats 0, a negative count, or a missing count the same as 1', () => {
  assert.equal(addDriftFromCatalog(makePlanState([]), 'winecup', 0).driftId, null);
  assert.equal(addDriftFromCatalog(makePlanState([]), 'winecup', -3).driftId, null);
  assert.equal(addDriftFromCatalog(makePlanState([]), 'winecup', undefined).plants.length, 1);
});

test('addDriftFromCatalog places N plants of the species, all sharing one new driftId distinct from a drift already in the yard', () => {
  const existing = baseDrift(); // already has a winecup drift named 'winecup-strip'
  const state = { plants: existing, species, project: YARD_WITH_PLAN };
  const { plants: created, driftId } = addDriftFromCatalog(state, 'winecup', 5);
  assert.equal(created.length, 5);
  assert.ok(driftId, 'a driftId was minted');
  assert.notEqual(driftId, 'winecup-strip');
  created.forEach((p) => {
    assert.equal(p.speciesId, 'winecup');
    assert.equal(p.driftId, driftId);
  });
  // The existing drift and the unrelated horseherb are untouched.
  assert.equal(state.plants.filter((p) => p.driftId === 'winecup-strip').length, 3);
  assert.equal(state.plants.length, existing.length + 5);
});

test('addDriftFromCatalog mints a unique id for every new member, colliding with none already in the yard', () => {
  const existing = baseDrift();
  const state = { plants: existing, species, project: YARD_WITH_PLAN };
  const { plants: created } = addDriftFromCatalog(state, 'winecup', 8);
  const ids = created.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'every new id is unique');
  const existingIds = new Set(existing.map((p) => p.id));
  ids.forEach((id) => assert.ok(!existingIds.has(id), `new id "${id}" collided with an existing plant`));
});

test('addDriftFromCatalog spaces members at roughly the species width x SPACING_FACTOR', () => {
  const state = makePlanState([]);
  const { plants: created } = addDriftFromCatalog(state, 'winecup', 7);
  const expected = winecup.width * SPACING_FACTOR; // 3 ft x 0.5 = 1.5 ft
  const measured = driftSpacing(created, winecup.width);
  assert.ok(
    Math.abs(measured - expected) < expected * 0.1,
    `measured spacing ${measured} not close to expected ${expected}`
  );
});

test('addDriftFromCatalog clamps a clump that would overhang the yard, as a group, keeping its shape', () => {
  const state = makePlanState([]);
  const { plants: created } = addDriftFromCatalog(state, 'winecup', 6, { at: { x: 1, y: 1 } });
  assert.equal(created.length, 6);
  created.forEach((p) => {
    assert.ok(p.x >= 0 && p.x <= 40, `x ${p.x} escaped the yard`);
    assert.ok(p.y >= 0 && p.y <= 40, `y ${p.y} escaped the yard`);
  });
  // clampGroup only translates the whole clump, so its pairwise distances
  // survive exactly; a per-point clamp would have flattened them instead.
  const raw = clumpPositions(6, winecup.width * SPACING_FACTOR, { x: 1, y: 1 }, null);
  const pairwiseDistances = (points) =>
    points
      .flatMap((a, i) => points.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y)))
      .sort((a, b) => a - b);
  const createdDistances = pairwiseDistances(created.map((p) => ({ x: p.x, y: p.y })));
  const rawDistances = pairwiseDistances(raw);
  createdDistances.forEach((d, i) => assert.ok(Math.abs(d - rawDistances[i]) < 1e-6));
});

test('addDriftFromCatalog never mutates the plants array it is given', () => {
  const plants = deepFreeze(baseDrift());
  const state = { plants, species, project: YARD_WITH_PLAN };
  addDriftFromCatalog(state, 'winecup', 4);
  assert.equal(plants.length, 4, 'the input array itself is untouched');
});

test('addDriftFromCatalog adds nothing for an unknown species, or a project with no plan view', () => {
  const state = makePlanState([]);
  assert.deepStrictEqual(addDriftFromCatalog(state, 'no-such-species', 5), { plants: [], driftId: null });
  assert.equal(state.plants.length, 0);

  const noPlan = { plants: [], species, project: { views: [], yardFt: { width: 40, depth: 40 } } };
  assert.deepStrictEqual(addDriftFromCatalog(noPlan, 'winecup', 5), { plants: [], driftId: null });
});

test('addDriftFromCatalog caps the count at MAX_DRIFT_COUNT', () => {
  const state = makePlanState([]);
  const { plants: created } = addDriftFromCatalog(state, 'winecup', MAX_DRIFT_COUNT + 25);
  assert.equal(created.length, MAX_DRIFT_COUNT);
});

// --- removeDrift ("Remove drift" on the action bar, nl-o47.6.2) --------------

test('removeDrift deletes PLANNED members outright and dissolves the label on PLANTED ones, leaving other plants untouched', () => {
  const plants = deepFreeze(baseDrift()); // wc-1, wc-2 planned; wc-3 planted; hh-1 not in the drift
  const state = makeState(plants);
  const { removedCount, dissolvedCount, reason } = removeDrift(state, 'winecup-strip');
  assert.equal(reason, null);
  assert.equal(removedCount, 2);
  assert.equal(dissolvedCount, 1);
  assert.equal(state.plants.find((p) => p.id === 'wc-1'), undefined);
  assert.equal(state.plants.find((p) => p.id === 'wc-2'), undefined);
  const survivor = state.plants.find((p) => p.id === 'wc-3');
  assert.ok(survivor, 'the planted member stays in the yard');
  assert.equal(survivor.driftId, undefined);
  assert.equal(survivor.status, 'planted');
  assert.equal(state.plants.find((p) => p.id === 'hh-1').driftId, undefined);
  assert.equal(state.plants.length, 2); // wc-3 and hh-1
});

test('removeDrift with every member planted removes nothing, only dissolves', () => {
  const plants = [
    plant(winecup, 'wc-1', 10, 10, { driftId: 'strip', status: 'planted' }),
    plant(winecup, 'wc-2', 12, 10, { driftId: 'strip', status: 'planted' }),
  ];
  const state = makeState(plants);
  const { removedCount, dissolvedCount, reason } = removeDrift(state, 'strip');
  assert.equal(reason, null);
  assert.equal(removedCount, 0);
  assert.equal(dissolvedCount, 2);
  assert.equal(state.plants.length, 2);
  state.plants.forEach((p) => assert.equal(p.driftId, undefined));
});

test('removeDrift on an unknown driftId', () => {
  assert.deepStrictEqual(removeDrift(makeState(baseDrift()), 'nope'), {
    removedCount: 0,
    dissolvedCount: 0,
    reason: 'no such drift',
  });
});

// --- addDriftMember's plantId path ("+" on a single plant, nl-o47.6.9; folded
// in from what used to be a separate convertToDrift, nl-o47.6.12) ------------

test('addDriftMember({ plantId }) turns a lone plant into a drift of 2: a fresh driftId on both, the new member at the default spacing, its own lifecycle copied', () => {
  const plants = deepFreeze([
    plant(winecup, 'solo', 10, 10, { status: 'planted', plantedOn: '2026-03-01', localEcotype: true }),
    plant(horseherb, 'hh-1', 30, 30),
  ]);
  const state = makeState(plants);
  const { plant: second, driftId, reason } = addDriftMember(state, { plantId: 'solo' });
  assert.equal(reason, null);
  assert.ok(driftId, 'a driftId was minted');
  assert.equal(state.plants.length, 3);
  assert.notEqual(state.plants, plants, 'a new array, not the frozen input');

  const original = state.plants.find((p) => p.id === 'solo');
  assert.equal(original.driftId, driftId);
  assert.equal(second.driftId, driftId);
  assert.equal(second.speciesId, 'winecup');
  // nl-o47.6.10: the plant's own lifecycle is unified onto the new member.
  assert.equal(second.status, 'planted');
  assert.equal(second.plantedOn, '2026-03-01');
  assert.equal(second.localEcotype, true);
  // The unrelated plant is untouched, and the original keeps its own id.
  assert.equal(state.plants.find((p) => p.id === 'hh-1').driftId, undefined);
});

test('addDriftMember({ plantId }) refuses a plant already in a drift, an unknown plant, or a species no longer in the catalog', () => {
  assert.deepStrictEqual(addDriftMember(makeState(baseDrift()), { plantId: 'nope' }), {
    plant: null,
    driftId: null,
    reason: 'no such plant',
  });
  assert.equal(addDriftMember(makeState(baseDrift()), { plantId: 'wc-1' }).reason, 'already in a drift');
  const orphan = [{ id: 'a', speciesId: 'extinct-species', x: 5, y: 5, width: 2 }];
  const result = addDriftMember(makeState(orphan), { plantId: 'a' });
  assert.equal(result.driftId, null);
  assert.match(result.reason, /no longer in the catalog/);
});

test('1 -> 2 -> 1 returns the original plant, with its original id and no driftId', () => {
  const plants = [plant(winecup, 'solo', 10, 10)];
  const state = makeState(plants);
  const { driftId } = addDriftMember(state, { plantId: 'solo' });
  assert.equal(state.plants.length, 2);

  const { plant: removed, reason } = removeDriftMember(state, driftId);
  assert.equal(reason, null);
  assert.equal(state.plants.length, 1);
  assert.notEqual(removed.id, 'solo', 'the NEW member is the one removed, per the most-recently-added tie-break');
  const survivor = state.plants[0];
  assert.equal(survivor.id, 'solo', 'the original plant, with its original id');
  assert.equal(survivor.driftId, undefined, 'no longer labelled: a plain single plant again');
});

// --- the >= 2 members invariant (nl-o47.6.9) ------------------------------------

test('removeDriftMember on a 2-member drift drops the driftId label from the survivor', () => {
  const plants = [plant(winecup, 'a', 10, 10, { driftId: 'strip' }), plant(winecup, 'b', 12, 10, { driftId: 'strip' })];
  const state = makeState(plants);
  const { plant: removed, reason } = removeDriftMember(state, 'strip');
  assert.equal(reason, null);
  assert.equal(state.plants.length, 1);
  const survivor = state.plants.find((p) => p.id !== removed.id);
  assert.equal(survivor.driftId, undefined);
});

test('removePlantFromDrift on a 2-member drift drops the driftId label from the OTHER member too', () => {
  const plants = [
    plant(winecup, 'a', 10, 10, { driftId: 'strip' }),
    plant(winecup, 'b', 12, 10, { driftId: 'strip' }),
  ];
  const state = makeState(plants);
  const { plant: updated, reason } = removePlantFromDrift(state, 'a');
  assert.equal(reason, null);
  assert.equal(updated.driftId, undefined);
  const other = state.plants.find((p) => p.id === 'b');
  assert.equal(other.driftId, undefined, "the whole drift ends, not just a's membership in it");
});

test('removeDriftAwarePlant deletes the plant, dropping the driftId label from a 2-member drift\'s survivor', () => {
  const plants = [
    plant(winecup, 'a', 10, 10, { driftId: 'strip' }),
    plant(winecup, 'b', 12, 10, { driftId: 'strip' }),
  ];
  const state = makeState(plants);
  assert.equal(removeDriftAwarePlant(state, 'a'), true);
  assert.equal(state.plants.length, 1);
  assert.equal(state.plants[0].id, 'b');
  assert.equal(state.plants[0].driftId, undefined);
});

test('removeDriftAwarePlant leaves a 3+-member drift\'s driftId alone, and behaves like removePlantById for a plant in no drift', () => {
  const plants = deepFreeze(baseDrift());
  const state = makeState(plants);
  assert.equal(removeDriftAwarePlant(state, 'wc-1'), true);
  assert.equal(state.plants.length, 3);
  assert.ok(state.plants.every((p) => p.id !== 'wc-1'));
  assert.equal(state.plants.find((p) => p.id === 'wc-2').driftId, 'winecup-strip');

  const state2 = makeState(deepFreeze(baseDrift()));
  assert.equal(removeDriftAwarePlant(state2, 'hh-1'), true);
  assert.equal(state2.plants.length, 3);
  assert.equal(removeDriftAwarePlant(state2, 'nope'), false);
});

// nl-o47.6.12: pruneUndersizedDrift and dropUndersizedDrifts are both gone,
// collapsed onto src/data/driftId.js's normalizeDrifts (fully tested in
// tests/driftId.test.js) — every edit above that could leave a drift
// undersized calls it directly, on the whole list, instead.

// --- one planting status per drift (nl-o47.6.10) --------------------------------

test('addDriftMember copies the drift\'s own (uniform) lifecycle onto the new member', () => {
  const plants = [
    plant(winecup, 'a', 10, 10, { driftId: 'strip', status: 'planted', plantedOn: '2026-02-01', localEcotype: true }),
    plant(winecup, 'b', 12, 10, { driftId: 'strip', status: 'planted', plantedOn: '2026-02-01', localEcotype: true }),
  ];
  const state = makeState(plants);
  const { plant: added, reason } = addDriftMember(state, 'strip');
  assert.equal(reason, null);
  assert.equal(added.status, 'planted');
  assert.equal(added.plantedOn, '2026-02-01');
  assert.equal(added.localEcotype, true);
});

test('addDriftMember on a drift whose members differ copies the FIRST member\'s lifecycle', () => {
  // baseDrift: wc-1 and wc-2 planned, wc-3 planted — members disagree.
  const state = makeState(deepFreeze(baseDrift()));
  const { plant: added } = addDriftMember(state, 'winecup-strip');
  assert.equal(added.status ?? undefined, undefined, 'planned, matching wc-1, the first member');
});

test('cloneDriftAwarePlant copies the source member\'s lifecycle when the clone stays in a drift', () => {
  const plants = [
    plant(winecup, 'a', 10, 10, { driftId: 'strip', status: 'planted', plantedOn: '2026-02-01' }),
    plant(winecup, 'b', 12, 10, { driftId: 'strip', status: 'planted', plantedOn: '2026-02-01' }),
  ];
  const state = makePlanState(plants);
  const clone = cloneDriftAwarePlant(state, 'a');
  assert.ok(clone);
  assert.equal(clone.driftId, 'strip');
  assert.equal(clone.status, 'planted');
  assert.equal(clone.plantedOn, '2026-02-01');
  assert.equal(state.plants.find((p) => p.id === clone.id), clone);
});

test('cloneDriftAwarePlant behaves exactly like clonePlantById for a plant in no drift: the clone starts planned', () => {
  const plants = [plant(winecup, 'solo', 10, 10, { status: 'planted', plantedOn: '2026-02-01' })];
  const state = makePlanState(plants);
  const clone = cloneDriftAwarePlant(state, 'solo');
  assert.ok(clone);
  assert.equal(clone.driftId, undefined);
  assert.equal(clone.status ?? undefined, undefined, 'a clone is not in the ground, drift or no drift');
});

test('cloneDriftAwarePlant on an unknown plant id', () => {
  assert.equal(cloneDriftAwarePlant(makePlanState(deepFreeze(baseDrift())), 'nope'), null);
});

test('setDriftLifecycle writes every member as one edit, and no-ops once every member already matches', () => {
  const plants = [
    plant(winecup, 'a', 10, 10, { driftId: 'strip' }),
    plant(winecup, 'b', 12, 10, { driftId: 'strip' }),
    plant(horseherb, 'hh-1', 30, 30),
  ];
  const state = makeState(plants);
  const { members, problems } = setDriftLifecycle(state, 'strip', {
    status: 'planted',
    plantedOn: '2026-04-01',
    source: { name: 'Native Gardeners' },
  });
  assert.deepStrictEqual(problems, []);
  assert.equal(members.length, 2);
  members.forEach((m) => {
    assert.equal(m.status, 'planted');
    assert.equal(m.plantedOn, '2026-04-01');
    assert.deepStrictEqual(m.source, { name: 'Native Gardeners' });
  });
  assert.equal(state.plants.find((p) => p.id === 'hh-1').status ?? undefined, undefined, 'unrelated plant untouched');

  // Applying the SAME fields again is a no-op: nothing to write, nothing to commit.
  const noop = setDriftLifecycle(state, 'strip', { status: 'planted', plantedOn: '2026-04-01' });
  assert.deepStrictEqual(noop, { members: [], problems: [] });
});

test('setDriftLifecycle unifies a drift whose members currently differ', () => {
  const state = makeState(deepFreeze(baseDrift())); // wc-1/wc-2 planned, wc-3 planted
  const { members, problems } = setDriftLifecycle(state, 'winecup-strip', { status: 'planted' });
  assert.deepStrictEqual(problems, []);
  assert.equal(members.length, 3);
  members.forEach((m) => assert.equal(m.status, 'planted'));
});

test('setDriftLifecycle refuses a future planting date, changing nothing', () => {
  const plants = [
    plant(winecup, 'a', 10, 10, { driftId: 'strip' }),
    plant(winecup, 'b', 12, 10, { driftId: 'strip' }),
  ];
  const state = makeState(plants);
  const { members, problems } = setDriftLifecycle(state, 'strip', { status: 'planted', plantedOn: '2999-01-01' });
  assert.equal(members.length, 0);
  assert.ok(problems.length > 0);
  assert.match(problems.join(' '), /future/);
  assert.deepStrictEqual(state.plants, plants, 'a refused edit changes nothing');
});

// --- acceptDriftSuggestion (nl-o47.6.5) --------------------------------------

test('acceptDriftSuggestion mints one driftId and writes it onto exactly the given members, as one state.plants replacement', () => {
  const plants = deepFreeze([
    plant(winecup, 'wc-1', 10, 10),
    plant(winecup, 'wc-2', 11, 10),
    plant(winecup, 'wc-3', 10, 11),
    plant(horseherb, 'hh-1', 30, 30),
  ]);
  const state = makeState(plants);
  const { driftId, members, reason } = acceptDriftSuggestion(state, ['wc-1', 'wc-2', 'wc-3']);
  assert.equal(reason, null);
  assert.ok(driftId);
  assert.equal(members.length, 3);
  assert.ok(members.every((m) => m.driftId === driftId));
  assert.equal(state.plants.find((p) => p.id === 'hh-1').driftId ?? undefined, undefined, 'unrelated plant untouched');
  assert.notEqual(state.plants, plants, 'a new array, not the frozen input');
});

test('acceptDriftSuggestion refuses fewer than MIN_SUGGESTION_CLUSTER_SIZE members, changing nothing', () => {
  const plants = deepFreeze([plant(winecup, 'wc-1', 10, 10)]);
  const state = makeState(plants);
  const { driftId, members, reason } = acceptDriftSuggestion(state, ['wc-1']);
  assert.equal(driftId, null);
  assert.deepStrictEqual(members, []);
  assert.match(reason, /at least/);
  assert.deepStrictEqual(state.plants, plants);
});

test('acceptDriftSuggestion refuses when a named plant no longer exists, changing nothing', () => {
  const plants = deepFreeze([plant(winecup, 'wc-1', 10, 10), plant(winecup, 'wc-2', 11, 10)]);
  const state = makeState(plants);
  const { driftId, reason } = acceptDriftSuggestion(state, ['wc-1', 'gone']);
  assert.equal(driftId, null);
  assert.match(reason, /no longer exist/);
  assert.deepStrictEqual(state.plants, plants);
});

test('acceptDriftSuggestion refuses a member already in a drift, changing nothing', () => {
  const plants = deepFreeze([
    plant(winecup, 'wc-1', 10, 10, { driftId: 'front-edge' }),
    plant(winecup, 'wc-2', 11, 10),
  ]);
  const state = makeState(plants);
  const { driftId, reason } = acceptDriftSuggestion(state, ['wc-1', 'wc-2']);
  assert.equal(driftId, null);
  assert.match(reason, /already in a drift/);
  assert.deepStrictEqual(state.plants, plants);
});

test('acceptDriftSuggestion with disagreeing lifecycles and no chosen lifecycle is refused, changing nothing', () => {
  const plants = deepFreeze([
    plant(winecup, 'wc-1', 10, 10, { status: 'planted', plantedOn: '2026-03-01' }),
    plant(winecup, 'wc-2', 11, 10),
  ]);
  const state = makeState(plants);
  const { driftId, reason } = acceptDriftSuggestion(state, ['wc-1', 'wc-2']);
  assert.equal(driftId, null);
  assert.match(reason, /planting status/);
  assert.deepStrictEqual(state.plants, plants);
});

test('acceptDriftSuggestion applies a chosen lifecycle to every member in the same call', () => {
  const plants = deepFreeze([
    plant(winecup, 'wc-1', 10, 10, { status: 'planted', plantedOn: '2026-03-01' }),
    plant(winecup, 'wc-2', 11, 10),
  ]);
  const state = makeState(plants);
  const { driftId, members, reason } = acceptDriftSuggestion(state, ['wc-1', 'wc-2'], {
    lifecycle: { status: 'planted', plantedOn: '2026-03-01' },
  });
  assert.equal(reason, null);
  assert.ok(driftId);
  members.forEach((m) => {
    assert.equal(m.status, 'planted');
    assert.equal(m.plantedOn, '2026-03-01');
  });
});

test('acceptDriftSuggestion rolls the driftId assignment back if the chosen lifecycle is refused', () => {
  const plants = deepFreeze([plant(winecup, 'wc-1', 10, 10), plant(winecup, 'wc-2', 11, 10)]);
  const state = makeState(plants);
  const { driftId, reason } = acceptDriftSuggestion(state, ['wc-1', 'wc-2'], {
    lifecycle: { status: 'planted', plantedOn: '2999-01-01' },
  });
  assert.equal(driftId, null);
  assert.match(reason, /future/);
  assert.deepStrictEqual(state.plants, plants, 'no driftId left dangling on a refused lifecycle');
});

test('acceptDriftSuggestion needs no explicit lifecycle when members already agree', () => {
  const plants = deepFreeze([
    plant(winecup, 'wc-1', 10, 10, { status: 'planted', plantedOn: '2026-03-01' }),
    plant(winecup, 'wc-2', 11, 10, { status: 'planted', plantedOn: '2026-03-01' }),
  ]);
  const state = makeState(plants);
  const { driftId, members, reason } = acceptDriftSuggestion(state, ['wc-1', 'wc-2']);
  assert.equal(reason, null);
  assert.ok(driftId);
  members.forEach((m) => assert.equal(m.plantedOn, '2026-03-01'));
});

test('setDriftLifecycle on an unknown driftId', () => {
  assert.deepStrictEqual(setDriftLifecycle(makeState(baseDrift()), 'nope', { status: 'planted' }), {
    members: [],
    problems: [],
  });
});
