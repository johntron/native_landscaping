import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlantsFromCsv } from '../src/data/plantParser.js';

const baseCsvHeader = 'id,common_name,growing_season_months,flowering_season_months,foliage_color_spring,foliage_color_summer,foliage_color_fall,foliage_color_winter,flower_color,x_ft,y_ft,width_ft,height_ft,growth_shape';

test('parses seasonal month ranges and foliage palette', () => {
  const csv = `${baseCsvHeader}\n`
    + 'a,Turkscap,3-5,6-7,#6fa45f,#4d8c4d,#c08050,#917447,pink,10,5,3,4,vertical';

  const plants = parsePlantsFromCsv(csv);
  const plant = plants[0];

  assert.deepStrictEqual(plant.growingMonths, [3, 4, 5]);
  assert.deepStrictEqual(plant.floweringMonths, [6, 7]);
  assert.equal(plant.foliageColors.spring, '#6fa45f');
  assert.equal(plant.foliageColors.summer, '#4d8c4d');
  assert.equal(plant.foliageColors.fall, '#c08050');
  assert.equal(plant.foliageColors.winter, '#917447');
});

test('handles wrap-around growth windows and growth shape aliases', () => {
  const csv = `${baseCsvHeader}\n`
    + 'b,Lyme grass,11-2,4-5,,,,,white,0,0,2,2,groundcover';

  const [plant] = parsePlantsFromCsv(csv);

  assert.deepStrictEqual(plant.growingMonths, [11, 12, 1, 2]);
  assert.equal(plant.growthShape, 'creeping');
});
