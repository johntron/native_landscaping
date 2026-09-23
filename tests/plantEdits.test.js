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

function makeState(plants = []) {
  return { plants, species, project: { views: [plan] } };
}

test('addPlantFromCatalog places one plant at the middle of the plan view', () => {
  const state = makeState();
  const before = state.plants;
  const plant = addPlantFromCatalog(state, species[0].botanicalKey);
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
  assert.equal(addPlantFromCatalog(noPlan, species[0].botanicalKey), null);
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
