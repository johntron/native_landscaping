import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSpeciesCsv } from '../src/data/plantParser.js';
import { buildSpeciesIndex, parseSynonymCsv } from '../src/data/speciesResolver.js';
import { migrateHistory, migrateLayoutCsv } from '../tools/migrate-species-ids.mjs';
import { buildSynonymRows, linkTaxonIds, writeTaxonIdColumn } from '../tools/link-species-taxa.mjs';

const index = buildSpeciesIndex(
  parseSpeciesCsv(readFileSync(new URL('../plants.csv', import.meta.url), 'utf8')),
  parseSynonymCsv(readFileSync(new URL('../catalog/species-synonyms.csv', import.meta.url), 'utf8'))
);

test('an old-shape layout is rewritten to species ids, coordinates copied as written', () => {
  const result = migrateLayoutCsv(
    'id,botanical_name,x_ft,y_ft\nholly,Ilex vomitoria,1.5,2.250\nsumac,Rhus trilobata,3,4',
    index
  );
  assert.equal(result.status, 'migrated');
  assert.equal(result.text, 'id,species_id,x_ft,y_ft\nholly,yaupon-holly,1.5,2.250\nsumac,fragrant-sumac,3,4');
  assert.equal(migrateLayoutCsv(result.text, index).status, 'already', 'a second run is a no-op');
});

test('a layout with any unresolvable row is left untouched, and never matched by epithet', () => {
  const result = migrateLayoutCsv('id,botanical_name,x_ft,y_ft\nok,Ilex vomitoria,1,1\nbad,Foo americana,2,2', index);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.text, undefined);
  assert.match(result.problems[0], /Foo americana/);
});

test('history gains speciesId per snapshot, nothing else changes, and a rerun adds nothing', () => {
  const history = {
    entries: [
      {
        id: 'e1',
        description: 'seed',
        plants: [
          { id: 'b1', botanicalName: 'Callicarpa americana', botanicalKey: 'callicarpa americana', speciesEpithet: 'americana', x: 1, y: 2 },
          { id: 'junk', botanicalName: 'X', x: 1, y: 2 },
          { id: 'impostor', botanicalName: 'Foo americana', speciesEpithet: 'americana', x: 0, y: 0 },
        ],
      },
    ],
    cursor: 0,
  };
  const { added, problems } = migrateHistory(history, index);
  assert.equal(added, 1);
  assert.equal(problems.length, 2, 'the junk row and the epithet-only impostor are reported');
  const [berry, junk, impostor] = history.entries[0].plants;
  assert.deepEqual(Object.keys(berry).slice(0, 2), ['id', 'speciesId']);
  assert.equal(berry.speciesId, 'beautyberry');
  assert.equal(berry.x, 1);
  assert.equal(junk.speciesId, undefined);
  assert.equal(impostor.speciesId, undefined);
  assert.equal(history.cursor, 0);

  assert.equal(migrateHistory(history, index).added, 0);
});

test('taxon links are exact-name only, and synonyms follow resolves_to to a plants.csv row', () => {
  const plantRows = [
    { id: 'fragrant-sumac', botanical_name: 'Rhus aromatica' },
    { id: 'dwarf', botanical_name: "Ilex vomitoria 'Nana'" },
  ];
  const taxa = [
    { id: 5, scientific_name: 'Rhus aromatica', resolves_to: null },
    { id: 7, scientific_name: 'Ilex vomitoria', resolves_to: null }, // parent only: the cultivar must NOT link to it
    { id: 101, scientific_name: 'Rhus trilobata', resolves_to: 5 },
    { id: 102, scientific_name: 'Rhus older', resolves_to: 101 }, // a chain
    { id: 103, scientific_name: 'Loop a', resolves_to: 104 },
    { id: 104, scientific_name: 'Loop b', resolves_to: 103 },
  ];
  const links = linkTaxonIds(plantRows, taxa);
  assert.equal(links.get('fragrant-sumac'), '5');
  assert.equal(links.get('dwarf'), '');

  const { rows, skipped } = buildSynonymRows(plantRows, links, taxa);
  assert.deepEqual(
    rows.map((r) => [r.synonym, r.species_id]),
    [['Rhus older', 'fragrant-sumac'], ['Rhus trilobata', 'fragrant-sumac']]
  );
  assert.ok(skipped.some((line) => /cycle/.test(line)));
});

test('writing taxon_id keeps every other byte, including mixed line endings', () => {
  const original = 'id,common_name,botanical_name,sun_pref\r\nfragrant-sumac,Fragrant sumac,Rhus aromatica,"full-sun,part-sun"\r\ndwarf,Dwarf,Ilex x,sun\n';
  const out = writeTaxonIdColumn(original, new Map([['fragrant-sumac', '5'], ['dwarf', '']]));
  assert.equal(
    out,
    'id,common_name,botanical_name,taxon_id,sun_pref\r\nfragrant-sumac,Fragrant sumac,Rhus aromatica,5,"full-sun,part-sun"\r\ndwarf,Dwarf,Ilex x,,sun\n'
  );
  assert.equal(writeTaxonIdColumn(out, new Map([['fragrant-sumac', '5'], ['dwarf', '']])), out);
});
