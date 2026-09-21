import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import {
  ingestNpinClaims,
  parseNpinFields,
  isResolvedSpeciesPage,
  sunPrefFromLight,
  waterPrefFromWaterUse,
  soilPrefFromDescription,
  bloomMonthFromBloomTime,
  deerResistanceSlug,
  NPIN_CLAIM_FIELDS,
} from '../tools/claims/npinIngest.js';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'npin-ingest-test-'));
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

// Minimal but structurally real fixture — the same
// `<strong>Label:</strong> value <br />` shape inside `<h4>`-headed
// `.section` divs, measured live against wildflower.org/plants/result.php on
// ILVO (Ilex vomitoria) 2026-09-21. Includes a glossary-linked `<a>` tag in
// prose (Conditions Comments) so the tag-stripping regex is exercised against
// the real markup shape, not just plain text.
const ILVO_HTML = `<!DOCTYPE html><html><body>
<div style="float:left;width:97.3%;" class="section"><h4>Bloom Information</h4><strong>Bloom Color:</strong>  White <br /><strong>Bloom Time:</strong>  Apr ,  May <br /></div>
<div style="float:left;width:97.3%;" class="section"><h4>Growing Conditions</h4><strong>Water Use:</strong>  Low <br /><strong>Light Requirement:</strong>  Sun ,  Part  Shade ,  Shade <br /><strong>Soil Moisture:</strong>  Dry ,  Moist <br /><strong>Soil Description:</strong>  Moist  or  well  drained,  sandy,  loamy,  clay,  limestone,  or  gravelly  soils. <br /><strong>Conditions Comments:</strong>  Best  production  of  red  <a class="glossary_link" title="Fruit">fruit</a>  when  shrub  gets  half  a  day  of  sun  or  more. <br /></div>
<div style="float:left;width:97.3%;" class="section"><h4>Benefit</h4><strong>Attracts:</strong>  Birds ,  Butterflies <br /><strong>Larval Host:</strong>  Henrys  Elfin  butterfly <br /><strong>Deer Resistant:</strong>  Moderate <br /></div>
</body></html>`;

// A symbol NPIN doesn't recognize 302-redirects to the plain search page,
// which `fetch` follows to a 200 with no species content — the real shape
// isResolvedSpeciesPage has to reject.
const UNRESOLVED_SEARCH_HTML = `<!DOCTYPE html><html><body>
<h1>Plant Database</h1>
<p>Search for native plants by scientific name, common name or family.</p>
<form method="get" action="/plants/search.php"></form>
</body></html>`;

function makeStubClient(pagesBySymbol, { requestDelayMs = 3000 } = {}) {
  return {
    requestDelayMs,
    async fetchSpeciesPage(symbol) {
      if (symbol in pagesBySymbol) {
        const entry = pagesBySymbol[symbol];
        if (entry instanceof Error) throw entry;
        return entry;
      }
      return UNRESOLVED_SEARCH_HTML;
    },
  };
}

test('isResolvedSpeciesPage tells a real species page apart from the unresolved-redirect search page', () => {
  assert.equal(isResolvedSpeciesPage(ILVO_HTML), true);
  assert.equal(isResolvedSpeciesPage(UNRESOLVED_SEARCH_HTML), false);
});

test('parseNpinFields extracts every labeled field, tags stripped, whitespace collapsed', () => {
  const fields = parseNpinFields(ILVO_HTML);
  assert.deepEqual(fields.bloomTime, ['Apr', 'May']);
  assert.deepEqual(fields.lightRequirement, ['Sun', 'Part Shade', 'Shade']);
  assert.equal(fields.waterUse, 'Low');
  assert.equal(fields.soilDescription, 'Moist or well drained, sandy, loamy, clay, limestone, or gravelly soils.');
  assert.equal(fields.deerResistant, 'Moderate');
  assert.equal(fields.larvalHost, 'Henrys Elfin butterfly');
});

test('value mapping functions', () => {
  assert.equal(sunPrefFromLight(['Sun', 'Part Shade', 'Shade']), 'full-sun,part-sun,shade');
  assert.equal(sunPrefFromLight(['Sun']), 'full-sun');
  assert.equal(sunPrefFromLight(null), null);

  assert.equal(waterPrefFromWaterUse('Low'), 'low');
  assert.equal(waterPrefFromWaterUse(null), null);

  assert.equal(soilPrefFromDescription('sandy, loamy, clay, limestone soils'), 'sandy,loamy,clay');
  assert.equal(soilPrefFromDescription('Well-drained limestone soils, caliches and rocky soils'), null);
  assert.equal(soilPrefFromDescription(null), null);

  assert.equal(bloomMonthFromBloomTime(['Apr', 'May']), '4-5');
  assert.equal(bloomMonthFromBloomTime(['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']), '4-10');
  assert.equal(bloomMonthFromBloomTime(['Feb', 'Aug']), '2,8');
  // Sorted ascending, so Dec/Jan doesn't collapse to a wraparound range —
  // same limitation seasonMonths.js's parseSeasonPhrase already has (its own
  // prev===12&&m===1 branch is unreachable after an ascending sort).
  assert.equal(bloomMonthFromBloomTime(['Dec', 'Jan']), '1,12');
  assert.equal(bloomMonthFromBloomTime(null), null);

  assert.equal(deerResistanceSlug('Moderate'), 'moderate');
  assert.equal(deerResistanceSlug('Rarely Damaged'), 'rarely-damaged');
  assert.equal(deerResistanceSlug(null), null);
});

test('a resolved species page writes asserted claims for every field it has, all carrying source/citation/license', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Ilex vomitoria', usdaSymbol: 'ILVO' });
  const client = makeStubClient({ ILVO: ILVO_HTML });

  const counts = await ingestNpinClaims(db, { client, now: () => '2026-09-21T00:00:00.000Z' });

  assert.equal(counts.pageResolved, 1);
  assert.equal(counts.pageUnresolved, 0);
  assert.equal(counts.requestDelayMs, 3000);
  assert.match(counts.crawlSummary, /1\/1 species pages fetched/);

  const claims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(taxonId);
  assert.equal(claims.length, NPIN_CLAIM_FIELDS.length);
  for (const claim of claims) {
    assert.equal(claim.status, 'asserted');
    assert.equal(claim.source, 'npin');
    assert.equal(claim.citation, 'npin:result.php:ILVO');
    assert.equal(claim.retrieved_at, '2026-09-21T00:00:00.000Z');
    assert.ok(claim.license_id, `claim for ${claim.field} missing license_id`);
  }

  const byField = Object.fromEntries(claims.map((c) => [c.field, c.value]));
  assert.equal(byField.sun_pref, 'full-sun,part-sun,shade');
  assert.equal(byField.water_pref, 'low');
  assert.equal(byField.soil_pref, 'sandy,loamy,clay');
  assert.equal(byField.bloom_month, '4-5');
  assert.equal(byField.deer_resistance, 'moderate');
  assert.equal(byField.larval_host_species, 'Henrys Elfin butterfly');
});

test('the NPIN license row is conditional and shared across claims, matching permission-requests.md §2', async () => {
  const db = freshDb();
  addTaxon(db, { scientificName: 'Ilex vomitoria', usdaSymbol: 'ILVO' });
  const client = makeStubClient({ ILVO: ILVO_HTML });
  await ingestNpinClaims(db, { client });

  const license = db.prepare("SELECT * FROM licenses WHERE source = 'npin'").get();
  assert.equal(license.grant, 'personal-noncommercial');
  assert.equal(license.condition, 'void if project becomes commercial');
  assert.equal(license.citation_required, 'Courtesy of Lady Bird Johnson Wildflower Center');

  // Re-running the ingest must not create a second license row (find-or-create).
  await ingestNpinClaims(db, { client });
  const licenseCount = db.prepare("SELECT COUNT(*) AS n FROM licenses WHERE source = 'npin'").get();
  assert.equal(licenseCount.n, 1);
});

test('a cultivar is skipped outright — no NPIN page of its own to resolve', async () => {
  const db = freshDb();
  const speciesId = addTaxon(db, { scientificName: 'Ilex vomitoria', usdaSymbol: 'ILVO' });
  db.prepare('INSERT INTO taxa (scientific_name, rank, parent_id) VALUES (?, ?, ?)').run("Ilex vomitoria 'Nana'", 'cultivar', speciesId);
  const cultivarId = Number(
    db.prepare("SELECT id FROM taxa WHERE scientific_name = ?").get("Ilex vomitoria 'Nana'").id,
  );
  db.prepare('INSERT INTO plantable_core (taxa_id, source) VALUES (?, ?)').run(cultivarId, 'plants.csv');

  const client = makeStubClient({ ILVO: ILVO_HTML });
  const counts = await ingestNpinClaims(db, { client });

  assert.equal(counts.cultivarsSkipped, 1);
  const cultivarClaims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(cultivarId);
  assert.equal(cultivarClaims.length, 0);
});

test('a taxon with no usda_symbol yet gets explicit unknown claims, not a skip — NPIN has no other way to key on it', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Some Unresolved Species', usdaSymbol: null });
  const client = makeStubClient({});

  const counts = await ingestNpinClaims(db, { client });

  assert.equal(counts.noSymbol, 1);
  assert.equal(counts.pageResolved, 0);
  const claims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(taxonId);
  assert.equal(claims.length, NPIN_CLAIM_FIELDS.length);
  for (const claim of claims) {
    assert.equal(claim.status, 'unknown');
    assert.equal(claim.value, null);
  }
});

test('a symbol that redirects to the search page (unresolved) gets explicit unknown claims', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Quercus shumardii', usdaSymbol: 'QUSH' });
  // QUSH is measured (2026-09-21) not to be Quercus shumardii's NPIN id — the
  // real-world case this test models, not a hypothetical.
  const client = makeStubClient({ QUSH: UNRESOLVED_SEARCH_HTML });

  const counts = await ingestNpinClaims(db, { client });

  assert.equal(counts.pageUnresolved, 1);
  assert.equal(counts.pageResolved, 0);
  const claims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(taxonId);
  assert.equal(claims.length, NPIN_CLAIM_FIELDS.length);
  for (const claim of claims) {
    assert.equal(claim.status, 'unknown');
    assert.match(claim.citation, /^npin:result\.php:unresolved:QUSH$/);
  }
});

test('a fetch failure (network error) writes unknown claims, never "absent"', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Prunus mexicana', usdaSymbol: 'PRME' });
  const client = makeStubClient({ PRME: new Error('network timeout') });

  const counts = await ingestNpinClaims(db, { client });

  assert.equal(counts.fetchFailed, 1);
  const claims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(taxonId);
  assert.equal(claims.length, NPIN_CLAIM_FIELDS.length);
  for (const claim of claims) assert.equal(claim.status, 'unknown');
});

test('a page missing one field (no Larval Host) writes no claim for it — silence, not unknown', async () => {
  const db = freshDb();
  const html = ILVO_HTML.replace(/<strong>Larval Host:<\/strong>[^<]*<br \/>/, '');
  const taxonId = addTaxon(db, { scientificName: 'Ilex vomitoria', usdaSymbol: 'ILVO' });
  const client = makeStubClient({ ILVO: html });

  await ingestNpinClaims(db, { client });

  const claims = db.prepare('SELECT * FROM claims WHERE species_id = ?').all(taxonId);
  assert.equal(claims.some((c) => c.field === 'larval_host_species'), false);
  assert.equal(claims.length, NPIN_CLAIM_FIELDS.length - 1);
});

test('per-field precedence: an NPIN claim and a USDA claim for the same field coexist as two rows, letting precedence.js arbitrate', async () => {
  const db = freshDb();
  const taxonId = addTaxon(db, { scientificName: 'Ilex vomitoria', usdaSymbol: 'ILVO' });
  db.prepare(
    `INSERT INTO claims (species_id, field, value, status, source, citation, retrieved_at)
     VALUES (?, 'sun_pref', 'full-sun', 'asserted', 'usda-plants-characteristics', 'usda-plants:PlantCharacteristics:ILVO', '2026-09-20T00:00:00.000Z')`,
  ).run(taxonId);

  const client = makeStubClient({ ILVO: ILVO_HTML });
  await ingestNpinClaims(db, { client, now: () => '2026-09-21T00:00:00.000Z' });

  const sunPrefClaims = db.prepare("SELECT * FROM claims WHERE species_id = ? AND field = 'sun_pref'").all(taxonId);
  assert.equal(sunPrefClaims.length, 2);
  assert.ok(sunPrefClaims.some((c) => c.source === 'usda-plants-characteristics'));
  assert.ok(sunPrefClaims.some((c) => c.source === 'npin' && c.value === 'full-sun,part-sun,shade'));
});
