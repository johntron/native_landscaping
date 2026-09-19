import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { classifyName, seedPlantableCore } from '../tools/claims/taxaSeed.js';
import { replayManualCorrections } from '../tools/claims/correctionsReplay.js';
import { rebuildClaimsStore } from '../tools/claims/rebuild.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'claims-test-'));
  return join(dir, 'claims.db');
}

test('schema: the four tables, four claims indexes, and plantable_set view exist', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['claims', 'licenses', 'name_reconciliations', 'plantable_core', 'taxa']);

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'claims' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(indexes, ['idx_claims_field', 'idx_claims_source', 'idx_claims_species_field', 'idx_claims_status']);

  const views = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all().map((r) => r.name);
  assert.deepEqual(views, ['plantable_set']);
});

test('classifyName: species, variety, subspecies, and cultivar-of-a-variety all resolve to a species-level parent', () => {
  assert.deepEqual(classifyName('Passiflora incarnata'), { rank: 'species', parentName: null });
  assert.deepEqual(classifyName('Malvaviscus arboreus var. drummondii'), {
    rank: 'variety',
    parentName: 'Malvaviscus arboreus',
  });
  assert.deepEqual(classifyName('Capsicum annuum var. glabriusculum'), {
    rank: 'variety',
    parentName: 'Capsicum annuum',
  });
  assert.deepEqual(classifyName("Ilex vomitoria 'Nana'"), { rank: 'cultivar', parentName: 'Ilex vomitoria' });
  // A cultivar of a named variety still parents to the species, not the variety (04 §2.3).
  assert.deepEqual(classifyName("Cercis canadensis var. texensis 'Oklahoma'"), {
    rank: 'cultivar',
    parentName: 'Cercis canadensis',
  });
});

test('seedPlantableCore reproduces the documented derivation: plants.csv ∪ npsot_dfw_recommended=yes, by exact botanical_name', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  const size = seedPlantableCore(db, {
    plantsCsvPath: `${REPO_ROOT}plants.csv`,
    blacklandCsvPath: `${REPO_ROOT}blackland-prairie-natives.csv`,
  });

  // 10 §2.2 measured 101 on 2026-09-18; plants.csv has since gained one species
  // (Silphium albiflorum, ad12d5e) that isn't in the npsot-recommended set, so a
  // correct rebuild today is the documented 101 plus exactly that one addition.
  assert.equal(size, 102);
  const stored = db.prepare('SELECT COUNT(*) AS n FROM plantable_core').get();
  assert.equal(stored.n, 102);

  const inCore = db
    .prepare(
      `SELECT pc.source FROM plantable_core pc
       JOIN taxa t ON t.id = pc.taxa_id
       WHERE t.scientific_name = 'Silphium albiflorum'`,
    )
    .get();
  assert.equal(inCore.source, 'plants.csv');
});

test('an empty claims table makes the county-presence gate and nativity exclusion no-ops (fail-open, per 10 §2.1)', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  seedPlantableCore(db, {
    plantsCsvPath: `${REPO_ROOT}plants.csv`,
    blacklandCsvPath: `${REPO_ROOT}blackland-prairie-natives.csv`,
  });
  const coreCount = db.prepare('SELECT COUNT(*) AS n FROM plantable_core').get().n;
  const setCount = db.prepare('SELECT COUNT(*) AS n FROM plantable_set').get().n;
  assert.equal(setCount, coreCount);
});

test('plantable_set excludes a species with an asserted non-native claim, and admits one with an asserted presence claim', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  seedPlantableCore(db, {
    plantsCsvPath: `${REPO_ROOT}plants.csv`,
    blacklandCsvPath: `${REPO_ROOT}blackland-prairie-natives.csv`,
  });
  const taxon = db.prepare("SELECT id FROM taxa WHERE scientific_name = 'Silphium albiflorum'").get();
  db.prepare(
    `INSERT INTO claims (species_id, field, value, status, source, retrieved_at)
     VALUES (?, 'nativity_nctx', 'introduced', 'asserted', 'nctx-flora', '2026-09-19T00:00:00Z')`,
  ).run(taxon.id);

  const excluded = db.prepare('SELECT 1 FROM plantable_set WHERE taxa_id = ?').get(taxon.id);
  assert.equal(excluded, undefined);

  const totalCore = db.prepare('SELECT COUNT(*) AS n FROM plantable_core').get().n;
  const totalSet = db.prepare('SELECT COUNT(*) AS n FROM plantable_set').get().n;
  assert.equal(totalSet, totalCore - 1);
});

test('replayManualCorrections is a no-op when the file does not exist', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  const result = replayManualCorrections(db, '/nonexistent/manual-corrections.tsv');
  assert.deepEqual(result, { applied: 0 });
});

test('replayManualCorrections applies a valid row, setting superseded_by on the row it corrects', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  seedPlantableCore(db, {
    plantsCsvPath: `${REPO_ROOT}plants.csv`,
    blacklandCsvPath: `${REPO_ROOT}blackland-prairie-natives.csv`,
  });
  const taxon = db.prepare("SELECT id, usda_symbol FROM taxa WHERE scientific_name = 'Achillea millefolium var. occidentalis'").get()
    ?? db.prepare("SELECT id FROM taxa LIMIT 1").get();

  // Give the taxon a symbol and an existing USDA claim to supersede.
  db.prepare('UPDATE taxa SET usda_symbol = ? WHERE id = ?').run('TEST1', taxon.id);
  db.prepare(
    `INSERT INTO claims (species_id, field, value, status, source, retrieved_at)
     VALUES (?, 'sun_pref', 'full-sun', 'asserted', 'usda-plants-characteristics', '2026-09-01T00:00:00Z')`,
  ).run(taxon.id);
  const original = db
    .prepare("SELECT id FROM claims WHERE species_id = ? AND field = 'sun_pref'")
    .get(taxon.id);

  const dir = mkdtempSync(join(tmpdir(), 'claims-corrections-'));
  const correctionsPath = join(dir, 'manual-corrections.tsv');
  writeFileSync(
    correctionsPath,
    [
      'usda_symbol\tfield\tvalue\treason\tauthor\tdate\tsupersedes_source',
      'TEST1\tsun_pref\tpart-sun\tNPIN direct statement outranks USDA\tjohn.syrinek@gmail.com\t2026-09-19\tusda-plants-characteristics',
    ].join('\n'),
  );

  const { applied } = replayManualCorrections(db, correctionsPath);
  assert.equal(applied, 1);

  const originalAfter = db.prepare('SELECT superseded_by FROM claims WHERE id = ?').get(original.id);
  assert.ok(originalAfter.superseded_by, 'original claim should now point at the correction');

  const correction = db.prepare('SELECT * FROM claims WHERE id = ?').get(originalAfter.superseded_by);
  assert.equal(correction.source, 'manual-correction');
  assert.equal(correction.status, 'asserted');
  assert.equal(correction.value, 'part-sun');

  rmSync(dir, { recursive: true, force: true });
});

test('replayManualCorrections rejects a row missing reason/author rather than importing it', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  seedPlantableCore(db, {
    plantsCsvPath: `${REPO_ROOT}plants.csv`,
    blacklandCsvPath: `${REPO_ROOT}blackland-prairie-natives.csv`,
  });

  const dir = mkdtempSync(join(tmpdir(), 'claims-corrections-bad-'));
  const correctionsPath = join(dir, 'manual-corrections.tsv');
  writeFileSync(
    correctionsPath,
    [
      'usda_symbol\tfield\tvalue\treason\tauthor\tdate\tsupersedes_source',
      'NOSYM\tsun_pref\tpart-sun\t\t\t2026-09-19\t',
    ].join('\n'),
  );

  assert.throws(() => replayManualCorrections(db, correctionsPath), /missing required column "reason"/);
  const count = db.prepare("SELECT COUNT(*) AS n FROM claims WHERE source = 'manual-correction'").get().n;
  assert.equal(count, 0, 'the invalid row must not be imported');

  rmSync(dir, { recursive: true, force: true });
});

test('replayManualCorrections rejects an unresolvable usda_symbol', () => {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  seedPlantableCore(db, {
    plantsCsvPath: `${REPO_ROOT}plants.csv`,
    blacklandCsvPath: `${REPO_ROOT}blackland-prairie-natives.csv`,
  });

  const dir = mkdtempSync(join(tmpdir(), 'claims-corrections-unresolved-'));
  const correctionsPath = join(dir, 'manual-corrections.tsv');
  writeFileSync(
    correctionsPath,
    [
      'usda_symbol\tfield\tvalue\treason\tauthor\tdate\tsupersedes_source',
      'NOSYM\tsun_pref\tpart-sun\tsome reason\tjohn.syrinek@gmail.com\t2026-09-19\t',
    ].join('\n'),
  );

  assert.throws(() => replayManualCorrections(db, correctionsPath), /does not resolve to any taxa row/);

  rmSync(dir, { recursive: true, force: true });
});

test('rebuildClaimsStore is idempotent: running it twice produces the same plantable_set content', () => {
  const dbPath = tempDbPath();
  const first = rebuildClaimsStore({ dbPath, correctionsPath: '/nonexistent/manual-corrections.tsv' });
  const firstNames = first.db
    .prepare(
      `SELECT t.scientific_name FROM plantable_set ps JOIN taxa t ON t.id = ps.taxa_id ORDER BY t.scientific_name`,
    )
    .all()
    .map((r) => r.scientific_name);
  first.db.close();

  const second = rebuildClaimsStore({ dbPath, correctionsPath: '/nonexistent/manual-corrections.tsv' });
  const secondNames = second.db
    .prepare(
      `SELECT t.scientific_name FROM plantable_set ps JOIN taxa t ON t.id = ps.taxa_id ORDER BY t.scientific_name`,
    )
    .all()
    .map((r) => r.scientific_name);
  second.db.close();

  assert.deepEqual(secondNames, firstNames);
  assert.equal(first.plantableCoreSize, second.plantableCoreSize);
});
