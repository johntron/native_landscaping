/**
 * The one place a layout row, a history entry, or an import finds its species.
 *
 * plants.csv's `id` (a slug such as `fragrant-sumac`) is the only species key a
 * saved yard carries. A botanical name is a label that changes: the flora
 * renames things (ecology/fnct-name-changes.csv exists for that reason), and a
 * yard keyed by name turned into "Unknown plant" the day a row was corrected.
 *
 * Name matching survives only for input that predates species ids (an old
 * planting_layout.csv with a `botanical_name` column, a history entry saved
 * before nl-3s5.18) or that comes from outside (an import). It is tried in
 * exactly this order, and nothing else is ever tried:
 *
 *   1. the species id itself;
 *   2. the full botanical name, exactly (case and surrounding whitespace aside),
 *      against plants.csv's current `botanical_name`;
 *   3. the committed synonym table, catalog/species-synonyms.csv, generated from
 *      the claim store's taxa.resolves_to by tools/build-species-synonyms.mjs.
 *
 * Never by species epithet alone (Callicarpa americana is not "any americana"),
 * and never by stripping a variety or cultivar to reach its parent species. Both
 * are guesses, and a guess that lands on the wrong species is worse than an
 * error, because it renders.
 *
 * Pure: no DOM, no fetch. The browser hands in the synonym CSV it loaded; the
 * migration tool reads the same file from disk.
 */
import { parseCsv } from './csvLoader.js';

/** Case- and whitespace-insensitive form of a botanical name, for exact comparison. */
export function normalizeBotanicalName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Parse catalog/species-synonyms.csv into a Map of normalized synonym → species id.
 * A synonym listed twice with different targets is ambiguous and dropped rather
 * than resolved to whichever row came last.
 * @param {string} csvText
 * @returns {Map<string, string>}
 */
export function parseSynonymCsv(csvText) {
  const map = new Map();
  const ambiguous = new Set();
  if (!csvText) return map;
  parseCsv(csvText).forEach((row) => {
    const key = normalizeBotanicalName(row.synonym);
    const speciesId = String(row.species_id || '').trim();
    if (!key || !speciesId || ambiguous.has(key)) return;
    const existing = map.get(key);
    if (existing && existing !== speciesId) {
      map.delete(key);
      ambiguous.add(key);
      return;
    }
    map.set(key, speciesId);
  });
  return map;
}

/**
 * Index species entries (rows from parseSpeciesCsv) for resolution.
 * @param {Array<{speciesId: string, botanicalName?: string}>} species
 * @param {Map<string, string>} [synonyms] from parseSynonymCsv
 */
export function buildSpeciesIndex(species, synonyms = new Map()) {
  const byId = new Map();
  const byName = new Map();
  (species || []).forEach((entry) => {
    if (!entry) return;
    if (entry.speciesId) byId.set(String(entry.speciesId), entry);
    const name = normalizeBotanicalName(entry.botanicalName);
    if (name) byName.set(name, entry);
  });
  return { byId, byName, synonyms: synonyms || new Map() };
}

/**
 * Find the species a botanical name refers to: exact current name, then the
 * synonym table. Returns null rather than guess.
 * @param {ReturnType<typeof buildSpeciesIndex>} index
 * @param {string} name
 * @returns {{entry: object, via: 'name'|'synonym'}|null}
 */
export function resolveSpeciesByName(index, name) {
  const key = normalizeBotanicalName(name);
  if (!key) return null;
  const direct = index.byName.get(key);
  if (direct) return { entry: direct, via: 'name' };
  const synonymTarget = index.synonyms.get(key);
  const viaSynonym = synonymTarget ? index.byId.get(synonymTarget) : null;
  if (viaSynonym) return { entry: viaSynonym, via: 'synonym' };
  return null;
}

/**
 * Resolve a reference that carries a species id, a botanical name, or both. A
 * species id, when present, is authoritative: a stale name beside it is ignored,
 * and an id the catalog does not know is NOT rescued by the name, because that
 * would silently swap one species for another.
 * @param {ReturnType<typeof buildSpeciesIndex>} index
 * @param {{speciesId?: string, botanicalName?: string}} ref
 * @returns {{entry: object, via: 'id'|'name'|'synonym'}|null}
 */
export function resolveSpeciesRef(index, { speciesId, botanicalName } = {}) {
  const id = String(speciesId || '').trim();
  if (id) {
    const entry = index.byId.get(id);
    return entry ? { entry, via: 'id' } : null;
  }
  return resolveSpeciesByName(index, botanicalName);
}
