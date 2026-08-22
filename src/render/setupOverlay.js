import { createViewTransform } from './viewTransform.js';
import { resolveElevationOrientation } from './elevationOrientation.js';
import { resolvePhotoPlacement } from './photoPlacement.js';
import { createSvgElement } from './svgUtils.js';

/**
 * The guides Setup mode draws over a view, and the gestures that move the
 * photograph underneath them.
 *
 * A view's rectangle is derived from the declared yard, so there is nothing
 * about it to drag: the guides are a fixed target — the yard's own edges, its
 * origin corner, the ground line, and a foot grid — and the *photo* is what
 * moves. That inversion is the whole of this module's job. Drag anywhere to
 * slide the picture until its yard lines up with the drawn one; measure a known
 * length in it to fix its scale.
 *
 * Geometry is separated from drawing so the arithmetic can be tested without a
 * DOM — `buildOverlayGeometry` returns plain numbers, `renderSetupOverlay` turns
 * them into elements. Everything derives from the view's transform, so the
 * guides and the plants they sit over can never disagree about scale.
 */

/** Grid spacing candidates, in feet. The first that is legible on screen wins. */
export const GRID_STEPS_FT = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
const MIN_GRID_SPACING_PX = 45;
const OVERLAY_GROUP_ATTR = 'data-setup-overlay';

export function chooseGridStepFt(pxPerFt) {
  return (
    GRID_STEPS_FT.find((step) => step * pxPerFt >= MIN_GRID_SPACING_PX) ||
    GRID_STEPS_FT[GRID_STEPS_FT.length - 1]
  );
}

/**
 * Where the view's two axes put a given value, in viewBox pixels.
 *
 * A plan view's horizontal axis is yard x and its vertical axis is yard y; an
 * elevation's horizontal axis is whichever yard axis the compass direction puts
 * across the drawing, and its vertical axis is height above ground. Both come
 * out of the transform, so mirrored elevations need no special case here.
 */
function axesFor(transform) {
  if (transform.type === 'plan') {
    return {
      toX: (feet) => transform.planToViewBox({ x: feet, y: 0 }).x,
      toY: (feet) => transform.planToViewBox({ x: 0, y: feet }).y,
      fromX: (px) => transform.viewBoxToPlan({ x: px, y: 0 }).x,
      fromY: (px) => transform.viewBoxToPlan({ x: 0, y: px }).y,
    };
  }
  return {
    toX: (feet) => transform.axisToX(feet),
    toY: (feet) => transform.heightToY(feet),
    fromX: (px) => transform.xToAxis(px),
    fromY: (px) => transform.yToHeight(px),
  };
}

/** Which yard axis runs across an elevation, and how far the yard reaches on it. */
function yardSpanAlong(view, yardFt) {
  if (!yardFt) return null;
  if (view.type === 'plan') return { width: yardFt.width, depth: yardFt.depth };
  try {
    const { axisKey } = resolveElevationOrientation(view.viewFrom);
    return { across: axisKey === 'x' ? yardFt.width : yardFt.depth, axisKey };
  } catch {
    return null;
  }
}

/**
 * @param {object} view a normalized view
 * @param {{ yardFt?: object, views?: Array<object> }} [context] the project the
 *   view belongs to: the yard it draws, and the siblings a plan marks cameras
 *   for. Omit and the yard outline and markers are simply not drawn.
 * @returns {{ transform: object, stepFt: number, gridLines: Array, guides: Array,
 *             cameras: Array, viewers: Array, photo: object|null,
 *             readout: { text: string, x: number, y: number } }}
 */
export function buildOverlayGeometry(view, context = {}) {
  const { yardFt = null, views = [] } = context;
  const transform = createViewTransform(view);
  const { viewBox, extentFt, originFt, pxPerFt, type } = transform;
  const axes = axesFor(transform);
  const stepFt = chooseGridStepFt(pxPerFt);

  // Grid lines land on whole yard feet, not on multiples of the view's corner,
  // so the same 5 ft line appears in the same place in every view.
  const gridLines = [];
  const firstFrom = (start) => Math.ceil(start / stepFt) * stepFt;
  for (let ft = firstFrom(originFt.x); ft <= originFt.x + extentFt.width + 1e-9; ft += stepFt) {
    const x = axes.toX(ft);
    gridLines.push({ orientation: 'vertical', feet: round(ft), x1: x, y1: 0, x2: x, y2: viewBox.height });
  }
  for (let ft = firstFrom(originFt.y); ft <= originFt.y + extentFt.height + 1e-9; ft += stepFt) {
    const y = axes.toY(ft);
    gridLines.push({ orientation: 'horizontal', feet: round(ft), x1: 0, y1: y, x2: viewBox.width, y2: y });
  }

  // The yard itself, and the corner every coordinate is measured from. These
  // are what a photo is dragged onto: fixed marks in a fixed frame, which is
  // exactly what the old draggable extent handles could not be.
  const guides = [];
  const span = yardSpanAlong(view, yardFt);
  if (type === 'elevation') {
    guides.push({
      id: 'ground',
      orientation: 'horizontal',
      x1: 0,
      y1: transform.groundY,
      x2: viewBox.width,
      y2: transform.groundY,
    });
    if (span) {
      guides.push({
        id: 'yard',
        orientation: 'rect',
        x1: Math.min(axes.toX(0), axes.toX(span.across)),
        y1: 0,
        x2: Math.max(axes.toX(0), axes.toX(span.across)),
        y2: transform.groundY,
      });
    }
  } else if (span) {
    guides.push({
      id: 'yard',
      orientation: 'rect',
      x1: axes.toX(0),
      y1: axes.toY(span.depth),
      x2: axes.toX(span.width),
      y2: axes.toY(0),
    });
  }
  guides.push({ id: 'origin', orientation: 'point', x1: axes.toX(0), y1: axes.toY(0) });

  return {
    transform,
    stepFt,
    gridLines,
    guides,
    cameras: buildCameraGeometry(transform, views),
    viewers: buildViewerMarkers(transform, views, yardFt),
    // An uncalibrated photo fills the panel, so its outline IS the panel — drawn
    // anyway, because the moment it is dragged the outline is the only thing
    // saying where the picture went.
    photo: view.background
      ? resolvePhotoPlacement(view).rect || { x: 0, y: 0, width: viewBox.width, height: viewBox.height }
      : null,
    readout: {
      text:
        type === 'elevation'
          ? `${round(extentFt.width)} ft across · ${round(extentFt.height)} ft tall`
          : `${round(extentFt.width)} × ${round(extentFt.height)} ft`,
      // Top-right: the panel's own scale badge occupies the top-left corner.
      x: viewBox.width - 8,
      y: 8,
      anchor: 'end',
    },
  };
}

/**
 * Which side of the yard each elevation is looked at from, drawn on a PLAN.
 *
 * Every elevation now covers the whole yard along its own axis, so a coverage
 * band would shade the entire plan and say nothing. What is still worth seeing
 * — and is the thing the numbers never said out loud — is *which* axis a view
 * runs along and which side its observer stands on. So each elevation gets a
 * bar on the yard edge it is taken from, pointing in.
 *
 * The edge comes from the orientation table rather than from the compass name,
 * for the same reason everything else here does: `north` and `west` are
 * mirrored, and reading the name would put half the bars on the wrong side.
 */
function buildViewerMarkers(transform, views, yardFt) {
  if (transform.type !== 'plan' || !yardFt) return [];
  const markers = [];
  (Array.isArray(views) ? views : []).forEach((sibling) => {
    if (sibling?.type !== 'elevation') return;
    let orientation;
    try {
      orientation = resolveElevationOrientation(sibling.viewFrom);
    } catch {
      return;
    }
    const { depthKey, farIsHigh } = orientation;
    // farIsHigh means the far edge is the high end of the depth axis, so the
    // observer stands at the low end of it.
    const standsAt = farIsHigh ? 0 : depthKey === 'y' ? yardFt.depth : yardFt.width;
    const corner = transform.planToViewBox({ x: 0, y: 0 });
    const opposite = transform.planToViewBox({ x: yardFt.width, y: yardFt.depth });
    const alongY = depthKey === 'y';
    const at = alongY
      ? transform.planToViewBox({ x: 0, y: standsAt }).y
      : transform.planToViewBox({ x: standsAt, y: 0 }).x;
    // Into the yard, away from the observer.
    const inward = farIsHigh ? 1 : -1;
    const flip = alongY ? -1 : 1; // yard y grows up the drawing, x grows right
    markers.push({
      id: sibling.id,
      label: sibling.label || sibling.id,
      viewFrom: sibling.viewFrom,
      orientation: alongY ? 'horizontal' : 'vertical',
      bar: alongY
        ? { x1: Math.min(corner.x, opposite.x), y1: at, x2: Math.max(corner.x, opposite.x), y2: at }
        : { x1: at, y1: Math.min(corner.y, opposite.y), x2: at, y2: Math.max(corner.y, opposite.y) },
      // A short arrow from the bar into the yard, at the middle of the edge.
      arrow: alongY
        ? { x: (corner.x + opposite.x) / 2, y: at, dx: 0, dy: inward * flip * 26 }
        : { x: at, y: (corner.y + opposite.y) / 2, dx: inward * 26, dy: 0 },
      // The label follows the arrow, but a bar on a panel edge puts the arrow's
      // tip near it and the text would run off the drawing. Anchored to the
      // side with room instead, which is always the side the arrow points.
      label_at: alongY
        ? {
            x: (corner.x + opposite.x) / 2,
            y: at + inward * flip * 40,
            anchor: 'middle',
          }
        : {
            x: at + inward * 34,
            y: (corner.y + opposite.y) / 2,
            anchor: inward > 0 ? 'start' : 'end',
          },
    });
  });
  return markers;
}

/**
 * Where each elevation's camera stands, drawn on a PLAN.
 *
 * `viewerAtFt` is a position on an elevation's depth axis — the axis running
 * into the drawing — so there is nowhere in that elevation to draw it: every
 * point of the picture is at every depth. On a plan the same number is a line,
 * and the region on the far side of it is exactly what that elevation refuses
 * to draw. So the cull is shown where it is a shape, not where it was authored.
 *
 * `farIsHigh` says which side is behind the camera: south and west stand at the
 * LOW end of their depth axis and cull below it, north and east stand at the
 * high end and cull above. Taking the side from the orientation table rather
 * than from the compass name is what keeps the mirrored pair from swapping.
 *
 * A camera outside the plan's own rectangle is still honest — the band is
 * clamped to the drawing, so it reads as "all of this" or as nothing at all,
 * which is what it means.
 */
function buildCameraGeometry(transform, siblings) {
  if (transform.type !== 'plan') return [];
  const { viewBox } = transform;
  const cameras = [];
  (Array.isArray(siblings) ? siblings : []).forEach((sibling) => {
    if (sibling?.type !== 'elevation') return;
    if (!Number.isFinite(sibling.viewerAtFt)) return;
    let orientation;
    try {
      orientation = resolveElevationOrientation(sibling.viewFrom);
    } catch {
      return;
    }
    const { depthKey, farIsHigh } = orientation;
    const alongY = depthKey === 'y';
    // Yard y grows up the drawing and yard x grows right, so "behind the
    // camera" is below the line on one axis and left of it on the other.
    const at = alongY
      ? transform.planToViewBox({ x: 0, y: sibling.viewerAtFt }).y
      : transform.planToViewBox({ x: sibling.viewerAtFt, y: 0 }).x;
    const span = alongY ? viewBox.height : viewBox.width;
    const clamp = (px) => Math.min(Math.max(px, 0), span);
    // In viewBox pixels the low end of yard y is the BOTTOM, and the low end of
    // yard x is the left; farIsHigh culls the low end.
    const from = clamp(alongY ? (farIsHigh ? at : 0) : farIsHigh ? 0 : at);
    const to = clamp(alongY ? (farIsHigh ? span : at) : farIsHigh ? at : span);
    const culled = alongY
      ? { x: 0, y: Math.min(from, to), width: viewBox.width, height: Math.abs(to - from) }
      : { x: Math.min(from, to), y: 0, width: Math.abs(to - from), height: viewBox.height };
    // The label belongs on the side the elevation can still see. Put it in the
    // band and it reads as a caption for the yard being hidden.
    const bandLeadsIn = alongY ? culled.y === 0 : culled.x === 0;
    cameras.push({
      id: sibling.id,
      label: sibling.label || sibling.id,
      atFt: sibling.viewerAtFt,
      orientation: alongY ? 'horizontal' : 'vertical',
      line: alongY
        ? { x1: 0, y1: at, x2: viewBox.width, y2: at }
        : { x1: at, y1: 0, x2: at, y2: viewBox.height },
      culled,
      labelAt: alongY
        ? { x: 8, y: bandLeadsIn ? at + 16 : at - 6, anchor: 'start' }
        : { x: bandLeadsIn ? at + 6 : at - 6, y: 16, anchor: bandLeadsIn ? 'start' : 'end' },
    });
  });
  return cameras;
}

/**
 * The rectangle of yard a view's photo covers, defaulting to the whole panel.
 *
 * An uploaded photo starts uncalibrated, which means "fills the panel". Before
 * it can be dragged it has to become a rectangle in feet, and the panel's own
 * rectangle is the one that leaves it exactly where it is drawn.
 */
function photoRectFt(transform, view) {
  if (view.photoFt) {
    return {
      originFt: { ...view.photoFt.originFt },
      extentFt: { ...view.photoFt.extentFt },
    };
  }
  return {
    originFt: { ...transform.originFt },
    extentFt: { ...transform.extentFt },
  };
}

/**
 * Slide the photograph by a drag, in the view's own coordinates.
 *
 * The delta is taken in FEET through the axis inverses rather than in pixels,
 * which is what makes one implementation right for a mirrored elevation: on a
 * north or west view a rightward drag is a *decreasing* axis value, and
 * `xToAxis` already knows that. Same for the vertical, where drawing y grows
 * down and yard y grows up.
 *
 * @returns {{ photoFt: { originFt: object, extentFt: object } } | null}
 */
export function resolvePhotoDrag(view, from, to) {
  if (!view?.background || !from || !to) return null;
  let transform;
  try {
    transform = createViewTransform(view);
  } catch {
    return null;
  }
  const axes = axesFor(transform);
  const dx = axes.fromX(to.x) - axes.fromX(from.x);
  const dy = axes.fromY(to.y) - axes.fromY(from.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;

  const photo = photoRectFt(transform, view);
  return {
    photoFt: {
      originFt: { x: photo.originFt.x + dx, y: photo.originFt.y + dy },
      extentFt: photo.extentFt,
    },
  };
}

/**
 * Measure a two-point drag across the view's background photo.
 *
 * Reported in the view's feet, which is what the reader wants to see while
 * dragging: "this is currently 8.4 ft". Scale is uniform, so a diagonal drag is
 * as valid as an axis-aligned one.
 *
 * @returns {{ pixels: number, feet: number, pxPerFt: number } | null}
 */
export function measureRuler(view, from, to) {
  if (!view || !from || !to) return null;
  const transform = createViewTransform(view);
  const pixels = Math.hypot(Number(to.x) - Number(from.x), Number(to.y) - Number(from.y));
  if (!Number.isFinite(pixels)) return null;
  return { pixels, feet: transform.toFeet(pixels), pxPerFt: transform.pxPerFt };
}

/**
 * A drag shorter than this is a misclick, not a measurement: a 3px span solves
 * to geometry that is perfectly valid and wildly wrong, which is exactly what
 * validation cannot catch.
 *
 * A fixed floor in viewBox space, deliberately not the controllers' hit radius
 * — that one is scaled to screen pixels, and a measurement's usefulness is a
 * property of the photo it is taken from, not of how big the panel happens to
 * be drawn.
 */
export const MIN_RULER_PIXELS = 28;

/**
 * Scale the photograph from a known length measured in it.
 *
 * The drag says "this many feet, at the size the photo is currently drawn" and
 * the typed length says "no, that is this many feet". The ratio is how much the
 * photo has to grow or shrink; the view does not move at all, because the view
 * is the yard and the yard is not what was wrong.
 *
 * The measurement's MIDPOINT is held fixed. Anchoring on a corner of the photo
 * would slide whatever the user just pointed at out from under the pointer,
 * which reads as the tool ignoring the drag; holding the thing being measured
 * makes the correction look like what it is.
 *
 * @param {object} view a normalized view
 * @param {{x: number, y: number}} from viewBox point
 * @param {{x: number, y: number}} to viewBox point
 * @param {number} lengthFt what the measured span really is
 * @returns {{ photoFt: { originFt: object, extentFt: object } } | null}
 */
export function resolveRulerCalibration(view, from, to, lengthFt) {
  const measured = measureRuler(view, from, to);
  if (!measured || measured.pixels < MIN_RULER_PIXELS) return null;
  const feet = Number(lengthFt);
  if (!Number.isFinite(feet) || feet <= 0) return null;
  if (!view.background) return null;

  const transform = createViewTransform(view);
  const axes = axesFor(transform);
  const scale = feet / measured.feet;
  const photo = photoRectFt(transform, view);

  // The held point, in the view's own feet.
  const anchor = {
    x: axes.fromX((from.x + to.x) / 2),
    y: axes.fromY((from.y + to.y) / 2),
  };
  return {
    photoFt: {
      originFt: {
        x: anchor.x - (anchor.x - photo.originFt.x) * scale,
        y: anchor.y - (anchor.y - photo.originFt.y) * scale,
      },
      extentFt: {
        width: photo.extentFt.width * scale,
        height: photo.extentFt.height * scale,
      },
    },
  };
}

/** Remove any overlay previously drawn into this SVG. */
export function clearSetupOverlay(svg) {
  if (!svg) return;
  svg.querySelectorAll(`g[${OVERLAY_GROUP_ATTR}]`).forEach((node) => node.parentNode?.removeChild(node));
}

/**
 * Draw the guides into a view's SVG, on top of the plants. Called after every
 * render because rendering clears the SVG.
 *
 * `interactive` is what separates the view being edited from its neighbours.
 * The grid is drawn on whole yard feet precisely so the same 5 ft line lands in
 * the same place in every view — which is only useful if you can SEE it in
 * more than one at a time, so every view draws grid, guides, and readout. Only
 * the selected one shows the photo's own outline, because only there can it be
 * dragged.
 *
 * @param {SVGElement} svg
 * @param {object} view a normalized view
 * @param {{from: object, to: object}|null} [ruler]
 * @param {{ interactive?: boolean, yardFt?: object, views?: Array<object>, highlightId?: string }} [options]
 */
export function renderSetupOverlay(
  svg,
  view,
  ruler,
  { interactive = true, yardFt = null, views = [], highlightId = '' } = {}
) {
  if (!svg || !view) return null;
  clearSetupOverlay(svg);
  const geometry = buildOverlayGeometry(view, { yardFt, views });
  const group = createSvgElement('g', {
    [OVERLAY_GROUP_ATTR]: geometry.transform.id,
    'pointer-events': 'none',
    'data-setup-interactive': interactive ? 'true' : 'false',
    // Reference views recede rather than disappear: still readable against a
    // photo, never mistaken for the one being edited.
    opacity: interactive ? 1 : 0.55,
  });

  // The photo's own edge, on the view being edited. Without it a picture that
  // is smaller than the panel just looks like a panel that failed to load, and
  // one that is larger gives no clue how much is off-screen.
  if (interactive && geometry.photo) {
    group.appendChild(
      createSvgElement('rect', {
        x: geometry.photo.x,
        y: geometry.photo.y,
        width: geometry.photo.width,
        height: geometry.photo.height,
        fill: 'none',
        stroke: '#c1121f',
        'stroke-width': 1.5,
        'stroke-dasharray': '4 4',
        'stroke-opacity': 0.7,
        'data-setup-photo': '',
      })
    );
  }

  geometry.gridLines.forEach((line) => {
    group.appendChild(
      createSvgElement('line', {
        x1: line.x1,
        y1: line.y1,
        x2: line.x2,
        y2: line.y2,
        stroke: '#1b74d8',
        'stroke-width': line.feet === 0 ? 1.6 : 0.6,
        'stroke-opacity': line.feet === 0 ? 0.55 : 0.25,
        'data-setup-grid': line.orientation,
      })
    );
  });

  geometry.guides.forEach((guide) => {
    if (guide.orientation === 'rect') {
      group.appendChild(
        createSvgElement('rect', {
          x: Math.min(guide.x1, guide.x2),
          y: Math.min(guide.y1, guide.y2),
          width: Math.abs(guide.x2 - guide.x1),
          height: Math.abs(guide.y2 - guide.y1),
          fill: 'none',
          stroke: '#ef7d1a',
          'stroke-width': 2,
          'stroke-dasharray': '8 5',
          'data-setup-guide': guide.id,
        })
      );
      return;
    }
    if (guide.orientation === 'point') {
      // The yard's origin, named on the drawing so nobody has to work out
      // which corner the coordinates count from.
      group.appendChild(
        createSvgElement('circle', {
          cx: guide.x1,
          cy: guide.y1,
          r: 5,
          fill: '#ef7d1a',
          stroke: '#fff',
          'stroke-width': 2,
          'data-setup-guide': guide.id,
        })
      );
      const text = createSvgElement('text', {
        x: guide.x1 + 9,
        y: guide.y1 - 9,
        'font-size': 13,
        'font-weight': 700,
        fill: '#ef7d1a',
        stroke: '#fff',
        'stroke-width': 3,
        'paint-order': 'stroke fill',
        'data-setup-origin-label': '',
      });
      text.textContent = '0, 0';
      group.appendChild(text);
      return;
    }
    group.appendChild(
      createSvgElement('line', {
        x1: guide.x1,
        y1: guide.y1,
        x2: guide.x2,
        y2: guide.y2,
        stroke: '#ef7d1a',
        'stroke-width': 2.5,
        'data-setup-guide': guide.id,
      })
    );
  });

  geometry.viewers.forEach((marker) => {
    const emphasised = marker.id === highlightId;
    group.appendChild(
      createSvgElement('line', {
        x1: marker.bar.x1,
        y1: marker.bar.y1,
        x2: marker.bar.x2,
        y2: marker.bar.y2,
        stroke: '#2f7a8c',
        'stroke-width': emphasised ? 6 : 4,
        'stroke-opacity': emphasised ? 0.95 : 0.5,
        'stroke-linecap': 'round',
        'data-setup-viewer': marker.id,
      })
    );
    group.appendChild(
      createSvgElement('line', {
        x1: marker.arrow.x,
        y1: marker.arrow.y,
        x2: marker.arrow.x + marker.arrow.dx,
        y2: marker.arrow.y + marker.arrow.dy,
        stroke: '#2f7a8c',
        'stroke-width': emphasised ? 3 : 2,
        'stroke-opacity': emphasised ? 0.95 : 0.5,
        'data-setup-viewer-arrow': marker.id,
      })
    );
    const text = createSvgElement('text', {
      x: marker.label_at.x,
      y: marker.label_at.y,
      'text-anchor': marker.label_at.anchor,
      'font-size': 13,
      'font-weight': 700,
      fill: '#2f7a8c',
      stroke: '#fff',
      'stroke-width': 3,
      'paint-order': 'stroke fill',
      'data-setup-viewer-label': marker.id,
    });
    text.textContent = `${marker.label} looks this way`;
    group.appendChild(text);
  });

  // Cameras after the guides so the band tints the grid rather than the reverse.
  geometry.cameras.forEach((camera) => {
    const emphasised = camera.id === highlightId;
    if (camera.culled.width > 0 && camera.culled.height > 0) {
      group.appendChild(
        createSvgElement('rect', {
          x: camera.culled.x,
          y: camera.culled.y,
          width: camera.culled.width,
          height: camera.culled.height,
          fill: '#5b3fa0',
          'fill-opacity': emphasised ? 0.22 : 0.1,
          'data-setup-culled': camera.id,
        })
      );
    }
    group.appendChild(
      createSvgElement('line', {
        x1: camera.line.x1,
        y1: camera.line.y1,
        x2: camera.line.x2,
        y2: camera.line.y2,
        stroke: '#5b3fa0',
        'stroke-width': emphasised ? 3 : 2,
        'stroke-dasharray': '2 6',
        'stroke-linecap': 'round',
        'data-setup-camera': camera.id,
      })
    );
    const text = createSvgElement('text', {
      x: camera.labelAt.x,
      y: camera.labelAt.y,
      'text-anchor': camera.labelAt.anchor,
      'font-size': 13,
      'font-weight': 700,
      fill: '#5b3fa0',
      stroke: '#fff',
      'stroke-width': 3,
      'paint-order': 'stroke fill',
      'data-setup-camera-label': camera.id,
    });
    text.textContent = `${camera.label} camera · ${round(camera.atFt)} ft`;
    group.appendChild(text);
  });

  const label = createSvgElement('text', {
    x: geometry.readout.x,
    y: geometry.readout.y,
    'text-anchor': geometry.readout.anchor || 'start',
    'dominant-baseline': 'hanging',
    'font-size': 16,
    'font-weight': 700,
    fill: '#1b1b1b',
    stroke: '#fff',
    'stroke-width': 3,
    'paint-order': 'stroke fill',
    'data-setup-readout': '',
  });
  label.textContent = geometry.readout.text;
  group.appendChild(label);

  if (ruler?.from && ruler?.to) appendRuler(group, view, ruler);

  svg.appendChild(group);
  return group;
}

/**
 * The measuring segment, drawn while the drag is live and left in place after
 * it so the user can see what they are typing a length for.
 */
function appendRuler(group, view, ruler) {
  const measured = measureRuler(view, ruler.from, ruler.to);
  if (!measured) return;
  group.appendChild(
    createSvgElement('line', {
      x1: ruler.from.x,
      y1: ruler.from.y,
      x2: ruler.to.x,
      y2: ruler.to.y,
      stroke: '#c1121f',
      'stroke-width': 3,
      'stroke-linecap': 'round',
      'data-setup-ruler': '',
    })
  );
  [ruler.from, ruler.to].forEach((end) => {
    group.appendChild(
      createSvgElement('circle', {
        cx: end.x,
        cy: end.y,
        r: 5,
        fill: '#fff',
        stroke: '#c1121f',
        'stroke-width': 2.5,
        'data-setup-ruler-end': '',
      })
    );
  });

  // Above the midpoint, so the segment itself is never covered by its label.
  const text = createSvgElement('text', {
    x: (ruler.from.x + ruler.to.x) / 2,
    y: (ruler.from.y + ruler.to.y) / 2 - 10,
    'text-anchor': 'middle',
    'font-size': 16,
    'font-weight': 700,
    fill: '#c1121f',
    stroke: '#fff',
    'stroke-width': 3,
    'paint-order': 'stroke fill',
    'data-setup-ruler-readout': '',
  });
  text.textContent = `${round(measured.feet)} ft at this scale`;
  group.appendChild(text);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
