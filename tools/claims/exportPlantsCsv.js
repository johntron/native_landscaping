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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../src/data/csvLoader.js';
import { resolveField } from './precedence.js';
import { COMMERCIAL_STATUS } from './projectConfig.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_IDENTITY_PATH = `${REPO_ROOT}plants.csv`;
export const DEFAULT_OUTPUT_PATH = `${REPO_ROOT}plants.csv`;

// The committed file's own column order — a fixed contract, not derived from
// whatever ingest happens to have populated the store with today.
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
  'flower_color',
  'foliage_color_spring',
  'foliage_color_summer',
  'foliage_color_fall',
  'foliage_color_winter',
  'sun_pref',
  'water_pref',
  'soil_pref',
  'width_ft',
  'height_ft',
  'inflorescence',
  'flower_count_hint',
  'flower_zone',
  'fruit_color',
  'fruit_season_months',
  'fruit_load',
];

const IDENTITY_COLUMNS = ['id', 'common_name', 'botanical_name'];

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openClaimsStore } = await import('./claimsStore.js');
  const { writeFileSync } = await import('node:fs');
  const db = openClaimsStore();
  const { csvText, replacements } = exportPlantsCsv(db);
  writeFileSync(DEFAULT_OUTPUT_PATH, csvText);
  console.log(`Wrote ${DEFAULT_OUTPUT_PATH} (${replacements.length} newline/quote replacements).`);
  for (const r of replacements) console.log(`  ${r.kind}: ${r.id} ${r.field}`);
}
