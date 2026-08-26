/**
 * Build a stable species key for lookups/highlighting regardless of source casing.
 * Prefers the normalized botanical name, then species epithet, then common name.
 * @param {Object} plant
 * @returns {string}
 */
export function getSpeciesKey(plant) {
  if (!plant) return '';
  const botanical =
    plant.botanicalKey ||
    plant.botanical_name ||
    plant.botanicalName ||
    '';
  if (botanical) return botanical.trim().toLowerCase();

  const epithet = plant.speciesEpithet || plant.species_epithet || '';
  if (epithet) return epithet.trim().toLowerCase();

  const common = plant.commonName || plant.common_name || '';
  return common.trim().toLowerCase();
}

/**
 * The botanical genus of a plant — the first whitespace-delimited token of its
 * botanical name. Lives beside getSpeciesKey because it is the same job at a
 * coarser grain, and the ecology rules join on it.
 * @param {Object} plant
 * @returns {string} e.g. "Asclepias", or '' when there is no botanical name
 */
export function getGenus(plant) {
  const botanical = plant?.botanicalName || plant?.botanical_name || plant?.botanicalKey || '';
  const first = String(botanical).trim().split(/\s+/)[0] || '';
  return first ? first[0].toUpperCase() + first.slice(1) : '';
}
