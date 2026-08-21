import {
  elevationAxisToViewBoxX,
  resolveElevationOrientation,
} from './elevationOrientation.js';

/**
 * The one place feet become pixels.
 *
 * A view is authored in feet: `extentFt` says how much yard it covers and
 * `originFt` says which yard coordinate sits at the viewBox's bottom-left
 * corner. The pixel scale falls out of those two — `pxPerFt` is derived, never
 * authored — so a calibration tool can move a view over its background photo
 * without ever touching a pixel offset.
 *
 * Renderers, drag controllers, and the setup overlay all build their geometry
 * here so they cannot drift apart. The compass mirror/offset table stays in
 * `elevationOrientation.js`; this module wraps it rather than restating it.
 */

/** Relative slack allowed between the width-derived and height-derived scales. */
const ASPECT_TOLERANCE = 1e-3;

/**
 * @typedef {Object} View
 * @property {string} [id]
 * @property {'plan'|'elevation'} type
 * @property {string} [viewFrom] required for elevations; one of VIEW_FROM_DIRECTIONS
 * @property {{ width: number, height: number }} viewBox
 * @property {{ width: number, height: number }} extentFt
 * @property {{ x: number, y: number }} originFt
 */

/**
 * Build the coordinate transform for one view.
 *
 * For a **plan** view `originFt` is the yard coordinate at the bottom-left
 * corner, and `planToViewBox` / `viewBoxToPlan` are the working pair.
 *
 * For an **elevation** `originFt.x` is the horizontal-axis value at the view's
 * *near* edge — the left edge on south/east, the right edge on the mirrored
 * north/west — and `originFt.y` is the ground height at the bottom edge, so a
 * negative value pushes the ground line up into the drawing. `axisToX` /
 * `xToAxis` are the working pair, and `groundY` is the pixel row where height
 * zero lands.
 *
 * @param {View} view
 * @returns {{
 *   view: View, id: string, type: 'plan'|'elevation',
 *   viewBox: { width: number, height: number },
 *   extentFt: { width: number, height: number },
 *   originFt: { x: number, y: number },
 *   viewerAtFt: number|undefined,
 *   pxPerFt: number,
 *   toPx: (feet: number) => number,
 *   toFeet: (px: number) => number,
 *   planToViewBox: (point: { x: number, y: number }) => { x: number, y: number },
 *   viewBoxToPlan: (point: { x: number, y: number }) => { x: number, y: number },
 *   axisToX: (axisFeet: number) => number,
 *   xToAxis: (px: number) => number,
 *   heightToY: (heightFt: number) => number,
 *   yToHeight: (px: number) => number,
 *   groundY: number,
 *   orientation: ReturnType<typeof resolveElevationOrientation> | null,
 * }}
 */
export function createViewTransform(view) {
  if (!view || typeof view !== 'object') {
    throw new Error('createViewTransform requires a view object');
  }
  const id = view.id ? String(view.id) : '(unnamed view)';
  const type = String(view.type || '');
  if (type !== 'plan' && type !== 'elevation') {
    throw new Error(`View "${id}" has an unknown type "${view.type}" (expected plan or elevation)`);
  }

  const viewBox = readSize(view.viewBox, `View "${id}" viewBox`);
  const extentFt = readSize(view.extentFt, `View "${id}" extentFt`);
  const originFt = readPoint(view.originFt);

  // Width fixes the scale; height only has to agree with it. Two independent
  // scales would mean a non-uniformly stretched view, which nothing downstream
  // can render honestly.
  const pxPerFt = viewBox.width / extentFt.width;
  const pxPerFtFromHeight = viewBox.height / extentFt.height;
  if (Math.abs(pxPerFtFromHeight - pxPerFt) > pxPerFt * ASPECT_TOLERANCE) {
    throw new Error(
      `View "${id}" is non-uniformly scaled: ${viewBox.width}x${viewBox.height}px over ` +
        `${extentFt.width}x${extentFt.height}ft gives ${pxPerFt} px/ft across and ` +
        `${pxPerFtFromHeight} px/ft down`
    );
  }

  const toPx = (feet) => feet * pxPerFt;
  const toFeet = (px) => px / pxPerFt;

  const orientation = type === 'elevation' ? resolveElevationOrientation(view.viewFrom) : null;
  // The mirror table wants a pixel inset from the near edge, which is exactly
  // what a negative origin means once scaled.
  const leftOffsetPx = -originFt.x * pxPerFt;

  const requirePlan = () => {
    if (type !== 'plan') {
      throw new Error(`View "${id}" is an elevation; use axisToX/xToAxis, not the plan mapping`);
    }
  };
  const requireElevation = () => {
    if (type !== 'elevation') {
      throw new Error(`View "${id}" is a plan; use planToViewBox/viewBoxToPlan, not the axis mapping`);
    }
  };

  function heightToY(heightFt) {
    return viewBox.height - toPx(heightFt - originFt.y);
  }

  function yToHeight(px) {
    return toFeet(viewBox.height - px) + originFt.y;
  }

  return {
    view,
    id,
    type,
    viewBox,
    extentFt,
    originFt,
    pxPerFt,
    // Where the viewer stands along the depth axis, in yard feet, or undefined
    // when the elevation does not say — which means "everything is in front of
    // the camera", the behaviour every project had before the field existed.
    viewerAtFt: type === 'elevation' && Number.isFinite(view.viewerAtFt) ? view.viewerAtFt : undefined,
    toPx,
    toFeet,

    planToViewBox({ x, y }) {
      requirePlan();
      return { x: toPx(x - originFt.x), y: heightToY(y) };
    },

    viewBoxToPlan({ x, y }) {
      requirePlan();
      return { x: toFeet(x) + originFt.x, y: yToHeight(y) };
    },

    axisToX(axisFeet) {
      requireElevation();
      return elevationAxisToViewBoxX(axisFeet, toPx, {
        mirrored: orientation.mirrored,
        leftOffsetPx,
        viewBoxWidth: viewBox.width,
      });
    },

    xToAxis(px) {
      requireElevation();
      const unmirrored = orientation.mirrored ? viewBox.width - px : px;
      return toFeet(unmirrored - leftOffsetPx);
    },

    heightToY,
    yToHeight,
    groundY: heightToY(0),
    orientation,
  };
}

function readSize(raw, label) {
  const width = Number(raw?.width);
  const height = Number(raw?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(`${label} must have positive width and height`);
  }
  return { width, height };
}

function readPoint(raw) {
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}
