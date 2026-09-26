import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeStanding, searchSpecies, speciesMatchesQuery, speciesOptionLabel } from '../src/data/speciesSearch.js';

const species = [
  { speciesId: 'black-eyed-susan', commonName: 'Black-eyed Susan', botanicalName: 'Rudbeckia hirta', nativity: 'native' },
  { speciesId: 'indian-blanket', commonName: 'Indian blanket', botanicalName: 'Gaillardia pulchella', nativity: 'native' },
  { speciesId: 'western-yarrow', commonName: 'Western yarrow', botanicalName: 'Achillea millefolium var. occidentalis', nativity: '' },
  { speciesId: 'no-common', commonName: '', botanicalName: 'Carex blanda', nativity: 'introduced' },
  { speciesId: 'no-botanical', commonName: 'Mystery', botanicalName: '' },
];

const ids = (rows) => rows.map((row) => row.speciesId);

test('an empty query keeps every placeable species, sorted by common name', () => {
  assert.deepEqual(ids(searchSpecies(species)), ['black-eyed-susan', 'no-common', 'indian-blanket', 'western-yarrow']);
});

test('sorting by botanical name orders by the scientific name', () => {
  assert.deepEqual(ids(searchSpecies(species, { sortBy: 'botanical' })), [
    'western-yarrow',
    'no-common',
    'indian-blanket',
    'black-eyed-susan',
  ]);
});

test('a partial word matches either name, ignoring case', () => {
  assert.deepEqual(ids(searchSpecies(species, { query: 'YARR' })), ['western-yarrow']);
  assert.deepEqual(ids(searchSpecies(species, { query: 'gaill' })), ['indian-blanket']);
});

test('every word must match, in any order and across both names', () => {
  assert.deepEqual(ids(searchSpecies(species, { query: 'hir rud' })), ['black-eyed-susan']);
  assert.deepEqual(ids(searchSpecies(species, { query: 'susan gaillardia' })), []);
  assert.ok(speciesMatchesQuery(species[1], 'blanket pulch'));
});

test('punctuation, spacing and accents do not stop a match', () => {
  for (const query of ['black eyed', 'blackeyed', 'Black-eyed', 'black–eyed']) {
    assert.ok(speciesMatchesQuery(species[0], query), query);
  }
  assert.ok(speciesMatchesQuery({ commonName: 'Café plant', botanicalName: 'X' }, 'cafe'));
});

test('a query that matches nothing returns no options', () => {
  assert.deepEqual(searchSpecies(species, { query: 'zzz' }), []);
});

test('the option label leads with the sort name and ends with the native standing', () => {
  assert.equal(
    speciesOptionLabel(species[1], 'common'),
    'Indian blanket (Gaillardia pulchella) · ✓ native to North Central Texas'
  );
  assert.equal(
    speciesOptionLabel(species[1], 'botanical'),
    'Gaillardia pulchella (Indian blanket) · ✓ native to North Central Texas'
  );
  assert.equal(speciesOptionLabel(species[2], 'common'), 'Western yarrow (Achillea millefolium var. occidentalis) · nativity not confirmed');
  assert.equal(speciesOptionLabel(species[3], 'common'), 'Carex blanda · not native here');
});

test('a cultivar is never native, whatever its nativity says', () => {
  const redbud = { speciesId: 'r', commonName: 'Oklahoma redbud', botanicalName: "Cercis canadensis var. texensis 'Oklahoma'", nativity: 'native' };
  assert.equal(nativeStanding(redbud), 'cultivar');
  assert.equal(nativeStanding({ botanicalName: 'Ilex vomitoria ‘Nana’' }), 'cultivar');
  assert.deepEqual(searchSpecies([redbud], { nativeOnly: true }), []);
});

test('native only keeps species FNCT treats as native, and blank is not native', () => {
  assert.deepEqual(ids(searchSpecies(species, { nativeOnly: true })), ['black-eyed-susan', 'indian-blanket']);
  assert.deepEqual(ids(searchSpecies(species, { nativeOnly: true, query: 'yarrow' })), []);
});
