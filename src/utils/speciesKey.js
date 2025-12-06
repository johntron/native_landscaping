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
