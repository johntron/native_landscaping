/**
 * Filter and order the species catalog for the Edit-mode "Add plant" picker
 * (nl-ah5). Pure: no DOM, so it is unit-tested on its own.
 *
 * A query matches when every word in it appears, as part of a word or across
 * words, in the common or botanical name. Case, accents and punctuation are
 * ignored, so "black eyed", "blackeyed" and "Black-eyed" all find
 * black-eyed Susan, and "rud hir" finds Rudbeckia hirta.
 */

export const SPECIES_SORT_KEYS = Object.freeze(['common', 'botanical']);

/**
 * @param {string} text
 * @returns {string} lower case, accents stripped, runs of anything else collapsed to one space
 */
function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @param {{commonName?: string, botanicalName?: string}} entry a parsed species row
 * @param {string} query
 */
export function speciesMatchesQuery(entry, query) {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const spaced = normalize(`${entry.commonName || ''} ${entry.botanicalName || ''}`);
  const compact = spaced.replace(/ /g, '');
  return words.every((word) => spaced.includes(word) || compact.includes(word));
}

function sortName(entry, sortBy) {
  return sortBy === 'botanical'
    ? entry.botanicalName || entry.commonName || ''
    : entry.commonName || entry.botanicalName || '';
}

/**
 * The picker's options: species with an id and a botanical name that match
 * `query`, ordered by the chosen name (the other name breaks ties).
 * @param {Array<{speciesId?: string, commonName?: string, botanicalName?: string}>} species
 * @param {{query?: string, sortBy?: 'common'|'botanical'}} [options]
 */
export function searchSpecies(species, { query = '', sortBy = 'common' } = {}) {
  const other = sortBy === 'botanical' ? 'common' : 'botanical';
  return (species || [])
    .filter((entry) => entry.speciesId && entry.botanicalName)
    .filter((entry) => speciesMatchesQuery(entry, query))
    .sort(
      (a, b) =>
        sortName(a, sortBy).localeCompare(sortName(b, sortBy), undefined, { sensitivity: 'base' }) ||
        sortName(a, other).localeCompare(sortName(b, other), undefined, { sensitivity: 'base' })
    );
}

/**
 * An option's text, leading with the name the list is sorted by so the order is visible.
 * @param {{commonName?: string, botanicalName?: string}} entry
 * @param {'common'|'botanical'} sortBy
 */
export function speciesOptionLabel(entry, sortBy = 'common') {
  if (!entry.commonName) return entry.botanicalName;
  return sortBy === 'botanical'
    ? `${entry.botanicalName} (${entry.commonName})`
    : `${entry.commonName} (${entry.botanicalName})`;
}
