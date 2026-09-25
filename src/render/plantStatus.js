/**
 * How a plant's lifecycle (nl-3s5.22) shows in a drawing. A planned plant,
 * the default, keeps its month's colours, flowers and fruit (the month-by-month
 * picture is the point of the tool) and draws its outline dashed; a planted one
 * draws it solid, as every plant was drawn before. The dash goes on the outline
 * the plant already has, so a plant is the same elements either way.
 *
 * Presentation attributes, not a stylesheet class, so the PNG a view exports
 * (src/export/viewCapture.js serializes the SVG alone) matches the screen.
 */
import { lifecycleOf, STATUS_PLANTED } from '../data/plantLifecycle.js';

/**
 * A planned outline's dash and gap, as multiples of the outline's width, and
 * the least width it is drawn at so the gaps still read on a small plant. The
 * width is the planted outline's own otherwise: widening it made a large
 * canopy's dashes heavier than anything else in the drawing.
 */
const DASH = 3;
const GAP = 2;
const MIN_PLANNED_WIDTH = 1.2;

/**
 * @param {object} plant
 * @returns {'planned'|'planted'}
 */
export function plantStatus(plant) {
  return lifecycleOf(plant).status;
}

/**
 * The outline attributes for a plant of `status`, given the planted outline's width.
 * @param {'planned'|'planted'} status
 * @param {number} strokeWidth
 * @returns {Record<string, string|number>}
 */
export function outlineStatusAttributes(status, strokeWidth) {
  if (status === STATUS_PLANTED) return { 'stroke-width': strokeWidth };
  const width = Math.max(strokeWidth, MIN_PLANNED_WIDTH);
  return {
    'stroke-width': width,
    'stroke-dasharray': `${round(width * DASH)} ${round(width * GAP)}`,
    'stroke-linecap': 'butt',
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
