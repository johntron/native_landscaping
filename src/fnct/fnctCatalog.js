/**
 * Cross-reference one FNCT index row against this project's own species
 * catalog (plants.csv), so the detail view can show "already in your
 * catalog" plus its growing info, not just the flora's page citation.
 *
 * Kept separate from fnctPage.js so the join logic is unit-testable with no
 * DOM. Matches on scientific name — first the exact rank-qualified name
 * ("Quercus sinuata var. breviloba"), falling back to the bare "Genus
 * species" pair (a catalog entry is usually the nominate species even when
 * the flora treats a named variety).
 */
export function matchCatalogRow(fnctRow, catalogRows) {
  const exact = fnctRow.scientific_name.toLowerCase();
  const bare = `${fnctRow.genus} ${fnctRow.species}`.toLowerCase();

  let bareMatch;
  for (const row of catalogRows) {
    const botanical = (row.botanical_name || '').trim().toLowerCase();
    if (botanical === exact) return row;
    if (!bareMatch && botanical === bare) bareMatch = row;
  }
  return bareMatch;
}
