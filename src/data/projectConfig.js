import {
  DEFAULT_PIXELS_PER_INCH,
  ELEVATION_VIEWBOX,
  INCHES_PER_FOOT,
  PLAN_VIEWBOX,
  SOUTH_ELEVATION_BOTTOM_OFFSET_PX,
  SOUTH_ELEVATION_LEFT_OFFSET_PX,
} from '../constants.js';
import { isValidViewFrom } from '../render/elevationOrientation.js';
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
 * A project declares `views[]`, each authored in feet: `extentFt` is how much
 * yard the view covers and `originFt` is the yard coordinate at its viewBox
 * bottom-left corner. Pixels per foot is derived, never authored.
 *
 * The legacy `{plan, elevations[]}` shape — pixel offsets plus a global
 * `defaultPixelsPerInch` — is still read and migrated on the way in. Writes
 * always emit `views[]`; see serializeProjectConfig.
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

  const seenIds = new Set();
  const views = rawViews.map((view, index) => {
    const normalized = normalizeView(view, index, id);
    if (seenIds.has(normalized.id)) {
      throw new Error(`Project "${id}" has two views with the id "${normalized.id}"`);
    }
    seenIds.add(normalized.id);
    return normalized;
  });

  views.forEach((view) => {
    if (view.backgroundFrom && !seenIds.has(view.backgroundFrom)) {
      throw new Error(
        `Project "${id}" view "${view.id}" borrows a background from unknown view "${view.backgroundFrom}"`
      );
    }
  });

  return {
    id,
    name: String(raw.name || id),
    views,
    ...legacyProjection(views),
  };
}

/**
 * Rewrite the pixel-authored `{plan, elevations[]}` shape as feet-authored views.
 * `defaultPixelsPerInch` is read here and nowhere else — it is never written back.
 */
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

function normalizeView(raw, index, projectId) {
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
  const viewBox = normalizeViewBox(raw.viewBox, type === 'plan' ? PLAN_VIEWBOX : ELEVATION_VIEWBOX);
  const defaults = defaultLabels(type, viewFrom);

  const view = {
    id,
    type,
    ...(type === 'elevation' ? { viewFrom } : {}),
    label: String(raw.label || defaults.label),
    sublabel: String(raw.sublabel || defaults.sublabel),
    viewBox,
    originFt: normalizePoint(raw.originFt),
    extentFt: normalizeExtent(raw.extentFt, projectId, id),
    background: normalizeAssetPath(raw.background, projectId, id),
    ...(raw.backgroundFrom ? { backgroundFrom: String(raw.backgroundFrom) } : {}),
  };

  // One derivation of pxPerFt for the whole app: build the transform the
  // renderers will use, so a non-uniformly scaled view is rejected here rather
  // than silently stretching the yard over its photo.
  try {
    createViewTransform(view);
  } catch (err) {
    throw new Error(`Project "${projectId}" ${where}: ${err.message}`);
  }

  return view;
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

function normalizePoint(raw) {
  return { x: normalizeNumber(raw?.x, 0), y: normalizeNumber(raw?.y, 0) };
}

function normalizeExtent(raw, projectId, viewId) {
  const width = Number(raw?.width);
  const height = Number(raw?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(
      `Project "${projectId}" view "${viewId}" needs a positive extentFt in feet (width and height)`
    );
  }
  return { width, height };
}

/**
 * Fields the app still reads while beads nl-tz7.3 / nl-tz7.4 rewire it onto
 * `views[]`. Derived, never authored — delete this once nothing consumes it.
 *
 * `pixelsPerInch` was global; per-view scales can now differ, so the first view
 * speaks for the project.
 */
function legacyProjection(views) {
  const plan = views.find((view) => view.type === 'plan') || views[0];
  const pxPerFt = views[0].viewBox.width / views[0].extentFt.width;
  return {
    pixelsPerInch: pxPerFt / INCHES_PER_FOOT,
    plan: {
      label: plan.label,
      sublabel: plan.sublabel,
      viewBox: plan.viewBox,
      background: plan.background,
    },
    elevations: views
      .filter((view) => view.type === 'elevation')
      .map((view) => {
        const viewPxPerFt = view.viewBox.width / view.extentFt.width;
        return {
          id: view.id,
          viewFrom: view.viewFrom,
          label: view.label,
          sublabel: view.sublabel,
          viewBox: view.viewBox,
          background: view.background,
          leftOffsetPx: -view.originFt.x * viewPxPerFt,
          bottomOffsetPx: -view.originFt.y * viewPxPerFt,
        };
      }),
  };
}

/**
 * Render a normalized config back to the shape project.json holds, dropping
 * anything normalizeProjectConfig would have supplied anyway. Without this,
 * every save would bake the inflated labels and zero origins into the file.
 *
 * @param {ReturnType<typeof normalizeProjectConfig>} config
 */
export function serializeProjectConfig(config) {
  return {
    id: config.id,
    name: config.name,
    views: config.views.map((view) => {
      const defaults = defaultLabels(view.type, view.viewFrom);
      const defaultViewBox = view.type === 'plan' ? PLAN_VIEWBOX : ELEVATION_VIEWBOX;
      const out = { id: view.id, type: view.type };
      if (view.type === 'elevation') out.viewFrom = view.viewFrom;
      if (view.label !== defaults.label) out.label = view.label;
      if (view.sublabel !== defaults.sublabel) out.sublabel = view.sublabel;
      if (view.viewBox.width !== defaultViewBox.width || view.viewBox.height !== defaultViewBox.height) {
        out.viewBox = { ...view.viewBox };
      }
      if (view.originFt.x !== 0 || view.originFt.y !== 0) out.originFt = { ...view.originFt };
      out.extentFt = { ...view.extentFt };
      if (view.background) out.background = view.background;
      if (view.backgroundFrom) out.backgroundFrom = view.backgroundFrom;
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
