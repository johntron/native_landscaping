import { isValidProjectId } from './projectConfig.js';

/**
 * Yard features — beds, hardscape, fences, the house footprint — are geometry in
 * FEET shared by every view, which is what keeps them out of project.json: that
 * file holds per-view presentation, this one holds the yard itself. Each feature
 * carries a footprint *and* a height because it has to appear in both a plan and
 * an elevation.
 *
 * Four primitives are enough for a real yard:
 *
 *   surface  flat, zero height — driveway, gravel bed, bed outline. Polygon.
 *   wall     an extruded line — fence, retaining wall, garden edge. Path.
 *   box      an extruded polygon — house, shed, raised planter. Polygon.
 *   trellis  an extruded line, like a wall, but open lattice rather than a
 *            solid fence — climbable the same way a wall is, but never hides
 *            what is behind it and reads visually as thin and open. Path.
 *
 * Styles are authored in feet (`strokeWidthFt`) like everything else, so a
 * feature keeps its weight when a view is rescaled.
 */

/** Feature ids become DOM ids and selectors, so they take the project slug shape. */
export const isValidFeatureId = isValidProjectId;

const POLYGON_TYPES = new Set(['surface', 'box']);
const FEATURE_TYPES = new Set(['surface', 'wall', 'box', 'trellis']);

/** Zero height is what *makes* a surface a surface; it is never authored. */
const SURFACE_HEIGHT_FT = 0;

const DEFAULT_STYLES = {
  surface: { fill: '#e8e4dc', stroke: '#cfc8bb', strokeWidthFt: 0.1 },
  wall: { fill: '#d8d2c6', stroke: '#b3aa99', strokeWidthFt: 0.1 },
  box: { fill: '#e6e1d8', stroke: '#c9c3b8', strokeWidthFt: 0.15 },
  trellis: { fill: '#8b6f4d', stroke: '#6e5638', strokeWidthFt: 0.05 },
};

/**
 * Colours land in SVG attributes and arrive over an endpoint, so accept a
 * conservative shape rather than passing arbitrary strings through: hex, the
 * `none` keyword, or a plain CSS colour name.
 */
const COLOR_PATTERN = /^(#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]+)$/;

/** The geometry key a primitive is authored with — the other one is never emitted. */
export function geometryKeyFor(type) {
  return POLYGON_TYPES.has(type) ? 'footprintFt' : 'pathFt';
}

function defaultStyle(type) {
  return DEFAULT_STYLES[type] || DEFAULT_STYLES.surface;
}

/**
 * Normalize a features.json into a fully-populated feature list.
 *
 * A project with no features is normal — an absent file and an empty list mean
 * the same thing and both normalize to `{ features: [] }`. Anything else that is
 * malformed throws, because a silently dropped house is worse than a failed load.
 *
 * @param {any} raw
 * @param {string} projectId taken from the directory name, not trusted from the file;
 *   used for error messages only, so normalize and serialize stay exact inverses
 * @returns {{ features: Array<object> }}
 */
export function normalizeFeatures(raw, projectId) {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid project id "${projectId}"`);
  }
  if (raw === null || raw === undefined) {
    return { features: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Project "${projectId}" features must be an object with a features array`);
  }
  const rawFeatures = raw.features === undefined ? [] : raw.features;
  if (!Array.isArray(rawFeatures)) {
    throw new Error(`Project "${projectId}" features must be an array`);
  }

  const seenIds = new Set();
  const features = rawFeatures.map((feature, index) => {
    const normalized = normalizeFeature(feature, index, projectId);
    if (seenIds.has(normalized.id)) {
      throw new Error(`Project "${projectId}" has two features with the id "${normalized.id}"`);
    }
    seenIds.add(normalized.id);
    return normalized;
  });

  return { features };
}

function normalizeFeature(raw, index, projectId) {
  const where = `feature ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Project "${projectId}" ${where} is not an object`);
  }

  // Unlike a view, a feature has no sensible id to fall back to — an elevation
  // can borrow its compass direction, a fence cannot borrow anything.
  if (!isValidFeatureId(raw.id)) {
    throw new Error(`Project "${projectId}" ${where} needs an id matching [a-z0-9][a-z0-9_-]*`);
  }
  const id = raw.id;

  const type = String(raw.type || '').toLowerCase();
  if (!FEATURE_TYPES.has(type)) {
    throw new Error(
      `Project "${projectId}" feature "${id}" has an unknown type "${raw.type}" (expected surface, wall, box, or trellis)`
    );
  }

  const geometryKey = geometryKeyFor(type);
  const points = normalizePoints(raw[geometryKey], projectId, id, geometryKey, type);

  return {
    id,
    type,
    label: String(raw.label || id),
    [geometryKey]: points,
    baseFt: normalizeBase(raw.baseFt, projectId, id),
    heightFt: normalizeHeight(raw.heightFt, projectId, id, type),
    style: normalizeStyle(raw.style, projectId, id, type),
  };
}

/**
 * A polygon needs three vertices to enclose anything and a path needs two to go
 * anywhere; fewer is a half-drawn shape, not a shape with a default.
 */
function normalizePoints(raw, projectId, featureId, geometryKey, type) {
  const minimum = POLYGON_TYPES.has(type) ? 3 : 2;
  if (!Array.isArray(raw) || raw.length < minimum) {
    throw new Error(
      `Project "${projectId}" feature "${featureId}" needs a ${geometryKey} of at least ${minimum} points in feet`
    );
  }
  return raw.map((point, index) => {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(
        `Project "${projectId}" feature "${featureId}" ${geometryKey} point ${index + 1} is not a finite {x, y} in feet`
      );
    }
    return { x, y };
  });
}

/** Ground height under the feature, so a shape can sit on a step. Negatives are legal. */
function normalizeBase(value, projectId, featureId) {
  if (value === undefined || value === null) return 0;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Project "${projectId}" feature "${featureId}" baseFt must be a number in feet`);
  }
  return num;
}

/**
 * Height is thrown on rather than defaulted for the extruded primitives: a
 * zero-height wall renders as nothing at all in an elevation, which is exactly
 * the kind of silent disappearance this normalizer exists to catch.
 */
function normalizeHeight(value, projectId, featureId, type) {
  if (type === 'surface') {
    const num = Number(value ?? SURFACE_HEIGHT_FT);
    if (num !== SURFACE_HEIGHT_FT) {
      throw new Error(
        `Project "${projectId}" feature "${featureId}" is a surface, which is flat — it cannot have a heightFt`
      );
    }
    return SURFACE_HEIGHT_FT;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(
      `Project "${projectId}" feature "${featureId}" needs a positive heightFt in feet`
    );
  }
  return num;
}

function normalizeStyle(raw, projectId, featureId, type) {
  const defaults = defaultStyle(type);
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`Project "${projectId}" feature "${featureId}" style must be an object`);
  }
  const style = raw || {};
  return {
    fill: normalizeColor(style.fill, defaults.fill, projectId, featureId, 'fill'),
    stroke: normalizeColor(style.stroke, defaults.stroke, projectId, featureId, 'stroke'),
    strokeWidthFt: normalizeStrokeWidth(style.strokeWidthFt, defaults.strokeWidthFt, projectId, featureId),
  };
}

function normalizeColor(value, fallback, projectId, featureId, key) {
  if (value === undefined || value === null || value === '') return fallback;
  const color = String(value).trim().toLowerCase();
  if (!COLOR_PATTERN.test(color)) {
    throw new Error(
      `Project "${projectId}" feature "${featureId}" style.${key} "${value}" is not a hex colour, a colour name, or none`
    );
  }
  return color;
}

function normalizeStrokeWidth(value, fallback, projectId, featureId) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(
      `Project "${projectId}" feature "${featureId}" style.strokeWidthFt must be a non-negative number of feet`
    );
  }
  return num;
}

/**
 * Render a normalized feature list back to the shape features.json holds,
 * dropping anything normalizeFeatures would have supplied anyway. Both
 * directions read the same defaults, so a serialize round-trips through
 * normalize unchanged.
 *
 * @param {ReturnType<typeof normalizeFeatures>} config
 */
export function serializeFeatures(config) {
  return {
    features: config.features.map((feature) => {
      const geometryKey = geometryKeyFor(feature.type);
      const defaults = defaultStyle(feature.type);
      const out = { id: feature.id, type: feature.type };
      if (feature.label !== feature.id) out.label = feature.label;
      out[geometryKey] = feature[geometryKey].map((point) => ({ x: point.x, y: point.y }));
      if (feature.baseFt !== 0) out.baseFt = feature.baseFt;
      if (feature.type !== 'surface') out.heightFt = feature.heightFt;

      const style = {};
      if (feature.style.fill !== defaults.fill) style.fill = feature.style.fill;
      if (feature.style.stroke !== defaults.stroke) style.stroke = feature.style.stroke;
      if (feature.style.strokeWidthFt !== defaults.strokeWidthFt) {
        style.strokeWidthFt = feature.style.strokeWidthFt;
      }
      if (Object.keys(style).length) out.style = style;
      return out;
    }),
  };
}
