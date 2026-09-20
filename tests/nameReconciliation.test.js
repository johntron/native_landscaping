import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from '../src/data/csvLoader.js';
import { buildFloraIndex, buildGenusDictionary, headingKey, loadCorpusText } from '../tools/claims/floraCorpus.js';
import { reconcile, reconcileCatalog } from '../tools/claims/nameReconciliation.js';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { seedPlantableCore } from '../tools/claims/taxaSeed.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'claims-reconcile-'));
  return join(dir, 'claims.db');
}

// Built once against the real corpus — this is 06 §6's control set exercised
// against the live corpus/catalog, not synthetic text, per that section's own
// validation discipline ("every bug found there was invisible in the output
// and obvious in the controls").
const catalog = parseCsv(readFileSync(`${REPO_ROOT}blackland-prairie-natives.csv`, 'utf8'));
const genusDictionary = buildGenusDictionary(catalog);
const floraIndex = buildFloraIndex(loadCorpusText(), genusDictionary);

test('06 §6 control set: resolves via direct match', () => {
  const result = reconcile('Bothriochloa ischaemum var. songarica', 'variety', 'songarica', floraIndex);
  assert.equal(result.matched_via, 'direct');
  assert.equal(result.status, 'asserted');
  assert.equal(result.flora_key, headingKey('Bothriochloa', 'ischaemum', 'variety', 'songarica'));
});

test("06 §6 control set: resolves via the flora's own bracket crosswalk (the headline Aster/Symphyotrichum case)", () => {
  const result = reconcile('Symphyotrichum oblongifolium', 'species', null, floraIndex);
  assert.equal(result.matched_via, 'flora-synonym');
  assert.equal(result.status, 'asserted');
  assert.equal(result.flora_key, 'aster oblongifolius');
});

test('06 §6 control set: glued genus-species in a bracket citation still resolves (Symphyotrichum lateriflorum)', () => {
  const result = reconcile('Symphyotrichum lateriflorum', 'species', null, floraIndex);
  assert.equal(result.matched_via, 'flora-synonym');
  assert.equal(result.flora_key, 'aster lateriflorus');
});

test('06 §6 control set: known true negatives resolve to unmatched/unknown, not a guess', () => {
  for (const [name, rank] of [
    ['Bouvardia ternifolia', 'species'],
    ['Liatris punctata', 'species'],
  ]) {
    const result = reconcile(name, rank, null, floraIndex);
    assert.equal(result.matched_via, 'unmatched');
    assert.equal(result.status, 'unknown');
    assert.equal(result.flora_key, null);
  }
});

test('06 §4 control set: an infraspecific partial match (species heading only) gets status=review, never asserted', () => {
  // Real corpus hit, filling in 06 §6's OPEN infraspecific-partial-match row
  // (07 items list) — the flora treats Aristida purpurea but not the
  // 'longiseta' variety by that epithet.
  const result = reconcile('Aristida purpurea var. longiseta', 'variety', 'longiseta', floraIndex);
  assert.equal(result.status, 'review');
  assert.equal(result.flora_key, 'aristida purpurea');
});

test('reconcileCatalog measures the step-2-only residual against the full catalog (06 §3\'s measurement gate)', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  const counts = reconcileCatalog(db, catalog, floraIndex);

  // Recorded per nl-scx.3's AC: the step-2-only residual, measured before
  // steps 3-5 (the USDA-synonym network path) exist. 467 non-cultivar
  // catalog rows; steps 1+2 resolve 339 (327 direct + 12 flora-synonym, 7 of
  // which are §4 partial matches carrying status='review'); 128 remain
  // matched_via='unmatched' (status='unknown'), a residual for whichever
  // bead builds steps 3-5 next — smaller than the 469-row catalog's naive
  // "119 unresolved" baseline suggested step 2 alone would leave.
  assert.equal(counts.direct, 327);
  assert.equal(counts['flora-synonym'], 12);
  assert.equal(counts.unmatched, 128);
  assert.equal(counts.review, 7);

  const total = db.prepare('SELECT COUNT(*) AS n FROM name_reconciliations').get().n;
  assert.equal(total, counts.direct + counts['flora-synonym'] + counts.unmatched);
});

test('reconcileCatalog writes a row for every reconciliation, including matched_via=unmatched', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  reconcileCatalog(db, catalog, floraIndex);

  // Bouvardia ternifolia/Liatris punctata (06 §6's named true negatives)
  // aren't in blackland-prairie-natives.csv at all; Acer grandidentatum is a
  // real catalog row this run measured as genuinely unmatched (06 §3 step 6).
  const unmatchedRow = db
    .prepare(
      `SELECT nr.matched_via, nr.flora_taxa_id FROM name_reconciliations nr
       JOIN taxa t ON t.id = nr.taxa_id WHERE t.scientific_name = 'Acer grandidentatum'`,
    )
    .get();
  assert.deepEqual({ ...unmatchedRow }, { matched_via: 'unmatched', flora_taxa_id: null });
});

test('reconcileCatalog: a flora-synonym match creates the old-name taxa row with resolves_to pointing at the catalog row', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  reconcileCatalog(db, catalog, floraIndex);

  const row = db
    .prepare(
      `SELECT t2.scientific_name AS flora_name, t2.resolves_to, t.id AS canonical_id
       FROM name_reconciliations nr
       JOIN taxa t ON t.id = nr.taxa_id
       JOIN taxa t2 ON t2.id = nr.flora_taxa_id
       WHERE t.scientific_name = 'Symphyotrichum lateriflorum var. lateriflorum'`,
    )
    .get();
  assert.equal(row.flora_name, 'Aster lateriflorus');
  assert.equal(row.resolves_to, row.canonical_id);
});

test('reconcileCatalog: a partial rank match is detectable by comparing taxa_id rank against flora_taxa_id rank, with no dedicated status column', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  reconcileCatalog(db, catalog, floraIndex);

  const row = db
    .prepare(
      `SELECT t.rank AS catalog_rank, t2.rank AS flora_rank
       FROM name_reconciliations nr
       JOIN taxa t ON t.id = nr.taxa_id
       JOIN taxa t2 ON t2.id = nr.flora_taxa_id
       WHERE t.scientific_name = 'Aristida purpurea var. longiseta'`,
    )
    .get();
  assert.equal(row.catalog_rank, 'variety');
  assert.equal(row.flora_rank, 'species');
});

test('reconcileCatalog skips cultivars (06 §7 — no taxonomic work treats one)', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  seedPlantableCore(db, {
    plantsCsvPath: `${REPO_ROOT}plants.csv`,
    blacklandCsvPath: `${REPO_ROOT}blackland-prairie-natives.csv`,
  });
  const cultivarRows = [{ botanical_name: "Ilex vomitoria 'Nana'", usda_symbol: 'ILVO' }];
  const counts = reconcileCatalog(db, cultivarRows, floraIndex);
  assert.deepEqual(counts, { direct: 0, 'flora-synonym': 0, unmatched: 0, review: 0 });
  const total = db.prepare('SELECT COUNT(*) AS n FROM name_reconciliations').get().n;
  assert.equal(total, 0);
});
