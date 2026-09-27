import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeciesCsv, createPlantFromSpecies } from '../src/data/plantParser.js';
import { addPlantFromCatalog, clonePlantById, removePlantById } from '../src/state/plantEdits.js';

const speciesHeader = 'id,common_name,botanical_name,growing_season_months,flowering_season_months,foliage_color_spring,foliage_color_summer,foliage_color_fall,foliage_color_winter,flower_color,width_ft,height_ft,growth_shape';
const species = parseSpeciesCsv(
  `${speciesHeader}\n` +
    'turkscap,Turkscap,Malvaviscus arboreus var. drummondii,3-11,6-10,#6fa45f,#4d8c4d,#c08050,#917447,red,3,4,mound\n' +
    'aster,Fall aster,Symphyotrichum oblongifolium,3-11,9-11,#6fa45f,#4d8c4d,#c08050,#917447,purple,2,2,mound'
);

// An explicit plan view: 20 ft x 10 ft at 10 px/ft, origin at the yard corner.
const plan = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 200, height: 100 },
  extentFt: { width: 20, height: 10 },
  originFt: { x: 0, y: 0 },
};

// A plan padded 2ft past the yard on every side, the way deriveViewGeometry
// actually builds one: originFt sits outside the yard corner and extentFt
// covers the yard plus the margin on both ends.
const paddedPlan = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 240, height: 140 },
  extentFt: { width: 24, height: 14 },
  originFt: { x: -2, y: -2 },
};

function makeState(plants = [], { views = [plan], yardFt } = {}) {
  const project = { views };
  if (yardFt) project.yardFt = yardFt;
  return { plants, species, project };
}

test('addPlantFromCatalog places one plant at the middle of the plan view', () => {
  const state = makeState();
  const before = state.plants;
  const plant = addPlantFromCatalog(state, species[0].speciesId);
  assert.equal(plant.x, 10);
  assert.equal(plant.y, 5);
  assert.equal(state.plants.length, 1);
  assert.notEqual(state.plants, before, 'replaces the array rather than mutating it');
  assert.match(plant.id, /malvaviscus/);
});

test('addPlantFromCatalog refuses an unknown species or a project with no plan', () => {
  assert.equal(addPlantFromCatalog(makeState(), 'no such plant'), null);
  assert.equal(addPlantFromCatalog(makeState(), ''), null);
  const noPlan = { plants: [], species, project: { views: [] } };
  assert.equal(addPlantFromCatalog(noPlan, species[0].speciesId), null);
});

test('addPlantFromCatalog places the plant at `at` when given and inside the yard', () => {
  const state = makeState([], { yardFt: { width: 20, depth: 10 } });
  const plant = addPlantFromCatalog(state, species[0].speciesId, { at: { x: 3, y: 7 } });
  assert.equal(plant.x, 3);
  assert.equal(plant.y, 7);
});

test('addPlantFromCatalog clamps `at` to the declared yard, not to the padded drawing extent', () => {
  // The plan draws 2ft of margin past the yard on every side; a point in that
  // margin must still land at the yard edge (0..20, 0..10), never at the
  // plan's own extent (which would allow -2..22, -2..12).
  const state = makeState([], { views: [paddedPlan], yardFt: { width: 20, depth: 10 } });
  const inMargin = addPlantFromCatalog(state, species[0].speciesId, { at: { x: -1.5, y: 11.5 } });
  assert.equal(inMargin.x, 0);
  assert.equal(inMargin.y, 10);
});

test('addPlantFromCatalog falls back to the plan middle when `at` is given but there is no declared yard', () => {
  const state = makeState([], { yardFt: undefined });
  const plant = addPlantFromCatalog(state, species[0].speciesId, { at: { x: 1, y: 1 } });
  assert.equal(plant.x, 10);
  assert.equal(plant.y, 5);
});

test('addPlantFromCatalog falls back to the plan middle when `at` is missing or not finite', () => {
  const state = makeState([], { yardFt: { width: 20, depth: 10 } });
  assert.equal(addPlantFromCatalog(state, species[0].speciesId, {}).x, 10);
  assert.equal(
    addPlantFromCatalog(state, species[0].speciesId, { at: { x: NaN, y: 5 } }).x,
    10
  );
});

test('clonePlantById copies a plant beside the original with a fresh id', () => {
  const source = createPlantFromSpecies(species[1], { id: 'aster-1', x: 4, y: 4 });
  const state = makeState([source]);
  const clone = clonePlantById(state, 'aster-1');
  assert.equal(clone.id, 'aster-1-copy');
  assert.ok(clone.x > source.x && clone.y > source.y);
  assert.equal(state.plants.length, 2);
  // A second clone of the same plant cannot collide with the first.
  assert.equal(clonePlantById(state, 'aster-1').id, 'aster-1-copy-2');
});

test('clonePlantById keeps a clone of an edge plant on the plan', () => {
  const edge = createPlantFromSpecies(species[1], { id: 'edge', x: 19.9, y: 9.9 });
  const clone = clonePlantById(makeState([edge]), 'edge');
  assert.equal(clone.x, 20);
  assert.equal(clone.y, 10);
});

test('clonePlantById returns null for an unknown id', () => {
  assert.equal(clonePlantById(makeState(), 'nope'), null);
});

test('removePlantById reports whether anything was removed', () => {
  const a = createPlantFromSpecies(species[0], { id: 'a', x: 1, y: 1 });
  const b = createPlantFromSpecies(species[1], { id: 'b', x: 2, y: 2 });
  const state = makeState([a, b]);
  assert.equal(removePlantById(state, 'a'), true);
  assert.deepEqual(state.plants.map((p) => p.id), ['b']);
  assert.equal(removePlantById(state, 'a'), false);
  assert.equal(removePlantById(state, ''), false);
});
