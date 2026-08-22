export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const DORMANT_FOLIAGE_COLOR = '#a38c61';
export const INCHES_PER_FOOT = 12;
export const GLOBAL_SEED = 0x9e3779b1; // stable default seed for reproducible randomness

export const DEFAULT_PIXELS_PER_INCH = 2.25; // legacy project.json only; never a render input

/**
 * Zoom is panel display size and nothing else — 1 is the layout's natural fit.
 * It deliberately cannot reach the plant coordinates or the background photo.
 */
export const DEFAULT_ZOOM = 1;
export const ZOOM_LIMITS = {
  min: 0.5,
  max: 3,
  step: 0.1,
};
export const PLANT_BLEND_OPACITY = 0.72;
export const SOUTH_ELEVATION_BOTTOM_OFFSET_PX = 100;
export const SOUTH_ELEVATION_LEFT_OFFSET_PX = 0;
export const EAST_ELEVATION_BOTTOM_OFFSET_PX = 100;
export const EAST_ELEVATION_LEFT_OFFSET_PX = 80;

/**
 * The yard, and the margin around it, when a project does not say.
 *
 * `yardFt` is authored once — how far the yard runs east-west and north-south —
 * and every view's rectangle is derived from it, which is what makes the panels
 * line up. `paddingFt` is drawing margin on every side: enough that a plant's
 * drag target never sits flush against a panel edge, and that an overhanging
 * canopy has somewhere to go. It is deliberately NOT derived from the widest
 * species (10 ft for a yaupon holly), because a plant's centre is what gets
 * clamped and its canopy is allowed to cross the property line, exactly as it
 * does in a real yard.
 */
export const DEFAULT_YARD_FT = { width: 30, depth: 22 };
export const DEFAULT_PADDING_FT = 2;

/**
 * How tall an elevation is, above and below the ground line. Both are
 * project-wide on purpose: identical vertical geometry is what puts every
 * elevation's ground on the same row of the page without anyone aligning
 * anything. They cannot be derived from the yard — the yard is flat — and
 * deriving them from the tallest planted species would make adding a tree
 * resize every view.
 */
export const DEFAULT_ELEVATION_FT = { above: 16, below: 2 };

/** Drawing resolution. Pixels are viewBox units, never a screen measure. */
export const DEFAULT_PX_PER_FT = 27;

export const PLAN_VIEWBOX = {
  width: 800,
  height: 600,
};

export const ELEVATION_VIEWBOX = {
  width: 800,
  height: 600,
};
