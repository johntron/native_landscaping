// Export generator (nl-scx.7), implementing docs/data-acquisition/04-data-model.md
// §4 (the four export steps) and §4.1 (the newline rule): projects the claim
// store into the flat plants.csv the app actually reads
// (src/data/plantParser.js never learns SQLite — 04 §4's own reasoning).
//
// Four steps, in order, per species/field:
//   1. Resolve through nl-scx.5's precedence rule (precedence.js).
//   2. Keep only status='asserted' claims — review/unknown are excluded
//      entirely, landing as a genuine blank (nl-c58, closed, is what makes
//      that safe downstream).
//   3. Check the resolved claim's license grant against the project's
//      CURRENT commercial status (projectConfig.js) — a voided grant drops
//      the value from the EXPORT, never from the store.
//   4. Cultivars walk 04 §2.3: the cultivar's own claims first; only when it
//      has NONE for a field does the parent species' claim apply. A cultivar
//      claim that exists but loses step 2 or 3 still blanks the cell — it
//      does not fall through to the parent, because "no claim" and "a claim
//      the export can't publish" are different things.
//
// What this module does NOT do: invent identity. `taxa` has no common_name
// or CSV-slug id (usdaIngest.js's IDENTITY_KEYS comment says otherwise but no
// ingest actually writes them), so the row set and its id/common_name/
// botanical_name columns come from an identity list — today, the existing
// plants.csv — not from claims. Widening identity into the store is a
// separate bead.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { parseCsv } from '../../src/data/csvLoader.js';
import { parseSpeciesCsv, LayoutDataError } from '../../src/data/plantParser.js';
import { resolveField } from './precedence.js';
import { COMMERCIAL_STATUS } from './projectConfig.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_IDENTITY_PATH = `${REPO_ROOT}plants.csv`;
export const DEFAULT_OUTPUT_PATH = `${REPO_ROOT}plants.csv`;

// The committed file's own column order — a fixed contract, not derived from
// whatever ingest happens to have populated the store with today.
//
// Every column is identity or a claim-store field (nl-3s5.21). How the design
// tool DRAWS a species (flower/foliage/fruit hex, inflorescence, flower count
// and zone) is an authored judgement and lives in plant-drawing.csv, which this
// export never writes. The store does hold USDA flower/summer-foliage/fruit
// colour claims (a colour name mapped to a swatch by
// tools/usda-plants/colorNames.js), but the hex the app draws is the authored
// one, so those claims are left for checking, not exported.
//
// width_ft is the one field here with no claims at all: the store tracks it
// (stoppingCondition.js BLOCKING_FIELDS) and unsourceableRegister.js records
// why no source carries it. It stays, because the rules engine grades it.
export const PLANTS_CSV_HEADER = [
  'id',
  'common_name',
  'botanical_name',
  // The taxa row this species links to (nl-3s5.18): written from the store
  // being exported, so it always names a row of THAT store. See
  // tools/link-species-taxa.mjs for why it is a link, not a key.
  'taxon_id',
  'growth_shape',
  'growing_season_months',
  'flowering_season_months',
  'sun_pref',
  'water_pref',
  'soil_pref',
  'width_ft',
  'height_ft',
  'fruit_season_months',
  'fruit_load',
  // FNCT nativity (nl-5j5): the Add plant picker labels and filters on it.
  'nativity_nctx',
];

const IDENTITY_COLUMNS = ['id', 'common_name', 'botanical_name'];

// Columns the store fills and the parser has rules for. `taxon_id` is
// identity-shaped (a link, not a claim) and the parser does not check it, so
// it is left out here rather than validated for nothing.
const VALIDATED_COLUMNS = PLANTS_CSV_HEADER.filter((col) => !IDENTITY_COLUMNS.includes(col) && col !== 'taxon_id');

/**
 * 04 §3.2: today's store only ever writes 'personal-noncommercial' (NPIN) or
 * 'unrestricted' (USDA) grants. A claim with no license row at all (e.g. a
 * manual correction, or a flora-nativity claim — neither has licensing terms
 * to evaluate) is published: fail-open, matching claimsStore.js's own
 * plantable_set precedent of under-excluding rather than wrongly admitting.
 * A future grant shape ('facts-only', ...) needs an explicit case added here,
 * not a silent fallthrough either way.
 */
function isLicenseVoided(license, commercialStatus) {
  if (!license) return false;
  if (license.grant === 'personal-noncommercial') return commercialStatus === 'commercial';
  return false; // 'unrestricted', or any other grant this store doesn't yet write
}

/** All asserted, non-superseded claims for one (species, field), with their license row joined in. */
function ownClaimsFor(db, speciesId, field) {
  return db
    .prepare(
      `SELECT c.value AS value, c.source AS source, c.citation AS citation, c.license_id AS license_id,
              l.grant AS license_grant, l.condition AS license_condition
       FROM claims c
       LEFT JOIN licenses l ON l.id = c.license_id
       WHERE c.species_id = ? AND c.field = ? AND c.status = 'asserted' AND c.superseded_by IS NULL`,
    )
    .all(speciesId, field);
}

/**
 * Resolve one (taxon, field) to an exportable string, or '' if no claim, a
 * tied/review resolution, or a license-voided resolution applies. Implements
 * 04 §4 steps 1-3, plus step 4's cultivar walk (04 §2.3) at the call site.
 */
function resolveOwn(db, taxonId, field, commercialStatus) {
  const claims = ownClaimsFor(db, taxonId, field);
  if (!claims.length) return { hasOwnClaims: false, value: '' };

  const resolved = resolveField(claims, field); // step 1: precedence
  if (!resolved || resolved.status === 'review') return { hasOwnClaims: true, value: '' }; // step 2

  const winner = claims.find((c) => c.source === resolved.source && c.value === resolved.value);
  const license = winner?.license_id ? { grant: winner.license_grant, condition: winner.license_condition } : null;
  if (isLicenseVoided(license, commercialStatus)) return { hasOwnClaims: true, value: '' }; // step 3

  return { hasOwnClaims: true, value: resolved.value ?? '' };
}

function resolveCultivarAware(db, taxon, field, commercialStatus) {
  const own = resolveOwn(db, taxon.id, field, commercialStatus);
  if (own.hasOwnClaims) return own.value; // 04 §2.3: own claim, even one that blanks, wins outright
  if (taxon.rank === 'cultivar' && taxon.parent_id) {
    return resolveOwn(db, taxon.parent_id, field, commercialStatus).value;
  }
  return '';
}

// 04 §4.1: parseCsv splits on newlines before honoring quotes, so an
// embedded newline can't round-trip; splitCsvLine also toggles on any `"`
// with no doubled-quote escaping, so a literal quote can't either. Both are
// scrubbed to a space and logged, same reasoning, same single point.
function sanitizeCell(raw, { id, field }, replacements) {
  let value = String(raw ?? '');
  if (/[\r\n]/.test(value)) {
    value = value.replace(/\r\n|\r|\n/g, ' ');
    replacements.push({ id, field, kind: 'newline' });
  }
  if (value.includes('"')) {
    value = value.replace(/"/g, "'");
    replacements.push({ id, field, kind: 'quote' });
  }
  return value;
}

function csvCell(value) {
  return value.includes(',') ? `"${value}"` : value;
}

/**
 * Build the exported plants.csv text from the claim store, in `identityRows`'
 * order. `identityRows` supplies id/common_name/botanical_name and the row
 * set — the store does not (yet) model identity, see module header.
 *
 * @returns {{ csvText: string, replacements: Array<{id: string, field: string, kind: 'newline'|'quote'}> }}
 */
export function buildPlantsCsv(db, identityRows, { commercialStatus = COMMERCIAL_STATUS } = {}) {
  const taxaByName = new Map(
    db
      .prepare('SELECT id, scientific_name, rank, parent_id FROM taxa')
      .all()
      .map((t) => [t.scientific_name, t]),
  );

  const replacements = [];
  const lines = [PLANTS_CSV_HEADER.join(',')];

  for (const row of identityRows) {
    const botanicalName = (row.botanical_name || '').trim();
    const taxon = taxaByName.get(botanicalName);
    const id = row.id || '';

    const cells = PLANTS_CSV_HEADER.map((col) => {
      let raw;
      if (IDENTITY_COLUMNS.includes(col)) {
        raw = row[col] || '';
      } else if (col === 'taxon_id') {
        raw = taxon ? String(taxon.id) : ''; // exact-name match only, blank otherwise
      } else if (taxon) {
        raw = resolveCultivarAware(db, taxon, col, commercialStatus);
      } else {
        raw = ''; // no taxa row for this identity entry: nothing to project, blank per 04 §4 step 2's spirit
      }
      const sanitized = sanitizeCell(raw, { id, field: col }, replacements);
      return csvCell(sanitized);
    });

    lines.push(cells.join(','));
  }

  return { csvText: `${lines.join('\n')}\n`, replacements };
}

/** Convenience: read the identity CSV from disk and build the export in one call. */
export function exportPlantsCsv(db, { identityCsvPath = DEFAULT_IDENTITY_PATH, commercialStatus = COMMERCIAL_STATUS } = {}) {
  const identityRows = parseCsv(readFileSync(identityCsvPath, 'utf8'));
  return buildPlantsCsv(db, identityRows, { commercialStatus });
}

/**
 * Validate every row the export built against the SAME parser design.html
 * loads plants.csv through (src/data/plantParser.js) — never a
 * reimplementation of its site-vocabulary/shape/month rules (nl-scx.15). A
 * `LayoutDataError` from that parser is exactly what would stop design.html
 * loading, so the export must refuse before the value ever reaches
 * plants.csv.
 *
 * Checked cell by cell first (a 2-column `id,<field>` mini CSV through the
 * one-argument `parseSpeciesCsv`, so drawing columns are never implicated),
 * so one bad row's second bad field is not hidden behind its first. Then,
 * only if every cell passed, once over the whole file as a backstop for a
 * structural/cross-row rule (duplicate ids) no single cell would trip.
 * @param {string} csvText the export's own output (buildPlantsCsv's csvText)
 * @returns {Array<{id: string, field: string, value: string, message: string}>} empty if every row is valid
 */
export function validateAgainstParser(csvText) {
  const rows = parseCsv(csvText);
  const errors = [];

  for (const row of rows) {
    const id = row.id || '';
    for (const field of VALIDATED_COLUMNS) {
      const value = row[field] ?? '';
      if (!value) continue; // blank is always valid — it's "no claim", not a bad one
      const miniCsv = `id,${field}\n${csvCell(id)},${csvCell(value)}\n`;
      try {
        parseSpeciesCsv(miniCsv);
      } catch (err) {
        if (!(err instanceof LayoutDataError)) throw err;
        errors.push({ id, field, value, message: err.message });
      }
    }
  }

  if (!errors.length) {
    try {
      parseSpeciesCsv(csvText);
    } catch (err) {
      if (!(err instanceof LayoutDataError)) throw err;
      errors.push({ id: '', field: '', value: '', message: err.message });
    }
  }

  return errors;
}

/**
 * Per-column diff between the export's rows and the committed file it would
 * replace, keyed by `id` (never row position — a reordered id is not a
 * change). This is the bead's own numbers (nl-scx.15: "height_ft on 53/62,
 * ... width_ft goes blank on all 56 that have it"), computed instead of
 * eyeballed, so the guard's refusal message always matches what actually
 * changed.
 * Every row shared by both files is compared, blank or not — a blank cell
 * gaining a value is as much a change as one losing it, and both must be
 * caught (nl-scx.15 requirement 2 is "differs", not "differs by losing a
 * value").
 * @param {string} csvText the export's own output
 * @param {string} committedCsvText the file on disk the export would overwrite
 * @returns {{ changed: boolean, perColumn: Array<{column: string, changed: number, blanked: number, filled: number, total: number}>,
 *             addedIds: string[], removedIds: string[] }}
 */
export function diffAgainstCommitted(csvText, committedCsvText) {
  const exportedById = new Map(parseCsv(csvText).map((row) => [row.id, row]));
  const committedById = new Map(parseCsv(committedCsvText).map((row) => [row.id, row]));

  const addedIds = [...exportedById.keys()].filter((id) => !committedById.has(id));
  const removedIds = [...committedById.keys()].filter((id) => !exportedById.has(id));

  const perColumn = PLANTS_CSV_HEADER.filter((col) => !IDENTITY_COLUMNS.includes(col)).map((column) => {
    let changed = 0;
    let blanked = 0;
    let filled = 0;
    let total = 0;
    for (const [id, committedRow] of committedById) {
      const exportedRow = exportedById.get(id);
      if (!exportedRow) continue; // row removed entirely — counted in removedIds, not per-column
      total += 1;
      const before = committedRow[column] ?? '';
      const after = exportedRow[column] ?? '';
      if (before !== after) {
        changed += 1;
        if (before && !after) blanked += 1;
        else if (!before && after) filled += 1;
      }
    }
    return { column, changed, blanked, filled, total };
  });

  const changed = addedIds.length > 0 || removedIds.length > 0 || perColumn.some((c) => c.changed > 0);
  return { changed, perColumn, addedIds, removedIds };
}

/**
 * The guarded write path (nl-scx.15). The diff against `protectedPath` is
 * always computed when that file exists — even when validation is about to
 * refuse the write, and even when `outPath` points elsewhere — so a caller
 * always sees the per-column summary the bead asked for, not just whichever
 * refusal happened to run first.
 *
 * Two refusals, both "print and don't write" rather than throwing, so a CLI
 * caller can report and exit non-zero:
 *
 *   1. Any row fails validateAgainstParser: no partial write, ever — this
 *      refusal `force` cannot bypass, because a LayoutDataError isn't a
 *      question of intent, it would break design.html.
 *   2. The output would replace `protectedPath`'s current committed bytes
 *      with different ones (`outPath` resolves to `protectedPath`), and
 *      `force` was not given. Writing to a different `outPath` (one that
 *      does not resolve to `protectedPath`) is exempt, same as `force`, per
 *      the bead's own escape hatches.
 *
 * @param {{ csvText: string, outPath?: string, protectedPath?: string, force?: boolean }} options
 * @returns {{ written: boolean, validationErrors: Array<object>, diff: object | null }}
 */
export function writePlantsCsvExport({
  csvText,
  outPath = DEFAULT_OUTPUT_PATH,
  protectedPath = DEFAULT_OUTPUT_PATH,
  force = false,
}) {
  const diff = existsSync(protectedPath) ? diffAgainstCommitted(csvText, readFileSync(protectedPath, 'utf8')) : null;

  const validationErrors = validateAgainstParser(csvText);
  if (validationErrors.length) {
    return { written: false, validationErrors, diff };
  }

  const isProtected = resolvePath(outPath) === resolvePath(protectedPath);
  if (isProtected && diff && diff.changed && !force) {
    return { written: false, validationErrors: [], diff };
  }

  writeFileSync(outPath, csvText);
  return { written: true, validationErrors: [], diff };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openClaimsStore } = await import('./claimsStore.js');
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const outFlagIdx = args.indexOf('--out');
  const outPath = outFlagIdx === -1 ? DEFAULT_OUTPUT_PATH : args[outFlagIdx + 1];
  const dbFlagIdx = args.indexOf('--db');
  const dbPath = dbFlagIdx === -1 ? undefined : args[dbFlagIdx + 1];

  const db = openClaimsStore(dbPath);
  const { csvText, replacements } = exportPlantsCsv(db);
  const { written, validationErrors, diff } = writePlantsCsvExport({ csvText, outPath, force });

  const printDiff = () => {
    if (!diff) return;
    for (const c of diff.perColumn) {
      if (!c.changed) continue;
      const detail = [c.blanked && `${c.blanked} blanked`, c.filled && `${c.filled} filled`].filter(Boolean).join(', ');
      console.error(`  ${c.column}: ${c.changed}/${c.total} changed${detail ? ` (${detail})` : ''}`);
    }
    if (diff.addedIds.length) console.error(`  added ids: ${diff.addedIds.join(', ')}`);
    if (diff.removedIds.length) console.error(`  removed ids: ${diff.removedIds.join(', ')}`);
  };

  if (validationErrors.length) {
    console.error(
      `Refusing to write ${outPath}: ${validationErrors.length} value${validationErrors.length === 1 ? '' : 's'} the parser design.html loads would reject:`,
    );
    for (const e of validationErrors) {
      console.error(e.field ? `  ${e.id} ${e.field} = "${e.value}": ${e.message}` : `  ${e.message}`);
    }
    if (diff && diff.changed) {
      console.error('It also differs from the committed file:');
      printDiff();
    }
    process.exitCode = 1;
  } else if (!written) {
    console.error(
      `Refusing to write ${outPath}: it differs from the committed file. Pass --force to overwrite, or --out <path> to write elsewhere.`,
    );
    printDiff();
    process.exitCode = 1;
  } else {
    console.log(`Wrote ${outPath} (${replacements.length} newline/quote replacements).`);
    for (const r of replacements) console.log(`  ${r.kind}: ${r.id} ${r.field}`);
  }
}
