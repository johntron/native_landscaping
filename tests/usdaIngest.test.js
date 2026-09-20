import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { ingestUsdaClaims, hasDallasCounty, CLAIM_FIELDS } from '../tools/claims/usdaIngest.js';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'usda-ingest-test-'));
  return join(dir, 'claims.db');
}

function freshDb() {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  return db;
}

function addTaxon(db, { scientificName, rank = 'species', usdaSymbol = null, source = 'plants.csv' }) {
  const result = db
    .prepare('INSERT INTO taxa (scientific_name, rank, usda_symbol) VALUES (?, ?, ?)')
    .run(scientificName, rank, usdaSymbol);
  const id = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO plantable_core (taxa_id, source) VALUES (?, ?)').run(id, source);
  return id;
}

const DALLAS_PRESENT_CSV =
  'Distribution Data\nSymbol,Country,State,State FIP,County,County FIP\nQUSH,United States,Texas,48,Dallas,113\nQUSH,United States,Texas,48,Tarrant,439\n';
const DALLAS_ABSENT_CSV =
  'Distribution Data\nSymbol,Country,State,State FIP,County,County FIP\nQUSH,United States,Texas,48,Tarrant,439\n';

const CHARACTERISTICS = [
  { PlantCharacteristicName: 'Shade Tolerance', PlantCharacteristicValue: 'High' },
  { PlantCharacteristicName: 'Moisture Use', PlantCharacteristicValue: 'Medium' },
  { PlantCharacteristicName: 'Adapted to Coarse Textured Soils', PlantCharacteristicValue: 'Yes' },
  { PlantCharacteristicName: 'Height, Mature (feet)', PlantCharacteristicValue: '45' },
  { PlantCharacteristicName: 'Commercial Availability', PlantCharacteristicValue: 'Routinely Available' },
];

const PROFILE = {
  Symbol: 'QUSH',
  ScientificName: '<i>Quercus shumardii</i> Buckland',
  CommonName: 'Shumard oak',
  GrowthHabits: ['Tree'],
  NativeStatuses: [{ Region: 'L48', Status: 'N' }],
};

/** A stub client good enough to satisfy search.js's searchByNames + usdaIngest's own calls. */
function makeStubClient({ resolvable = true, distributionCsv = DALLAS_PRESENT_CSV, distributionError = null, characteristics = CHARACTERISTICS } = {}) {
  return {
    async searchByName(name) {
      if (!resolvable) return [];
      return [{ ScientificName: PROFILE.ScientificName, CommonName: PROFILE.CommonName, Symbol: PROFILE.Symbol, Id: 70468 }];
    },
    async getProfile(id) {
      return PROFILE;
    },
    async getCharacteristics(id) {
      return characteristics;
    },
    async getDistributionCsv(id) {
      if (distributionError) throw distributionError;
      return distributionCsv;
    },
  };
}

test('hasDallasCounty matches on numeric FIP codes, not the county name string', () => {
  assert.equal(hasDallasCounty(DALLAS_PRESENT_CSV), true);
  assert.equal(hasDallasCounty(DALLAS_ABSENT_CSV), false);
  assert.equal(hasDallasCounty('Distribution Data\nSymbol,Country,State,State FIP,County,County FIP\n'), false);
});

test('a resolved species with a characteristics record gets asserted claims, all four provenance fields populated', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Quercus shumardii' });
  const client = makeStubClient();

  const counts = await ingestUsdaClaims(db, { client, now: () => '2026-09-20T00:00:00.000Z' });

  assert.equal(counts.withCharacteristics, 1);
  assert.equal(counts.countyPresent, 1);

  const claims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(taxonId);
  assert.ok(claims.length > 0);
  for (const claim of claims) {
    assert.ok(claim.source, `claim for ${claim.field} missing source`);
    assert.ok(claim.citation, `claim for ${claim.field} missing citation`);
    assert.ok(claim.retrieved_at, `claim for ${claim.field} missing retrieved_at`);
    assert.ok(claim.license_id, `claim for ${claim.field} missing license_id`);
  }

  const sunPref = claims.find((c) => c.field === 'sun_pref');
  assert.equal(sunPref.value, 'full-sun'); // Shade Tolerance: High -> full-sun
  assert.equal(sunPref.status, 'asserted');
  assert.equal(sunPref.citation, 'usda-plants:PlantCharacteristics:QUSH');

  const county = claims.find((c) => c.field === 'county_presence_48113');
  assert.equal(county.value, 'present');
  assert.equal(county.source, 'usda-plants-county');
  assert.equal(county.citation, 'usda-plants:getDownloadDistributionDocumentation:QUSH');

  // nl-yud fields must never be asserted as claims yet.
  assert.equal(claims.some((c) => c.field === 'usda_commercial_availability'), false);
  assert.equal(counts.nlYudFillRates['Commercial Availability'], 1);

  // taxa.usda_symbol gets backfilled when the search resolved one.
  const taxon = db.prepare('SELECT usda_symbol FROM taxa WHERE id = ?').get(taxonId);
  assert.equal(taxon.usda_symbol, 'QUSH');
});

test('an empty characteristics array (no USDA record) writes status=unknown claims, not missing rows, for characteristics-endpoint fields', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Quercus shumardii' });
  const client = makeStubClient({ characteristics: [] });

  const counts = await ingestUsdaClaims(db, { client, now: () => '2026-09-20T00:00:00.000Z' });
  assert.equal(counts.noCharacteristicsRecord, 1);

  const sunPref = db.prepare("SELECT * FROM claims WHERE species_id = ? AND field = 'sun_pref'").get(taxonId);
  assert.equal(sunPref.status, 'unknown');
  assert.equal(sunPref.value, null);
  assert.ok(sunPref.citation);
  assert.ok(sunPref.retrieved_at);
  assert.ok(sunPref.license_id);

  // Profile-derived fields still come through — the profile call succeeded
  // independently of the characteristics endpoint being empty.
  const nativeStatus = db.prepare("SELECT * FROM claims WHERE species_id = ? AND field = 'usda_native_status'").get(taxonId);
  assert.equal(nativeStatus.status, 'asserted');
  assert.equal(nativeStatus.value, 'L48:N');
});

test('an unresolved species (search finds no match) writes unknown claims for every claim field, including county presence', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Nonexistentia madeupia' });
  const client = makeStubClient({ resolvable: false });

  const counts = await ingestUsdaClaims(db, { client, now: () => '2026-09-20T00:00:00.000Z' });
  assert.equal(counts.unresolved, 1);

  const claims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(taxonId);
  const fields = claims.map((c) => c.field).sort();
  assert.deepEqual(fields, [...CLAIM_FIELDS, 'county_presence_48113'].sort());
  for (const claim of claims) {
    assert.equal(claim.status, 'unknown');
    assert.equal(claim.value, null);
  }
});

test('cultivars are skipped outright — no claims, no network call attempted', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: "Ilex vomitoria 'Nana'", rank: 'cultivar', usdaSymbol: 'ILVO' });
  const client = makeStubClient();

  const counts = await ingestUsdaClaims(db, { client, now: () => '2026-09-20T00:00:00.000Z' });
  assert.equal(counts.cultivarsSkipped, 1);
  const claims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(taxonId);
  assert.deepEqual(claims, []);
});

test('a county-presence fetch failure is recorded as unknown, never as absent — the gate must fail open', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Quercus shumardii' });
  const client = makeStubClient({ distributionError: new Error('USDA API POST /... -> 500') });

  await ingestUsdaClaims(db, { client, now: () => '2026-09-20T00:00:00.000Z' });

  const county = db.prepare("SELECT * FROM claims WHERE species_id = ? AND field = 'county_presence_48113'").get(taxonId);
  assert.equal(county.status, 'unknown');
  assert.equal(county.value, null);

  const inSet = db.prepare('SELECT 1 FROM plantable_set WHERE taxa_id = ?').get(taxonId);
  assert.ok(inSet, 'a species whose county presence could not be checked must stay in plantable_set (fail-open, 10 §2.1)');
});

test('re-running the ingest inserts new rows only — claim count doubles, original rows untouched, exactly one license row', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Quercus shumardii' });
  const client = makeStubClient();

  await ingestUsdaClaims(db, { client, now: () => '2026-09-20T00:00:00.000Z' });
  const firstIds = db.prepare('SELECT id FROM claims WHERE species_id = ? ORDER BY id').all(taxonId).map((r) => r.id);
  const firstCount = firstIds.length;

  await ingestUsdaClaims(db, { client, now: () => '2026-09-21T00:00:00.000Z' });
  const secondRows = db.prepare('SELECT id FROM claims WHERE species_id = ? ORDER BY id').all(taxonId);

  assert.equal(secondRows.length, firstCount * 2);
  // Original rows are still exactly as they were — same ids present, none rewritten.
  for (const id of firstIds) {
    assert.ok(secondRows.some((r) => r.id === id));
  }

  const licenseCount = db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n;
  assert.equal(licenseCount, 1);
});

test('acceptance criterion 1, as a query: every plantable_core taxon has a USDA claim with source/citation/retrieved_at/license_id populated', async () => {
  const db = freshDb();
  addTaxon(db, { scientificName: 'Quercus shumardii' });
  addTaxon(db, { scientificName: "Ilex vomitoria 'Nana'", rank: 'cultivar', usdaSymbol: 'ILVO' });
  const client = makeStubClient();

  await ingestUsdaClaims(db, { client, now: () => '2026-09-20T00:00:00.000Z' });

  // The cultivar is the one legitimate hole: it has no USDA-keyable identity
  // at all (04 §2.3), so it gets no claims here — see the "cultivars are
  // skipped" test above. Everything else must have coverage.
  const missing = db
    .prepare(
      `SELECT t.scientific_name FROM plantable_core pc
       JOIN taxa t ON t.id = pc.taxa_id
       WHERE t.rank != 'cultivar' AND NOT EXISTS (
         SELECT 1 FROM claims c
         WHERE c.species_id = pc.taxa_id
           AND c.source LIKE 'usda-plants%'
           AND c.citation IS NOT NULL AND c.retrieved_at IS NOT NULL AND c.license_id IS NOT NULL
       )`,
    )
    .all();
  assert.deepEqual(missing, []);
});
