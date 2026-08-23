import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeasonPhrase, parseSeasonRange } from '../tools/usda-plants/seasonMonths.js';
import { colorNameToHex } from '../tools/usda-plants/colorNames.js';
import { mapPlantToIntermediateRow } from '../tools/usda-plants/mapCharacteristics.js';
import { rowsToCsv } from '../tools/usda-plants/csvWriter.js';

test('parseSeasonPhrase converts contiguous season names to a month range', () => {
  assert.equal(parseSeasonPhrase('Spring and Summer'), '3-8');
  assert.equal(parseSeasonPhrase('Fall'), '9-11');
  assert.equal(parseSeasonPhrase('Mid Summer'), '7');
  assert.equal(parseSeasonPhrase('Year Round'), '1-12');
  assert.equal(parseSeasonPhrase('None'), null);
  assert.equal(parseSeasonPhrase(''), null);
});

test('parseSeasonRange combines begin/end phrases into one range', () => {
  assert.equal(parseSeasonRange('Fall', 'Fall'), '9-11');
  assert.equal(parseSeasonRange('Summer', 'Fall'), '6-11');
  assert.equal(parseSeasonRange(null, null), null);
});

test('colorNameToHex maps known USDA color words', () => {
  assert.equal(colorNameToHex('Yellow'), '#e8d24a');
  assert.equal(colorNameToHex('Brown'), '#6b5a4a');
  assert.equal(colorNameToHex('Some Unknown Color'), null);
  assert.equal(colorNameToHex(null), null);
});

test('mapPlantToIntermediateRow derives plants.csv fields from USDA data', () => {
  const profile = {
    Symbol: 'ABBA',
    ScientificName: '<i>Abies balsamea</i> (L.) Mill.',
    CommonName: 'balsam fir',
    GrowthHabits: ['Tree'],
    NativeStatuses: [{ Region: 'L48', Status: 'N' }],
  };
  const characteristics = [
    { PlantCharacteristicName: 'Active Growth Period', PlantCharacteristicValue: 'Spring and Summer' },
    { PlantCharacteristicName: 'Bloom Period', PlantCharacteristicValue: 'Mid Summer' },
    { PlantCharacteristicName: 'Flower Color', PlantCharacteristicValue: 'Yellow' },
    { PlantCharacteristicName: 'Foliage Color', PlantCharacteristicValue: 'Green' },
    { PlantCharacteristicName: 'Shade Tolerance', PlantCharacteristicValue: 'Intolerant' },
    { PlantCharacteristicName: 'Moisture Use', PlantCharacteristicValue: 'Medium' },
    { PlantCharacteristicName: 'Adapted to Coarse Textured Soils', PlantCharacteristicValue: 'Yes' },
    { PlantCharacteristicName: 'Adapted to Medium Textured Soils', PlantCharacteristicValue: 'Yes' },
    { PlantCharacteristicName: 'Adapted to Fine Textured Soils', PlantCharacteristicValue: 'Yes' },
    { PlantCharacteristicName: 'Height, Mature (feet)', PlantCharacteristicValue: '60.0' },
    { PlantCharacteristicName: 'Fruit/Seed Color', PlantCharacteristicValue: 'Brown' },
    { PlantCharacteristicName: 'Fruit/Seed Period Begin', PlantCharacteristicValue: 'Fall' },
    { PlantCharacteristicName: 'Fruit/Seed Period End', PlantCharacteristicValue: 'Fall' },
    { PlantCharacteristicName: 'Fruit/Seed Abundance', PlantCharacteristicValue: 'Medium' },
  ];

  const row = mapPlantToIntermediateRow(profile, characteristics);

  assert.equal(row.id, 'balsam-fir');
  assert.equal(row.common_name, 'balsam fir');
  assert.equal(row.botanical_name, 'Abies balsamea (L.) Mill.');
  assert.equal(row.growth_shape, 'tree');
  assert.equal(row.growing_season_months, '3-8');
  assert.equal(row.flowering_season_months, '7');
  assert.equal(row.flower_color, '#e8d24a');
  assert.equal(row.foliage_color_summer, '#5b7a4b');
  assert.equal(row.sun_pref, 'full-sun');
  assert.equal(row.water_pref, 'medium');
  assert.equal(row.soil_pref, 'sandy,loamy,clay');
  assert.equal(row.height_ft, 60);
  assert.equal(row.fruit_color, '#6b5a4a');
  assert.equal(row.fruit_season_months, '9-11');
  assert.equal(row.fruit_load, 'moderate');
  assert.equal(row.usda_symbol, 'ABBA');
  assert.equal(row.usda_native_status, 'L48:N');
});

test('rowsToCsv escapes commas and quotes', () => {
  const csv = rowsToCsv(['a', 'b'], [{ a: 'has,comma', b: 'has "quote"' }]);
  assert.equal(csv, 'a,b\n"has,comma","has ""quote"""\n');
});
