import { buildOverlayGeometry, pickCamera, resolveCameraDrag } from '../render/setupOverlay.js';

const MIN_HITBOX_RADIUS_PX = 28; // matches dragController; generous for touch

/**
 * Drag an elevation's camera on the plan.
 *
 * This is the plant drag controller's sibling: same pointer capture, same
 * rAF-throttled repaint, same generous hit radius. It owns the pointer only in
 * Setup mode, where the plant controllers are locked, so the two never compete.
 *
 * There is exactly one thing to drag. A view's rectangle is derived from the
 * declared yard, so the guides over it are a fixed reference; where an
 * elevation is looked at from is the one per-view number the yard cannot
 * supply. It is a position on that elevation's depth axis, which runs into the
 * page in its own drawing and is a line on the plan — so the control lives on
 * the plan, and the patch it reports is for a DIFFERENT view than the one being
 * dragged in. That is the oddity worth knowing about this controller.
 *
 * Every gesture reports `{ id, viewerAtFt }` through `onChange`; the app
 * validates it before it becomes live, which is why nothing here mutates the
 * views it was handed.
 *
 * @param {{ svg: SVGSVGElement, getView: () => object, getViews: () => Array<object>,
 *           getYard: () => object,
 *           onChange: (patch: object) => void, onCommit?: () => void }} options
 */
export function createSetupController({ svg, getView, getViews, getYard, onChange, onCommit }) {
  const state = { locked: true, cameraId: '', pointerId: null, frame: 0, pending: null };

  if (!svg) {
    return {
      setLocked: () => {},
      isLocked: () => true,
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
      scaleFactor: Math.max(scaleX, scaleY),
    };
  }

  function cameraAt(context) {
    const geometry = buildOverlayGeometry(context.view, {
      yardFt: getYard?.(),
      views: getViews?.() || [],
    });
    return pickCamera(geometry, context.point, MIN_HITBOX_RADIUS_PX * context.scaleFactor);
  }

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const context = toViewBoxPoint(event);
    if (!context) return;

    const camera = cameraAt(context);
    if (!camera) return;
    state.cameraId = camera.id;
    state.pointerId = event.pointerId;
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = 'grabbing';
    event.preventDefault();
  }

  function handlePointerMove(event) {
    if (state.locked) return;
    const context = toViewBoxPoint(event);
    if (!state.cameraId || event.pointerId !== state.pointerId) {
      updateHoverCursor(context);
      return;
    }
    if (!context) return;
    state.pending = resolveCameraDrag(
      context.view,
      state.cameraId,
      context.point,
      getViews?.() || []
    );
    queueChange();
    event.preventDefault();
  }

  function updateHoverCursor(context) {
    if (!context) return;
    const camera = cameraAt(context);
    svg.style.cursor = camera ? (camera.axis === 'y' ? 'ns-resize' : 'ew-resize') : restingCursor();
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    const wasDragging = Boolean(state.cameraId);
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
    if (state.pending) onChange?.(state.pending);
    state.pending = null;
  }

  /**
   * Coalesce to one change per frame. Moving a camera re-culls and re-sorts
   * every elevation, so an unthrottled stream would redraw the whole page per
   * pointermove.
   */
  function queueChange() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      const payload = state.pending;
      state.pending = null;
      if (payload) onChange?.(payload);
    });
  }

  function release() {
    if (state.pointerId !== null && svg.hasPointerCapture(state.pointerId)) {
      svg.releasePointerCapture(state.pointerId);
    }
    state.cameraId = '';
    state.pointerId = null;
    state.pending = null;
    svg.style.cursor = restingCursor();
  }

  function restingCursor() {
    return state.locked ? 'default' : 'default';
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

  return { setLocked, isLocked: () => state.locked, destroy };
}
