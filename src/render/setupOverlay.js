import { createViewTransform } from './viewTransform.js';
import { resolveElevationOrientation } from './elevationOrientation.js';
import { defaultViewerAt } from '../data/projectConfig.js';
import { createSvgElement } from './svgUtils.js';

/**
 * The guides Setup mode draws over a view, and the one thing in them that moves.
 *
 * A view's rectangle is derived from the declared yard, so almost everything
 * here is a fixed reference rather than a control: the yard's own edges, its
 * origin corner, the ground line, and a foot grid on whole yard feet. Setup is
 * for saying how big the yard is and which views look at it, and those marks
 * are what makes that legible.
 *
 * The exception is the **camera**. Where an elevation is looked at from is the
 * one per-view number that is not derivable, and it is a position on the plan,
 * so it is drawn there and dragged there. Camera, direction arrow, and the band
 * of yard behind it are ONE object: they were two marks for a while, a "looks
 * this way" bar on the yard edge and a dashed line somewhere else, which is the
 * same fact drawn twice in two places that could disagree.
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
  const { yardFt = null, paddingFt = 0, views = [] } = context;
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

  // The yard itself, and the corner every coordinate is measured from. Fixed
  // marks in a fixed frame — the drawing is the yard, and the yard is what the
  // author is here to state.
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
    cameras: buildCameraGeometry(transform, views, yardFt, paddingFt),
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
 * Where each elevation is looked at from, drawn on a PLAN as one object.
 *
 * `viewerAtFt` is a position on an elevation's DEPTH axis — the axis running
 * into that drawing — so there is nowhere in the elevation itself to show it:
 * every point of the picture is at every depth. On a plan the same number is a
 * line, the direction of view is an arrow off that line, and the ground behind
 * it is the region the elevation refuses to draw. All three are the same fact,
 * so they are one mark that moves together.
 *
 * `farIsHigh` says which side is behind the camera: south and west stand at the
 * LOW end of their depth axis and look up it, north and east stand at the high
 * end and look down it. Taking the side from the orientation table rather than
 * from the compass name is what keeps the mirrored pair from swapping.
 *
 * A camera outside the plan's own rectangle is still honest — the band is
 * clamped to the drawing, so it reads as "all of this" or as nothing at all,
 * which is what it means.
 */
function buildCameraGeometry(transform, siblings, yardFt, paddingFt) {
  if (transform.type !== 'plan' || !yardFt) return [];
  const { viewBox } = transform;
  const cameras = [];
  (Array.isArray(siblings) ? siblings : []).forEach((sibling) => {
    if (sibling?.type !== 'elevation') return;
    let orientation;
    try {
      orientation = resolveElevationOrientation(sibling.viewFrom);
    } catch {
      return;
    }
    // An elevation that declares no camera still gets one drawn, so there is
    // something to pick up — but it is NOT culling, and the band below is what
    // says so. The first drag commits a real position.
    const declared = Number.isFinite(sibling.viewerAtFt);
    const atFt = declared ? sibling.viewerAtFt : defaultViewerAt(sibling.viewFrom, { yardFt, paddingFt });
    const { depthKey, farIsHigh } = orientation;
    const alongY = depthKey === 'y';
    // Yard y grows up the drawing and yard x grows right, so "behind the
    // camera" is below the line on one axis and left of it on the other.
    const at = alongY
      ? transform.planToViewBox({ x: 0, y: atFt }).y
      : transform.planToViewBox({ x: atFt, y: 0 }).x;
    const span = alongY ? viewBox.height : viewBox.width;
    const clamp = (px) => Math.min(Math.max(px, 0), span);
    // In viewBox pixels the low end of yard y is the BOTTOM, and the low end of
    // yard x is the left; farIsHigh culls the low end.
    const from = clamp(alongY ? (farIsHigh ? at : 0) : farIsHigh ? 0 : at);
    const to = clamp(alongY ? (farIsHigh ? span : at) : farIsHigh ? at : span);
    const culled = alongY
      ? { x: 0, y: Math.min(from, to), width: viewBox.width, height: Math.abs(to - from) }
      : { x: Math.min(from, to), y: 0, width: Math.abs(to - from), height: viewBox.height };

    // Which way the arrow points: away from the culled band, into the yard the
    // elevation can see. In drawing pixels, not in feet — the y flip is already
    // baked into `at`, so comparing pixels needs no second mirror case.
    const bandLeadsIn = alongY ? culled.y === 0 : culled.x === 0;
    const towards = bandLeadsIn ? 1 : -1;
    // Along the line, the arrow sits at the middle of the yard it looks at, so
    // it lands on the picture rather than in a corner.
    const middle = alongY
      ? transform.planToViewBox({ x: (yardFt?.width ?? 0) / 2, y: 0 }).x
      : transform.planToViewBox({ x: 0, y: (yardFt?.depth ?? 0) / 2 }).y;

    cameras.push({
      id: sibling.id,
      label: sibling.label || sibling.id,
      atFt,
      declared,
      orientation: alongY ? 'horizontal' : 'vertical',
      // The axis the drag moves along — the other one is fixed by the line.
      axis: alongY ? 'y' : 'x',
      at,
      line: alongY
        ? { x1: 0, y1: at, x2: viewBox.width, y2: at }
        : { x1: at, y1: 0, x2: at, y2: viewBox.height },
      culled,
      // Grown off the line itself, so there is one thing to grab and one thing
      // that moves.
      arrow: alongY
        ? { x: middle, y: at, dx: 0, dy: towards * ARROW_PX }
        : { x: at, y: middle, dx: towards * ARROW_PX, dy: 0 },
      labelAt: alongY
        ? { x: 8, y: bandLeadsIn ? at + 16 : at - 6, anchor: 'start' }
        : { x: bandLeadsIn ? at + 6 : at - 6, y: 16, anchor: bandLeadsIn ? 'start' : 'end' },
    });
  });
  return cameras;
}

/** How far the direction arrow reaches off the camera line, in viewBox pixels. */
const ARROW_PX = 34;

/**
 * Move one elevation's camera to a dragged point, in yard feet.
 *
 * Returned as a patch for the SIBLING view, not for the plan being dragged in —
 * which is the whole oddity of this control and the reason it carries the id.
 *
 * @returns {{ id: string, viewerAtFt: number } | null}
 */
export function resolveCameraDrag(view, cameraId, point, siblings) {
  if (view?.type !== 'plan') return null;
  const sibling = (Array.isArray(siblings) ? siblings : []).find((v) => v?.id === cameraId);
  if (!sibling) return null;
  let orientation;
  try {
    orientation = resolveElevationOrientation(sibling.viewFrom);
  } catch {
    return null;
  }
  const transform = createViewTransform(view);
  const feet = transform.viewBoxToPlan(point);
  const viewerAtFt = orientation.depthKey === 'y' ? feet.y : feet.x;
  if (!Number.isFinite(viewerAtFt)) return null;
  return { id: cameraId, viewerAtFt: round(viewerAtFt) };
}

/**
 * The camera line nearest a point, within `radius` viewBox pixels.
 *
 * A line is grabbable anywhere along it, so only the axis it moves counts
 * toward the distance — the same rule the old guide handles used, and the
 * reason a camera can be caught at the edge of the drawing rather than only
 * where its label happens to be.
 */
export function pickCamera(geometry, point, radius) {
  let best = null;
  (geometry?.cameras || []).forEach((camera) => {
    const distance = Math.abs((camera.axis === 'y' ? point.y : point.x) - camera.at);
    if (distance <= radius && (!best || distance < best.distance)) best = { camera, distance };
  });
  return best ? best.camera : null;
}

/*
 * Positioning the photograph — dragging it, and scaling it from a measured
 * length — lived here and has been taken out for now.
 *
 * Both wrote `photoFt` starting from the PANEL's rectangle when a photo had no
 * placement yet, and the panel is the yard's shape, not the picture's. So the
 * first gesture on any photo stretched it: 4% on backyard's 800x600 into a
 * 33.6 x 26.2 ft panel, 39% on a 16:9 upload. Placements already in a file
 * still render (src/render/photoPlacement.js); there is simply no longer a way
 * to create a bad one by hand.
 *
 * The ruler went with them rather than surviving alone: under a declared yard
 * it no longer solves the view's extent — the yard does that — so all it had
 * left to scale was the photo, by the same stretching arithmetic.
 *
 * What the replacement needs is the image's intrinsic aspect, which nothing
 * currently loads; see nl-0di.
 */

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
 * @param {{ interactive?: boolean, yardFt?: object, views?: Array<object>, highlightId?: string }} [options]
 */
export function renderSetupOverlay(
  svg,
  view,
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

  // Cameras after the guides so the band tints the grid rather than the reverse.
  geometry.cameras.forEach((camera) => {
    const emphasised = camera.id === highlightId;
    // No band until a camera is real: an undeclared one culls nothing, and
    // tinting the yard behind it would claim otherwise.
    if (camera.declared && camera.culled.width > 0 && camera.culled.height > 0) {
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
    // Grown off the line, not placed near it: one object, so what you grab and
    // what tells you which way it faces cannot end up disagreeing.
    const tip = { x: camera.arrow.x + camera.arrow.dx, y: camera.arrow.y + camera.arrow.dy };
    group.appendChild(
      createSvgElement('line', {
        x1: camera.arrow.x,
        y1: camera.arrow.y,
        x2: tip.x,
        y2: tip.y,
        stroke: '#5b3fa0',
        'stroke-width': emphasised ? 3 : 2,
        'data-setup-camera-arrow': camera.id,
      })
    );
    group.appendChild(
      createSvgElement('polygon', {
        points: arrowHead(camera.arrow, tip),
        fill: '#5b3fa0',
        'fill-opacity': emphasised ? 1 : 0.7,
        'data-setup-camera-head': camera.id,
      })
    );
    if (interactive) {
      group.appendChild(
        createSvgElement('circle', {
          cx: camera.axis === 'y' ? camera.arrow.x : camera.at,
          cy: camera.axis === 'y' ? camera.at : camera.arrow.y,
          r: 7,
          fill: '#fff',
          stroke: '#5b3fa0',
          'stroke-width': 2.5,
          'data-setup-camera-grip': camera.id,
        })
      );
    }
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
    text.textContent = camera.declared
      ? `${camera.label} camera · ${round(camera.atFt)} ft`
      : `${camera.label} camera · not set`;
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

  svg.appendChild(group);
  return group;
}

/** A solid triangle at the arrow's tip, sized to the shaft it sits on. */
function arrowHead(arrow, tip) {
  const size = 8;
  // One of dx/dy is always zero — the arrow runs along the depth axis — so the
  // perpendicular is the other one, and no trigonometry is needed.
  const alongY = arrow.dx === 0;
  const sign = alongY ? Math.sign(arrow.dy) : Math.sign(arrow.dx);
  return alongY
    ? `${tip.x},${tip.y} ${tip.x - size},${tip.y - sign * size} ${tip.x + size},${tip.y - sign * size}`
    : `${tip.x},${tip.y} ${tip.x - sign * size},${tip.y - size} ${tip.x - sign * size},${tip.y + size}`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
