import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildHostGeneraIndex,
  emptyHostGeneraIndex,
  normalizeGenus,
  describeHostGeneraRow,
  ecologicalFitNotes,
} from '../src/analysis/hostGenera.js';
import { getGenus } from '../src/utils/speciesKey.js';

const CSV = readFileSync(
  fileURLToPath(new URL('../ecology/host-genera.csv', import.meta.url)),
  'utf8'
);
const index = buildHostGeneraIndex(CSV, { ecoregion: '9' });

test('the shipped table carries both NWF top-30 lists verbatim', () => {
  const lep = [...index.byGenus.values()].filter((row) => row.lepHostSpecies !== null);
  const bee = [...index.byGenus.values()].filter((row) => row.beeSpecialistSpecies !== null);
  assert.equal(lep.length, 30, 'top-30 caterpillar-host genera');
  assert.equal(bee.length, 30, 'top-30 pollen-specialist-bee genera');

  // Spot-check the head and tail of each list plus Alnus, which a naive
  // line-wise extraction of the two-column PDF drops.
  assert.equal(index.lookup('Quercus').lepHostSpecies, 253);
  assert.equal(index.lookup('Alnus').lepHostSpecies, 164);
  assert.equal(index.lookup('Helianthus').lepHostSpecies, 58);
  assert.equal(index.lookup('Helianthus').beeSpecialistSpecies, 89);
  assert.equal(index.lookup('Helenium').beeSpecialistSpecies, 10);
  // Genera on BOTH lists are one row with both columns filled, not two rows.
  assert.equal(index.lookup('Salix').lepHostSpecies, 214);
  assert.equal(index.lookup('Salix').beeSpecialistSpecies, 20);
});

test('every row carries a source', () => {
  const unsourced = [...index.byGenus.values()].filter((row) => !row.source);
  assert.deepEqual(unsourced.map((row) => row.genus), []);
});

test('synonym_of resolves Packera to Senecio', () => {
  const packera = index.lookup('Packera');
  assert.equal(packera.beeSpecialistSpecies, 22, "Senecio's count");
  assert.equal(packera.genus, 'Packera', 'keeps the name the design uses');
  assert.equal(packera.resolvedFrom, 'Senecio');
  assert.equal(index.isKeystone('Packera'), true);
});

test('a genus with no counts is not keystone but can still be a larval host', () => {
  const asclepias = index.lookup('Asclepias');
  assert.equal(asclepias.lepHostSpecies, null, 'blank, not zero');
  assert.equal(asclepias.beeSpecialistSpecies, null);
  assert.match(asclepias.larvalHosts, /monarch/i);
  assert.equal(index.isKeystone('Asclepias'), false);
});

test('lookup is case-insensitive and unknown genera return null', () => {
  assert.equal(index.lookup('vernonia').beeSpecialistSpecies, 12);
  assert.equal(index.lookup('Nothingia'), null);
  assert.equal(index.isKeystone('Nothingia'), false);
  assert.equal(normalizeGenus('  Salix '), 'salix');
});

test('ecoregion filters rows, so a second region is a data change not a code change', () => {
  const other = buildHostGeneraIndex(CSV, { ecoregion: '13' });
  assert.equal(other.size, 0);
  assert.equal(other.lookup('Quercus'), null);
  const all = buildHostGeneraIndex(CSV);
  assert.equal(all.size, index.size, 'no filter keeps every row');
});

test('the empty index answers without throwing', () => {
  const empty = emptyHostGeneraIndex();
  assert.equal(empty.size, 0);
  assert.equal(empty.lookup('Quercus'), null);
  assert.equal(empty.isKeystone('Quercus'), false);
});

test('a synonym pointing at a missing genus degrades instead of hanging', () => {
  const odd = buildHostGeneraIndex(
    ['genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source',
     'Aaa,9,,,,Bbb,test',
     'Ccc,9,,,,Ddd,test',
     'Ddd,9,,,,Ccc,test'].join('\n'),
    { ecoregion: '9' }
  );
  assert.equal(odd.lookup('Aaa').genus, 'Aaa', 'unresolvable synonym keeps its own row');
  assert.equal(odd.lookup('Ccc').genus, 'Ccc', 'a synonym cycle terminates');
});

test('describeHostGeneraRow names caterpillar species, specialist bees, and a synonym source', () => {
  assert.equal(describeHostGeneraRow(index.lookup('Quercus')), '253 caterpillar species');
  assert.equal(
    describeHostGeneraRow(index.lookup('Salix')),
    '214 caterpillar species, 20 specialist bees'
  );
  // Packera resolves through synonym_of to Senecio's numbers.
  assert.match(describeHostGeneraRow(index.lookup('Packera')), /— listed as Senecio$/);
});

test('ecologicalFitNotes reuses the same row keystoneGenera/larvalHosts grade against', () => {
  const notes = ecologicalFitNotes('Asclepias', index);
  assert.ok(
    notes.some((n) => /^Documented larval host: .*monarch/.test(n)),
    'Asclepias is a larval host, not a keystone genus'
  );
  assert.ok(!notes.some((n) => n.startsWith('Keystone genus')));

  const quercusNotes = ecologicalFitNotes('Quercus', index);
  assert.ok(quercusNotes.some((n) => n.startsWith('Keystone genus for ecoregion 9: 253 caterpillar')));
});

test('ecologicalFitNotes is empty for an unknown genus or an empty index', () => {
  assert.deepEqual(ecologicalFitNotes('Nothingia', index), []);
  assert.deepEqual(ecologicalFitNotes('Quercus', emptyHostGeneraIndex()), []);
});

test('getGenus takes the first token of the botanical name', () => {
  assert.equal(getGenus({ botanicalName: 'Packera obovata' }), 'Packera');
  assert.equal(getGenus({ botanicalKey: 'asclepias asperula' }), 'Asclepias');
  assert.equal(getGenus({ botanicalName: '' }), '');
  assert.equal(getGenus(null), '');
});
