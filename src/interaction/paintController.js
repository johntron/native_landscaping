import { clientPointToViewBox } from '../render/screenPoint.js';
import { exceedsTapThreshold } from './tapSelection.js';

/**
 * Pointer handling for "paint a drift along a stroke" (nl-o47.6.6): turns a
 * one-finger (or mouse) drag on the plan into a polyline of plan-feet points
 * and reports it to src/interaction/paintDriftMode.js, which owns everything
 * about what the points MEAN — resampling at a spacing, clamping to the yard,
 * committing the edit. This controller knows nothing about species, spacing,
 * or drifts; it only answers "where did the pointer go."
 *
 * PLAN-only, built in the same shape as src/interaction/featureController.js
 * (its closest sibling here): bound to one plan view's svg, pointer capture
 * on down, torn down and rebuilt whenever Setup mode replaces the panel.
 * Unlike featureController there is no hit-testing or dragging an existing
 * shape — every stroke starts wherever the pointer went down, with nothing to
 * miss — and unlike src/interaction/dragController.js there is no tap/drag
 * ambiguity to resolve via a cycling selection: a stroke either moved past the
 * ordinary tap-movement threshold (src/interaction/tapSelection.js's
 * TAP_MOVEMENT_THRESHOLD_PX, the SAME judgement call a plain selection drag
 * uses) or it did not, full stop. A plain tap places nothing.
 *
 * Two fingers always pinch/pan (nl-o47.4): a second touch/pen pointer
 * arriving mid-stroke cancels it outright, the same clean hand-off
 * dragController's own cancelTouchForSecondPointer gives
 * src/interaction/canvasGesture.js's pinch — releasing capture here is what
 * lets that module's own bubbled pointerdown/pointermove see the two fingers
 * on the very next event and take over. Mouse has no second pointer to worry
 * about. The caller (src/app.js) is expected to fully LOCK every OTHER
 * pointer consumer of this svg (dragController's plan controller included)
 * for painting's duration, via this controller's own setLocked — this module
 * never has to coordinate with dragController directly.
 *
 * @param {object} deps
 * @param {SVGSVGElement} deps.svg a plan view's own svg
 * @param {() => object} deps.getTransform the plan view's own transform
 *   (src/render/viewTransform.js), resolved fresh per call like every other
 *   controller here — a Setup edit can replace the view object underneath
 * @param {() => void} [deps.onStrokeMove] called on every pointermove once the
 *   gesture has moved past the tap threshold, with the full polyline
 *   collected so far (plan feet, from the stroke's own start)
 * @param {(points: Array<{x:number,y:number}>) => void} [deps.onStrokeEnd]
 *   called at pointerup with the full polyline, but only when the gesture
 *   moved past the tap threshold at some point — a plain tap never reaches
 *   this at all (see onStrokeCancel)
 * @param {() => void} [deps.onStrokeCancel] called when a stroke ends with no
 *   edit to make: a plain tap (pointerup with no real movement), a second
 *   finger arriving mid-stroke, or an interrupted gesture (pointercancel/
 *   lostpointercapture)
 */
export function createPaintController({ svg, getTransform, onStrokeMove = () => {}, onStrokeEnd = () => {}, onStrokeCancel = () => {} }) {
  const state = {
    locked: true,
    pointerId: null,
    downClient: null,
    movedPastThreshold: false,
    points: [], // plan-feet {x,y}, pointerdown through now, in drawing order
  };

  if (!svg) {
    return { setLocked: () => {}, isLocked: () => true, destroy: () => {} };
  }

  const listeners = [
    ['pointerdown', handlePointerDown],
    ['pointermove', handlePointerMove],
    ['pointerup', handlePointerUp],
    ['pointercancel', handleInterrupted],
    ['lostpointercapture', handleInterrupted],
  ];
  listeners.forEach(([type, handler]) => svg.addEventListener(type, handler));

  /**
   * Screen point to plan feet, through the SVG's screenCTM
   * (src/render/screenPoint.js — correct under letterboxing and the phone
   * editor's own pinch-zoom/pan CSS transform, unlike a rect-based x/y scale).
   */
  function pointFromEvent(event) {
    const transform = getTransform?.();
    if (!transform) return null;
    const mapped = clientPointToViewBox(svg, event.clientX, event.clientY);
    if (!mapped) return null;
    return transform.viewBoxToPlan(mapped.point);
  }

  function handlePointerDown(event) {
    if (state.locked) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!event.isPrimary) {
      // A second touch/pen finger: hand off to canvasGesture's pinch, the
      // same clean cancel dragController gives it.
      if (state.pointerId !== null) cancelStroke();
      return;
    }
    const point = pointFromEvent(event);
    if (!point) return;
    state.pointerId = event.pointerId;
    state.downClient = { x: event.clientX, y: event.clientY };
    state.movedPastThreshold = false;
    state.points = [point];
    // Captured unconditionally, like dragController's own touch handling:
    // once a live preview starts re-rendering the panel on every frame, the
    // element under the finger is replaced, and only an explicit capture
    // keeps later events reaching this controller at all.
    svg.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event) {
    if (event.pointerId !== state.pointerId) return;
    const point = pointFromEvent(event);
    if (!point) return;
    state.points.push(point);
    if (!state.movedPastThreshold) {
      const dx = event.clientX - state.downClient.x;
      const dy = event.clientY - state.downClient.y;
      if (!exceedsTapThreshold(dx, dy)) return; // still might be a plain tap; keep collecting, show nothing yet
      state.movedPastThreshold = true;
    }
    onStrokeMove(state.points.slice());
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    const moved = state.movedPastThreshold;
    const points = state.points.slice();
    reset();
    if (moved) onStrokeEnd(points);
    else onStrokeCancel(); // a plain tap: nothing was ever shown, nothing to clean up either
  }

  function handleInterrupted(event) {
    if (event.pointerId !== state.pointerId) return;
    cancelStroke();
  }

  function cancelStroke() {
    reset();
    onStrokeCancel();
  }

  function reset() {
    if (state.pointerId !== null && svg.hasPointerCapture(state.pointerId)) {
      svg.releasePointerCapture(state.pointerId);
    }
    state.pointerId = null;
    state.downClient = null;
    state.movedPastThreshold = false;
    state.points = [];
  }

  /**
   * A class, not svg.style.cursor/touchAction directly — several controllers
   * can share this svg (styles.css's "Touch: who owns the finger" comment),
   * so each toggles its own class and CSS combines them, exactly like
   * dragController's is-drag-enabled / featureController's is-features-
   * enabled. is-paint-enabled claims every touch outright (no page left to
   * scroll behind an active stroke) and draws a crosshair cursor on desktop.
   */
  function setLocked(locked) {
    const next = Boolean(locked);
    if (next === state.locked) return;
    state.locked = next;
    if (state.locked && state.pointerId !== null) cancelStroke();
    svg.classList.toggle('is-paint-enabled', !state.locked);
  }

  function destroy() {
    if (state.pointerId !== null) cancelStroke();
    svg.classList.remove('is-paint-enabled');
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return { setLocked, isLocked: () => state.locked, destroy };
}
