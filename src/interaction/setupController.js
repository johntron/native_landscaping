import { buildOverlayGeometry, pickHandle, resolveHandleDrag } from '../render/setupOverlay.js';

const MIN_HITBOX_RADIUS_PX = 28; // matches dragController; generous for touch

/**
 * Drag the setup guides on a view.
 *
 * This is the plant drag controller's sibling: same pointer capture, same
 * rAF-throttled repaint, same generous hit radius. It owns the pointer only in
 * Setup mode, where the plant controllers are locked, so the two never compete.
 *
 * Every gesture reports a candidate `{originFt, extentFt}` through `onChange`;
 * the app validates it before it becomes the live view, which is why nothing
 * here mutates the view it was handed.
 *
 * @param {{ svg: SVGSVGElement, getView: () => object,
 *           onChange: (patch: object) => void, onCommit?: () => void }} options
 */
export function createSetupController({ svg, getView, onChange, onCommit }) {
  const state = { locked: true, handleId: '', pointerId: null, frame: 0, pending: null };

  if (!svg) {
    return { setLocked: () => {}, isLocked: () => true, destroy: () => {} };
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
      scaleFactor: Math.max(scaleX, scaleY),
    };
  }

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const context = toViewBoxPoint(event);
    if (!context) return;

    const geometry = buildOverlayGeometry(context.view);
    const handle = pickHandle(geometry, context.point, MIN_HITBOX_RADIUS_PX * context.scaleFactor);
    if (!handle) return;

    state.handleId = handle.id;
    state.pointerId = event.pointerId;
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = 'grabbing';
    event.preventDefault();
  }

  function handlePointerMove(event) {
    if (state.locked) return;
    const context = toViewBoxPoint(event);
    if (!state.handleId || event.pointerId !== state.pointerId) {
      updateHoverCursor(context);
      return;
    }
    if (!context) return;
    state.pending = resolveHandleDrag(context.view, state.handleId, context.point);
    queueChange();
    event.preventDefault();
  }

  function updateHoverCursor(context) {
    if (!context) return;
    const geometry = buildOverlayGeometry(context.view);
    const handle = pickHandle(geometry, context.point, MIN_HITBOX_RADIUS_PX * context.scaleFactor);
    svg.style.cursor = handle ? cursorFor(handle) : 'default';
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    const wasDragging = Boolean(state.handleId);
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
    const patch = state.pending;
    state.pending = null;
    if (patch) onChange?.(patch);
  }

  /**
   * Coalesce to one change per frame. A handle drag rescales the whole view, so
   * an unthrottled stream would re-render every plant per pointermove.
   */
  function queueChange() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      const patch = state.pending;
      state.pending = null;
      if (patch) onChange?.(patch);
    });
  }

  function release() {
    if (state.pointerId !== null && svg.hasPointerCapture(state.pointerId)) {
      svg.releasePointerCapture(state.pointerId);
    }
    state.handleId = '';
    state.pointerId = null;
    state.pending = null;
    svg.style.cursor = state.locked ? 'default' : 'crosshair';
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    if (state.locked) release();
    svg.style.touchAction = state.locked ? 'auto' : 'none';
    svg.style.cursor = state.locked ? 'default' : 'crosshair';
  }

  function destroy() {
    release();
    if (state.frame) cancelAnimationFrame(state.frame);
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return { setLocked, isLocked: () => state.locked, destroy };
}

function cursorFor(handle) {
  if (handle.axis === 'y') return 'ns-resize';
  if (handle.axis === 'x') return 'ew-resize';
  const vertical = handle.edgeY ? (handle.edgeY === 'max' ? 'n' : 's') : '';
  const horizontal = handle.edgeX ? (handle.edgeX === 'max' ? 'e' : 'w') : '';
  return `${vertical}${horizontal}-resize`;
}
