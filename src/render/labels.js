function pickSourceName(plant) {
  return (
    plant?.botanicalName ||
    plant?.botanical_name ||
    plant?.commonName ||
    plant?.common_name ||
    ''
  );
}

/**
 * Build short uppercase initials for a plant species.
 * Example: "Callicarpa americana" => "CA".
 * @param {Object} plant
 * @returns {string}
 */
export function buildPlantLabel(plant) {
  const source = pickSourceName(plant);
  if (!source) return '';
  const tokens = source.match(/[A-Za-z]+/g);
  if (!tokens) return '';
  const limited = tokens.slice(0, 2);
  return limited.map((word) => word[0].toUpperCase()).join('');
}
