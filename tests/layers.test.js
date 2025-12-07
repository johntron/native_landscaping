import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANT_LAYERS,
  classifyPlantLayer,
  clampHiddenLayerCount,
  filterPlantStatesByHiddenLayers,
} from '../src/state/layers.js';

test('classifyPlantLayer buckets plants by growth shape and height', () => {
  assert.equal(classifyPlantLayer({ height: 0.6, growthShape: 'creeping' }), 'groundcover');
  assert.equal(classifyPlantLayer({ height: 10, growthShape: 'mound', width: 2 }), 'trees');
  assert.equal(classifyPlantLayer({ height: 5, growthShape: 'vertical' }), 'sculptural');
  assert.equal(classifyPlantLayer({ height: 2, growthShape: 'mound' }), 'accents');
  assert.equal(classifyPlantLayer({ height: 0.2 }), 'groundcover');
  assert.equal(classifyPlantLayer({ height: 6, growthShape: 'tree' }), 'trees');
});

test('clampHiddenLayerCount enforces bounds and rounds cleanly', () => {
  assert.equal(clampHiddenLayerCount(-1), 0);
  assert.equal(clampHiddenLayerCount('foo'), 0);
  assert.equal(clampHiddenLayerCount(1.6), 2);
  assert.equal(clampHiddenLayerCount(PLANT_LAYERS.length + 10), PLANT_LAYERS.length);
});

test('filterPlantStatesByHiddenLayers hides the requested strata', () => {
  const plantStates = PLANT_LAYERS.map((layer) => ({
    plant: { id: `plant-${layer}`, layer },
    state: {},
  }));

  const allLayers = filterPlantStatesByHiddenLayers(plantStates, 0);
  assert.deepStrictEqual(allLayers, plantStates);

  const hiddenOne = filterPlantStatesByHiddenLayers(plantStates, 1);
  assert.deepStrictEqual(hiddenOne.map((s) => s.plant.layer), PLANT_LAYERS.slice(1));

  const hiddenTwo = filterPlantStatesByHiddenLayers(plantStates, 2);
  assert.deepStrictEqual(hiddenTwo.map((s) => s.plant.layer), PLANT_LAYERS.slice(2));

  const clamped = filterPlantStatesByHiddenLayers(plantStates, -5);
  assert.deepStrictEqual(clamped, plantStates);
});
