// The six Phase 2 claims_* MCP introspection tools (nl-scx.9), implementing
// docs/data-acquisition/07-mcp-introspection.md §3 with
// docs/data-acquisition/05-quality-metrics.md §4's six metric queries as
// their bodies (07 §3's opening: these are not two deliverables, one tool
// surface covers both). Exported as plain functions over an opened
// claims.db handle so they're testable without the MCP transport — see
// tools/usda-plants/mcpServer.js for the registerTool wiring that exposes
// them to an agent.
//
// Five read tools, one write tool (claims_correct) — 07 §4's table, restated
// as code rather than just documented.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../src/data/csvLoader.js';
import { resolveField, isSourceEligibleForField } from './precedence.js';
import { buildPlantsCsv, DEFAULT_IDENTITY_PATH } from './exportPlantsCsv.js';
import { COMMERCIAL_STATUS } from './projectConfig.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_CORRECTIONS_PATH = `${REPO_ROOT}catalog/manual-corrections.tsv`;
const CORRECTIONS_HEADER = 'usda_symbol\tfield\tvalue\treason\tauthor\tdate\tsupersedes_source';

const CULTIVAR_NAME_RE = /'([^']+)'\s*$/;

// ---------------------------------------------------------------------------
// Species resolution — shared by every tool that takes a `species` argument.
// 07 §3.1/.2 both spec it as "USDA symbol or taxa.id"; taxa.id arrives as a
// number or a numeric string, a USDA symbol as anything else.
// ---------------------------------------------------------------------------

function looksNumeric(value) {
  return typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()));
}

/** Resolve a species argument to its taxa row, or throw naming exactly what didn't match. */
export function resolveTaxon(db, species) {
  if (species == null || species === '') throw new Error('species is required');
  if (looksNumeric(species)) {
    const row = db.prepare('SELECT * FROM taxa WHERE id = ?').get(Number(species));
    if (!row) throw new Error(`no taxa row with id ${species}`);
    return row;
  }
  const row = db.prepare('SELECT * FROM taxa WHERE usda_symbol = ?').get(species);
  if (!row) throw new Error(`no taxa row with usda_symbol "${species}"`);
  return row;
}

/** All non-synonym taxa (04 §2.2: resolves_to IS NULL) — the "all species" scope for coverage. */
function allConceptTaxa(db) {
  return db.prepare('SELECT * FROM taxa WHERE resolves_to IS NULL ORDER BY scientific_name').all();
}

/**
 * Distinct fields ever claimed, across the whole store. There is no codified
 * "required fields" list to import yet (searched; none exists) — using every
 * field a claim has ever been written for is the conservative "all fields"
 * scope: it can't report a field missing that no source has ever been asked
 * about, and it needs no new list to keep in sync with plants.csv's columns.
 */
function allClaimedFields(db) {
  return db.prepare('SELECT DISTINCT field FROM claims ORDER BY field').all().map((r) => r.field);
}

// ---------------------------------------------------------------------------
// 3.1 claims_coverage
// ---------------------------------------------------------------------------

/**
 * Resolve one (taxonId, field)'s coverage, walking the cultivar chain (04
 * §2.3) exactly the way exportPlantsCsv's resolveCultivarAware does: an own
 * claim of ANY status wins outright (07 §3.1 — status must distinguish
 * missing from unknown, so "own claim exists but is unknown" must not fall
 * through to the parent the way "no own claim" does).
 */
function coverageFor(db, taxon, field) {
  const own = db
    .prepare(
      `SELECT status, source FROM claims
       WHERE species_id = ? AND field = ? AND superseded_by IS NULL
       ORDER BY (status = 'asserted') DESC, (status = 'review') DESC`,
    )
    .all(taxon.id, field);

  if (own.length) {
    const asserted = own.filter((c) => c.status === 'asserted');
    if (asserted.length) {
      return {
        status: 'asserted',
        assertedCount: asserted.length,
        sourcesAsserting: [...new Set(asserted.map((c) => c.source))],
      };
    }
    const status = own.some((c) => c.status === 'review') ? 'review' : 'unknown';
    return { status, assertedCount: 0, sourcesAsserting: [] };
  }

  if (taxon.rank === 'cultivar' && taxon.parent_id) {
    const parent = db.prepare('SELECT * FROM taxa WHERE id = ?').get(taxon.parent_id);
    if (parent) return coverageFor(db, parent, field);
  }

  return { status: 'missing', assertedCount: 0, sourcesAsserting: [] };
}

/**
 * claims_coverage (07 §3.1 / 05 §4's completeness + Missing queries).
 * @param {object} args
 * @param {string} [args.field] - omit for all fields ever claimed
 * @param {string} [args.species] - USDA symbol or taxa.id, omit for all species
 */
export function claimsCoverage(db, { field, species } = {}) {
  const taxa = species != null && species !== '' ? [resolveTaxon(db, species)] : allConceptTaxa(db);
  const fields = field ? [field] : allClaimedFields(db);

  const results = [];
  for (const taxon of taxa) {
    for (const f of fields) {
      results.push({
        species: taxon.scientific_name,
        speciesId: taxon.id,
        field: f,
        ...coverageFor(db, taxon, f),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 3.2 claims_provenance
// ---------------------------------------------------------------------------

/**
 * claims_provenance (07 §3.2) — every claim row (active or superseded) for
 * one (species, field), plus the precedence resolution over the active ones.
 * resolutionReason is populated (nl-scx.5/precedence.js landed before this
 * bead), null only when there is nothing active to resolve.
 */
export function claimsProvenance(db, { species, field }) {
  if (!field) throw new Error('field is required');
  const taxon = resolveTaxon(db, species);

  const rows = db
    .prepare(
      `SELECT value, status, source, citation, retrieved_at AS retrievedAt, confidence, superseded_by AS supersededBy
       FROM claims WHERE species_id = ? AND field = ? ORDER BY id`,
    )
    .all(taxon.id, field);

  const active = rows.filter((r) => r.supersededBy == null && r.status === 'asserted');
  const resolution = resolveField(active, field);

  let resolved = null;
  let resolutionReason = null;
  if (resolution) {
    resolutionReason = resolution.reason;
    if (resolution.status !== 'review') resolved = { value: resolution.value, source: resolution.source };
  }

  return { species: taxon.scientific_name, speciesId: taxon.id, field, claims: rows, resolved, resolutionReason };
}

// ---------------------------------------------------------------------------
// 3.3 claims_conflicts
// ---------------------------------------------------------------------------

/**
 * claims_conflicts (07 §3.3) — status='review' rows and 2+ disagreeing
 * asserted claims, bucketed together deliberately. Scoped to active claims
 * (superseded_by IS NULL) — a claim a manual correction already superseded
 * is a resolved conflict, not an open one.
 */
export function claimsConflicts(db, { field } = {}) {
  const fieldClause = field ? 'AND field = ?' : '';
  const fieldArgs = field ? [field] : [];

  const reviewPairs = db
    .prepare(`SELECT DISTINCT species_id, field FROM claims WHERE status = 'review' AND superseded_by IS NULL ${fieldClause}`)
    .all(...fieldArgs);

  const disagreeingPairs = db
    .prepare(
      `SELECT species_id, field FROM claims
       WHERE status = 'asserted' AND superseded_by IS NULL ${fieldClause}
       GROUP BY species_id, field
       HAVING COUNT(DISTINCT value) >= 2`,
    )
    .all(...fieldArgs);

  const seen = new Set();
  const pairs = [];
  for (const p of [...reviewPairs, ...disagreeingPairs]) {
    const key = `${p.species_id}::${p.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(p);
  }

  const taxaCache = new Map();
  const results = [];
  for (const { species_id, field: f } of pairs) {
    let taxon = taxaCache.get(species_id);
    if (!taxon) {
      taxon = db.prepare('SELECT * FROM taxa WHERE id = ?').get(species_id);
      taxaCache.set(species_id, taxon);
    }
    const claims = db
      .prepare(
        `SELECT value, source, status FROM claims
         WHERE species_id = ? AND field = ? AND superseded_by IS NULL AND status IN ('asserted', 'review')
         ORDER BY id`,
      )
      .all(species_id, f);
    results.push({ species: taxon?.scientific_name ?? null, speciesId: species_id, field: f, claims });
  }
  return results.sort((a, b) => (a.species ?? '').localeCompare(b.species ?? '') || a.field.localeCompare(b.field));
}

// ---------------------------------------------------------------------------
// 3.4 claims_sources
// ---------------------------------------------------------------------------

/**
 * License for a claims.source string. Joined via claims.license_id, NOT by
 * matching licenses.source text — usdaIngest.js proves the two vocabularies
 * differ (claims.source='usda-plants-characteristics' vs
 * licenses.source='usda-plants'), so the license a source's claims actually
 * carry has to be read off the claims themselves. Today's ingest writes one
 * license row per source (usdaIngest.test.js asserts exactly one), so a
 * single distinct license is the expected case; a source with zero (e.g.
 * manual-correction, nctx-flora — neither licenses today) reports null.
 */
function licenseForSource(db, source) {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.id, l."grant" AS grant, l.condition, l.citation_required AS citationRequired
       FROM claims c JOIN licenses l ON l.id = c.license_id
       WHERE c.source = ?`,
    )
    .all(source);
  if (!rows.length) return null;
  const { id, ...license } = rows[0];
  return license;
}

/**
 * claims_sources (07 §3.4 / 05 §4's freshness query) — per source:
 * claimCount, claimCountByField, retrievedAtMin/Max, avgAgeDays, license.
 * Unfiltered by status, matching 05 §4's freshness SQL (a review/unknown
 * claim is still a real crawl event worth counting for freshness).
 */
export function claimsSources(db, { source } = {}) {
  const sourceClause = source ? 'WHERE source = ?' : '';
  const sourceArgs = source ? [source] : [];

  const sources = db
    .prepare(`SELECT DISTINCT source FROM claims ${sourceClause} ORDER BY source`)
    .all(...sourceArgs)
    .map((r) => r.source);

  return sources.map((s) => {
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS claimCount, MIN(retrieved_at) AS retrievedAtMin, MAX(retrieved_at) AS retrievedAtMax,
                AVG(julianday('now') - julianday(retrieved_at)) AS avgAgeDays
         FROM claims WHERE source = ?`,
      )
      .get(s);
    const byField = db
      .prepare('SELECT field, COUNT(*) AS n FROM claims WHERE source = ? GROUP BY field ORDER BY field')
      .all(s);
    return {
      source: s,
      claimCount: agg.claimCount,
      claimCountByField: Object.fromEntries(byField.map((r) => [r.field, r.n])),
      retrievedAtMin: agg.retrievedAtMin,
      retrievedAtMax: agg.retrievedAtMax,
      avgAgeDays: agg.avgAgeDays,
      license: licenseForSource(db, s),
    };
  });
}

// ---------------------------------------------------------------------------
// 3.5 claims_correct — the one write tool
// ---------------------------------------------------------------------------

const FORBIDDEN_CHARS_RE = /[\t\r\n]/;

function assertNoTabsOrNewlines(label, value) {
  if (FORBIDDEN_CHARS_RE.test(value)) {
    throw new Error(`${label} may not contain a tab or newline (manual-corrections.tsv is TSV, one row per physical line)`);
  }
}

/**
 * Resolve a species argument to the usda_symbol form manual-corrections.tsv
 * expects (09 §2: plain symbol, or "SYMBOL 'CultivarName'" for a cultivar).
 * A cultivar's own taxa row never carries a usda_symbol (04 §2.2) — its
 * correction key is built from the parent's symbol plus the cultivar name
 * parsed off its own scientific_name, the same pairing taxaSeed.js's
 * CULTIVAR_RE and correctionsReplay.js's resolveTaxon both use.
 */
function correctionSymbolFor(db, taxon) {
  if (taxon.usda_symbol) return taxon.usda_symbol;
  if (taxon.rank === 'cultivar' && taxon.parent_id) {
    const parent = db.prepare('SELECT * FROM taxa WHERE id = ?').get(taxon.parent_id);
    const cultivarName = taxon.scientific_name.match(CULTIVAR_NAME_RE)?.[1];
    if (parent?.usda_symbol && cultivarName) return `${parent.usda_symbol} '${cultivarName}'`;
  }
  throw new Error(
    `taxa row "${taxon.scientific_name}" (id ${taxon.id}) has no usda_symbol and is not a cultivar of a symboled ` +
      'species — manual-corrections.tsv has no way to key a correction to it',
  );
}

/**
 * claims_correct (07 §3.5) — the sole write tool. Appends a row to
 * manual-corrections.tsv; does NOT touch claims.db directly (04 §3.4: a
 * correction's system of record is the committed file, replayed on the next
 * rebuild). reason and author are required with no optional path around
 * either, per the doc's own repeated framing of this rule.
 *
 * supersedes_source is auto-detected from the species/field's currently
 * resolved active claim when one exists (09 §3's staleness pin) — it is not
 * a caller argument, since 07 §3.5 doesn't list one and precedence.js's
 * manual-correction rank (-1, always wins) makes the resolution correct
 * even when this is left blank; auto-filling it is a courtesy for §3's
 * staleness detection, not load-bearing for correctness.
 */
export function claimsCorrect(
  db,
  { species, field, value, reason, author },
  { correctionsPath = DEFAULT_CORRECTIONS_PATH } = {},
) {
  if (!reason) throw new Error('reason is required');
  if (!author) throw new Error('author is required');
  if (!field) throw new Error('field is required');
  if (value == null || value === '') throw new Error('value is required');

  assertNoTabsOrNewlines('field', field);
  assertNoTabsOrNewlines('value', value);
  assertNoTabsOrNewlines('reason', reason);
  assertNoTabsOrNewlines('author', author);

  const taxon = resolveTaxon(db, species);
  const usdaSymbol = correctionSymbolFor(db, taxon);

  const active = db
    .prepare(
      `SELECT value, source, citation FROM claims
       WHERE species_id = ? AND field = ? AND status = 'asserted' AND superseded_by IS NULL`,
    )
    .all(taxon.id, field);
  const current = resolveField(active, field);
  const supersedesSource = current && current.status !== 'review' ? current.source : '';

  const date = new Date().toISOString().slice(0, 10);
  const record = { usda_symbol: usdaSymbol, field, value, reason, author, date, supersedes_source: supersedesSource };

  const line = [record.usda_symbol, record.field, record.value, record.reason, record.author, record.date, record.supersedes_source].join(
    '\t',
  );

  if (!existsSync(correctionsPath)) {
    writeFileSync(correctionsPath, `${CORRECTIONS_HEADER}\n${line}\n`);
  } else {
    const existing = readFileSync(correctionsPath, 'utf8');
    const prefix = existing.length && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(correctionsPath, `${prefix}${line}\n`);
  }

  return {
    record,
    path: correctionsPath,
    note:
      'Appended to manual-corrections.tsv only — claims.db is not updated until the next rebuild ' +
      '(tools/claims/rebuild.js). claims_provenance will not reflect this correction until then.',
  };
}

// ---------------------------------------------------------------------------
// 3.6 claims_dry_run
// ---------------------------------------------------------------------------

/**
 * Export dry run: builds the proposed plants.csv (exportPlantsCsv's own
 * logic — precedence, status filter, license, cultivar walk) and diffs it
 * cell-by-cell against the committed file. added/changed/newlyExcluded per
 * 07 §3.6's return shape.
 */
function dryRunExport(db, { identityCsvPath = DEFAULT_IDENTITY_PATH, commercialStatus = COMMERCIAL_STATUS } = {}) {
  const identityRows = parseCsv(readFileSync(identityCsvPath, 'utf8'));
  const { csvText } = buildPlantsCsv(db, identityRows, { commercialStatus });
  const proposedRows = parseCsv(csvText);
  const proposedById = new Map(proposedRows.map((r) => [r.id, r]));

  const added = [];
  const changed = [];
  const newlyExcluded = [];

  for (const committed of identityRows) {
    const proposed = proposedById.get(committed.id);
    if (!proposed) continue;
    for (const col of Object.keys(committed)) {
      if (col === 'id' || col === 'common_name' || col === 'botanical_name') continue;
      const from = committed[col] ?? '';
      const to = proposed[col] ?? '';
      if (from === to) continue;
      if (from === '' && to !== '') added.push({ species: committed.botanical_name, field: col, value: to });
      else if (from !== '' && to === '') newlyExcluded.push({ species: committed.botanical_name, field: col, value: from });
      else changed.push({ species: committed.botanical_name, field: col, from, to });
    }
  }

  return { added, changed, newlyExcluded };
}

/**
 * Re-crawl dry run, scoped to one source (07 §3.6). This does NOT perform a
 * live fetch: no per-source fetch pipeline is wired generically into this
 * introspection tool (usdaIngest.js's fetch machinery is USDA-specific;
 * other sources' ingest is separate epic work, in progress in parallel), and
 * fabricating "what a fresh value would be" without actually calling the
 * source is exactly the invent-nothing rule this whole store exists to
 * enforce. So this reports only the subset 07 §3.6 itself says is
 * answerable without a live fetch or a precedence outcome: `added` —
 * (species, field) pairs currently `missing` (claims_coverage's sense) for
 * fields this source is named as primary or fallback for in precedence.js's
 * table. `changed` (an arbitration outcome a fresh value would flip) and
 * `newlyExcluded` (export-time-only per 07 §3.6) both require data this
 * tool cannot fabricate and are returned empty, with that reasoning in the
 * result rather than silently omitted.
 */
function dryRunRecrawl(db, source) {
  if (!source) throw new Error('source is required when mode is "recrawl"');

  const fieldsForSource = allClaimedFields(db).filter((field) => isSourceEligibleForField(source, field));
  if (!fieldsForSource.length) {
    return {
      added: [],
      changed: [],
      newlyExcluded: [],
      note: `"${source}" is not named as a primary or fallback source for any currently-claimed field; nothing to report.`,
    };
  }

  const added = [];
  for (const taxon of allConceptTaxa(db)) {
    for (const field of fieldsForSource) {
      const coverage = coverageFor(db, taxon, field);
      if (coverage.status === 'missing') added.push({ species: taxon.scientific_name, field });
    }
  }

  return {
    added,
    changed: [],
    newlyExcluded: [],
    note:
      'recrawl mode does not perform a live fetch, so "changed" (an arbitration outcome a fresh value ' +
      'would flip) cannot be computed without inventing a value; "added" above lists currently-missing ' +
      '(species, field) pairs this source is eligible to fill, per precedence.js.',
  };
}

export function claimsDryRun(db, { mode, source, identityCsvPath, commercialStatus } = {}) {
  if (mode === 'export') return dryRunExport(db, { identityCsvPath, commercialStatus });
  if (mode === 'recrawl') return dryRunRecrawl(db, source);
  throw new Error(`mode must be "export" or "recrawl", got ${JSON.stringify(mode)}`);
}
