import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlantsFromCsv,
  createPlantFromSpecies,
  LayoutDataError,
  parsePlantLayoutCsv,
  parseSpeciesCsv,
  plantsFromPlacements,
} from '../src/data/plantParser.js';
import { buildLayoutCsv } from '../src/data/layoutExporter.js';
import { parseSynonymCsv } from '../src/data/speciesResolver.js';
import { readFileSync } from 'node:fs';

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

test('a species missing width_ft gets a shape-appropriate estimate instead of a flat 1 ft default', () => {
  const csv = `${speciesHeader}\n`
    + 'creep,Creeper,Dichondra argentea,,,,,,,,,2,creeping\n'
    + 'unknownshape,Mystery,Mysterium plantus,,,,,,,,,4,exotic-shape';
  const species = parseSpeciesCsv(csv);

  const creeper = createPlantFromSpecies(species[0], { id: 'p1', x: 0, y: 0 });
  // creeping ratio is 7.5 — a groundcover spreads far wider than it stands tall.
  assert.equal(creeper.width, 15);

  const unknownShape = createPlantFromSpecies(species[1], { id: 'p2', x: 0, y: 0 });
  // no ratio declared for this shape falls back to 1:1 with height.
  assert.equal(unknownShape.width, 4);
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
    /Unknown plant "Nonexistent plant" in layout row missing/
  );
});

test('parses inflorescence metadata and carries it through plant instances', () => {
  const speciesCsv = `${speciesHeader},inflorescence,flower_count_hint,flower_zone\n`
    + 'f,Goldenrod,solidago speciosa,3-10,8-10,,,,,yellow,3,5,vertical,spike,18,upper\n'
    + 'g,Gregg\'s mistflower,Conoclinium greggii,3-11,6-10,,,,,purple,3,2,mound,umbel,25,mid\n'
    + 'h,Maximilian sunflower,Helianthus maximiliani,3-11,8-10,,,,,yellow,3,6,vertical,panicle,30,full';

  const layoutCsv = 'id,botanical_name,x_ft,y_ft\n'
    + 'plant-f,solidago speciosa,1,1\n'
    + 'plant-g,Conoclinium greggii,2,2\n'
    + 'plant-h,Helianthus maximiliani,3,3';

  const [spec1, spec2, spec3] = parseSpeciesCsv(speciesCsv);
  assert.equal(spec1.inflorescence, 'spike/raceme');
  assert.equal(spec1.flowerCountHint, 18);
  assert.equal(spec1.flowerZone, 'upper');

  assert.equal(spec2.inflorescence, 'umbel/head');
  assert.equal(spec2.flowerCountHint, 25);
  assert.equal(spec2.flowerZone, 'mid');

  assert.equal(spec3.inflorescence, 'panicle/spray');
  assert.equal(spec3.flowerZone, 'full');

  const plants = buildPlantsFromCsv(speciesCsv, layoutCsv);
  assert.equal(plants[0].inflorescence, 'spike/raceme');
  assert.equal(plants[1].flowerCountHint, 25);
  assert.equal(plants[2].flowerZone, 'full');
});

test('parses fruit metadata and carries it through plant instances', () => {
  const speciesCsv = `${speciesHeader},fruit_color,fruit_season_months,fruit_load\n`
    + 'i,Beautyberry,Callicarpa americana,3-11,5-6,,,,,purple,5.5,4.5,arch,#b245cc,8-12,heavy\n'
    + 'j,Holly,Ilex vomitoria,3-12,3-4,,,,,white,10,15,tree,#b3261e,10-2,moderate\n';
  const layoutCsv = 'id,botanical_name,x_ft,y_ft\n'
    + 'berry,Callicarpa americana,2,2\n'
    + 'holly,Ilex vomitoria,5,5';

  const plants = buildPlantsFromCsv(speciesCsv, layoutCsv);
  assert.equal(plants[0].fruitColor, '#b245cc');
  assert.deepStrictEqual(plants[0].fruitMonths, [8, 9, 10, 11, 12]);
  assert.equal(plants[0].fruitLoad, 'heavy');

  assert.equal(plants[1].fruitColor, '#b3261e');
  assert.deepStrictEqual(plants[1].fruitMonths, [10, 11, 12, 1, 2]);
  assert.equal(plants[1].fruitLoad, 'moderate');
});

test('"low" fruit_load is a sparse synonym, not a fall-through to blank (nl-5c8)', () => {
  const speciesCsv = `${speciesHeader},fruit_color,fruit_season_months,fruit_load\n`
    + 'k,Rock rose,Pavonia lasiopetala,3-11,5-11,,,,,red,3.5,3,mound,#a35c4a,8-10,low\n';
  const layoutCsv = 'id,botanical_name,x_ft,y_ft\nrose,Pavonia lasiopetala,1,1';

  const plants = buildPlantsFromCsv(speciesCsv, layoutCsv);
  assert.equal(plants[0].fruitLoad, 'sparse');
});

test('rejects layouts that reuse a plant id', () => {
  const layoutCsv = 'id,botanical_name,x_ft,y_ft\n'
    + 'daisy,Tetraneuris scaposa,1,1\n'
    + 'sage,Salvia greggii,2,2\n'
    + 'daisy,Tetraneuris scaposa,3,3';

  assert.throws(
    () => parsePlantLayoutCsv(layoutCsv),
    /Duplicate plant id "daisy" in layout \(data rows 1 and 3, excluding the header\)/
  );
});

test('accepts layouts whose ids are all distinct', () => {
  const layoutCsv = 'id,botanical_name,x_ft,y_ft\n'
    + 'daisy,Tetraneuris scaposa,1,1\n'
    + 'sage,Salvia greggii,2,2';

  const placements = parsePlantLayoutCsv(layoutCsv);

  assert.deepStrictEqual(placements.map((p) => p.id), ['daisy', 'sage']);
});

test('content mistakes are LayoutDataError so the UI can name the real reason', () => {
  const dupCsv = 'id,botanical_name,x_ft,y_ft\n'
    + 'daisy,Tetraneuris scaposa,1,1\n'
    + 'daisy,Tetraneuris scaposa,2,2';

  assert.throws(() => parsePlantLayoutCsv(dupCsv), LayoutDataError);

  const speciesCsv = `${speciesHeader}\n`
    + 'c,Autumn sage,Salvia greggii,3-11,3-11,,,,,red,3,3,mound';
  const unknownCsv = 'id,botanical_name,x_ft,y_ft\nmystery,Nothing realis,1,1';

  assert.throws(() => buildPlantsFromCsv(speciesCsv, unknownCsv), LayoutDataError);
});

test('a plant built from the catalog round-trips through the layout CSV', () => {
  // The payoff of sharing one builder: a plant added in the browser has to
  // survive being written to planting_layout.csv and read back. Both sides key
  // on the species id (buildLayoutCsv writes speciesId, buildPlantsFromCsv
  // resolves species_id).
  const speciesCsv = `${speciesHeader}\n`
    + 'c,Autumn sage,Salvia greggii,3-11,3-11,,#4d8c4d,,,red,3,4,mound';
  const species = parseSpeciesCsv(speciesCsv);

  const added = createPlantFromSpecies(species[0], { id: 'salvia-greggii-1', x: 12.5, y: 7.25 });

  assert.equal(added.id, 'salvia-greggii-1');
  assert.equal(added.botanicalName, 'Salvia greggii');
  assert.equal(added.width, 3);
  assert.equal(added.height, 4);
  assert.ok(added.layer, 'the layer is computed, as it is for CSV-loaded plants');

  const reloaded = buildPlantsFromCsv(speciesCsv, buildLayoutCsv([added]));

  assert.equal(reloaded.length, 1);
  assert.deepStrictEqual(
    { ...reloaded[0], x: Number(reloaded[0].x.toFixed(3)), y: Number(reloaded[0].y.toFixed(3)) },
    { ...added, x: 12.5, y: 7.25 }
  );
});

/**
 * History stores placements only (nl-3s5.19): a plant is its species plus where
 * it stands, and plantsFromPlacements builds every plant shown from the catalog
 * just parsed, so undo after a catalog correction shows the correction. Legacy
 * full-object snapshots still load; their stored attributes are ignored.
 */
test('plantsFromPlacements takes every attribute from the catalog as it is now', () => {
  const oldSpecies = parseSpeciesCsv(`${speciesHeader}\n`
    + 'c,Autumn sage,Salvia greggii,3-11,3-11,,,,,red,3,3,mound');
  const legacySnapshot = [createPlantFromSpecies(oldSpecies[0], { id: 'sage-1', x: 5, y: 5 })];
  const placement = [{ id: 'sage-1', speciesId: 'c', x: 5, y: 5 }];

  // The catalog has since been corrected: wider, and reclassified as a vase shape.
  const newSpecies = parseSpeciesCsv(`${speciesHeader}\n`
    + 'c,Autumn sage,Salvia greggii,3-11,3-11,,,,,red,5,3,vase');

  const fromPlacement = plantsFromPlacements(placement, newSpecies);
  const fromLegacy = plantsFromPlacements(legacySnapshot, newSpecies);

  assert.equal(fromPlacement[0].width, 5);
  assert.equal(fromPlacement[0].growthShape, 'vase');
  assert.deepStrictEqual(fromLegacy, fromPlacement, 'a legacy snapshot renders exactly as its placement does');
  assert.deepStrictEqual(fromPlacement, [createPlantFromSpecies(newSpecies[0], placement[0])]);
});

test('plantsFromPlacements leaves a placement alone if its species left the catalog', () => {
  const placement = [{ id: 'sage-1', speciesId: 'gone', x: 5, y: 5 }];
  assert.deepStrictEqual(plantsFromPlacements(placement, []), placement);
});

test('optional placement fields ride through createPlantFromSpecies and back', async () => {
  const { toPlacement } = await import('../src/data/placements.js');
  const species = parseSpeciesCsv(`${speciesHeader}\n`
    + 'c,Autumn sage,Salvia greggii,3-11,3-11,,,,,red,3,3,mound');
  const placement = {
    id: 'sage-1', speciesId: 'c', x: 5, y: 5,
    status: 'planted', plantedOn: '2026-04-18', source: { name: 'Big Box #123' }, note: { any: 'shape' },
  };
  const plant = createPlantFromSpecies(species[0], placement);
  assert.equal(plant.status, 'planted');
  assert.equal(plant.width, 3, 'species attributes still come from the catalog');
  assert.deepStrictEqual(toPlacement(plant), placement);
  // A species attribute on the placement never beats the catalog's.
  assert.equal(createPlantFromSpecies(species[0], { ...placement, width: 99 }).width, 3);
});

/**
 * nl-3s5.18: a saved yard names its species by plants.csv `id`, never by
 * botanical name, so a rename in plants.csv cannot orphan it, and no code path
 * finds a species by epithet alone.
 */
const REPO_PLANTS_CSV = readFileSync(new URL('../plants.csv', import.meta.url), 'utf8');
const REPO_SYNONYMS = parseSynonymCsv(
  readFileSync(new URL('../catalog/species-synonyms.csv', import.meta.url), 'utf8')
);
// The one yard still tracked (nl-3s5.3); the others are private, in app.db.
const SHIPPED_PROJECTS = ['backyard'];

/** Rename one species' botanical_name in plants.csv text, leaving its id alone. */
function renameInCatalog(csvText, speciesId, newName) {
  const lines = csvText.split(/\r?\n/);
  const idx = lines.findIndex((line) => line.startsWith(`${speciesId},`));
  assert.ok(idx > 0, `plants.csv has no ${speciesId}`);
  const cells = lines[idx].split(',');
  cells[2] = newName; // id,common_name,botanical_name,...
  lines[idx] = cells.join(',');
  return lines.join('\n');
}

const renderedShape = (plants) =>
  plants.map((p) => ({ id: p.id, speciesId: p.speciesId, x: p.x, y: p.y, width: p.width, height: p.height, growthShape: p.growthShape }));

test('renaming every species in plants.csv leaves every shipped yard rendering the same plants', () => {
  const renamedCatalog = parseSpeciesCsv(REPO_PLANTS_CSV).reduce(
    (text, entry) => renameInCatalog(text, entry.speciesId, `Renamedus ${entry.speciesId.toLowerCase()}`),
    REPO_PLANTS_CSV
  );
  // Sanity: the rename really did take every old name away.
  const renamedNames = new Set(parseSpeciesCsv(renamedCatalog).map((e) => e.botanicalName));
  assert.ok(!renamedNames.has('Ilex vomitoria'));

  SHIPPED_PROJECTS.forEach((project) => {
    const layout = readFileSync(new URL(`../projects/${project}/planting_layout.csv`, import.meta.url), 'utf8');
    assert.match(layout, /^id,species_id,x_ft,y_ft/, `${project} layout is keyed by species_id`);
    const before = buildPlantsFromCsv(REPO_PLANTS_CSV, layout);
    const after = buildPlantsFromCsv(renamedCatalog, layout);
    assert.ok(before.length > 0);
    assert.deepStrictEqual(renderedShape(after), renderedShape(before), project);
    after.forEach((plant) => assert.match(plant.botanicalName, /^Renamedus /, 'attributes come from the renamed row'));
  });
});

test('a history snapshot survives a rename too: plantsFromPlacements resolves by speciesId', () => {
  const species = parseSpeciesCsv(REPO_PLANTS_CSV);
  const holly = species.find((e) => e.speciesId === 'yaupon-holly');
  const snapshot = [createPlantFromSpecies(holly, { id: 'holly-1', x: 3, y: 4 })];

  const renamed = parseSpeciesCsv(renameInCatalog(REPO_PLANTS_CSV, 'yaupon-holly', 'Ilex renamedii'));
  const [restored] = plantsFromPlacements(snapshot, renamed);

  assert.equal(restored.speciesId, 'yaupon-holly');
  assert.equal(restored.botanicalName, 'Ilex renamedii', 're-derived from the catalog, not left stale');
  assert.equal(restored.x, 3);
});

test('no path finds a species by epithet alone', () => {
  // Callicarpa americana is in plants.csv; "Foo americana" shares only its epithet.
  const legacyLayout = 'id,botanical_name,x_ft,y_ft\nimpostor,Foo americana,1,1';
  assert.throws(() => buildPlantsFromCsv(REPO_PLANTS_CSV, legacyLayout, { synonyms: REPO_SYNONYMS }), /Unknown plant "Foo americana"/);

  // An old layout with a species_epithet column and no usable name finds nothing either.
  const epithetOnly = 'id,species_epithet,x_ft,y_ft\nberry,americana,1,1';
  assert.throws(() => buildPlantsFromCsv(REPO_PLANTS_CSV, epithetOnly), LayoutDataError);

  // A history snapshot carrying only an epithet is left as it was, not re-pointed.
  const species = parseSpeciesCsv(REPO_PLANTS_CSV);
  const stale = { id: 'old', botanicalName: 'Foo americana', speciesEpithet: 'americana', x: 0, y: 0 };
  assert.deepStrictEqual(plantsFromPlacements([stale], species, { synonyms: REPO_SYNONYMS }), [stale]);

  // A variety is not rescued by its parent species, or vice versa.
  assert.throws(
    () => buildPlantsFromCsv(REPO_PLANTS_CSV, 'id,botanical_name,x_ft,y_ft\nv,Ilex vomitoria var. chiapensis,1,1'),
    LayoutDataError
  );
});

test('a legacy botanical_name layout still loads: exact name, then the committed synonym table', () => {
  const legacy = 'id,botanical_name,x_ft,y_ft\n'
    + 'holly,Ilex vomitoria,1,1\n'
    + 'sumac,Rhus trilobata,2,2';
  const plants = buildPlantsFromCsv(REPO_PLANTS_CSV, legacy, { synonyms: REPO_SYNONYMS });
  assert.deepStrictEqual(plants.map((p) => p.speciesId), ['yaupon-holly', 'fragrant-sumac']);

  // Without the synonym table the old name is refused, not guessed.
  assert.throws(() => buildPlantsFromCsv(REPO_PLANTS_CSV, legacy), /Unknown plant "Rhus trilobata"/);
});

test('species_id is authoritative: an unknown id is an error, not rescued by a name beside it', () => {
  const layout = 'id,species_id,botanical_name,x_ft,y_ft\nghost,no-such-species,Ilex vomitoria,1,1';
  assert.throws(() => buildPlantsFromCsv(REPO_PLANTS_CSV, layout), /Unknown species id "no-such-species"/);
});

test('plants.csv species ids are required and unique', () => {
  assert.throws(
    () => parseSpeciesCsv(`${speciesHeader}\n,Nameless,Salvia greggii,3-11,3-11,,,,,red,3,3,mound`),
    /has no id/
  );
  assert.throws(
    () => parseSpeciesCsv(`${speciesHeader}\nsage,A,Salvia greggii,,,,,,,,3,3,mound\nsage,B,Salvia farinacea,,,,,,,,3,3,mound`),
    /Duplicate species id "sage"/
  );
});
