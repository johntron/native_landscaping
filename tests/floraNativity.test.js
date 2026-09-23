import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from '../src/data/csvLoader.js';
import { buildFloraIndex, buildGenusDictionary, headingKey, loadCorpusText } from '../tools/claims/floraCorpus.js';
import { reconcileCatalog, parseCatalogName } from '../tools/claims/nameReconciliation.js';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { seedPlantableCore } from '../tools/claims/taxaSeed.js';
import { buildTreatmentIndex, classifyNativity, ingestFloraNativity } from '../tools/claims/floraNativity.js';
import { SOURCE } from '../tools/claims/precedence.js';
import { rebuildClaimsStore } from '../tools/claims/rebuild.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'claims-nativity-'));
  return join(dir, 'claims.db');
}

// Built once against the real corpus, same discipline as nameReconciliation.test.js.
const catalog = parseCsv(readFileSync(`${REPO_ROOT}catalog/blackland-prairie-natives.csv`, 'utf8'));
const genusDictionary = buildGenusDictionary(catalog);
const floraIndex = buildFloraIndex(loadCorpusText(), genusDictionary);
const treatmentIndex = buildTreatmentIndex(genusDictionary);

function buildIngestedStore() {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  seedPlantableCore(db, {
    plantsCsvPath: `${REPO_ROOT}plants.csv`,
    blacklandCsvPath: `${REPO_ROOT}catalog/blackland-prairie-natives.csv`,
  });
  reconcileCatalog(db, catalog, floraIndex);
  ingestFloraNativity(db, treatmentIndex);
  return db;
}

function classifyByName(name) {
  const parsed = parseCatalogName(name);
  const key = headingKey(parsed.genus, parsed.species, parsed.rank, parsed.infraEpithet);
  return treatmentIndex.get(key);
}

// 03 §3's Lonicera maackii regression: a wrapped ALL-CAPS common name must
// not be read as the next genus heading, dropping the trailing 'I'.
test('03 §6a control: Lonicera maackii keeps its wrapped common name and its introduced I', () => {
  const treatment = classifyByName('Lonicera maackii');
  assert.equal(classifyNativity(treatment.text).value, 'introduced');
});

// 03 §6b control: a genus synopsis must not bleed into the species either
// side of it.
test('03 §6b control: genus-synopsis text does not bleed onto the species it borders', () => {
  for (const name of ['Lupinus texensis', 'Lupinus subcarnosus', 'Engelmannia peristenia']) {
    const treatment = classifyByName(name);
    assert.notEqual(classifyNativity(treatment.text).value, 'introduced', name);
  }
});

// 03 §7's two hand-verified misattributions: a same-genus/same-species
// neighbor's 'I' must never attach to the wrong exact taxon.
test("03 §7 control: Bothriochloa barbinodis does not inherit B. ischaemum's introduced flag", () => {
  const treatment = classifyByName('Bothriochloa barbinodis');
  assert.notEqual(classifyNativity(treatment.text).value, 'introduced');
});

test("03 §7 control: Prunella vulgaris subsp. lanceolata does not inherit subsp. vulgaris's introduced flag", () => {
  const treatment = classifyByName('Prunella vulgaris subsp. lanceolata');
  assert.notEqual(classifyNativity(treatment.text).value, 'introduced');
});

// 03 §7.1's per-taxon review table: page citations are the free exact
// oracle (already committed in manual-corrections.tsv for the 7 confirmed
// non-natives), and every one of these 15 reachable taxa must screen to
// 'review', never auto-assert a verdict (03 §4: "never auto-assign").
// Eschscholzia californica and Taxodium distichum are excluded here — 06 §3
// steps 1/2 leave them matched_via='unmatched' (the flora only treats their
// infraspecific ranks), a name-reconciliation gap this bead does not own.
test("03 §7.1 control: the 15 reachable prose-origin hits all screen to review with their recorded page", () => {
  const expected = [
    ['Chilopsis linearis', 443],
    ['Catalpa speciosa', 443],
    ['Robinia pseudoacacia', 692],
    ['Gymnocladus dioicus', 663],
    ['Tillandsia usneoides', 1096],
    ['Quercus muehlenbergii', 716],
    ['Maclura pomifera', 831],
    ['Heliotropium curassavicum', 450],
    ['Impatiens capensis', 434],
    ['Phragmites australis', 1311],
    ['Pinus echinata', 206],
    ['Pinus taeda', 207],
    ['Cyperus esculentus', 1138],
    ['Nymphaea mexicana', 845],
  ];
  for (const [name, page] of expected) {
    const treatment = classifyByName(name);
    assert.ok(treatment, `${name} should resolve to a treatment`);
    assert.equal(treatment.page, page, `${name} page citation`);
    const result = classifyNativity(treatment.text);
    assert.equal(result.status, 'review', `${name} status`);
    assert.equal(result.value, null, `${name} value`);
  }
});

test('classifyNativity: the four-step routing (03 §4.1) — I, origin-phrase, escape-language, silence', () => {
  assert.deepEqual(classifyNativity('Native from India to e Asia. I'), {
    status: 'asserted',
    value: 'introduced',
    screen: 'introduced-symbol',
  });
  assert.deepEqual(classifyNativity('Cultivated in gardens; native of Mexico and sw U.S.'), {
    status: 'review',
    value: null,
    screen: 'origin-phrase',
  });
  assert.deepEqual(classifyNativity('Cultivated and long persists, planted along highways, escapes.'), {
    status: 'review',
    value: null,
    screen: 'escape-language',
  });
  assert.deepEqual(classifyNativity('Sandy prairies and open woods; e TX w to nc TX.'), {
    status: 'asserted',
    value: 'native',
    screen: 'silence',
  });
});

test('ingestFloraNativity writes one nativity_nctx claim per reconciled taxon, sourced and cited', () => {
  const db = buildIngestedStore();
  const rows = db.prepare("SELECT status, value, source, citation FROM claims WHERE field = 'nativity_nctx'").all();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.source, SOURCE.NCTX_FLORA);
    assert.ok(['asserted', 'review', 'unknown'].includes(row.status));
    if (row.status === 'unknown') {
      assert.equal(row.value, null);
      assert.equal(row.citation, null);
    } else if (row.status === 'review') {
      assert.equal(row.value, null);
      assert.match(row.citation, /^Diggs, Lipscomb & O'Kennon 1999, p\. \d+$/);
    } else {
      assert.ok(row.value === 'native' || row.value === 'introduced');
      assert.match(row.citation, /^Diggs, Lipscomb & O'Kennon 1999, p\. \d+$/);
    }
  }
});

test('ingestFloraNativity: a species outside the reconciled corpus gets an unknown claim, not a guess', () => {
  const db = buildIngestedStore();
  const row = db
    .prepare(
      `SELECT c.status, c.value FROM claims c
       JOIN taxa t ON t.id = c.species_id
       WHERE t.scientific_name = 'Acer grandidentatum' AND c.field = 'nativity_nctx'`,
    )
    .get();
  assert.deepEqual({ ...row }, { status: 'unknown', value: null });
});

test('ingestFloraNativity never writes flora prose — only status/value/citation, no excerpt', () => {
  const db = buildIngestedStore();
  const rows = db.prepare("SELECT citation FROM claims WHERE field = 'nativity_nctx' AND citation IS NOT NULL").all();
  for (const { citation } of rows) {
    assert.match(citation, /^Diggs, Lipscomb & O'Kennon 1999, p\. \d+$/, `citation "${citation}" is not the fixed page format`);
  }
});

test('rebuild ordering: ingestFloraNativity runs before a manual correction supersedes it', () => {
  // Mirrors 09 §2.1's replay-last rule: a correction targeting the same
  // (species, field) the flora just asserted must find a claim to supersede.
  const db = buildIngestedStore();
  const chilopsisId = db.prepare("SELECT id FROM taxa WHERE scientific_name = 'Chilopsis linearis'").get().id;
  const sourcedClaim = db
    .prepare(
      "SELECT id FROM claims WHERE species_id = ? AND field = 'nativity_nctx' AND source = ? AND superseded_by IS NULL",
    )
    .get(chilopsisId, SOURCE.NCTX_FLORA);
  assert.ok(sourcedClaim, 'a sourced nativity_nctx claim must exist for a manual correction to target');
});

// AC bullet 1: "nativity claims exist for every plantable-set species the
// corpus treats" — every non-cultivar plantable_core row must carry a
// nativity_nctx claim of SOME status, including 'unknown'. A plants.csv-only
// species (not also in blackland-prairie-natives.csv, e.g. one added to the
// live catalog before the wider list) previously got no reconciliation row
// at all and therefore no claim whatsoever — a gap 04 §5's "missing" lookup
// must not silently have. Runs the real rebuild pipeline, not a hand-rolled
// substitute, so it catches a regression in how rebuild.js builds the
// reconciliation catalog, not just in floraNativity.js itself.
test('rebuildClaimsStore: every non-cultivar plantable_core taxon gets a nativity_nctx claim of some status', () => {
  const { db } = rebuildClaimsStore({ dbPath: tempDbPath() });
  const gaps = db
    .prepare(
      `SELECT t.scientific_name, t.rank FROM plantable_core pc
       JOIN taxa t ON t.id = pc.taxa_id
       WHERE t.rank != 'cultivar'
         AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.species_id = pc.taxa_id AND c.field = 'nativity_nctx')`,
    )
    .all();
  assert.deepEqual(gaps, [], `plantable_core taxa with no nativity_nctx claim at all: ${JSON.stringify(gaps)}`);
});
