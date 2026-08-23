// Deterministic lookup from USDA's categorical color names (Flower Color,
// Foliage Color, Fruit/Seed Color) to a representative hex swatch. USDA gives
// one word, not a swatch, so this is necessarily approximate — the LLM
// augmentation pass should treat these as a starting point, not ground truth,
// especially for foliage where plants.csv wants per-season values USDA
// doesn't distinguish.
const COLOR_HEX = {
  white: "#f1f1e2",
  cream: "#f2ead0",
  yellow: "#e8d24a",
  orange: "#d98a3d",
  red: "#b3261e",
  pink: "#d98fae",
  rose: "#c96b8a",
  purple: "#8f6fb3",
  lavender: "#b4a3d6",
  violet: "#7a5ea8",
  blue: "#5b7ea3",
  green: "#5b7a4b",
  brown: "#6b5a4a",
  tan: "#c2a978",
  gray: "#9a9a8c",
  grey: "#9a9a8c",
  black: "#3a3a34",
  gold: "#c9a227",
  bronze: "#8a6a3a",
};

export function colorNameToHex(name) {
  if (!name) return null;
  const key = name.trim().toLowerCase().split(/\s*,\s*/)[0];
  return COLOR_HEX[key] || null;
}
