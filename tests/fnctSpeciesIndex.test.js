import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';

/**
 * Regression tests for the FNCT species index (tools/fnct-species-index.mjs)
 * — one row per species/variety/subspecies treatment in Diggs, Lipscomb &
 * O'Kennon 1999. The corpus's own heading regex (tools/claims/floraCorpus.js)
 * occasionally matches ordinary prose as a fake treatment (03 §6's known
 * hazard); this suite pins the size, a few known-good rows, and that the
 * specific false positives found during development stay filtered.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rows = parseCsv(readFileSync(`${ROOT}ecology/fnct-species-index.csv`, 'utf8'));
const byName = (name) => rows.find((r) => r.scientific_name === name);

test('extracted at roughly the expected size, one row per treatment', () => {
  assert.ok(rows.length > 2400 && rows.length < 2700, `expected ~2400-2700 rows, got ${rows.length}`);
  assert.ok(rows.every((r) => Number(r.fnct_page) >= 1 && Number(r.fnct_page) <= 1456));
});

test('every row cites the flora with a page number', () => {
  assert.ok(rows.every((r) => /^Diggs, Lipscomb & O'Kennon 1999, p\. \d+$/.test(r.source)));
});

test('common names extracted for a known multi-name species (Quercus alba)', () => {
  const row = byName('Quercus alba');
  assert.ok(row, 'Quercus alba missing');
  const names = row.common_names.split('; ');
  assert.ok(names.includes('White Oak'));
  assert.ok(names.includes('Forked-Leaf White Oak'));
  assert.equal(row.fnct_page, '714');
});

test('a species with no listed common name gets an empty field, not a guess', () => {
  const row = byName('Quercus sinuata');
  assert.ok(row, 'Quercus sinuata missing');
  assert.equal(row.common_names, '');
});

test('a bare infraspecific continuation heading resolves to its own scientific name', () => {
  const row = byName('Quercus sinuata var. breviloba');
  assert.ok(row, 'Quercus sinuata var. breviloba missing');
  assert.equal(row.rank, 'variety');
  assert.equal(row.infra_epithet, 'breviloba');
  assert.ok(row.common_names.split('; ').includes('Shin Oak'));
});

test('known false-positive headings from ordinary prose are filtered out', () => {
  ['Abundant weed', 'As the', 'Malva and', 'Escobaria in', 'Key to'].forEach((name) => {
    assert.equal(byName(name), undefined, `${name} should have been filtered as a fake treatment`);
  });
});

test('genus, species and scientific_name stay consistent', () => {
  rows.forEach((r) => {
    const expected =
      r.rank === 'species'
        ? `${r.genus} ${r.species}`
        : `${r.genus} ${r.species} ${r.rank === 'variety' ? 'var.' : 'subsp.'} ${r.infra_epithet}`;
    assert.equal(r.scientific_name, expected);
  });
});
