import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlantsFromCsv, parseSpeciesCsv } from '../src/data/plantParser.js';

const speciesHeader = 'id,common_name,botanical_name,growing_season_months,flowering_season_months,foliage_color_spring,foliage_color_summer,foliage_color_fall,foliage_color_winter,flower_color,width_ft,height_ft,growth_shape';

test('parses species seasonal month ranges and foliage palette', () => {
  const csv = `${speciesHeader}\n`
    + 'a,Turkscap,Malvaviscus arboreus var. drummondii,3-5,6-7,#6fa45f,#4d8c4d,#c08050,#917447,pink,3,4,vertical';

  const species = parseSpeciesCsv(csv);
  const plant = species[0];

  assert.deepStrictEqual(plant.growingMonths, [3, 4, 5]);
  assert.deepStrictEqual(plant.floweringMonths, [6, 7]);
  assert.equal(plant.foliageColors.spring, '#6fa45f');
  assert.equal(plant.foliageColors.summer, '#4d8c4d');
  assert.equal(plant.foliageColors.fall, '#c08050');
  assert.equal(plant.foliageColors.winter, '#917447');
  assert.equal(plant.botanicalKey, 'malvaviscus arboreus var. drummondii');
});

test('builds plants by matching layout botanical_name to species dimensions and structure', () => {
  const speciesCsv = `${speciesHeader}\n`
    + 'b,Lyme grass,Elymus arenarius,11-2,4-5,,,,,white,2,2,groundcover\n'
    + 'c,Autumn sage,Salvia greggii,3-11,3-11,,,,,red,3,3,mound';
  const layoutHeader = 'id,botanical_name,x_ft,y_ft';
  const layoutCsv = `${layoutHeader}\n`
    + 'a,Elymus arenarius,10,5\n'
    + 'b,Salvia greggii,20,6';

  const plants = buildPlantsFromCsv(speciesCsv, layoutCsv);

  assert.equal(plants.length, 2);
  assert.equal(plants[0].growthShape, 'creeping');
  assert.equal(plants[0].width, 2);
  assert.equal(plants[0].height, 2);
  assert.equal(plants[0].x, 10);
  assert.equal(plants[0].y, 5);

  assert.equal(plants[1].growthShape, 'mound');
  assert.equal(plants[1].width, 3);
  assert.equal(plants[1].height, 3);
  assert.equal(plants[1].botanicalName, 'Salvia greggii');
});

test('parses wraparound seasonal ranges across year end', () => {
  const csv = `${speciesHeader}\n`
    + 'd,Seedbox,Ludwigia alternifolia,11-2,12-1,#5f7b6a,#587161,#c27f4d,#9e7b5e,yellow,2,3,mound';

  const [species] = parseSpeciesCsv(csv);
  assert.deepStrictEqual(species.growingMonths, [11, 12, 1, 2]);
  assert.deepStrictEqual(species.floweringMonths, [12, 1]);
});

test('throws when layout references unknown species', () => {
  const speciesCsv = `${speciesHeader}\n`
    + 'e,Coreopsis,Coreopsis tinctoria,4-9,5-7,,,,,yellow,2,2,mound';
  const layoutCsv = 'id,botanical_name,x_ft,y_ft\nmissing,Nonexistent plant,1,1';

  assert.throws(
    () => buildPlantsFromCsv(speciesCsv, layoutCsv),
    /Unknown plant "nonexistent plant" in layout row missing/
  );
});
