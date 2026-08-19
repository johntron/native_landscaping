import test from 'node:test';
import assert from 'node:assert/strict';
import { computePlantState } from '../src/state/seasonalState.js';

const basePlant = {
  growingMonths: [3, 4],
  floweringMonths: [4],
  foliageColors: {
    spring: '#77aa55',
    summer: '#669944',
    fall: '#aa7733',
    winter: '#664422',
  },
  leafColor: '#77aa55',
  flowerColor: '#ee88aa',
  dormantColor: '#998866',
};

test('computes seasonal growth and chooses seasonal foliage color', () => {
  const march = computePlantState(basePlant, 3);
  assert.equal(march.isGrowing, true);
  assert.equal(march.isFlowering, false);
  assert.equal(march.foliageColor, '#77aa55');
  assert.equal(march.flowerColor, null);

  const april = computePlantState(basePlant, 4);
  assert.equal(april.isGrowing, true);
  assert.equal(april.isFlowering, true);
  assert.equal(april.foliageColor, '#77aa55');
  assert.equal(april.flowerColor, '#ee88aa');
});

test('falls back to dormant palette when outside growth season', () => {
  const decemberState = computePlantState(basePlant, 12);
  assert.equal(decemberState.isGrowing, false);
  assert.equal(decemberState.isFlowering, false);
  assert.equal(decemberState.foliageColor, '#998866');
  assert.equal(decemberState.flowerColor, null);
});

test('computes fruiting with flower dependency and seasonal window', () => {
  const plantWithFruit = {
    ...basePlant,
    floweringMonths: [4, 5],
    fruitMonths: [8, 9, 10, 11, 12, 1, 2],
    fruitColor: '#b245cc',
    fruitLoad: 'heavy',
  };

  const october = computePlantState(plantWithFruit, 10);
  assert.equal(october.isFruiting, true);
  assert.equal(october.fruitColor, '#b245cc');

  const march = computePlantState(plantWithFruit, 3);
  assert.equal(march.isFruiting, false);
  assert.equal(march.fruitColor, null);

  const plantWithoutFlowering = { ...plantWithFruit, floweringMonths: [] };
  const december = computePlantState(plantWithoutFlowering, 12);
  assert.equal(december.isFruiting, false);
});
