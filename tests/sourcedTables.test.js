// Enforces the "every row carries a source" rule from AGENTS.md ("Evidence") on
// the committed data tables, so the rule does not depend on anyone remembering it.
// A value nobody has sourced stays blank; a row that exists must say where it
// came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';

const ECOLOGY_DIR = fileURLToPath(new URL('../ecology/', import.meta.url));
const SOURCING_DIR = fileURLToPath(new URL('../sourcing/', import.meta.url));
const CORRECTIONS = fileURLToPath(new URL('../catalog/manual-corrections.tsv', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const csvIn = (dir) => readdirSync(dir).filter((name) => name.endsWith('.csv')).map((name) => ({ dir, name }));
const ecologyTables = csvIn(ECOLOGY_DIR);
// sourcing/ (nurseries and plant sales) is held to the same rule, and so is
// plant-drawing.csv (nl-3s5.21): how each species is drawn is our judgement,
// and its source column is where that judgement names its author.
const sourcedTables = [...ecologyTables, ...csvIn(SOURCING_DIR), { dir: REPO_ROOT, name: 'plant-drawing.csv' }];
const labelFor = (dir) => (dir === ECOLOGY_DIR ? 'ecology' : dir === SOURCING_DIR ? 'sourcing' : 'repo root');

test('ecology/ has tables to check', () => {
  assert.ok(ecologyTables.length > 0);
});

for (const { dir, name } of sourcedTables) {
  const label = labelFor(dir);
  test(`${label === 'repo root' ? '' : `${label}/`}${name}: has a source column and every row fills it`, () => {
    const rows = parseCsv(readFileSync(`${dir}${name}`, 'utf8'));
    assert.ok(rows.length > 0, 'table is empty');
    assert.ok('source' in rows[0], `no source column: every sourced table must cite where its rows came from`);
    const unsourced = rows
      .map((row, i) => ({ line: i + 2, row }))
      .filter(({ row }) => !String(row.source ?? '').trim());
    assert.deepEqual(
      unsourced.map(({ line }) => line),
      [],
      `rows with an empty source (file line numbers): ${unsourced.length}`,
    );
  });
}

test('catalog/manual-corrections.tsv: every correction names a reason, an author, and a date', () => {
  const [header, ...lines] = readFileSync(CORRECTIONS, 'utf8').split('\n').filter((l) => l.trim());
  const cols = header.split('\t');
  const required = ['reason', 'author', 'date'];
  required.forEach((c) => assert.ok(cols.includes(c), `missing column ${c}`));
  lines.forEach((line, i) => {
    const cells = line.split('\t');
    required.forEach((c) => {
      assert.ok(cells[cols.indexOf(c)]?.trim(), `line ${i + 2}: empty ${c}`);
    });
  });
});

// nl-3s5.31: a yard's site (its streams and green space with distances, and
// the animals reported near it) once sat in committed tables keyed by a
// `place` label, which put the owner's surroundings in this public repo. Those
// rows now live per yard in the gitignored data/ecosystem.db. No committed
// table may be keyed by a yard's place again; region-level tables (a county)
// are keyed by `region` instead.
test('no committed table is keyed by a yard’s place label', () => {
  for (const { dir, name } of sourcedTables) {
    const header = readFileSync(`${dir}${name}`, 'utf8').split('\n')[0].split(',').map((c) => c.trim());
    assert.ok(!header.includes('place'), `${labelFor(dir)}/${name} has a place column`);
  }
  for (const retired of ['anchors.csv', 'nearby-fauna.csv']) {
    assert.ok(!ecologyTables.some((t) => t.name === retired), `ecology/${retired} is back`);
  }
});
