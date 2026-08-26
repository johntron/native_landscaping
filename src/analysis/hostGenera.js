import { parseCsv } from '../data/csvLoader.js';

/**
 * Parse and index `ecology/host-genera.csv` — the one genus-keyed table rules 4,
 * 5, and 10 share, because all three reduce to "what does this genus do for
 * insects". Per-species columns on plants.csv were rejected: 48 rows of
 * hand-researched booleans is expensive and invites invention.
 *
 * Columns:
 *   genus                  botanical genus, as the source spells it
 *   ecoregion              EPA Level I ecoregion the counts are for
 *   lep_host_species       caterpillar species the genus hosts (NWF top 30)
 *   bee_specialist_species pollen-specialist bees relying on it (NWF top 30)
 *   larval_hosts           documented obligate relationships the keystone lists miss
 *   synonym_of             the genus the source filed these numbers under
 *   source                 where the row came from; a row with nothing sourced
 *                          stays blank rather than guessed
 */

/**
 * @param {string} csvText
 * @param {{ ecoregion?: string }} [options] keep only rows for one ecoregion
 * @returns {{ ecoregion: string, byGenus: Map<string, object>, size: number,
 *             lookup(genus: string): object|null, isKeystone(genus: string): boolean }}
 */
export function buildHostGeneraIndex(csvText, { ecoregion } = {}) {
  const wanted = normalizeEcoregion(ecoregion);
  const rows = parseCsv(csvText)
    .map(normalizeRow)
    .filter((row) => row.genus && (!wanted || row.ecoregion === wanted));

  const byGenus = new Map();
  rows.forEach((row) => {
    byGenus.set(row.genusKey, row);
  });

  // `synonym_of` is load-bearing, not decoration: NWF files ragwort under
  // Senecio, while the catalog and both layouts use Packera obovata (segregated
  // from Senecio obovatus). Without this the frontyard's ragwort is silently
  // missed. Resolution is iterative so a chain of synonyms still lands, and
  // capped so a file that points two genera at each other cannot hang the app.
  const resolve = (genus) => {
    let row = byGenus.get(normalizeGenus(genus)) || null;
    const seen = new Set();
    while (row?.synonymOf && !seen.has(row.genusKey)) {
      seen.add(row.genusKey);
      const target = byGenus.get(normalizeGenus(row.synonymOf));
      if (!target) break;
      // Keep the name the design uses; take the numbers from the source's genus.
      row = { ...target, genus: row.genus, genusKey: row.genusKey, resolvedFrom: target.genus };
      if (!target.synonymOf) break;
    }
    return row;
  };

  return {
    ecoregion: wanted,
    byGenus,
    size: byGenus.size,
    lookup: resolve,
    isKeystone(genus) {
      const row = resolve(genus);
      return Boolean(row && (row.lepHostSpecies !== null || row.beeSpecialistSpecies !== null));
    },
  };
}

/**
 * The empty index a project without an `ecoregion` — or one whose CSV failed to
 * load — analyses against. Rules see "no table" and report `not-declared`
 * rather than throwing, which is what keeps a fetch failure from breaking the app.
 */
export function emptyHostGeneraIndex() {
  return {
    ecoregion: '',
    byGenus: new Map(),
    size: 0,
    lookup: () => null,
    isKeystone: () => false,
  };
}

function normalizeRow(row) {
  const genus = String(row.genus || '').trim();
  return {
    genus,
    genusKey: normalizeGenus(genus),
    ecoregion: normalizeEcoregion(row.ecoregion),
    lepHostSpecies: normalizeCount(row.lep_host_species),
    beeSpecialistSpecies: normalizeCount(row.bee_specialist_species),
    larvalHosts: String(row.larval_hosts || '').trim(),
    synonymOf: String(row.synonym_of || '').trim(),
    source: String(row.source || '').trim(),
  };
}

/** Blank means "not on the list", which is a different answer from zero. */
function normalizeCount(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

export function normalizeGenus(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEcoregion(value) {
  return String(value ?? '').trim();
}
