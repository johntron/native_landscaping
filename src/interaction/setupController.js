import {
  buildOverlayGeometry,
  isOverPhoto,
  pickCamera,
  pickPhotoHandle,
  resolveCameraDrag,
  resolvePhotoDrag,
  resolvePhotoResize,
} from '../render/setupOverlay.js';

const MIN_HITBOX_RADIUS_PX = 28; // matches dragController; generous for touch

/**
 * Drag an elevation's camera on the plan.
 *
 * This is the plant drag controller's sibling: same pointer capture, same
 * rAF-throttled repaint, same generous hit radius. It owns the pointer only in
 * Setup mode, where the plant controllers are locked, so the two never compete.
 *
 * A view's rectangle is derived from the declared yard, so the guides over it
 * are a fixed reference and nothing in them is a control. Three things are:
 *
 * 1. a corner of the photograph, which scales it about the opposite corner;
 * 2. the photograph itself, which slides;
 * 3. an elevation's camera, which is the one per-view number the yard cannot
 *    supply — a position on that elevation's depth axis, which runs into the
 *    page in its own drawing and is a line on the plan. So the control lives on
 *    the plan and the patch it reports is for a DIFFERENT view than the one
 *    being dragged in, which is the oddity worth knowing here.
 *
 * Hit-tested in that order, smallest target first: a camera line crossing the
 * photo must not swallow the corner grip sitting on it.
 *
 * Every gesture reports a patch through `onChange`; the app validates it before
 * it becomes live, which is why nothing here mutates the views it was handed.
 *
 * @param {{ svg: SVGSVGElement, getView: () => object, getViews: () => Array<object>,
 *           getLayout: () => object, getPhotoAspect: () => number,
 *           onChange: (patch: object) => void, onCommit?: () => void }} options
 */
export function createSetupController({
  svg,
  getView,
  getViews,
  getLayout,
  getPhotoAspect,
  onChange,
  onCommit,
}) {
  const state = {
    locked: true,
    gesture: null,
    pointerId: null,
    frame: 0,
    pending: null,
  };

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

  /**
   * Screen point to drawing point, read from the SVG's OWN viewBox rather than
   * the view's declared one. Setup widens the box to leave room around the
   * drawing for a photo that reaches past it, and a converter that assumed the
   * declared box would put every gesture in the wrong place there.
   */
  function toViewBoxPoint(event) {
    const view = getView?.();
    if (!view) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const box = svg.viewBox?.baseVal;
    const width = box?.width || view.viewBox.width;
    const height = box?.height || view.viewBox.height;
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    return {
      view,
      point: {
        x: (box?.x || 0) + (event.clientX - rect.left) * scaleX,
        y: (box?.y || 0) + (event.clientY - rect.top) * scaleY,
      },
      scaleFactor: Math.max(scaleX, scaleY),
    };
  }

  function geometryFor(view) {
    return buildOverlayGeometry(view, {
      ...(getLayout?.() || {}),
      views: getViews?.() || [],
      photoAspect: getPhotoAspect?.() || 0,
    });
  }

  /** What the pointer is over, smallest target first. */
  function gestureAt(context) {
    const geometry = geometryFor(context.view);
    const radius = MIN_HITBOX_RADIUS_PX * context.scaleFactor;
    const handle = pickPhotoHandle(geometry, context.point, radius);
    if (handle) return { kind: 'photo-resize', handleId: handle.id, handle, geometry };
    const camera = pickCamera(geometry, context.point, radius);
    if (camera) return { kind: 'camera', id: camera.id, camera };
    if (isOverPhoto(geometry, context.point)) return { kind: 'photo-move' };
    return null;
  }

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const context = toViewBoxPoint(event);
    if (!context) return;

    const gesture = gestureAt(context);
    if (!gesture) return;
    // The view as it was when the gesture began; every frame is solved against
    // this one, never against the state it has already moved to.
    state.gesture = { ...gesture, from: context.point, view: context.view };
    state.pointerId = event.pointerId;
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor =
      gesture.kind === 'photo-resize' ? cursorFor(gesture.handle, gesture.geometry) : 'grabbing';
    event.preventDefault();
  }

  function handlePointerMove(event) {
    if (state.locked) return;
    const context = toViewBoxPoint(event);
    if (!state.gesture || event.pointerId !== state.pointerId) {
      updateHoverCursor(context);
      return;
    }
    if (!context) return;
    state.pending = solve(state.gesture, context.point);
    queueChange();
    event.preventDefault();
  }

  function solve(gesture, point) {
    const aspect = getPhotoAspect?.() || 0;
    if (gesture.kind === 'camera') {
      return resolveCameraDrag(gesture.view, gesture.id, point, getViews?.() || []);
    }
    if (gesture.kind === 'photo-resize') {
      return resolvePhotoResize(gesture.view, gesture.handleId, point, aspect);
    }
    return resolvePhotoDrag(gesture.view, gesture.from, point, aspect);
  }

  function updateHoverCursor(context) {
    if (!context) return;
    const gesture = gestureAt(context);
    if (!gesture) {
      svg.style.cursor = restingCursor();
      return;
    }
    if (gesture.kind === 'photo-resize') {
      svg.style.cursor = cursorFor(gesture.handle, gesture.geometry);
    }
    else if (gesture.kind === 'camera') {
      svg.style.cursor = gesture.camera.axis === 'y' ? 'ns-resize' : 'ew-resize';
    } else svg.style.cursor = 'grab';
  }

  /**
   * Diagonal resize cursor, taken from where the grip sits on SCREEN rather
   * than from which corner in feet it is. A cursor is a promise about which way
   * the pointer will go, and on a plan the low-y corner is the bottom one.
   */
  function cursorFor(handle, geometry) {
    const rect = geometry?.photo?.rect;
    if (!rect) return 'nwse-resize';
    const vertical = handle.y < rect.y + rect.height / 2 ? 'n' : 's';
    const horizontal = handle.x < rect.x + rect.width / 2 ? 'w' : 'e';
    return `${vertical}${horizontal}-resize`;
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    const wasDragging = Boolean(state.gesture);
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
   * every elevation, and moving a photo repaints the drawing, so an unthrottled
   * stream would redraw everything per pointermove.
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
    state.gesture = null;
    state.pointerId = null;
    state.pending = null;
    svg.style.removeProperty('cursor');
  }

  /**
   * Nothing here claims the resting cursor. Three controllers share this
   * element and the last writer wins (nl-jfm), so the only cursors this one
   * sets are the ones it owns outright: a resize over a camera, a grab while
   * dragging one. Locking clears this controller's own inline value instead
   * of asserting 'default', which used to stomp is-drag-enabled/
   * is-features-enabled's cursor whenever setLocked ran after theirs.
   */
  function restingCursor() {
    return 'default';
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    if (state.locked) release();
    // See dragController: this element has two controllers, so touch-action is
    // expressed as a class rather than an inline property they overwrite.
    svg.classList.toggle('is-setup-enabled', !state.locked);
  }

  function destroy() {
    release();
    if (state.frame) cancelAnimationFrame(state.frame);
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return { setLocked, isLocked: () => state.locked, destroy };
}
