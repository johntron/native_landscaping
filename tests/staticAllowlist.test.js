import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isServableStaticPath } from '../server/static.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('secrets, local state, exact addresses and the flora PDFs are never served', () => {
  for (const p of [
    '.env',
    '.git/config',
    '.beads/issues.jsonl',
    '.claude/settings.json',
    'data/saved-areas.db',
    'data/saved-areas.export.json',
    'projects/backyard/location.json',
    'projects/backyard/layout-history.json',
    'projects/backyard/img/top.xcf',
    'docs/data-acquisition/corpus/flora.pdf',
    'node_modules/jszip/package.json',
    'server.js',
    'server/static.js',
    'package.json',
    'src/../.env',
    'src//app.js',
  ]) {
    assert.equal(isServableStaticPath(p), false, p);
  }
});

test('every page, and every file those pages reference, is served', () => {
  const pages = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    assert.equal(isServableStaticPath(page), true, page);
    const html = readFileSync(`${ROOT}${page}`, 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#?:]+)"/g)) {
      assert.equal(isServableStaticPath(ref), true, `${page} -> ${ref}`);
    }
  }
});

test('the data files and project assets the browser fetches are served', () => {
  for (const p of [
    'plants.csv',
    'src/app.js',
    'src/ecosystem/plantMatches.view.js',
    'ecology/anchors.csv',
    'catalog/blackland-prairie-natives.csv',
    'sourcing/plant-sales.csv',
    'projects/index.json',
    'projects/backyard/project.json',
    'projects/backyard/planting_layout.csv',
    'projects/backyard/img/top.webp',
    'projects/example-frontyard/img/north.svg',
  ]) {
    assert.equal(isServableStaticPath(p), true, p);
  }
});
