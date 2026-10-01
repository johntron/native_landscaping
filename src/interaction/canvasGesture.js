/**
 * The phone editor's pinch-zoom/pan gesture (nl-o47.4): turns real touch
 * pointer events into calls into src/render/canvasZoom.js's pure math, and
 * applies the result as a CSS transform on `.view`. Mouse is untouched here
 * entirely — the desktop Scale slider and mouse drag are unchanged, and this
 * module's own listeners simply ignore a mouse pointerType.
 *
 * Coordination with src/interaction/dragController.js, which shares the same
 * svg (no shared state — each reacts to the real DOM events on its own):
 * dragController now cancels its own tracked touch gesture the instant a
 * second finger arrives (its own handlePointerDown, nl-o47.4), so by the
 * time this module's bubbled listener sees that same pointerdown, capture on
 * the svg has already been released and nothing is fighting this module for
 * it. For a lone finger, dragController's tap-vs-drag machinery is left
 * untouched: this module only ever acts on a one-finger move when nothing is
 * selected — dragController's own comment on that branch ("nothing
 * selected: the pan gesture owns this move") is this module. With a
 * selection, dragController's own group drag IS the one-finger gesture, and
 * this module keeps tracking the finger (in case a second one turns it into
 * a pinch) without ever touching the transform for it.
 *
 * Listens on the maximized panel (`.view-panel.is-maximized`), one level
 * above `.view` — bubbled events from the svg inside it reach it whichever
 * child was actually touched, and it doubles as the clip box whose size
 * bounds the pan (styles.css gives it `overflow: clip` and zero padding
 * while the phone editor is open, so its border box IS the content box, with
 * no padding arithmetic to get right here).
 */
import { FIT_STATE, clampZoomState, fitRectState, isAtFit, panBy, pinchUpdate } from '../render/canvasZoom.js';

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * @param {object} deps
 * @param {() => number} [deps.getSelectionSize]  the live Edit-mode selection
 *   size, so a one-finger move pans only while it is 0
 * @param {() => boolean} [deps.isPaintActive]  nl-o47.6.6's "paint a drift
 *   along a stroke": while it is open, a one-finger move must not pan either,
 *   even though the ordinary selection stays empty throughout painting (the
 *   same reason it must not pan with a real selection) — src/interaction/
 *   paintController.js owns that same finger instead, tracing the stroke.
 *   Checked alongside getSelectionSize() in the one place this module decides
 *   whether to start a pan at all.
 * @param {(state: {scale:number, tx:number, ty:number}, atRest: boolean) => void} [deps.onChange]
 *   called with the new state every time it changes, plus whether it is
 *   already the (possibly letterboxed, so not necessarily FIT_STATE itself
 *   — see canvasZoom.js's isAtFit) resting position, to sync a Fit button's
 *   enabled state
 */
export function createCanvasGesture({ getSelectionSize = () => 0, isPaintActive = () => false, onChange = () => {} } = {}) {
  let panelEl = null;
  let viewEl = null;
  let state = FIT_STATE;
  /** @type {Map<number, {x:number,y:number}>} client-px positions, by pointerId */
  const pointers = new Map();
  // This gesture's own mode, independent of dragController's:
  //  - null:    0 fingers, or 1 finger this module has no reason to act on
  //             yet (still deciding, or a selection exists and dragController
  //             owns it)
  //  - 'pan':   1 finger, nothing selected, already moved
  //  - 'pinch': 2 fingers
  //  - 'settled': a finger left over after a pinch — ignored (no pan, no tap
  //    hand-back) until it, too, lifts, so releasing one finger of a pinch
  //    cannot jump the drawing or read as a tap on whatever the remaining
  //    finger happens to sit over.
  let mode = null;
  // The untransformed viewport position of `.view`'s own top-left,
  // recomputed at the start of every gesture from the CURRENTLY APPLIED
  // transform and a fresh measured rect: since `screen = origin + state`
  // (translate/scale), `origin = rect.left - state.tx` holds regardless of
  // the clip container's padding, flex alignment, or safe-area insets — none
  // of that has to be reasoned about here at all.
  let origin = { x: 0, y: 0 };
  let pinchStart = null; // { state, mid, dist } snapshot from the 2nd finger's pointerdown
  let panLast = null; // { x, y }, the previous frame's single-finger position

  function bounds() {
    if (!panelEl || !viewEl) {
      return { containerWidth: 0, containerHeight: 0, contentWidth: 0, contentHeight: 0 };
    }
    const panelRect = panelEl.getBoundingClientRect();
    return {
      containerWidth: panelRect.width,
      containerHeight: panelRect.height,
      // offsetWidth/Height are `.view`'s own LAYOUT size — a CSS transform
      // never changes it, which is exactly why it is the stable "fit" size
      // canvasZoom.js measures scale against.
      contentWidth: viewEl.offsetWidth,
      contentHeight: viewEl.offsetHeight,
    };
  }

  function computeOrigin() {
    if (!viewEl) return;
    const rect = viewEl.getBoundingClientRect(); // reflects the transform applied so far
    origin = { x: rect.left - state.tx, y: rect.top - state.ty };
  }

  function toLocal(clientPoint) {
    return { x: clientPoint.x - origin.x, y: clientPoint.y - origin.y };
  }

  function apply(next) {
    state = next;
    if (viewEl) {
      viewEl.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    }
    // The resting position for THIS panel's own bounds, which is FIT_STATE
    // only when the content happens to fill it exactly on both axes —
    // otherwise it is a centered state (see clampTranslateAxis's own
    // comment), and comparing against raw FIT_STATE would leave the Fit
    // button reading as live forever on a letterboxed drawing.
    onChange(state, isAtFit(state, clampZoomState(FIT_STATE, bounds())));
  }

  function handlePointerDown(event) {
    if (event.pointerType === 'mouse') return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2) {
      // A pinch always takes over, whatever a lone first finger was doing —
      // "two fingers always pinch-zoom and pan," selection or none.
      // dragController has already let go of its own tracked pointer by now
      // (its handlePointerDown's own !isPrimary branch), so capturing both
      // fingers here is not competing with it for either one.
      computeOrigin();
      pointers.forEach((_point, id) => {
        try {
          panelEl.setPointerCapture(id);
        } catch {
          /* already released, or this pointerId is gone — nothing to do */
        }
      });
      const [a, b] = [...pointers.values()];
      pinchStart = { state, mid: toLocal(midpoint(a, b)), dist: distance(a, b) };
      mode = 'pinch';
      panLast = null;
    } else if (pointers.size === 1 && mode === null) {
      // Might become a pan (moves, nothing selected), stay a tap
      // (dragController's own call), or grow into a pinch (above).
      computeOrigin();
      panLast = { x: event.clientX, y: event.clientY };
    }
  }

  function handlePointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (mode === 'pinch') {
      const [idA, idB] = [...pointers.keys()];
      const a = pointers.get(idA);
      const b = idB !== undefined ? pointers.get(idB) : null;
      if (!a || !b) return; // a 3rd finger touched: tracked, but the pinch stays anchored to the first two
      const mid = toLocal(midpoint(a, b));
      const dist = distance(a, b);
      apply(pinchUpdate(pinchStart.state, pinchStart.mid, pinchStart.dist, mid, dist, bounds()));
      return;
    }

    if (mode === 'settled' || pointers.size !== 1) return;
    // A 1-finger move with a selection is dragController's drag, not a pan;
    // a 1-finger move while painting (nl-o47.6.6) is paintController's
    // stroke, not a pan either.
    if (getSelectionSize() > 0 || isPaintActive()) return;
    const current = pointers.get(event.pointerId);
    if (!panLast) {
      panLast = current;
      return;
    }
    const dx = current.x - panLast.x;
    const dy = current.y - panLast.y;
    if (dx === 0 && dy === 0) return;
    mode = 'pan';
    apply(panBy(state, dx, dy, bounds()));
    panLast = current;
  }

  function endPointer(event) {
    try {
      panelEl?.releasePointerCapture?.(event.pointerId);
    } catch {
      /* never captured, or already released */
    }
    pointers.delete(event.pointerId);
    if (pointers.size >= 2) return; // still mid-pinch with the others
    if (pointers.size === 1) {
      if (mode === 'pinch') mode = 'settled';
      panLast = null;
      return;
    }
    // Every finger is up: ready for a fresh gesture.
    mode = null;
    pinchStart = null;
    panLast = null;
  }

  /**
   * Bind to a newly-maximized panel (entering the editor, or switching the
   * view tab). Always tears down any previous binding first — configureViews
   * hands out a DIFFERENT panel element per view id, so switching tabs binds
   * to a different element entirely rather than reusing one.
   * @param {HTMLElement|null} panel  `.view-panel.is-maximized`
   * @param {HTMLElement|null} view   its own `.view` child
   */
  function attachTo(panel, view) {
    detach();
    panelEl = panel || null;
    viewEl = view || null;
    if (!panelEl) return;
    panelEl.addEventListener('pointerdown', handlePointerDown);
    panelEl.addEventListener('pointermove', handlePointerMove);
    panelEl.addEventListener('pointerup', endPointer);
    panelEl.addEventListener('pointercancel', endPointer);
  }

  function detach() {
    if (panelEl) {
      panelEl.removeEventListener('pointerdown', handlePointerDown);
      panelEl.removeEventListener('pointermove', handlePointerMove);
      panelEl.removeEventListener('pointerup', endPointer);
      panelEl.removeEventListener('pointercancel', endPointer);
    }
    panelEl = null;
    viewEl = null;
    pointers.clear();
    mode = null;
    pinchStart = null;
    panLast = null;
  }

  /** Back to FIT_STATE (the Fit button, and re-entering the editor). */
  function reset() {
    apply(clampZoomState(FIT_STATE, bounds()));
  }

  function getState() {
    return state;
  }

  /**
   * Frame a content-space rectangle (`.view`'s own untransformed CSS px —
   * see canvasZoom.js's fitRectState) centered, with `paddingPx` of margin.
   * nl-o47.6.5: the drift-suggestion review calls this (through
   * src/interaction/phoneEditor.js's focusOnPlants) so the whole suggestion
   * lands in view when review starts or moves on, without requiring a manual
   * pinch first the way an ordinary drift selection does.
   * @param {{x:number, y:number, width:number, height:number}} rect
   * @param {number} [paddingPx]
   */
  function focusRect(rect, paddingPx) {
    apply(fitRectState(rect, bounds(), paddingPx));
  }

  return { attachTo, detach, reset, getState, getBounds: bounds, focusRect };
}
