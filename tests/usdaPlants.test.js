import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSeasonPhrase, parseSeasonRange } from '../tools/usda-plants/seasonMonths.js';
import { colorNameToHex } from '../tools/usda-plants/colorNames.js';
import { mapPlantToIntermediateRow } from '../tools/usda-plants/mapCharacteristics.js';
import { rowsToCsv } from '../tools/usda-plants/csvWriter.js';
import { filterToRegion } from '../tools/usda-plants/regionFilter.js';
import { USDA_TARGET_FIELDS, sniffFields, probeUsda } from '../tools/usda-plants/probe.js';
import { openProbeCache, getCached, setCached, cached } from '../tools/usda-plants/probeCache.js';

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

test('mapPlantToIntermediateRow carries the previously-discarded characteristics as raw columns', () => {
  // nl-yud: these were already in every USDA characteristics response and
  // discarded by the mapper — recovering them costs no new request.
  const row = mapPlantToIntermediateRow(
    { Symbol: 'QUSH', ScientificName: '<i>Quercus shumardii</i> Buckland', GrowthHabits: ['Tree'], NativeStatuses: [] },
    [
      { PlantCharacteristicName: 'Commercial Availability', PlantCharacteristicValue: 'Routinely Available' },
      { PlantCharacteristicName: 'Toxicity', PlantCharacteristicValue: 'None' },
      { PlantCharacteristicName: 'Lifespan', PlantCharacteristicValue: 'Long' },
      { PlantCharacteristicName: 'Vegetative Spread Rate', PlantCharacteristicValue: 'None' },
      { PlantCharacteristicName: 'Seed Spread Rate', PlantCharacteristicValue: 'Slow' },
      { PlantCharacteristicName: 'Resprout Ability', PlantCharacteristicValue: 'No' },
      { PlantCharacteristicName: 'Fruit/Seed Persistence', PlantCharacteristicValue: 'No' },
      { PlantCharacteristicName: 'Growth Rate', PlantCharacteristicValue: 'Moderate' },
      { PlantCharacteristicName: 'Height at 20 Years, Maximum', PlantCharacteristicValue: '35' },
    ],
  );
  assert.equal(row.usda_commercial_availability, 'Routinely Available');
  assert.equal(row.usda_toxicity, 'None');
  assert.equal(row.usda_lifespan, 'Long');
  assert.equal(row.usda_vegetative_spread_rate, 'None');
  assert.equal(row.usda_seed_spread_rate, 'Slow');
  assert.equal(row.usda_resprout_ability, 'No');
  assert.equal(row.usda_fruit_seed_persistence, 'No');
  assert.equal(row.usda_growth_rate, 'Moderate');
  assert.equal(row.usda_height_20yr_max_ft, '35');
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

test('water_pref reads Moisture Use only — Drought Tolerance is a different scale and must not backfill it', () => {
  // nl-yud: Drought Tolerance is a lower bound, Moisture Use an optimum.
  // Falling back to Drought Tolerance when Moisture Use is absent can
  // invert the answer (High drought tolerance means the plant wants LESS
  // water, not more) — the same class of bug as the documented Shade
  // Tolerance inversion. High drought tolerance with no Moisture Use must
  // read as unknown, not as "high" water_pref.
  const profile = { Symbol: 'X', ScientificName: '<i>Testus plantus</i>', GrowthHabits: [], NativeStatuses: [] };
  const row = mapPlantToIntermediateRow(profile, [
    { PlantCharacteristicName: 'Drought Tolerance', PlantCharacteristicValue: 'High' },
  ]);
  assert.equal(row.water_pref, null);
  assert.equal(row.usda_drought_tolerance, 'High');
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

// nl-41o.9: the source probe's field sniff and its response cache.

test('sniffFields reports population from RAW USDA shapes, not a normalized view', () => {
  const profile = { NativeStatuses: [{ Region: 'L48', Status: 'N' }] };
  const characteristics = [
    { PlantCharacteristicName: 'Commercial Availability', PlantCharacteristicValue: 'Routinely Available' },
    { PlantCharacteristicName: 'Shade Tolerance', PlantCharacteristicValue: 'High' },
  ];
  const results = sniffFields(USDA_TARGET_FIELDS, profile, characteristics);
  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));

  // Populated, but flagged: NativeStatuses is regional, never county — the
  // sniff must not silently upgrade "some value present" to "county nativity".
  assert.equal(byKey.county_nativity.populated, true);
  assert.equal(byKey.county_nativity.value, 'L48:N');
  assert.match(byKey.county_nativity.note, /REGIONAL/);

  // A field with no matching characteristic name anywhere in the response
  // reads as genuinely absent, not as a parse failure.
  assert.equal(byKey.mature_width.populated, false);
  assert.equal(byKey.mature_width.value, null);

  assert.equal(byKey.commercial_availability.populated, true);
  assert.equal(byKey.commercial_availability.value, 'Routinely Available');

  // A field not present in this response's characteristics list at all.
  assert.equal(byKey.soil_tolerance_coarse.populated, false);

  // nl-yud's newly-probed fields: unpopulated in this response, which is the
  // point of probing them across species before relying on the QUSH sample.
  assert.equal(byKey.fruit_seed_persistence.populated, false);
  assert.equal(byKey.toxicity.populated, false);
});

test('sniffFields reads the nl-yud fields when present in the response', () => {
  const characteristics = [
    { PlantCharacteristicName: 'Fruit/Seed Persistence', PlantCharacteristicValue: 'No' },
    { PlantCharacteristicName: 'Toxicity', PlantCharacteristicValue: 'None' },
    { PlantCharacteristicName: 'Lifespan', PlantCharacteristicValue: 'Long' },
    { PlantCharacteristicName: 'Vegetative Spread Rate', PlantCharacteristicValue: 'None' },
    { PlantCharacteristicName: 'Seed Spread Rate', PlantCharacteristicValue: 'Slow' },
    { PlantCharacteristicName: 'Resprout Ability', PlantCharacteristicValue: 'No' },
    { PlantCharacteristicName: 'Growth Rate', PlantCharacteristicValue: 'Moderate' },
    { PlantCharacteristicName: 'Height at 20 Years, Maximum', PlantCharacteristicValue: '35' },
  ];
  const byKey = Object.fromEntries(
    sniffFields(USDA_TARGET_FIELDS, {}, characteristics).map((r) => [r.key, r]),
  );
  assert.equal(byKey.fruit_seed_persistence.value, 'No');
  assert.equal(byKey.toxicity.value, 'None');
  assert.equal(byKey.lifespan.value, 'Long');
  assert.equal(byKey.vegetative_spread_rate.value, 'None');
  assert.equal(byKey.seed_spread_rate.value, 'Slow');
  assert.equal(byKey.resprout_ability.value, 'No');
  assert.equal(byKey.growth_rate.value, 'Moderate');
  assert.equal(byKey.height_20yr_max.value, '35');
});

test('sniffFields treats an empty NativeStatuses array as unpopulated', () => {
  const results = sniffFields(USDA_TARGET_FIELDS, { NativeStatuses: [] }, []);
  const nativity = results.find((r) => r.key === 'county_nativity');
  assert.equal(nativity.populated, false);
  assert.equal(nativity.value, null);
});

test('mature_width sniff scans this response\'s own keys rather than asserting absence blind', () => {
  // No width-shaped key anywhere: the diagnostic must say what it actually
  // checked, not just assert absence from three guessed names.
  const noMatch = sniffFields(
    USDA_TARGET_FIELDS,
    {},
    [{ PlantCharacteristicName: 'Shade Tolerance', PlantCharacteristicValue: 'High' }],
  ).find((r) => r.key === 'mature_width');
  assert.equal(noMatch.populated, false);
  assert.match(noMatch.diagnostic, /scanned 1 characteristic key/);

  // A key the exact-match list doesn't know about, but the regex catches —
  // this must NOT be auto-adopted as the value (measured live: "Seed Spread
  // Rate" and "Vegetative Spread Rate" both match /spread/ on a real probed
  // species and are propagation-rate fields, not width). It's a pointer for
  // a human to check, surfaced only in the diagnostic.
  const nearMiss = sniffFields(
    USDA_TARGET_FIELDS,
    {},
    [{ PlantCharacteristicName: 'Canopy Spread (feet)', PlantCharacteristicValue: '12' }],
  ).find((r) => r.key === 'mature_width');
  assert.equal(nearMiss.populated, false);
  assert.equal(nearMiss.value, null);
  assert.match(nearMiss.diagnostic, /Canopy Spread \(feet\)/);
  assert.match(nearMiss.diagnostic, /NOT auto-adopted/);

  // The exact canonical key.
  const exact = sniffFields(
    USDA_TARGET_FIELDS,
    {},
    [{ PlantCharacteristicName: 'Width, Mature (feet)', PlantCharacteristicValue: '15' }],
  ).find((r) => r.key === 'mature_width');
  assert.equal(exact.populated, true);
  assert.equal(exact.value, '15');
});

test('probe cache: a miss fetches and caches, a hit does not re-fetch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-cache-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openProbeCache(join(dir, 'cache.db'));

  let fetchCount = 0;
  const fetcher = () => {
    fetchCount++;
    return { hello: 'world' };
  };

  const first = await cached(db, 'usda', 'PlantProfile', 12345, fetcher);
  assert.equal(first.cached, false);
  assert.deepEqual(first.raw, { hello: 'world' });
  assert.equal(fetchCount, 1);

  const second = await cached(db, 'usda', 'PlantProfile', 12345, fetcher);
  assert.equal(second.cached, true);
  assert.deepEqual(second.raw, { hello: 'world' });
  assert.equal(fetchCount, 1, 'a cache hit must not call the fetcher again');

  const third = await cached(db, 'usda', 'PlantProfile', 12345, fetcher, { force: true });
  assert.equal(third.cached, false);
  assert.equal(fetchCount, 2, 'force must bypass the cache read');
});

test('probeUsda surfaces characteristicsCount so a zero-record taxon is distinguishable from a real gap', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-cache-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openProbeCache(join(dir, 'cache.db'));
  const fakeClient = {
    getProfile: async () => ({ Symbol: 'SYOB', NativeStatuses: [] }),
    getCharacteristics: async () => [],
  };

  const result = await probeUsda(fakeClient, db, 40799);
  assert.equal(result.characteristicsCount, 0);
  // Every target field reads populated:false here — characteristicsCount is
  // what tells this apart from a species that has a record but genuinely
  // lacks these fields.
  assert.equal(result.fieldSniff.every((f) => !f.populated), true);
});

test('probe cache keys are scoped by (source, endpoint, key)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-cache-test-'));
  const db = openProbeCache(join(dir, 'cache.db'));
  setCached(db, 'usda', 'PlantProfile', 1, { a: 1 });
  setCached(db, 'usda', 'PlantCharacteristics', 1, { a: 2 });
  setCached(db, 'npin', 'PlantProfile', 1, { a: 3 });

  assert.deepEqual(getCached(db, 'usda', 'PlantProfile', 1).raw, { a: 1 });
  assert.deepEqual(getCached(db, 'usda', 'PlantCharacteristics', 1).raw, { a: 2 });
  assert.deepEqual(getCached(db, 'npin', 'PlantProfile', 1).raw, { a: 3 });
  assert.equal(getCached(db, 'usda', 'PlantProfile', 999), null);
  rmSync(dir, { recursive: true, force: true });
});
