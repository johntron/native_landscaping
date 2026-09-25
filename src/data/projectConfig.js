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

/**
 * Where the browser loads a yard from (nl-3s5.3). Yards live in app.db on the
 * server, scoped to the signed-in owner, so these are API routes rather than
 * files under projects/: the caller's yard list, one yard's config, and one
 * of its photos. Relative, like every other fetch here, so they resolve
 * against document.baseURI.
 */
export const PROJECT_INDEX_PATH = 'api/projects';

/**
 * Project ids become path segments on both the client and the server, so keep
 * them to a conservative slug shape — no dots, no separators, nothing that could
 * escape the projects directory.
 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Same shape featureConfig.js validates style colours against. */
const COLOR_PATTERN = /^(#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]+)$/;

/**
 * What the ecology analysis needs to know about the ground, and the closed
 * vocabularies the catalog already uses. `high` water is here even though no
 * plants.csv row uses it yet: the scale is a property of the world, not of the
 * current 48 rows, and rule 8 has to be able to say "this plant wants more water
 * than the site gives" in both directions.
 */
export const SITE_VOCABULARY = Object.freeze({
  sun: Object.freeze(['shade', 'part-sun', 'full-sun']),
  water: Object.freeze(['low', 'medium', 'high']),
  soil: Object.freeze(['clay', 'clay-loam', 'loamy', 'sandy']),
});

export function isValidProjectId(id) {
  return typeof id === 'string' && id.length <= 64 && PROJECT_ID_PATTERN.test(id);
}

/**
 * Normalize the caller's yard list (GET /api/projects) into a predictable shape.
 * An empty list is legitimate — a person who has not made a yard yet — and
 * comes back with a null default rather than an error.
 * @param {any} raw
 * @returns {{ defaultProject: string | null, projects: Array<{ id: string, name: string, readOnly?: true }> }}
 */
export function normalizeProjectIndex(raw) {
  const entries = Array.isArray(raw?.projects) ? raw.projects : [];
  const projects = entries
    .map((entry) => {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (!isValidProjectId(id)) return null;
      const name = (typeof entry === 'object' && entry?.name) || id;
      // The shared example yard (nl-3s5.24) comes marked read-only; the flag
      // is kept only where set, so an ordinary entry stays { id, name }.
      return typeof entry === 'object' && entry?.readOnly === true
        ? { id, name: String(name), readOnly: true }
        : { id, name: String(name) };
    })
    .filter(Boolean);

  if (!projects.length) return { defaultProject: null, projects };

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
    ...normalizeEcoregion(raw.ecoregion),
    ...normalizeSite(raw.site, id),
    ...normalizePlace(raw.place),
    views,
  };
}

/**
 * The EPA Level I ecoregion the yard sits in — Dallas and the Blackland Prairie
 * are 9, Great Plains. Optional: a project that never declares one gets
 * "not declared" on the keystone-genus rules rather than an error, because the
 * keystone lists are per ecoregion and guessing one would grade the design
 * against the wrong continent.
 */
function normalizeEcoregion(raw) {
  const value = String(raw ?? '').trim();
  return value ? { ecoregion: value } : {};
}

/**
 * What the ground actually offers, as opposed to what each plant asks for.
 *
 * Also optional, and partial is allowed: a project that declares soil but not
 * sun gets soil checked and sun reported as undeclared. An unknown value is a
 * hand-edit mistake worth failing on — silently dropping it would grade the
 * design against a site condition the file does not describe.
 */
function normalizeSite(raw, projectId) {
  if (!raw || typeof raw !== 'object') return {};
  const site = {};
  Object.keys(SITE_VOCABULARY).forEach((key) => {
    const value = String(raw[key] ?? '').trim().toLowerCase();
    if (!value) return;
    if (!SITE_VOCABULARY[key].includes(value)) {
      throw new Error(
        `Project "${projectId}" site.${key} "${raw[key]}" is not one of ${SITE_VOCABULARY[key].join(', ')}`
      );
    }
    site[key] = value;
  });
  return Object.keys(site).length ? { site } : {};
}

/**
 * A short label identifying which locality's nearby-fauna records
 * (`ecology/nearby-fauna.csv`) apply to this project — e.g. "home". The exact
 * address or coordinates behind that label are never committed to this
 * (public) repo; they live in app.db (`projects.location_json`, nl-3s5.3), read
 * by the offline `tools/` fetch scripts (tools/projectSite.mjs) and, as bare
 * lat/lng for the owner, by /api/ecosystem. Two projects on the same property (backyard, walkway) share one
 * `place` and therefore one fetch.
 */
function normalizePlace(raw) {
  const value = String(raw ?? '').trim();
  return value ? { place: value } : {};
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
    ...(background && raw.photoHidden ? { photoHidden: true } : {}),
    ...normalizeViewerAt(type, raw.viewerAtFt),
    ...normalizeOptionalColor(raw.skyColor, projectId, id, 'skyColor'),
    ...normalizeOptionalColor(raw.groundColor, projectId, id, 'groundColor'),
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
 * height, and said nothing about depth — which put the camera at infinity and
 * made everything in the yard, in every direction, in front of it. A wall
 * standing between the photographer and the bed is then drawn over the bed in
 * the view taken from the other side, which is exactly backwards: from there
 * the wall is behind the camera.
 *
 * **Absent means cull nothing**, and that is deliberate: the permissive default
 * leaves a project that never mentioned a camera drawing exactly what it drew
 * before. This is the opposite of `normalizeFeatures`, which refuses a missing
 * height rather than defaulting it — there a default HIDES a shape, here a
 * default would hide one.
 *
 * It is tempting to fill this in so every elevation has a camera to drag on the
 * plan, and that was tried: `defaultViewerAt` puts one half a margin outside
 * the yard, which culls no PLANT because plants are clamped to the yard. It
 * culls features, which are not — example-frontyard's `west` elevation lost a
 * bed the moment it acquired a camera it had never declared. So the default is
 * a drawing concern and lives in the overlay, which shows an undeclared camera
 * at that spot without the band behind it; the first drag is what commits one.
 *
 * Zero is a real position, so the test is finiteness, never truthiness.
 */
function normalizeViewerAt(type, raw) {
  if (type !== 'elevation' || raw === undefined || raw === null || raw === '') return {};
  const feet = Number(raw);
  return Number.isFinite(feet) ? { viewerAtFt: feet } : {};
}

/**
 * Where an elevation's camera is SHOWN when it declares none: half a margin
 * outside the yard edge it is taken from, which is where a person stands to
 * photograph their yard.
 *
 * Presentation, not model. Writing it into the view would change what the
 * drawing culls; see normalizeViewerAt.
 */
export function defaultViewerAt(viewFrom, layout) {
  const { yardFt, paddingFt } = layout;
  const back = paddingFt / 2;
  let orientation;
  try {
    orientation = resolveElevationOrientation(viewFrom);
  } catch {
    return -back;
  }
  // farIsHigh puts the far edge at the high end of the depth axis, so the
  // observer stands below zero; its opposite stands past the far side.
  if (orientation.farIsHigh) return -back;
  return (orientation.depthKey === 'y' ? yardFt.depth : yardFt.width) + back;
}

/**
 * A view's sky/ground fill, or nothing — a view that never declares one renders
 * exactly as it does today. Same colour grammar as a feature's style: hex or a
 * CSS colour name.
 */
function normalizeOptionalColor(value, projectId, viewId, key) {
  if (value === undefined || value === null || value === '') return {};
  const color = String(value).trim().toLowerCase();
  if (!COLOR_PATTERN.test(color)) {
    throw new Error(
      `Project "${projectId}" view "${viewId}" ${key} "${value}" is not a hex colour, a colour name, or none`
    );
  }
  return { [key]: color };
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
    // serializeProjectConfig WHITELISTS fields, so anything added to the
    // normalizer and not here survives in memory and vanishes the first time
    // Setup mode saves — the user's declaration gone with no error.
    ...(config.ecoregion ? { ecoregion: config.ecoregion } : {}),
    ...(config.site ? { site: { ...config.site } } : {}),
    ...(config.place ? { place: config.place } : {}),
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
      if (view.photoHidden) out.photoHidden = true;
      if (view.viewerAtFt !== undefined) out.viewerAtFt = view.viewerAtFt;
      if (view.skyColor) out.skyColor = view.skyColor;
      if (view.groundColor) out.groundColor = view.groundColor;
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

/**
 * The URL of a photo a view's `background` names (a path relative to the yard,
 * e.g. "img/plan-130d05047b7d.webp"). Photos are served by the owner-checked
 * GET /api/project-photo, never as static files.
 */
export function projectAssetPath(projectId, relativePath) {
  // Slashes left readable ("path=img/top.webp"): they are legal in a query
  // value, and a URL that still names the file is easier to debug.
  const photo = encodeURIComponent(relativePath).replace(/%2F/gi, '/');
  return `api/project-photo?project=${encodeURIComponent(projectId)}&path=${photo}`;
}

export function projectConfigPath(projectId) {
  return `api/project?project=${encodeURIComponent(projectId)}`;
}

/**
 * Fetch and normalize the caller's yard list. Kept fetch-injectable for tests.
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
    const error = new Error(
      response.status === 401 ? 'Sign in to see your yards' : `Failed to load ${path} (${response.status})`
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}
