import {
  DEFAULT_PIXELS_PER_INCH,
  ELEVATION_VIEWBOX,
  PLAN_VIEWBOX,
  SOUTH_ELEVATION_BOTTOM_OFFSET_PX,
  SOUTH_ELEVATION_LEFT_OFFSET_PX,
} from '../constants.js';
import { isValidViewFrom } from '../render/elevationOrientation.js';

export const PROJECTS_DIR = 'projects';
export const PROJECT_INDEX_PATH = `${PROJECTS_DIR}/index.json`;

/**
 * Project ids become path segments on both the client and the server, so keep
 * them to a conservative slug shape — no dots, no separators, nothing that could
 * escape the projects directory.
 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** The app has exactly two elevation panels; a project supplies a direction for each. */
export const ELEVATION_SLOTS = 2;

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
 * Normalize a project.json into a fully-populated config, filling gaps from the
 * global constants so a minimal project file stays valid.
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

  const rawElevations = Array.isArray(raw.elevations) ? raw.elevations : [];
  if (rawElevations.length !== ELEVATION_SLOTS) {
    throw new Error(
      `Project "${id}" must declare exactly ${ELEVATION_SLOTS} elevations (found ${rawElevations.length})`
    );
  }

  const plan = raw.plan || {};
  const elevations = rawElevations.map((elevation, index) =>
    normalizeElevation(elevation, index, id)
  );

  return {
    id,
    name: String(raw.name || id),
    pixelsPerInch: normalizePositiveNumber(raw.defaultPixelsPerInch, DEFAULT_PIXELS_PER_INCH),
    plan: {
      label: String(plan.label || 'Plan'),
      sublabel: String(plan.sublabel || 'Looking Down'),
      viewBox: normalizeViewBox(plan.viewBox, PLAN_VIEWBOX),
      background: normalizeAssetPath(plan.background, id, 'plan'),
    },
    elevations,
  };
}

function normalizeElevation(raw, index, projectId) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Project "${projectId}" elevation ${index + 1} is not an object`);
  }
  const viewFrom = String(raw.viewFrom || '').toLowerCase();
  if (!isValidViewFrom(viewFrom)) {
    throw new Error(
      `Project "${projectId}" elevation ${index + 1} has an unknown viewFrom "${raw.viewFrom}"`
    );
  }
  const id = isValidProjectId(raw.id) ? raw.id : viewFrom;
  return {
    id,
    viewFrom,
    label: String(raw.label || `${capitalize(viewFrom)} elevation`),
    sublabel: String(raw.sublabel || `Looking ${capitalize(oppositeOf(viewFrom))}`),
    viewBox: normalizeViewBox(raw.viewBox, ELEVATION_VIEWBOX),
    background: normalizeAssetPath(raw.background, projectId, `elevation ${index + 1}`),
    bottomOffsetPx: normalizeNumber(raw.bottomOffsetPx, SOUTH_ELEVATION_BOTTOM_OFFSET_PX),
    leftOffsetPx: normalizeNumber(raw.leftOffsetPx, SOUTH_ELEVATION_LEFT_OFFSET_PX),
  };
}

function normalizeViewBox(raw, fallback) {
  const width = normalizePositiveNumber(raw?.width, fallback.width);
  const height = normalizePositiveNumber(raw?.height, fallback.height);
  return { width, height };
}

/**
 * Background paths are relative to the project directory. Reject anything that
 * tries to climb out of it or point at another origin.
 */
function normalizeAssetPath(value, projectId, label) {
  const path = String(value || '').trim();
  if (!path) {
    throw new Error(`Project "${projectId}" is missing a background image for its ${label} view`);
  }
  if (path.startsWith('/') || path.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error(
      `Project "${projectId}" ${label} background must be a path relative to the project directory`
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
