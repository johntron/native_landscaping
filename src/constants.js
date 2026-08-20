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

export const PLAN_VIEWBOX = {
  width: 800,
  height: 600,
};

export const ELEVATION_VIEWBOX = {
  width: 800,
  height: 600,
};
