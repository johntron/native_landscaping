import { createViewTransform } from './viewTransform.js';
import { createSvgElement } from './svgUtils.js';

/**
 * The guides Setup mode draws over a view: a foot grid, a dimension readout,
 * and the handles that edit the view's own geometry.
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

/**
 * @param {object} view a normalized view
 * @returns {{ transform: object, stepFt: number, gridLines: Array, guides: Array,
 *             handles: Array, readout: { text: string, x: number, y: number } }}
 */
export function buildOverlayGeometry(view) {
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

  const guides = [];
  const handles = [];

  if (type === 'elevation') {
    // Ground is height zero; the near edge is the axis value the view starts at,
    // which mirroring puts on the right for north and west.
    guides.push({
      id: 'ground',
      orientation: 'horizontal',
      x1: 0,
      y1: transform.groundY,
      x2: viewBox.width,
      y2: transform.groundY,
    });
    handles.push({ id: 'ground', axis: 'y', x: viewBox.width / 2, y: transform.groundY });

    const nearX = transform.axisToX(originFt.x);
    guides.push({ id: 'near-edge', orientation: 'vertical', x1: nearX, y1: 0, x2: nearX, y2: viewBox.height });
    handles.push({ id: 'near-edge', axis: 'x', x: nearX, y: viewBox.height / 2 });
  } else {
    // The rect a plan view covers is the viewBox itself, so its handles sit on
    // the panel edges: dragging one grows or shrinks the yard the view shows.
    const xs = { min: 0, mid: viewBox.width / 2, max: viewBox.width };
    const ys = { min: viewBox.height, mid: viewBox.height / 2, max: 0 }; // yard y grows up
    ['min', 'mid', 'max'].forEach((ex) => {
      ['min', 'mid', 'max'].forEach((ey) => {
        if (ex === 'mid' && ey === 'mid') return;
        handles.push({
          id: `${ex}-${ey}`,
          edgeX: ex === 'mid' ? null : ex,
          edgeY: ey === 'mid' ? null : ey,
          x: xs[ex],
          y: ys[ey],
        });
      });
    });
    guides.push({ id: 'extent', orientation: 'rect', x1: 0, y1: 0, x2: viewBox.width, y2: viewBox.height });
  }

  return {
    transform,
    stepFt,
    gridLines,
    guides,
    handles,
    readout: {
      text:
        type === 'elevation'
          ? `${round(extentFt.width)} × ${round(extentFt.height)} ft · ground ${round(originFt.y)} ft`
          : `${round(extentFt.width)} × ${round(extentFt.height)} ft`,
      // Top-right: the panel's own scale badge occupies the top-left corner.
      x: viewBox.width - 8,
      y: 8,
      anchor: 'end',
    },
  };
}

/**
 * Recompute a view's geometry from a handle dragged to a viewBox point.
 * Returns the changed fields, so the caller can patch without knowing which
 * handle moved.
 *
 * The drawing follows the extent at a fixed resolution, the same rule the setup
 * form uses: resizing a view covers more or less yard rather than rescaling what
 * is already there. viewBox has to travel with extentFt — leaving it behind is a
 * non-uniform view, which validation rejects and the drag would silently die on.
 *
 * @returns {{ originFt: {x:number,y:number}, extentFt: {width:number,height:number},
 *             viewBox: {width:number,height:number} } | null}
 */
export function resolveHandleDrag(view, handleId, point) {
  const geometry = buildOverlayGeometry(view);
  const { transform } = geometry;
  const handle = geometry.handles.find((entry) => entry.id === handleId);
  if (!handle) return null;
  const axes = axesFor(transform);
  const originFt = { ...transform.originFt };
  const extentFt = { ...transform.extentFt };

  if (transform.type === 'elevation') {
    if (handle.id === 'ground') {
      // Move height zero to the pointer, keeping the yard the view covers.
      originFt.y = transform.toFeet(point.y - transform.viewBox.height);
    } else {
      // xToAxis is the exact inverse of axisToX, so this is correct in the
      // mirrored directions too — where the near edge is the right-hand side.
      originFt.x = axes.fromX(point.x);
    }
    return withDerivedViewBox(originFt, extentFt, transform.pxPerFt);
  }

  const MIN_EXTENT_FT = 0.5;
  if (handle.edgeX === 'min') {
    const right = originFt.x + extentFt.width;
    originFt.x = Math.min(axes.fromX(point.x), right - MIN_EXTENT_FT);
    extentFt.width = right - originFt.x;
  } else if (handle.edgeX === 'max') {
    extentFt.width = Math.max(axes.fromX(point.x) - originFt.x, MIN_EXTENT_FT);
  }
  if (handle.edgeY === 'min') {
    const top = originFt.y + extentFt.height;
    originFt.y = Math.min(axes.fromY(point.y), top - MIN_EXTENT_FT);
    extentFt.height = top - originFt.y;
  } else if (handle.edgeY === 'max') {
    extentFt.height = Math.max(axes.fromY(point.y) - originFt.y, MIN_EXTENT_FT);
  }
  return withDerivedViewBox(originFt, extentFt, transform.pxPerFt);
}

/**
 * Measure a two-point drag across the view's background photo.
 *
 * The photo is stretched to fill the viewBox (`background-size: 100% 100%` in
 * styles.css), so viewBox pixels map proportionally onto the image and a
 * measurement taken here is a measurement of the photo. Scale is uniform, so a
 * diagonal drag is as valid as an axis-aligned one.
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
 * Solve a view's real-world extent from a known length in its photo.
 *
 * The drag says "this many viewBox pixels" and the typed length says "that is
 * this many feet". Everything else follows: the view keeps its resolution and
 * its anchor against the photo, and only how much yard the photo covers moves.
 *
 * Resolution is held rather than the viewBox, so the patch has the same shape
 * as a handle drag's and "px per ft" in the setup form keeps meaning what it
 * says. The viewBox therefore changes size — visually a no-op, because the
 * photo fills whatever box it is given.
 *
 * Anchoring: a plan's `originFt` IS its bottom-left corner and an elevation's
 * `originFt.x` IS its near edge, so both sit on a photo edge at any scale and
 * survive untouched. An elevation's ground line does not — it floats at
 * `-originFt.y` feet above the bottom — so that one scales with the extent,
 * keeping the ground on the photo row the user placed it on.
 *
 * @param {object} view a normalized view
 * @param {{x: number, y: number}} from viewBox point
 * @param {{x: number, y: number}} to viewBox point
 * @param {number} lengthFt what the measured span really is
 * @returns {{ originFt: {x:number,y:number}, extentFt: {width:number,height:number},
 *             viewBox: {width:number,height:number} } | null}
 */
export function resolveRulerCalibration(view, from, to, lengthFt) {
  const measured = measureRuler(view, from, to);
  if (!measured || measured.pixels < MIN_RULER_PIXELS) return null;
  const feet = Number(lengthFt);
  if (!Number.isFinite(feet) || feet <= 0) return null;

  const transform = createViewTransform(view);
  const scale = feet / measured.feet;
  const originFt = { ...transform.originFt };
  if (transform.type === 'elevation') originFt.y *= scale;
  return withDerivedViewBox(
    originFt,
    {
      width: transform.extentFt.width * scale,
      height: transform.extentFt.height * scale,
    },
    transform.pxPerFt
  );
}

function withDerivedViewBox(originFt, extentFt, pxPerFt) {
  return {
    originFt,
    extentFt,
    viewBox: { width: extentFt.width * pxPerFt, height: extentFt.height * pxPerFt },
  };
}

/** Nearest handle within `radius` viewBox pixels, or null. */
export function pickHandle(geometry, point, radius) {
  let best = null;
  geometry.handles.forEach((handle) => {
    // A line guide is grabbable anywhere along it, so only the axis it moves
    // counts toward the distance.
    const dx = handle.axis === 'y' ? 0 : point.x - handle.x;
    const dy = handle.axis === 'x' ? 0 : point.y - handle.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= radius * radius && (!best || distSq < best.distSq)) {
      best = { handle, distSq };
    }
  });
  return best ? best.handle : null;
}

/** Remove any overlay previously drawn into this SVG. */
export function clearSetupOverlay(svg) {
  if (!svg) return;
  svg.querySelectorAll(`g[${OVERLAY_GROUP_ATTR}]`).forEach((node) => node.parentNode?.removeChild(node));
}

/**
 * Draw the guides into a view's SVG, on top of the plants. Called after every
 * render because rendering clears the SVG.
 */
export function renderSetupOverlay(svg, view, ruler) {
  if (!svg || !view) return null;
  clearSetupOverlay(svg);
  const geometry = buildOverlayGeometry(view);
  const group = createSvgElement('g', { [OVERLAY_GROUP_ATTR]: geometry.transform.id, 'pointer-events': 'none' });

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
          x: guide.x1 + 1,
          y: guide.y1 + 1,
          width: Math.max(guide.x2 - guide.x1 - 2, 0),
          height: Math.max(guide.y2 - guide.y1 - 2, 0),
          fill: 'none',
          stroke: '#ef7d1a',
          'stroke-width': 2,
          'stroke-dasharray': '8 5',
          'data-setup-guide': guide.id,
        })
      );
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

  geometry.handles.forEach((handle) => {
    group.appendChild(
      createSvgElement('circle', {
        cx: handle.x,
        cy: handle.y,
        r: 7,
        fill: '#fff',
        stroke: '#ef7d1a',
        'stroke-width': 2.5,
        'data-setup-handle': handle.id,
      })
    );
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
