import { parseCsv } from '../data/csvLoader.js';
import { normalizeGenus } from './hostGenera.js';

/**
 * `ecology/invasive-watchlist.csv` — hand-curated, not derived from
 * establishment_means. iNaturalist's own place checklist for this project's
 * sites (North Texas) turned out to carry only native/introduced/endemic —
 * no separate 'invasive' tier (confirmed against `data/ecosystem.db`'s real
 * distribution before building this) — so `isExcludedEstablishment`'s
 * 'introduced'/'naturalized'/'invasive' set can't discriminate a genuinely
 * invasive species from the much larger pool of merely-non-native common
 * weeds. This table is the answer: a short, sourced list of species actually
 * worth surfacing (see the CSV's `source` column), same curation stance as
 * `ecology/host-genera.csv`.
 *
 * Columns:
 *   genus         botanical genus
 *   species       specific epithet, or blank to match the whole genus.
 *                 Left blank only when the source genuinely has no native
 *                 congener in Texas to confuse it with (e.g. Ligustrum);
 *                 a genus like Morus that does (native M. rubra) is always
 *                 given a species so the native relative is never flagged.
 *   common_name   for display
 *   source        citation
 */

/**
 * @param {string} csvText
 * @returns {{ size: number, match(taxonName: string): object|null }}
 */
export function buildInvasiveWatchlistIndex(csvText) {
  const rows = parseCsv(csvText || '')
    .map((row) => ({
      genus: String(row.genus || '').trim(),
      species: String(row.species || '').trim(),
      commonName: String(row.common_name || '').trim(),
      source: String(row.source || '').trim(),
    }))
    .filter((row) => row.genus);

  const byBinomial = new Map();
  const byGenusOnly = new Map();
  rows.forEach((row) => {
    if (row.species) {
      byBinomial.set(`${normalizeGenus(row.genus)} ${row.species.toLowerCase()}`, row);
    } else {
      byGenusOnly.set(normalizeGenus(row.genus), row);
    }
  });

  return {
    size: rows.length,
    /** Full match against a taxon_name ("Genus species ..."), or null. Species-specific rows are checked before a genus-wide row, so a genus with both (not currently the case here) would never let the wide row shadow a narrower one. */
    match(taxonName) {
      const tokens = String(taxonName || '').trim().split(/\s+/);
      if (!tokens.length) return null;
      const genus = normalizeGenus(tokens[0]);
      if (tokens[1]) {
        const binomial = byBinomial.get(`${genus} ${tokens[1].toLowerCase()}`);
        if (binomial) return binomial;
      }
      return byGenusOnly.get(genus) || null;
    },
  };
}

export function emptyInvasiveWatchlistIndex() {
  return { size: 0, match: () => null };
}

/**
 * Classify one observation-event row against the watchlist. Not gated to
 * Plantae — the watchlist itself decides scope, so a future animal row
 * (feral hog, nutria) needs only a CSV row, not a code change here.
 * @param {{taxon_name?: string}} event
 * @param {{watchlist: ReturnType<typeof buildInvasiveWatchlistIndex>}} ctx
 * @returns {null|{kind: 'invasive-watchlist', commonName: string, genus: string, species: string, source: string}}
 */
export function classifyInvasive(event, { watchlist }) {
  if (!watchlist?.size) return null;
  const row = watchlist.match(event.taxon_name);
  if (!row) return null;
  return { kind: 'invasive-watchlist', commonName: row.commonName, genus: row.genus, species: row.species, source: row.source };
}
