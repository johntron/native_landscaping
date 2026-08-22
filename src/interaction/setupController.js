import { resolvePhotoDrag } from '../render/setupOverlay.js';

/**
 * Drag the photograph under a view's drawing.
 *
 * This is the plant drag controller's sibling: same pointer capture, same
 * rAF-throttled repaint. It owns the pointer only in Setup mode, where the
 * plant controllers are locked, so the two never compete.
 *
 * There is nothing to hit-test. A view's rectangle is derived from the declared
 * yard, so the guides drawn over it are a fixed target and the only thing a
 * gesture can move is the picture behind them — grab it anywhere. That replaced
 * eight extent handles, their hit radius, and their eight resize cursors, and
 * it is a better gesture besides: dragging a photo into place is what the task
 * actually is.
 *
 * Every gesture reports a candidate `{photoFt}` through `onChange`; the app
 * validates it before it becomes the live view, which is why nothing here
 * mutates the view it was handed.
 *
 * Armed with `setRuler(true)` the same pointer draws a measuring segment
 * instead, reported through `onRuler` for the app to draw and to ask a length
 * for.
 *
 * @param {{ svg: SVGSVGElement, getView: () => object,
 *           onChange: (patch: object) => void, onCommit?: () => void,
 *           onRuler?: (segment: {from: object, to: object, done: boolean}) => void }} options
 */
export function createSetupController({ svg, getView, onChange, onCommit, onRuler }) {
  const state = {
    locked: true,
    dragFrom: null,
    dragView: null,
    pointerId: null,
    frame: 0,
    pending: null,
    ruler: false,
    from: null,
    to: null,
  };

  if (!svg) {
    return {
      setLocked: () => {},
      isLocked: () => true,
      setRuler: () => {},
      destroy: () => {},
    };
  }

  const listeners = [
    ['pointerdown', handlePointerDown],
    ['pointermove', handlePointerMove],
    ['pointerup', handlePointerUp],
    ['pointercancel', handlePointerUp],
    ['lostpointercapture', handlePointerUp],
  ];
  listeners.forEach(([type, handler]) => svg.addEventListener(type, handler));

  /** Screen point to viewBox point, using the view's own declared box. */
  function toViewBoxPoint(event) {
    const view = getView?.();
    if (!view) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scaleX = view.viewBox.width / rect.width;
    const scaleY = view.viewBox.height / rect.height;
    return {
      view,
      point: { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY },
    };
  }

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const context = toViewBoxPoint(event);
    if (!context) return;

    if (state.ruler) {
      // A measurement starts wherever the pointer went down; there is nothing
      // to hit-test, which is why the ruler cannot also move a handle.
      state.from = context.point;
      state.to = context.point;
      state.pointerId = event.pointerId;
      svg.setPointerCapture(event.pointerId);
      onRuler?.({ from: state.from, to: state.from, done: false });
      event.preventDefault();
      return;
    }

    // Nothing to grab if there is no photo to move.
    if (!context.view.background) return;
    state.dragFrom = context.point;
    // The view as it was when the gesture began; every frame's delta is
    // measured against this one, never against the view it has already moved.
    state.dragView = context.view;
    state.pointerId = event.pointerId;
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = 'grabbing';
    event.preventDefault();
  }

  function handlePointerMove(event) {
    if (state.locked) return;
    const context = toViewBoxPoint(event);
    if (state.from && event.pointerId === state.pointerId) {
      if (!context) return;
      // Held outside `pending`, which the frame throttle empties: the release
      // needs the last point the pointer reached, not the last one drawn.
      state.to = context.point;
      state.pending = { from: state.from, to: state.to, done: false };
      queueChange();
      event.preventDefault();
      return;
    }
    if (!state.dragFrom || event.pointerId !== state.pointerId) return;
    if (!context) return;
    // Measured from where the gesture STARTED, against the view as it was when
    // it started: reporting a delta from the last frame would compound the
    // rounding, and reporting one against the already-moved photo would move it
    // twice per frame.
    state.pending = resolvePhotoDrag(state.dragView, state.dragFrom, context.point);
    queueChange();
    event.preventDefault();
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    if (state.from) {
      const from = state.from;
      const to = state.to || from;
      flushPending();
      release();
      onRuler?.({ from, to, done: true });
      return;
    }
    const wasDragging = Boolean(state.dragFrom);
    // A flick can finish inside a single frame. Without this the coalesced
    // change is still pending when release() drops it, and the whole gesture
    // is silently lost.
    flushPending();
    release();
    if (wasDragging) onCommit?.();
  }

  function flushPending() {
    if (state.frame) {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    }
    deliver(state.pending);
    state.pending = null;
  }

  /** One pending payload, two destinations: a ruler segment is not a view patch. */
  function deliver(payload) {
    if (!payload) return;
    if (payload.from) onRuler?.(payload);
    else onChange?.(payload);
  }

  /**
   * Coalesce to one change per frame. A photo drag repaints every panel, so an
   * unthrottled stream would re-render every plant per pointermove.
   */
  function queueChange() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      const payload = state.pending;
      state.pending = null;
      deliver(payload);
    });
  }

  function release() {
    if (state.pointerId !== null && svg.hasPointerCapture(state.pointerId)) {
      svg.releasePointerCapture(state.pointerId);
    }
    state.dragFrom = null;
    state.dragView = null;
    state.pointerId = null;
    state.pending = null;
    state.from = null;
    state.to = null;
    svg.style.cursor = restingCursor();
  }

  /**
   * `grab` says the picture under the pointer is the thing that moves; the
   * ruler's crosshair says a measurement starts here instead.
   */
  function restingCursor() {
    if (state.locked) return 'default';
    return state.ruler ? 'crosshair' : 'grab';
  }

  /**
   * Arm or disarm the measuring gesture. Arming mid-drag would leave a handle
   * half-moved, so any gesture in flight is dropped first.
   */
  function setRuler(active) {
    const next = Boolean(active);
    if (next === state.ruler) return;
    state.ruler = next;
    release();
    svg.style.cursor = restingCursor();
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    if (state.locked) release();
    // See dragController: this element has two controllers, so touch-action is
    // expressed as a class rather than an inline property they overwrite.
    svg.classList.toggle('is-setup-enabled', !state.locked);
    svg.style.cursor = restingCursor();
  }

  function destroy() {
    release();
    if (state.frame) cancelAnimationFrame(state.frame);
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return { setLocked, isLocked: () => state.locked, setRuler, destroy };
}
