/**
 * Search predicate for the FNCT species index (ecology/fnct-species-index.csv).
 * Kept separate from fnctPage.js so it can be unit-tested with no DOM.
 *
 * Matches on: genus alone ("Quercus"), genus + epithet ("Quercus alba"), or
 * any listed common name — all case-insensitive substring matches, so a
 * partial genus or a partial common name both work.
 */
export function matchesFnctQuery(row, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.scientific_name.toLowerCase().includes(q)) return true;
  if (row.genus.toLowerCase().includes(q)) return true;
  return row.common_names.toLowerCase().includes(q);
}

export function filterFnctRows(rows, query) {
  return rows.filter((row) => matchesFnctQuery(row, query));
}

/**
 * Combined genus + species results, genus rows first (each already sorted
 * alphabetically within its kind — see fnctGenus.js). A genus row is shaped
 * like a species row (scientific_name = genus, common_names aggregated), so
 * matchesFnctQuery works on it unchanged: "Quercus" matches the genus row
 * and every Quercus species; a common name matches whichever rows list it.
 */
export function searchFnctResults(genusRows, speciesRows, query) {
  return [
    ...filterFnctRows(genusRows, query),
    ...filterFnctRows(speciesRows, query),
  ];
}
