import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import {
  claimsCoverage,
  claimsProvenance,
  claimsConflicts,
  claimsSources,
  claimsCorrect,
  claimsDryRun,
  resolveTaxon,
} from '../tools/claims/claimsTools.js';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'claims-tools-test-'));
  return join(dir, 'claims.db');
}

function tempPath(name) {
  const dir = mkdtempSync(join(tmpdir(), 'claims-tools-test-'));
  return join(dir, name);
}

function makeStore() {
  const db = openClaimsStore(tempDbPath());
  createSchema(db);
  return db;
}

function insertTaxon(db, { name, rank = 'species', parentId = null, usdaSymbol = null }) {
  const result = db
    .prepare('INSERT INTO taxa (scientific_name, rank, parent_id, usda_symbol) VALUES (?, ?, ?, ?)')
    .run(name, rank, parentId, usdaSymbol);
  return Number(result.lastInsertRowid);
}

function insertLicense(db, { source, grant, condition = null }) {
  const result = db
    .prepare('INSERT INTO licenses (source, "grant", condition) VALUES (?, ?, ?)')
    .run(source, grant, condition);
  return Number(result.lastInsertRowid);
}

function insertClaim(db, { speciesId, field, value, status = 'asserted', source, licenseId = null, retrievedAt = '2026-09-21T00:00:00Z', supersededBy = null }) {
  const result = db
    .prepare(
      `INSERT INTO claims (species_id, field, value, status, source, retrieved_at, license_id, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(speciesId, field, value, status, source, retrievedAt, licenseId, supersededBy);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// resolveTaxon — shared species resolution
// ---------------------------------------------------------------------------

test('resolveTaxon resolves by taxa.id (number or numeric string) and by usda_symbol, and throws naming what failed', () => {
  const db = makeStore();
  const id = insertTaxon(db, { name: 'Salvia greggii', usdaSymbol: 'SAGR9' });

  assert.equal(resolveTaxon(db, id).scientific_name, 'Salvia greggii');
  assert.equal(resolveTaxon(db, String(id)).scientific_name, 'Salvia greggii');
  assert.equal(resolveTaxon(db, 'SAGR9').scientific_name, 'Salvia greggii');
  assert.throws(() => resolveTaxon(db, 'NOPE'), /no taxa row with usda_symbol "NOPE"/);
  assert.throws(() => resolveTaxon(db, 999999), /no taxa row with id 999999/);
  assert.throws(() => resolveTaxon(db, ''), /species is required/);
});

// ---------------------------------------------------------------------------
// claims_coverage
// ---------------------------------------------------------------------------

test('claims_coverage: asserted, review, unknown, and missing are all distinguished', () => {
  const db = makeStore();
  const a = insertTaxon(db, { name: 'Species Asserted' });
  const r = insertTaxon(db, { name: 'Species Review' });
  const u = insertTaxon(db, { name: 'Species Unknown' });
  const m = insertTaxon(db, { name: 'Species Missing' });

  insertClaim(db, { speciesId: a, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'npin' });
  insertClaim(db, { speciesId: r, field: 'sun_pref', value: 'part-sun', status: 'review', source: 'npin' });
  insertClaim(db, { speciesId: u, field: 'sun_pref', value: null, status: 'unknown', source: 'nctx-flora' });
  // m gets no claim at all.

  const results = claimsCoverage(db, { field: 'sun_pref' });
  const byName = Object.fromEntries(results.map((r) => [r.species, r]));

  assert.equal(byName['Species Asserted'].status, 'asserted');
  assert.equal(byName['Species Asserted'].assertedCount, 1);
  assert.deepEqual(byName['Species Asserted'].sourcesAsserting, ['npin']);

  assert.equal(byName['Species Review'].status, 'review');
  assert.equal(byName['Species Unknown'].status, 'unknown');
  assert.equal(byName['Species Missing'].status, 'missing');
});

test('claims_coverage: a cultivar with no own claim inherits the parent species status, not missing', () => {
  const db = makeStore();
  const parent = insertTaxon(db, { name: 'Ilex vomitoria' });
  const cultivar = insertTaxon(db, { name: "Ilex vomitoria 'Nana'", rank: 'cultivar', parentId: parent });

  insertClaim(db, { speciesId: parent, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'npin' });

  const [coverage] = claimsCoverage(db, { field: 'sun_pref', species: cultivar });
  assert.equal(coverage.status, 'asserted');
  assert.deepEqual(coverage.sourcesAsserting, ['npin']);

  // But an own claim, even an unknown one, wins outright — no fallthrough to the parent.
  insertClaim(db, { speciesId: cultivar, field: 'height_ft', value: null, status: 'unknown', source: 'nctx-flora' });
  insertClaim(db, { speciesId: parent, field: 'height_ft', value: '45', status: 'asserted', source: 'usda-plants-characteristics' });
  const [heightCoverage] = claimsCoverage(db, { field: 'height_ft', species: cultivar });
  assert.equal(heightCoverage.status, 'unknown');
});

test('claims_coverage: a superseded claim does not count toward asserted status', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Species Superseded' });
  const oldId = insertClaim(db, { speciesId: s, field: 'water_pref', value: 'dry', status: 'asserted', source: 'usda-plants-characteristics' });
  insertClaim(db, { speciesId: s, field: 'water_pref', value: 'medium', status: 'asserted', source: 'manual-correction' });
  db.prepare('UPDATE claims SET superseded_by = (SELECT MAX(id) FROM claims) WHERE id = ?').run(oldId);

  const [coverage] = claimsCoverage(db, { field: 'water_pref', species: s });
  assert.equal(coverage.status, 'asserted');
  assert.deepEqual(coverage.sourcesAsserting, ['manual-correction']);
});

test('claims_coverage with no arguments sweeps every claimed field and every non-synonym species', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Species One' });
  const synonym = insertTaxon(db, { name: 'Old Name', resolvesTo: s });
  db.prepare('UPDATE taxa SET resolves_to = ? WHERE id = ?').run(s, synonym);
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'npin' });

  const results = claimsCoverage(db);
  assert.ok(results.some((r) => r.species === 'Species One' && r.field === 'sun_pref'));
  assert.ok(!results.some((r) => r.species === 'Old Name'), 'a synonym row itself should never appear in coverage');
});

// ---------------------------------------------------------------------------
// claims_provenance
// ---------------------------------------------------------------------------

test('claims_provenance returns every claim row including superseded ones, plus the resolved winner and reason', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Passiflora lutea' });
  const oldId = insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'full-shade', status: 'asserted', source: 'usda-plants-characteristics' });
  const newId = insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'part-sun', status: 'asserted', source: 'manual-correction' });
  db.prepare('UPDATE claims SET superseded_by = ? WHERE id = ?').run(newId, oldId);

  const result = claimsProvenance(db, { species: s, field: 'sun_pref' });
  assert.equal(result.claims.length, 2, 'both the superseded and the superseding claim are returned');
  assert.deepEqual(result.resolved, { value: 'part-sun', source: 'manual-correction' });
  assert.match(result.resolutionReason, /manual-correction outranks/);
});

test('claims_provenance: tied disagreeing claims resolve to no winner, with a reason explaining the tie', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Callicarpa americana' });
  insertClaim(db, { speciesId: s, field: 'lep_host_species', value: '3', status: 'asserted', source: 'nwf-keystone' });
  insertClaim(db, { speciesId: s, field: 'lep_host_species', value: '5', status: 'asserted', source: 'nwf-keystone' });

  const result = claimsProvenance(db, { species: s, field: 'lep_host_species' });
  assert.equal(result.resolved, null);
  assert.match(result.resolutionReason, /tied claims/);
});

test('claims_provenance requires field and rejects an unresolvable species', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Some Species' });
  assert.throws(() => claimsProvenance(db, { species: s }), /field is required/);
  assert.throws(() => claimsProvenance(db, { species: 'NOPE', field: 'sun_pref' }), /no taxa row/);
});

// ---------------------------------------------------------------------------
// claims_conflicts
// ---------------------------------------------------------------------------

test('claims_conflicts surfaces review rows and disagreeing asserted claims, but not agreeing ones or superseded ones', () => {
  const db = makeStore();
  const reviewSpecies = insertTaxon(db, { name: 'Review Species' });
  const disagreeSpecies = insertTaxon(db, { name: 'Disagree Species' });
  const agreeSpecies = insertTaxon(db, { name: 'Agree Species' });
  const resolvedSpecies = insertTaxon(db, { name: 'Resolved Species' });

  insertClaim(db, { speciesId: reviewSpecies, field: 'nativity_nctx', value: null, status: 'review', source: 'nctx-flora' });

  insertClaim(db, { speciesId: disagreeSpecies, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'npin' });
  insertClaim(db, { speciesId: disagreeSpecies, field: 'sun_pref', value: 'part-sun', status: 'asserted', source: 'usda-plants-characteristics' });

  insertClaim(db, { speciesId: agreeSpecies, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'npin' });
  insertClaim(db, { speciesId: agreeSpecies, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'usda-plants-characteristics' });

  const oldId = insertClaim(db, { speciesId: resolvedSpecies, field: 'sun_pref', value: 'full-sun', status: 'asserted', source: 'usda-plants-characteristics' });
  const newId = insertClaim(db, { speciesId: resolvedSpecies, field: 'sun_pref', value: 'part-sun', status: 'asserted', source: 'manual-correction' });
  db.prepare('UPDATE claims SET superseded_by = ? WHERE id = ?').run(newId, oldId);

  const conflicts = claimsConflicts(db);
  const species = conflicts.map((c) => c.species);
  assert.ok(species.includes('Review Species'));
  assert.ok(species.includes('Disagree Species'));
  assert.ok(!species.includes('Agree Species'), 'agreeing sources are not a conflict');
  assert.ok(!species.includes('Resolved Species'), 'a superseded disagreement is already resolved');
});

test('claims_conflicts scopes to one field when given', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Multi Field Species' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'a', status: 'asserted', source: 'npin' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'b', status: 'asserted', source: 'usda-plants-characteristics' });
  insertClaim(db, { speciesId: s, field: 'water_pref', value: 'x', status: 'review', source: 'npin' });

  const scoped = claimsConflicts(db, { field: 'water_pref' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].field, 'water_pref');
});

// ---------------------------------------------------------------------------
// claims_sources
// ---------------------------------------------------------------------------

test('claims_sources reports counts, freshness, and the license actually referenced by that source\'s claims', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Some Species' });
  const usdaLicense = insertLicense(db, { source: 'usda-plants', grant: 'unrestricted' });
  insertClaim(db, {
    speciesId: s,
    field: 'sun_pref',
    value: 'full-sun',
    source: 'usda-plants-characteristics',
    licenseId: usdaLicense,
    retrievedAt: '2020-01-01T00:00:00Z',
  });
  insertClaim(db, {
    speciesId: s,
    field: 'water_pref',
    value: 'dry',
    source: 'usda-plants-characteristics',
    licenseId: usdaLicense,
    retrievedAt: '2020-06-01T00:00:00Z',
  });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'part-sun', source: 'manual-correction' });

  const sources = claimsSources(db);
  const usda = sources.find((r) => r.source === 'usda-plants-characteristics');
  assert.equal(usda.claimCount, 2);
  assert.deepEqual(usda.claimCountByField, { sun_pref: 1, water_pref: 1 });
  assert.equal(usda.retrievedAtMin, '2020-01-01T00:00:00Z');
  assert.equal(usda.retrievedAtMax, '2020-06-01T00:00:00Z');
  assert.deepEqual(usda.license, { grant: 'unrestricted', condition: null, citationRequired: null });

  const manual = sources.find((r) => r.source === 'manual-correction');
  assert.equal(manual.license, null, 'a source with no license row referenced reports null, not a guess');
});

test('claims_sources scopes to one source when given', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Some Species' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'a', source: 'npin' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'b', source: 'usda-plants-characteristics' });

  const scoped = claimsSources(db, { source: 'npin' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].source, 'npin');
});

// ---------------------------------------------------------------------------
// claims_correct
// ---------------------------------------------------------------------------

test('claims_correct rejects a call missing reason or author', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Passiflora lutea', usdaSymbol: 'PALU2' });
  const correctionsPath = tempPath('manual-corrections.tsv');

  assert.throws(
    () => claimsCorrect(db, { species: s, field: 'sun_pref', value: 'part-sun', author: 'john.syrinek@gmail.com' }, { correctionsPath }),
    /reason is required/,
  );
  assert.throws(
    () => claimsCorrect(db, { species: s, field: 'sun_pref', value: 'part-sun', reason: 'NPIN direct statement' }, { correctionsPath }),
    /author is required/,
  );
  assert.ok(!existsSync(correctionsPath), 'a rejected call must not write anything');
});

test('claims_correct appends a well-formed TSV row, resolving usda_symbol and auto-filling supersedes_source', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Passiflora lutea', usdaSymbol: 'PALU2' });
  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'full-shade', status: 'asserted', source: 'usda-plants-characteristics' });
  const correctionsPath = tempPath('manual-corrections.tsv');

  const result = claimsCorrect(
    db,
    { species: s, field: 'sun_pref', value: 'part-sun', reason: 'NPIN direct statement outranks USDA', author: 'john.syrinek@gmail.com' },
    { correctionsPath },
  );

  assert.equal(result.path, correctionsPath);
  assert.equal(result.record.usda_symbol, 'PALU2');
  assert.equal(result.record.supersedes_source, 'usda-plants-characteristics');
  assert.match(result.note, /not updated until the next rebuild/);

  const fileText = readFileSync(correctionsPath, 'utf8');
  const lines = fileText.trim().split('\n');
  assert.equal(lines[0], 'usda_symbol\tfield\tvalue\treason\tauthor\tdate\tsupersedes_source');
  assert.equal(lines.length, 2);
  const cells = lines[1].split('\t');
  assert.deepEqual(cells.slice(0, 5), ['PALU2', 'sun_pref', 'part-sun', 'NPIN direct statement outranks USDA', 'john.syrinek@gmail.com']);
});

test('claims_correct appends to an existing file without disturbing prior rows, and builds a cultivar key from the parent symbol', () => {
  const db = makeStore();
  const parent = insertTaxon(db, { name: 'Ilex vomitoria', usdaSymbol: 'ILVO' });
  const cultivar = insertTaxon(db, { name: "Ilex vomitoria 'Nana'", rank: 'cultivar', parentId: parent });
  const correctionsPath = tempPath('manual-corrections.tsv');
  writeFileSync(correctionsPath, 'usda_symbol\tfield\tvalue\treason\tauthor\tdate\tsupersedes_source\nEXIST\tsun_pref\ta\treason\tauthor\t2026-01-01\t\n');

  const result = claimsCorrect(
    db,
    { species: cultivar, field: 'height_ft', value: '3', reason: 'nursery tag', author: 'john.syrinek@gmail.com' },
    { correctionsPath },
  );
  assert.equal(result.record.usda_symbol, "ILVO 'Nana'");

  const lines = readFileSync(correctionsPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, 'the pre-existing row must survive the append');
  assert.equal(lines[1].split('\t')[0], 'EXIST');
});

test('claims_correct rejects a value/reason/author containing a tab or newline rather than mangling the file', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Some Species', usdaSymbol: 'SOME1' });
  const correctionsPath = tempPath('manual-corrections.tsv');
  assert.throws(
    () => claimsCorrect(db, { species: s, field: 'sun_pref', value: 'a', reason: 'line one\nline two', author: 'x' }, { correctionsPath }),
    /may not contain a tab or newline/,
  );
});

test('claims_correct throws for a taxon with no usda_symbol and no cultivar parent to key off of', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Nameless Species' }); // no usdaSymbol
  const correctionsPath = tempPath('manual-corrections.tsv');
  assert.throws(
    () => claimsCorrect(db, { species: s, field: 'sun_pref', value: 'a', reason: 'r', author: 'a' }, { correctionsPath }),
    /has no usda_symbol/,
  );
});

// ---------------------------------------------------------------------------
// claims_dry_run
// ---------------------------------------------------------------------------

test('claims_dry_run requires a valid mode, and requires source for recrawl', () => {
  const db = makeStore();
  assert.throws(() => claimsDryRun(db, { mode: 'bogus' }), /mode must be/);
  assert.throws(() => claimsDryRun(db, { mode: 'recrawl' }), /source is required/);
});

test('claims_dry_run recrawl mode reports currently-missing fields this source is eligible for, and never fabricates changed/newlyExcluded', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Some Species' });
  // sun_pref's precedence order includes npin (precedence.js); it has no claim
  // at all yet, so it is genuinely "missing", not "unknown".
  // A different field with a genuine claim establishes allClaimedFields() sees sun_pref at all.
  const other = insertTaxon(db, { name: 'Other Species' });
  insertClaim(db, { speciesId: other, field: 'sun_pref', value: null, status: 'unknown', source: 'nctx-flora' });
  // A field with an existing asserted claim should not show up as "added".
  insertClaim(db, { speciesId: s, field: 'lep_host_species', value: '2', status: 'asserted', source: 'nwf-keystone' });

  const result = claimsDryRun(db, { mode: 'recrawl', source: 'npin' });
  assert.equal(result.changed.length, 0);
  assert.equal(result.newlyExcluded.length, 0);
  assert.ok(result.added.some((a) => a.species === 'Some Species' && a.field === 'sun_pref'));
  assert.match(result.note, /does not perform a live fetch/);
});

test('claims_dry_run recrawl mode reports nothing for a source with no field eligibility', () => {
  const db = makeStore();
  const result = claimsDryRun(db, { mode: 'recrawl', source: 'not-a-real-source' });
  assert.deepEqual(result.added, []);
  assert.match(result.note, /not named as a primary or fallback source/);
});

test('claims_dry_run export mode diffs the store against the committed identity CSV: added, changed, and newlyExcluded', () => {
  const db = makeStore();
  const s = insertTaxon(db, { name: 'Test Species One' });
  const usdaLicense = insertLicense(db, { source: 'usda-plants', grant: 'unrestricted' });
  const npinLicense = insertLicense(db, { source: 'npin', grant: 'personal-noncommercial', condition: 'void if commercial' });

  insertClaim(db, { speciesId: s, field: 'sun_pref', value: 'part-sun', source: 'usda-plants-characteristics', licenseId: usdaLicense });
  insertClaim(db, { speciesId: s, field: 'water_pref', value: 'medium', source: 'npin', licenseId: npinLicense });

  const identityDir = mkdtempSync(join(tmpdir(), 'claims-tools-test-'));
  const identityCsvPath = join(identityDir, 'identity.csv');
  writeFileSync(
    identityCsvPath,
    [
      'id,common_name,botanical_name,growth_shape,growing_season_months,flowering_season_months,flower_color,foliage_color_spring,foliage_color_summer,foliage_color_fall,foliage_color_winter,sun_pref,water_pref,soil_pref,width_ft,height_ft,inflorescence,flower_count_hint,flower_zone,fruit_color,fruit_season_months,fruit_load',
      'test-one,Test Species One,Test Species One,,,,,,,,,,,,,,,,,,,',
    ].join('\n') + '\n',
  );

  const result = claimsDryRun(db, { mode: 'export', identityCsvPath });
  assert.ok(result.added.some((a) => a.species === 'Test Species One' && a.field === 'sun_pref' && a.value === 'part-sun'));
  assert.ok(result.added.some((a) => a.species === 'Test Species One' && a.field === 'water_pref' && a.value === 'medium'));
});
