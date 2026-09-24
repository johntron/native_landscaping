/**
 * The key two plants (or a plant and a species row) share when they are the same
 * species: plants.csv's `id`, carried as `speciesId` on both species rows and
 * plants (nl-3s5.18). Lower-cased because the highlight code compares it
 * lower-cased; plants.csv ids are unique case-insensitively.
 *
 * Never `.id`: on a plant that is the plant's own id, on a species row the
 * species id, and mixing the two is exactly the bug a shared key must not have.
 * An object with no speciesId (a synthetic row in a unit test, say) falls back
 * to its full botanical name, then its common name. There is no epithet
 * fallback: two species sharing an epithet are not the same species.
 * @param {Object} plant
 * @returns {string}
 */
export function getSpeciesKey(plant) {
  if (!plant) return '';
  const speciesId = plant.speciesId || '';
  if (speciesId) return String(speciesId).trim().toLowerCase();

  const botanical =
    plant.botanicalKey ||
    plant.botanical_name ||
    plant.botanicalName ||
    '';
  if (botanical) return botanical.trim().toLowerCase();

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
