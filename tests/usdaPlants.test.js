import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeasonPhrase, parseSeasonRange } from '../tools/usda-plants/seasonMonths.js';
import { colorNameToHex } from '../tools/usda-plants/colorNames.js';
import { mapPlantToIntermediateRow } from '../tools/usda-plants/mapCharacteristics.js';
import { rowsToCsv } from '../tools/usda-plants/csvWriter.js';
import { filterToRegion } from '../tools/usda-plants/regionFilter.js';

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
  // plants.csv matches species by the author-free name; the full citation
  // stays in the usda_* reference column.
  assert.equal(row.botanical_name, 'Abies balsamea');
  assert.equal(row.usda_scientific_name_full, 'Abies balsamea (L.) Mill.');
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

test('mapPlantToIntermediateRow keeps the infraspecific epithet in botanical_name', () => {
  // Without the rank + second epithet, a variety and its parent species share
  // one botanical_name, and getSpeciesKey (which ignores species_epithet when a
  // botanical name is present) cannot tell the two catalog rows apart.
  const row = mapPlantToIntermediateRow(
    {
      Symbol: 'ACMIO',
      ScientificName: '<i>Achillea millefolium</i> L. var. <i>occidentalis</i> DC.',
      CommonName: 'western yarrow',
      GrowthHabits: ['Forb/herb'],
      NativeStatuses: [],
    },
    [],
  );
  assert.equal(row.botanical_name, 'Achillea millefolium var. occidentalis');
  assert.equal(row.usda_scientific_name_full, 'Achillea millefolium L. var. occidentalis DC.');
});

test('rowsToCsv escapes commas and quotes', () => {
  const csv = rowsToCsv(['a', 'b'], [{ a: 'has,comma', b: 'has "quote"' }]);
  assert.equal(csv, 'a,b\n"has,comma","has ""quote"""\n');
});

test('filterToRegion keeps list species, separates non-natives, reports gaps', () => {
  const csv = [
    'id,common_name,botanical_name,usda_native_status',
    'a,fragrant sumac,Rhus aromatica var. serotina,L48:N',
    'b,Japanese privet,Ligustrum japonicum,L48:I',
    'c,desertbroom,Baccharis sarothroides,L48:N',
  ].join('\n');
  // "Rhus aromatica" matches the var. serotina record — a regional list gives
  // the bare binomial, USDA carries the infraspecific taxon.
  const { native, introduced, unmatched } = filterToRegion(csv, [
    'Rhus aromatica',
    'Ligustrum japonicum',
    'Aquilegia canadensis',
  ]);
  assert.deepEqual(native.map((r) => r[2]), ['Rhus aromatica var. serotina']);
  // On the regional list but introduced — the DFW list's "invasives to remove"
  // rows arrive this way and must not reach a planting recommendation.
  assert.deepEqual(introduced.map((r) => r[2]), ['Ligustrum japonicum']);
  // Off the list entirely: alkaline-clay-tolerant, but Sonoran, not Blackland.
  assert.equal(native.some((r) => r[2] === 'Baccharis sarothroides'), false);
  // On the list, but USDA has no characteristics record for it.
  assert.deepEqual(unmatched, ['aquilegia canadensis']);
});

test('filterToRegion keeps the nominate record over unlisted varieties', () => {
  const csv = [
    'id,common_name,botanical_name,usda_native_status',
    'a,sugarberry,Celtis laevigata,L48:N',
    'b,netleaf hackberry,Celtis laevigata var. reticulata,L48:N',
    'c,eastern redbud,Cercis canadensis,L48:N',
    'd,Texas redbud,Cercis canadensis var. texensis,L48:N',
    'e,fragrant sumac,Rhus aromatica var. serotina,L48:N',
  ].join('\n');
  const { native } = filterToRegion(csv, [
    'Celtis laevigata',                 // bare binomial: the western var. must not ride along
    'Cercis canadensis',
    'Cercis canadensis var. texensis',  // named outright: keep it as well as the nominate
    'Rhus aromatica',                   // USDA has no nominate record — keep what exists
  ]);
  assert.deepEqual(native.map((r) => r[2]).sort(), [
    'Celtis laevigata',
    'Cercis canadensis',
    'Cercis canadensis var. texensis',
    'Rhus aromatica var. serotina',
  ]);
});

test('Shade Tolerance Low/Medium/High reads as light requirement, not shade tolerance', () => {
  // The live API's Low/Medium/High run opposite to the documented
  // Intolerant/Intermediate/Tolerant enum: little bluestem, an obligate full-sun
  // prairie grass, comes back "High"; Carex blanda, a woodland sedge, "Low".
  const profile = {
    Symbol: 'SCSC',
    ScientificName: '<i>Schizachyrium scoparium</i> (Michx.) Nash',
    CommonName: 'little bluestem',
    GrowthHabits: ['Graminoid'],
    NativeStatuses: [],
  };
  const sun = (value) =>
    mapPlantToIntermediateRow(profile, [
      { PlantCharacteristicName: 'Shade Tolerance', PlantCharacteristicValue: value },
    ]).sun_pref;
  assert.equal(sun('High'), 'full-sun');
  assert.equal(sun('Low'), 'shade');
  assert.equal(sun('Medium'), 'part-sun');
  // The documented enum still maps by its own plain meaning.
  assert.equal(sun('Intolerant'), 'full-sun');
  assert.equal(sun('Tolerant'), 'shade');
});
