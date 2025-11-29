export function buildTooltipLines(plant, state) {
  return [
    plant.commonName,
    plant.botanicalName,
    `Height: ${plant.height}ft, Width: ${plant.width}ft`,
    `Sun: ${plant.sunPref}`,
    `Water: ${plant.waterPref}`,
    `Soil: ${plant.soilPref}`,
    state?.isFlowering ? 'Flowering' : '',
  ];
}
