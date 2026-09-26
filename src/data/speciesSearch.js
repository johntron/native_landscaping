/**
 * Filter and order the species catalog for the Edit-mode "Add plant" picker
 * (nl-ah5). Pure: no DOM, so it is unit-tested on its own.
 *
 * A query matches when every word in it appears, as part of a word or across
 * words, in the common or botanical name. Case, accents and punctuation are
 * ignored, so "black eyed", "blackeyed" and "Black-eyed" all find
 * black-eyed Susan, and "rud hir" finds Rudbeckia hirta.
 *
 * "Native" here is the owner's definition (nl-5j5): the Flora of North Central
 * Texas treats the species as native (plants.csv `nativity_nctx`), and it is
 * not a cultivar. A cultivar is a selected clone, not a local population, so it
 * never counts, whatever its parent species is. Blank nativity is "not
 * confirmed", never "introduced".
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

/** A cultivar name carries its cultivar epithet in quotes: Ilex vomitoria 'Nana'. */
function isCultivar(entry) {
  return /['‘’"]/.test(entry.botanicalName || '');
}

/**
 * How a species stands against the native test, for its label and the filter.
 * @param {{botanicalName?: string, nativity?: string}} entry
 * @returns {'native'|'cultivar'|'introduced'|'unconfirmed'}
 */
export function nativeStanding(entry) {
  if (isCultivar(entry)) return 'cultivar';
  if (entry.nativity === 'native') return 'native';
  if (entry.nativity === 'introduced') return 'introduced';
  return 'unconfirmed';
}

const STANDING_LABELS = Object.freeze({
  native: 'native to North Central Texas',
  cultivar: 'cultivar',
  introduced: 'not native here',
  unconfirmed: 'nativity not confirmed',
});

function sortName(entry, sortBy) {
  return sortBy === 'botanical'
    ? entry.botanicalName || entry.commonName || ''
    : entry.commonName || entry.botanicalName || '';
}

/**
 * The picker's options: species with an id and a botanical name that match
 * `query`, ordered by the chosen name (the other name breaks ties).
 * @param {Array<{speciesId?: string, commonName?: string, botanicalName?: string}>} species
 * @param {{query?: string, sortBy?: 'common'|'botanical', nativeOnly?: boolean}} [options]
 */
export function searchSpecies(species, { query = '', sortBy = 'common', nativeOnly = false } = {}) {
  const other = sortBy === 'botanical' ? 'common' : 'botanical';
  return (species || [])
    .filter((entry) => entry.speciesId && entry.botanicalName)
    .filter((entry) => !nativeOnly || nativeStanding(entry) === 'native')
    .filter((entry) => speciesMatchesQuery(entry, query))
    .sort(
      (a, b) =>
        sortName(a, sortBy).localeCompare(sortName(b, sortBy), undefined, { sensitivity: 'base' }) ||
        sortName(a, other).localeCompare(sortName(b, other), undefined, { sensitivity: 'base' })
    );
}

/**
 * An option's text, leading with the name the list is sorted by so the order
 * is visible, then where the species stands against the native test, then a
 * star when the person marked it favorite (nl-3on).
 * @param {{commonName?: string, botanicalName?: string, nativity?: string}} entry
 * @param {'common'|'botanical'} sortBy
 * @param {{favorite?: boolean}} [options]
 */
export function speciesOptionLabel(entry, sortBy = 'common', { favorite = false } = {}) {
  let names = entry.botanicalName;
  if (entry.commonName) {
    names =
      sortBy === 'botanical'
        ? `${entry.botanicalName} (${entry.commonName})`
        : `${entry.commonName} (${entry.botanicalName})`;
  }
  // The mark trails the names so typing a letter in the select still jumps by name.
  const standing = nativeStanding(entry);
  const label = `${names} · ${standing === 'native' ? '✓ ' : ''}${STANDING_LABELS[standing]}`;
  return favorite ? `${label} · ★ favorite` : label;
}
