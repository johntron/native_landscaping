import {
  DEFAULT_ELEVATION_FT,
  DEFAULT_PADDING_FT,
  DEFAULT_PIXELS_PER_INCH,
  DEFAULT_PX_PER_FT,
  DEFAULT_YARD_FT,
  ELEVATION_VIEWBOX,
  INCHES_PER_FOOT,
  PLAN_VIEWBOX,
  SOUTH_ELEVATION_BOTTOM_OFFSET_PX,
  SOUTH_ELEVATION_LEFT_OFFSET_PX,
} from '../constants.js';
import { isValidViewFrom, resolveElevationOrientation } from '../render/elevationOrientation.js';
import { createViewTransform } from '../render/viewTransform.js';

export const PROJECTS_DIR = 'projects';
export const PROJECT_INDEX_PATH = `${PROJECTS_DIR}/index.json`;

/**
 * Project ids become path segments on both the client and the server, so keep
 * them to a conservative slug shape — no dots, no separators, nothing that could
 * escape the projects directory.
 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidProjectId(id) {
  return typeof id === 'string' && id.length <= 64 && PROJECT_ID_PATTERN.test(id);
}

/**
 * Normalize projects/index.json into a predictable shape.
 * @param {any} raw
 * @returns {{ defaultProject: string, projects: Array<{ id: string, name: string }> }}
 */
export function normalizeProjectIndex(raw) {
  const entries = Array.isArray(raw?.projects) ? raw.projects : [];
  const projects = entries
    .map((entry) => {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (!isValidProjectId(id)) return null;
      const name = (typeof entry === 'object' && entry?.name) || id;
      return { id, name: String(name) };
    })
    .filter(Boolean);

  if (!projects.length) {
    throw new Error('projects/index.json lists no valid projects');
  }

  const requestedDefault = raw?.defaultProject;
  const defaultProject = projects.some((p) => p.id === requestedDefault)
    ? requestedDefault
    : projects[0].id;

  return { defaultProject, projects };
}

/**
 * Pick the project to load from a requested id (typically `?project=`), falling
 * back to the index default. Returns the reason for a fallback so the UI can say
 * something rather than silently showing the wrong yard.
 *
 * @param {string} requestedId
 * @param {{ defaultProject: string, projects: Array<{ id: string }> }} index
 * @returns {{ id: string, fellBack: boolean, requestedId: string }}
 */
export function resolveActiveProjectId(requestedId, index) {
  const requested = requestedId ? String(requestedId) : '';
  const known = index.projects.some((project) => project.id === requested);
  if (requested && known) {
    return { id: requested, fellBack: false, requestedId: requested };
  }
  return { id: index.defaultProject, fellBack: Boolean(requested), requestedId: requested };
}

/**
 * Normalize a project.json into a fully-populated config.
 *
 * **A project declares its yard once and every view is derived from it.**
 * `yardFt` says how far the yard runs east-west (`width`) and north-south
 * (`depth`); `paddingFt` is the margin drawn around it; `elevationFt` says how
 * far an elevation reaches above and below the ground line; `pxPerFt` is the
 * drawing resolution. Nothing about a view's rectangle is authored per view,
 * which is the whole point: two views of one yard cannot disagree about how big
 * it is, so their panels line up and their ground lines share a row.
 *
 * What IS per view is the photograph. `photoFt` is the rectangle of yard the
 * image covers, in that view's own coordinates — drag it into place, measure a
 * known length to scale it. A view with no `photoFt` simply fills its panel
 * with the image, which is where an uncalibrated upload starts.
 *
 * Two older shapes are read and migrated on the way in: `views[]` with
 * per-view `extentFt`/`originFt` (the yard is taken from the plan, and each
 * view's old rectangle becomes its photo's placement), and the pixel-authored
 * `{plan, elevations[]}`. Writes always emit the current shape; see
 * serializeProjectConfig.
 *
 * @param {any} raw
 * @param {string} id project id, taken from the directory name rather than trusted from the file
 */
export function normalizeProjectConfig(raw, id) {
  if (!isValidProjectId(id)) {
    throw new Error(`Invalid project id "${id}"`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Project "${id}" has no configuration object`);
  }

  const rawViews = Array.isArray(raw.views) ? raw.views : migrateLegacyViews(raw, id);
  if (!rawViews.length) {
    throw new Error(`Project "${id}" declares no views`);
  }

  const layout = resolveLayout(raw, rawViews);
  // An older file authored one rectangle per view and fitted it to the photo.
  // The rectangle is now derived, so that same rectangle becomes the PHOTO's —
  // which leaves every picture exactly where it was while the panel around it
  // changes size. Skipped once the file declares a yard, because then the
  // rectangles are gone and photoFt is the only placement there is.
  const sourceViews = raw.yardFt ? rawViews : rawViews.map(adoptRectAsPhoto);

  const seenIds = new Set();
  const views = sourceViews.map((view, index) => {
    const normalized = normalizeView(view, index, id, layout);
    if (seenIds.has(normalized.id)) {
      throw new Error(`Project "${id}" has two views with the id "${normalized.id}"`);
    }
    seenIds.add(normalized.id);
    return normalized;
  });

  return {
    id,
    name: String(raw.name || id),
    ...layout,
    views,
  };
}

/**
 * Carry an old view's own rectangle over to its photograph.
 *
 * Only where there is a photo to place and nothing already placing it: a file
 * part-way through conversion, or one hand-edited to add `photoFt`, keeps what
 * it says.
 */
function adoptRectAsPhoto(view) {
  if (!view || typeof view !== 'object') return view;
  if (!view.background || view.photoFt) return view;
  const width = Number(view.extentFt?.width);
  const height = Number(view.extentFt?.height);
  if (!(width > 0) || !(height > 0)) return view;
  return {
    ...view,
    photoFt: { originFt: normalizePoint(view.originFt), extentFt: { width, height } },
  };
}

/**
 * The four numbers every view is derived from, taken from the file or inferred
 * from the per-view rectangles an older file authored.
 *
 * Inferring rather than defaulting matters: a project saved under the old shape
 * has a yard, it just spelled it out one view at a time. The plan's rectangle
 * is that yard by definition — `resolveYardBounds` already treated it as such —
 * and the tallest thing any elevation reached above its ground line is the
 * headroom they all now share. Nothing moves on screen except the margins.
 */
function resolveLayout(raw, rawViews) {
  const declared = raw.yardFt && Number(raw.yardFt.width) > 0 && Number(raw.yardFt.depth) > 0;
  const plan = rawViews.find((view) => String(view?.type || '').toLowerCase() === 'plan');
  const elevations = rawViews.filter(
    (view) => String(view?.type || '').toLowerCase() === 'elevation'
  );

  const yardFt = declared
    ? { width: Number(raw.yardFt.width), depth: Number(raw.yardFt.depth) }
    : inferYard(plan);

  const paddingFt = normalizeNonNegative(raw.paddingFt, DEFAULT_PADDING_FT);

  const above = normalizePositiveNumber(
    raw.elevationFt?.above,
    declared ? DEFAULT_ELEVATION_FT.above : inferHeadroom(elevations)
  );
  const below = normalizeNonNegative(raw.elevationFt?.below, DEFAULT_ELEVATION_FT.below);

  const pxPerFt = normalizePositiveNumber(raw.pxPerFt, inferPxPerFt(plan || rawViews[0]));

  return { yardFt, paddingFt, elevationFt: { above, below }, pxPerFt };
}

/** The yard an old plan view described: its rectangle, measured from zero. */
function inferYard(plan) {
  const width = Number(plan?.extentFt?.width);
  const depth = Number(plan?.extentFt?.height);
  if (!(width > 0) || !(depth > 0)) return { ...DEFAULT_YARD_FT };
  return {
    width: Math.max(width, width + normalizeNumber(plan?.originFt?.x, 0)),
    depth: Math.max(depth, depth + normalizeNumber(plan?.originFt?.y, 0)),
  };
}

/** The most any old elevation reached above its own ground line. */
function inferHeadroom(elevations) {
  const heights = elevations
    .map((view) => Number(view?.extentFt?.height) + normalizeNumber(view?.originFt?.y, 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!heights.length) return DEFAULT_ELEVATION_FT.above;
  return Math.ceil(Math.max(...heights));
}

function inferPxPerFt(view) {
  const px = Number(view?.viewBox?.width);
  const feet = Number(view?.extentFt?.width);
  if (!(px > 0) || !(feet > 0)) return DEFAULT_PX_PER_FT;
  return px / feet;
}

/**
 * The rectangle a view covers, derived from the yard.
 *
 * A plan shows the yard plus its margin on all four sides. An elevation shows
 * whichever yard axis runs across it — east-west for a view from the north or
 * south, north-south for one from the east or west — plus the same margin at
 * both ends, and the shared band of height. `originFt.x` is still the lowest
 * axis value the view covers; mirroring decides which screen edge that lands
 * on, and `viewTransform` owns that.
 *
 * @param {'plan'|'elevation'} type
 * @param {string} viewFrom
 * @param {{ yardFt: object, paddingFt: number, elevationFt: object, pxPerFt: number }} layout
 */
export function deriveViewGeometry(type, viewFrom, layout) {
  const { yardFt, paddingFt, elevationFt, pxPerFt } = layout;
  if (type === 'plan') {
    const extentFt = {
      width: yardFt.width + 2 * paddingFt,
      height: yardFt.depth + 2 * paddingFt,
    };
    return { originFt: { x: -paddingFt, y: -paddingFt }, extentFt, viewBox: scale(extentFt, pxPerFt) };
  }
  const axisKey = resolveElevationOrientation(viewFrom).axisKey;
  const extentFt = {
    width: (axisKey === 'x' ? yardFt.width : yardFt.depth) + 2 * paddingFt,
    height: elevationFt.above + elevationFt.below,
  };
  return {
    originFt: { x: -paddingFt, y: -elevationFt.below },
    extentFt,
    viewBox: scale(extentFt, pxPerFt),
  };
}

/**
 * Derived pixels, trimmed of float noise.
 *
 * 33.6296… ft at 27 px/ft is 908.0000000000001, which ends up in the SVG's
 * viewBox attribute and in every snapshot of it. Six decimals is far finer than
 * the 1e-3 relative tolerance createViewTransform allows between the two axes,
 * so rounding cannot make a view non-uniform.
 */
function scale(extentFt, pxPerFt) {
  const trim = (value) => Math.round(value * 1e6) / 1e6;
  return { width: trim(extentFt.width * pxPerFt), height: trim(extentFt.height * pxPerFt) };
}

function migrateLegacyViews(raw, projectId) {
  const pxPerFt =
    normalizePositiveNumber(raw.defaultPixelsPerInch, DEFAULT_PIXELS_PER_INCH) * INCHES_PER_FOOT;
  const plan = raw.plan || {};
  const planViewBox = normalizeViewBox(plan.viewBox, PLAN_VIEWBOX);
  const views = [
    {
      id: 'plan',
      type: 'plan',
      label: plan.label,
      sublabel: plan.sublabel,
      viewBox: planViewBox,
      originFt: { x: 0, y: 0 },
      extentFt: extentForViewBox(planViewBox, pxPerFt),
      background: plan.background,
    },
  ];

  const rawElevations = Array.isArray(raw.elevations) ? raw.elevations : [];
  rawElevations.forEach((elevation, index) => {
    if (!elevation || typeof elevation !== 'object') {
      throw new Error(`Project "${projectId}" elevation ${index + 1} is not an object`);
    }
    const viewBox = normalizeViewBox(elevation.viewBox, ELEVATION_VIEWBOX);
    // A pixel inset from the near edge becomes a negative origin in feet: the
    // drawing starts that far before the yard's zero.
    const leftOffsetPx = normalizeNumber(elevation.leftOffsetPx, SOUTH_ELEVATION_LEFT_OFFSET_PX);
    const bottomOffsetPx = normalizeNumber(
      elevation.bottomOffsetPx,
      SOUTH_ELEVATION_BOTTOM_OFFSET_PX
    );
    views.push({
      id: elevation.id,
      type: 'elevation',
      viewFrom: elevation.viewFrom,
      label: elevation.label,
      sublabel: elevation.sublabel,
      viewBox,
      originFt: { x: -leftOffsetPx / pxPerFt, y: -bottomOffsetPx / pxPerFt },
      extentFt: extentForViewBox(viewBox, pxPerFt),
      background: elevation.background,
    });
  });

  return views;
}

function extentForViewBox(viewBox, pxPerFt) {
  return { width: viewBox.width / pxPerFt, height: viewBox.height / pxPerFt };
}

function normalizeView(raw, index, projectId, layout) {
  const where = `view ${index + 1}`;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Project "${projectId}" ${where} is not an object`);
  }
  const type = String(raw.type || '').toLowerCase();
  if (type !== 'plan' && type !== 'elevation') {
    throw new Error(
      `Project "${projectId}" ${where} has an unknown type "${raw.type}" (expected plan or elevation)`
    );
  }

  const viewFrom = type === 'elevation' ? String(raw.viewFrom || '').toLowerCase() : '';
  if (type === 'elevation' && !isValidViewFrom(viewFrom)) {
    throw new Error(`Project "${projectId}" ${where} has an unknown viewFrom "${raw.viewFrom}"`);
  }

  const fallbackId = type === 'elevation' ? viewFrom : 'plan';
  const id = isValidProjectId(raw.id) ? raw.id : fallbackId;
  const defaults = defaultLabels(type, viewFrom);
  const background = normalizeAssetPath(raw.background, projectId, id);

  const view = {
    id,
    type,
    ...(type === 'elevation' ? { viewFrom } : {}),
    label: String(raw.label || defaults.label),
    sublabel: String(raw.sublabel || defaults.sublabel),
    ...deriveViewGeometry(type, viewFrom, layout),
    background,
    ...normalizePhoto(raw, background),
    ...normalizeViewerAt(type, raw.viewerAtFt),
  };

  // One derivation of pxPerFt for the whole app: build the transform the
  // renderers will use, so a non-uniformly scaled view is rejected here rather
  // than silently stretching the yard over its photo. Derived geometry cannot
  // produce one, which is the point — but a bad pxPerFt still can.
  try {
    createViewTransform(view);
  } catch (err) {
    throw new Error(`Project "${projectId}" ${where}: ${err.message}`);
  }

  return view;
}

/**
 * Where the view's photograph sits, as a rectangle of yard in the view's own
 * coordinates.
 *
 * Absent is a real answer and the common one: an image that has never been
 * calibrated fills its panel, which is both the old behaviour and a sane place
 * to start dragging from. A file authored under the previous shape carries the
 * view's own former rectangle here, so its photo lands exactly where it always
 * did while the panel around it changes size.
 */
function normalizePhoto(raw, background) {
  if (!background) return {};
  const photo = raw.photoFt;
  const width = Number(photo?.extentFt?.width);
  const height = Number(photo?.extentFt?.height);
  if (!(width > 0) || !(height > 0)) return {};
  return {
    photoFt: {
      originFt: normalizePoint(photo.originFt),
      extentFt: { width, height },
    },
  };
}

function defaultLabels(type, viewFrom) {
  if (type === 'plan') {
    return { label: 'Plan', sublabel: 'Looking Down' };
  }
  return {
    label: `${capitalize(viewFrom)} elevation`,
    sublabel: `Looking ${capitalize(oppositeOf(viewFrom))}`,
  };
}

/**
 * Where the viewer stands along an elevation's DEPTH axis, in yard feet.
 *
 * An elevation authors the axis running across the drawing and the ground
 * height, and until now said nothing about depth — which put the camera at
 * infinity and made everything in the yard, in every direction, in front of it.
 * A wall standing between the photographer and the bed is then drawn over the
 * bed in the view taken from the other side, which is exactly backwards: from
 * there the wall is behind the camera.
 *
 * **Absent means cull nothing**, and that is deliberate: no existing project
 * declares one, and the permissive default leaves them drawing exactly what
 * they drew before. This is the opposite of `normalizeFeatures`, which refuses
 * a missing height rather than defaulting it — there a default HIDES a shape,
 * here a default would hide one. Zero is a real position, so the test is
 * finiteness, never truthiness.
 */
function normalizeViewerAt(type, raw) {
  if (type !== 'elevation' || raw === undefined || raw === null || raw === '') return {};
  const feet = Number(raw);
  return Number.isFinite(feet) ? { viewerAtFt: feet } : {};
}

function normalizePoint(raw) {
  return { x: normalizeNumber(raw?.x, 0), y: normalizeNumber(raw?.y, 0) };
}

/**
 * Render a normalized config back to the shape project.json holds, dropping
 * anything normalizeProjectConfig would have supplied anyway — the inflated
 * default labels, and every view rectangle, which is derived from the yard and
 * must never be written back as authored data.
 *
 * @param {ReturnType<typeof normalizeProjectConfig>} config
 */
export function serializeProjectConfig(config) {
  return {
    id: config.id,
    name: config.name,
    yardFt: { ...config.yardFt },
    paddingFt: config.paddingFt,
    elevationFt: { ...config.elevationFt },
    pxPerFt: config.pxPerFt,
    views: config.views.map((view) => {
      const defaults = defaultLabels(view.type, view.viewFrom);
      const out = { id: view.id, type: view.type };
      if (view.type === 'elevation') out.viewFrom = view.viewFrom;
      if (view.label !== defaults.label) out.label = view.label;
      if (view.sublabel !== defaults.sublabel) out.sublabel = view.sublabel;
      if (view.background) out.background = view.background;
      // Geometry is derived from the yard and never written back — that is what
      // stops a saved file from re-acquiring per-view rectangles that disagree.
      if (view.photoFt) {
        out.photoFt = {
          originFt: { ...view.photoFt.originFt },
          extentFt: { ...view.photoFt.extentFt },
        };
      }
      if (view.viewerAtFt !== undefined) out.viewerAtFt = view.viewerAtFt;
      return out;
    }),
  };
}

function normalizeViewBox(raw, fallback) {
  const width = normalizePositiveNumber(raw?.width, fallback.width);
  const height = normalizePositiveNumber(raw?.height, fallback.height);
  return { width, height };
}

/**
 * Background paths are relative to the project directory. Reject anything that
 * tries to climb out of it or point at another origin. A view may declare no
 * background at all — a freshly added view is valid before its image exists.
 */
function normalizeAssetPath(value, projectId, viewId) {
  const path = String(value ?? '').trim();
  if (!path) return null;
  if (path.startsWith('/') || path.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error(
      `Project "${projectId}" view "${viewId}" background must be a path relative to the project directory`
    );
  }
  return path;
}

function normalizeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizePositiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/** Zero is a legitimate margin; negative is not. */
function normalizeNonNegative(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function capitalize(value) {
  const str = String(value || '');
  return str ? str[0].toUpperCase() + str.slice(1) : str;
}

function oppositeOf(direction) {
  const opposites = { north: 'south', south: 'north', east: 'west', west: 'east' };
  return opposites[direction] || direction;
}

/** Directory holding a project's config, layout, and background images. */
export function projectDirectory(projectId) {
  return `${PROJECTS_DIR}/${projectId}`;
}

/** Resolve an asset declared in project.json against the project directory. */
export function projectAssetPath(projectId, relativePath) {
  return `${projectDirectory(projectId)}/${relativePath}`;
}

export function projectLayoutPath(projectId) {
  return `${projectDirectory(projectId)}/planting_layout.csv`;
}

export function projectConfigPath(projectId) {
  return `${projectDirectory(projectId)}/project.json`;
}

/**
 * Fetch and normalize the project index. Kept fetch-injectable for tests and so
 * the app keeps working as plain static files (no API endpoint involved).
 */
export async function loadProjectIndex(fetchFn, baseUri) {
  const raw = await fetchJson(fetchFn, PROJECT_INDEX_PATH, baseUri);
  return normalizeProjectIndex(raw);
}

export async function loadProjectConfig(projectId, fetchFn, baseUri) {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid project id "${projectId}"`);
  }
  const raw = await fetchJson(fetchFn, projectConfigPath(projectId), baseUri);
  return normalizeProjectConfig(raw, projectId);
}

async function fetchJson(fetchFn, path, baseUri) {
  const url = baseUri ? new URL(path, baseUri).toString() : path;
  const response = await fetchFn(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load ${path} (${response.status})`);
  }
  return response.json();
}
