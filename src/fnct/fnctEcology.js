/**
 * Genus-level ecology lookups for the FNCT detail panel — every one of
 * these tables is keyed by genus, not by species, so a detail view for
 * "Quercus alba" shows what's known about Quercus as a whole (the flora and
 * these sources rarely go finer than genus for animal interactions).
 * Kept as pure functions, separate from fnctPage.js, so they're unit-testable
 * with no DOM or fetch.
 */

/** ecology/host-genera.csv row for this genus, or undefined. NWF's keystone-genus counts are continental (ecoregion 9), not nc-TX-specific — label accordingly wherever this is shown. */
export function findKeystoneRow(genus, hostGeneraRows) {
  return hostGeneraRows.find((r) => r.genus === genus);
}

/** ecology/fnct-lepidoptera-hosts.csv rows for this genus — the flora's own, nc-TX-specific larval-host records. */
export function lepidopteraHostsForGenus(genus, lepRows) {
  return lepRows
    .filter((r) => r.plant_genus === genus)
    .map((r) => ({ common: r.lep_common, species: r.lep_species, section: r.section, page: r.fnct_page }))
    .sort((a, b) => a.species.localeCompare(b.species));
}

/** ecology/plant-animal-interactions.csv rows for this genus, grouped by interaction_type (GloBI — global, not nc-TX-specific). */
export function interactionsForGenus(genus, interactionRows) {
  const groups = new Map();
  for (const row of interactionRows) {
    if (row.genus !== genus) continue;
    const key = row.interaction_type || row.category || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ species: row.animal_species, common: row.animal_common });
  }
  return [...groups.entries()]
    .map(([type, animals]) => ({ type, animals: animals.sort((a, b) => a.species.localeCompare(b.species)) }))
    .sort((a, b) => b.animals.length - a.animals.length);
}
