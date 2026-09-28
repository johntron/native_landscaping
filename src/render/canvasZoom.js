/**
 * Pure math behind the phone editor's pinch-zoom/pan (nl-o47.4): a CSS
 * transform (`translate(tx, ty) scale(scale)`) applied to `.view` inside its
 * clipped panel — never a viewBox rewrite. The photo is a CSS background
 * sized as PERCENTAGES of the viewBox (src/render/photoPlacement.js), so
 * rewriting the viewBox on zoom would slide plants off the photo; a CSS
 * transform scales both together, and getScreenCTM (src/render/screenPoint.js)
 * already follows a CSS transform on the element or an ancestor, so hit-
 * testing, drags, and drift outlines all stay correct under it for free.
 *
 * No DOM here: src/interaction/canvasGesture.js is the only caller, turning
 * real pointer events into the plain numbers below. `.view`'s own
 * (untransformed) layout box IS the "fit" size — styles.css already sizes it
 * to its clip container at rest — so "no zoom" is exactly `FIT_STATE`, with
 * no separate base size to track here.
 */

// Judgement calls (nl-o47.4): how far a phone may zoom the drawing in. Fit
// (1x) is the floor — there is nothing useful past showing the whole drawing
// smaller than its container already draws it, and letting the transform go
// below 1 would shrink the content past its own clip box, leaving empty
// margin the drawing does not have. 6x is chosen so a small plant's ~28px
// MIN_HITBOX_RADIUS_PX (src/interaction/dragController.js) becomes a
// comfortably large on-screen target well before the drawing turns to mush.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

/** The transform at rest: the drawing exactly as `.view`'s own CSS sizes it. */
export const FIT_STATE = Object.freeze({ scale: 1, tx: 0, ty: 0 });

/** @param {number} scale @returns {number} */
export function clampScale(scale) {
  if (!Number.isFinite(scale)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/**
 * Clamp one axis of a translate so the scaled content always covers its clip
 * box. At `scale` 1 the content's own box already equals the container's
 * (the CSS that sizes `.view` to fit), so the only legal translate is 0; at a
 * higher scale the content may slide until either edge reaches the
 * container's edge, and no further — panning past that would show empty
 * margin the drawing does not have.
 * @param {number} translate
 * @param {number} scale
 * @param {number} containerSize  the clip box's own size, CSS px
 * @param {number} contentSize    `.view`'s own untransformed size, CSS px
 * @returns {number}
 */
export function clampTranslateAxis(translate, scale, containerSize, contentSize) {
  const slack = containerSize - contentSize * scale;
  if (slack >= 0) {
    // The content is not larger than its box — should only happen
    // transiently (e.g. mid-resize), since scale is floored at MIN_ZOOM and
    // `.view`'s own CSS already fits it to the container at that scale.
    // Center it rather than leave a one-sided gap.
    return slack / 2;
  }
  return Math.min(0, Math.max(slack, translate));
}

/**
 * @typedef {{containerWidth:number, containerHeight:number, contentWidth:number, contentHeight:number}} ZoomBounds
 */

/**
 * Clamp a whole {scale, tx, ty} state: scale to [MIN_ZOOM, MAX_ZOOM], then
 * each translate axis against the (now-clamped) scale.
 * @param {{scale:number, tx:number, ty:number}} state
 * @param {ZoomBounds} bounds
 */
export function clampZoomState(state, bounds) {
  const scale = clampScale(state.scale);
  return {
    scale,
    tx: clampTranslateAxis(state.tx, scale, bounds.containerWidth, bounds.contentWidth),
    ty: clampTranslateAxis(state.ty, scale, bounds.containerHeight, bounds.contentHeight),
  };
}

/**
 * Pan by a screen-px delta at the current scale (one-finger pan with no
 * selection, or the tail end of a released pinch settling back in bounds).
 * @param {{scale:number, tx:number, ty:number}} state
 * @param {number} dx
 * @param {number} dy
 * @param {ZoomBounds} bounds
 */
export function panBy(state, dx, dy, bounds) {
  return clampZoomState({ scale: state.scale, tx: state.tx + dx, ty: state.ty + dy }, bounds);
}

/**
 * Zoom to `nextScale` while keeping the content-space point currently under
 * `anchor` (container-local CSS px, e.g. `clientX - containerRect.left`)
 * fixed on screen — the Fit button and any future tap/button zoom use this
 * directly; the live pinch gesture uses `pinchUpdate` below instead, which
 * holds its anchor fixed across a whole gesture rather than re-deriving it
 * every frame.
 * @param {{scale:number, tx:number, ty:number}} state
 * @param {{x:number, y:number}} anchor
 * @param {number} nextScale
 * @param {ZoomBounds} bounds
 */
export function zoomAbout(state, anchor, nextScale, bounds) {
  const scale = clampScale(nextScale);
  // screen = translate + scale * local, so local = (screen - translate) / scale.
  const localX = (anchor.x - state.tx) / state.scale;
  const localY = (anchor.y - state.ty) / state.scale;
  return clampZoomState(
    { scale, tx: anchor.x - scale * localX, ty: anchor.y - scale * localY },
    bounds
  );
}

/**
 * One frame of an active two-finger pinch, from the gesture's START snapshot
 * (captured once when the second finger touched down) and the CURRENT
 * midpoint/finger-separation — combines zoom (from the distance ratio) and
 * pan (from the midpoint's own movement) in one pass, which is what makes a
 * two-finger drag with no distance change a plain pan and a pinch-in-place a
 * plain zoom, without treating them as separate gestures.
 *
 * The anchor is the CONTENT-SPACE point under the gesture's own STARTING
 * midpoint, held fixed for the gesture's whole duration. Recomputing it from
 * the current midpoint every frame would let a slow pinch drift: scale and
 * translate would then each frame be solved from a different midpoint than
 * the one the previous frame committed to.
 * @param {{scale:number, tx:number, ty:number}} startState  the state when the 2nd finger touched down
 * @param {{x:number, y:number}} startMid  container-local midpoint at gesture start
 * @param {number} startDist  finger separation (container-local px) at gesture start
 * @param {{x:number, y:number}} currentMid
 * @param {number} currentDist
 * @param {ZoomBounds} bounds
 */
export function pinchUpdate(startState, startMid, startDist, currentMid, currentDist, bounds) {
  const ratio = startDist > 0 ? currentDist / startDist : 1;
  const scale = clampScale(startState.scale * ratio);
  const localX = (startMid.x - startState.tx) / startState.scale;
  const localY = (startMid.y - startState.ty) / startState.scale;
  return clampZoomState(
    { scale, tx: currentMid.x - scale * localX, ty: currentMid.y - scale * localY },
    bounds
  );
}

/**
 * Whether `state` is close enough to `reference` that the Fit button has
 * nothing left to do (and can show as such rather than as a live toggle).
 * `reference` defaults to the raw `FIT_STATE`, right when the content
 * happens to fill its container exactly (no letterboxing on either axis);
 * whenever it does not, the actual resting position is a CENTERED state —
 * `clampZoomState(FIT_STATE, bounds)`, not `FIT_STATE` itself — and the
 * caller (src/interaction/canvasGesture.js, which is the one place that
 * knows `bounds`) passes that instead, or the Fit button would read as live
 * even at rest.
 * @param {{scale:number, tx:number, ty:number}} state
 * @param {{scale:number, tx:number, ty:number}} [reference]
 * @param {number} [epsilon]
 */
export function isAtFit(state, reference = FIT_STATE, epsilon = 0.001) {
  return (
    Math.abs(state.scale - reference.scale) < epsilon &&
    Math.abs(state.tx - reference.tx) < epsilon &&
    Math.abs(state.ty - reference.ty) < epsilon
  );
}
