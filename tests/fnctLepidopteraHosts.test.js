import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';

/**
 * Regression tests for the FNCT Appendix Ten extraction
 * (tools/fnct-lepidoptera-hosts.mjs). Every expectation below was read off the
 * printed appendix by eye before the parser was written, because a whitespace-
 * columnar table fails by silently under-extracting rather than by crashing —
 * which is exactly how the walnut sphinx, four of Quercus's five underwings,
 * and the Celtis/Ulmus grouping each went missing during development.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rows = parseCsv(readFileSync(`${ROOT}ecology/fnct-lepidoptera-hosts.csv`, 'utf8'));

const forGenus = (genus) => rows.filter((r) => r.plant_genus === genus);
const speciesFor = (genus) => new Set(forGenus(genus).map((r) => r.lep_species));

test('the appendix extracted at all, at roughly the expected size', () => {
  assert.ok(rows.length > 300, `expected 300+ rows, got ${rows.length}`);
  assert.equal(new Set(rows.map((r) => r.section)).size, 2, 'butterflies and moths');
  assert.ok(rows.every((r) => Number(r.fnct_page) >= 1394 && Number(r.fnct_page) <= 1403));
});

test('every plant cell is a plant, not a fragment of the grouping prose', () => {
  const malformed = rows.filter((r) => !/^[A-Z][a-z]+(?: (?:spp\.|[a-z]+))?$/.test(r.plant));
  assert.deepEqual(malformed.map((r) => r.plant), []);
});

test('Quercus carries all six butterflies and all five underwings (p. 1396, 1401)', () => {
  const species = speciesFor('Quercus');
  ['Erynnis horatius', 'Erynnis juvenalis', 'Erynnis brizo', 'Satyrium calanus'].forEach((s) =>
    assert.ok(species.has(s), `missing butterfly ${s}`)
  );
  ['Antheraea polyphemus', 'Eacles imperialis', 'Hemileuca maia', 'Anisota stigma'].forEach((s) =>
    assert.ok(species.has(s), `missing moth ${s}`)
  );
  const underwings = forGenus('Quercus').filter((r) => r.lep_species.startsWith('Catocala'));
  assert.equal(underwings.length, 5, 'the run continues onto a second line');
  assert.ok(!species.has('Catocala species'), '"(Catocala species)" introduces the list, it is not a taxon');
});

test('Carya keeps the full eleven-name underwing run', () => {
  const underwings = forGenus('Carya').filter((r) => r.lep_species.startsWith('Catocala'));
  assert.equal(underwings.length, 11);
  assert.ok(speciesFor('Carya').has('Actias luna'));
  assert.ok(underwings.every((r) => r.name_inferred === 'yes'), 'C. -> Catocala is the tool\'s expansion, not the flora\'s');
});

// The reason this matters: Celtis is absent from NWF's keystone list and from
// GloBI's 96 genera, so before Appendix Ten the demo had nothing citable for
// the signature Blackland tree.
test('the Celtis/Ulmus grouping sentence attaches all three moths to BOTH genera', () => {
  ['Celtis', 'Ulmus'].forEach((genus) => {
    const species = speciesFor(genus);
    ['Automeris io', 'Ceratomia undulosa', 'Paonias excaetatus'].forEach((s) =>
      assert.ok(species.has(s), `${genus} missing ${s}`)
    );
    const grouped = forGenus(genus).filter((r) => r.grouping_note);
    assert.ok(grouped.length >= 3);
    assert.match(grouped[0].grouping_note, /on both Celtis and Ulmus/);
  });
  assert.ok(speciesFor('Celtis').has('Asterocampa celtis'), 'hackberry butterfly');
});

test('Prunus mexicana and P. gracilis each get all five shared butterflies', () => {
  ['Prunus mexicana', 'Prunus gracilis'].forEach((plant) => {
    const species = new Set(rows.filter((r) => r.plant === plant).map((r) => r.lep_species));
    assert.equal(species.size, 5, `${plant} should carry five`);
    assert.ok(species.has('Satyrium titus'));
  });
});

// A non-ASCII epithet used to break the column split, absorbing the animal
// into the plant cell instead of emitting it.
test('taxa with diacritics survive the column split', () => {
  assert.ok(speciesFor('Juglans').has('Lathoë juglandis'), 'walnut sphinx');
  assert.ok(
    rows.some((r) => r.lep_species === 'Euchloë olympia'),
    'olympia marble'
  );
  const juglans = forGenus('Juglans').map((r) => r.plant);
  assert.ok(juglans.every((p) => !p.includes('SPHINX')), 'the animal must not leak into the plant cell');
});

test('the flora\'s own typos are preserved rather than silently corrected', () => {
  // "Chlyosyne gorgone" is printed thus in FNCT; correcting it here would make
  // the citation unverifiable against the page.
  assert.ok(rows.some((r) => r.lep_species === 'Chlyosyne gorgone'));
});

// The moth section opens with a prose paragraph. Parsed as a table row it
// became a plant called "Many moths" and captured the entire Salicaceae group,
// so Populus and Salix silently lost all eight of their moths.
test('the moth-section preamble is not mistaken for a host plant', () => {
  assert.equal(forGenus('Many').length, 0, 'no plant named "Many"');
  ['Populus', 'Salix'].forEach((genus) => {
    const species = speciesFor(genus);
    ['Antheraea polyphemus', 'Automeris io', 'Hylaphora cecropia', 'Pachysphinx modesta'].forEach((s) =>
      assert.ok(species.has(s), `${genus} missing ${s}`)
    );
  });
});

test('"Panicum SPP." keeps its capitals out of the animal\'s common name', () => {
  assert.deepEqual(rows.filter((r) => r.lep_common.startsWith('SPP')), []);
  assert.ok(speciesFor('Panicum').has('Ancyloxypha numitor'), 'least skipper');
});
