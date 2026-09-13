/**
 * Shared native/invasive classification for `data/ecosystem.db` rows, fed by
 * iNaturalist's own `preferred_establishment_means` per-taxon-per-place field
 * (see `tools/fetch-ecosystem-index.mjs`, which fetches and stores it as
 * `establishment_means`). Values observed live: native, endemic, introduced,
 * naturalized, invasive, or absent (no listed-taxa entry for that place —
 * NOT evidence of native status, just unassessed; state-level coverage is
 * far denser than county, but even Texas leaves some species unlisted).
 *
 * Absent/unassessed is deliberately let through rather than excluded — same
 * "no invented judgment" stance as `hostGenera.js`: only positive evidence of
 * non-native/invasive status excludes a row.
 */
export const EXCLUDED_ESTABLISHMENT_MEANS = new Set(['introduced', 'naturalized', 'invasive']);

export function isExcludedEstablishment(means) {
  return EXCLUDED_ESTABLISHMENT_MEANS.has(String(means || '').trim().toLowerCase());
}

/** @param {Array<{establishment_means?: string}>} rows */
export function excludeNonNative(rows) {
  return (rows || []).filter((row) => !isExcludedEstablishment(row.establishment_means));
}
