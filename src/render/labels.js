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

/**
 * A drift's ONE label, wherever a drift is named (nl-o47.6.11, owner decision
 * 2026-09-29): the species' plan initials (buildPlantLabel of its first
 * member) plus its member count, e.g. "CV (3x)" for three horseherb. A drift
 * has no name of its own to show or edit — there is nothing left to rename —
 * so this single helper is the ONE place a drift's label is composed: the
 * plan's centroid label (src/render/topView.js, and so the plan bundle and
 * HOA packet exports that capture the same renderer,
 * src/export/exportActions.js), the species list's per-drift chips
 * (src/render/speciesTable.js), the selection bar's whole-drift text
 * (src/ui/selectionBar.js), the suggestion review bar (a suggestion is a
 * proposed drift, src/state/driftSuggestions.js describeSuggestion), and the
 * Planting sheet's drift-wide scope note
 * (src/interaction/plantLifecyclePanel.js). Two drifts of one species with
 * the same count get identical labels — the species list resolves that by
 * grouping under the species (src/render/speciesTable.js).
 * @param {Array<object>} members full plant objects, the drift's current membership
 * @returns {string} '' for an empty list
 */
export function driftLabel(members) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return '';
  const label = buildPlantLabel(list[0]);
  if (!label) return '';
  return `${label} (${list.length}x)`;
}

/** driftLabel's/clampLabelPosition's guess at an average glyph's
 * width, in units of its own font size — a Helvetica-ish average character
 * width, and a judgement call, not a metric: the renderer has no access to
 * the DOM's actual glyph widths (an exported PNG is captured from this same
 * SVG headless, so ctx.measureText is not available to it either). Erring
 * wide is cheap: it only nudges a label a little farther from an edge than
 * strictly necessary. */
const AVG_CHAR_WIDTH_EM = 0.62;

/**
 * Keep a centred SVG text label (`text-anchor="middle"`,
 * `dominant-baseline="middle"`) fully inside `viewBox`, nudging its anchor
 * point inward from whichever edges it would otherwise overhang. Written for
 * a drift's single on-plan label (nl-o47.6.7), whose text ("CV (17x)") is
 * wider than a member's own two-letter buildPlantLabel and can overhang
 * the plan's own edge when a drift's centroid sits near one — the plan's SVG
 * itself never clips (`.view svg { overflow: visible }`, styles.css), but
 * its parent panel does (`overflow: hidden`), so text drawn past the
 * viewBox is genuinely lost, not merely drawn behind other art.
 * @param {{x: number, y: number}} point in viewBox pixels
 * @param {string} text the label this point will carry
 * @param {number} fontSize in viewBox pixels
 * @param {{width: number, height: number}} viewBox
 * @param {number} [padPx] margin kept clear of every edge
 * @returns {{x: number, y: number}}
 */
export function clampLabelPosition(point, text, fontSize, viewBox, padPx = 4) {
  const halfWidth = (String(text || '').length * Number(fontSize || 0) * AVG_CHAR_WIDTH_EM) / 2;
  const halfHeight = Number(fontSize || 0) / 2;
  const width = Number(viewBox?.width) || 0;
  const height = Number(viewBox?.height) || 0;
  // A label wider/taller than the viewBox itself has no room that keeps it
  // fully inside either: min/max both collapse to the centre rather than
  // inverting (which would make clamp() below throw its arguments away).
  const minX = Math.min(halfWidth + padPx, width / 2);
  const maxX = Math.max(width - halfWidth - padPx, width / 2);
  const minY = Math.min(halfHeight + padPx, height / 2);
  const maxY = Math.max(height - halfHeight - padPx, height / 2);
  return {
    x: clampValue(Number(point?.x) || 0, minX, maxX),
    y: clampValue(Number(point?.y) || 0, minY, maxY),
  };
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
