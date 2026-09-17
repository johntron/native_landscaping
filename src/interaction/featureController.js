import {
  buildFeatureHandles,
  grabOffsetFor,
  pickFeatureAt,
  pickFeatureHandle,
  resolveFeatureDrag,
} from '../render/featureOverlay.js';

const MIN_HITBOX_RADIUS_PX = 28; // matches dragController; generous for touch

/**
 * Edit yard features on the plan.
 *
 * The setup controller's sibling, deliberately: same pointer capture, same
 * rAF-throttled repaint, same generous hit radius. It owns the pointer only in
 * Features mode, where the plant and setup controllers are locked, so the three
 * never compete for one SVG.
 *
 * Every gesture reports a candidate feature through `onChange`; the app
 * validates it before it becomes live, which is why nothing here mutates the
 * feature it was handed. A rejected edit therefore leaves the drawing exactly
 * where it was.
 *
 * @param {{ svg: SVGSVGElement, getTransform: () => object,
 *           getFeatures: () => Array<object>, getSelectedId: () => string,
 *           onSelect: (id: string) => void,
 *           onChange: (feature: object) => void, onCommit?: () => void }} options
 */
export function createFeatureController({
  svg,
  getTransform,
  getFeatures,
  getSelectedId,
  onSelect,
  onChange,
  onCommit,
}) {
  const state = {
    locked: true,
    handleId: '',
    featureId: '',
    grabOffsetFt: null,
    pointerId: null,
    frame: 0,
    pending: null,
    moved: false,
  };

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

  /** Screen point to viewBox point, and on to yard feet. */
  function toContext(event) {
    const transform = getTransform?.();
    if (!transform) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scaleX = transform.viewBox.width / rect.width;
    const scaleY = transform.viewBox.height / rect.height;
    const point = {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
    return {
      transform,
      point,
      // A detail crop is a plan view with its own origin and extent, so the
      // pointer becomes YARD feet here rather than feet within this view.
      pointFt: transform.viewBoxToPlan(point),
      scaleFactor: Math.max(scaleX, scaleY),
    };
  }

  function selectedFeature(features) {
    const id = getSelectedId?.() || '';
    return features.find((feature) => feature.id === id) || null;
  }

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const context = toContext(event);
    if (!context) return;
    const features = getFeatures?.() || [];
    const radius = MIN_HITBOX_RADIUS_PX * context.scaleFactor;

    // A vertex of the shape already selected wins over the shapes underneath:
    // otherwise a corner sitting inside a neighbouring bed can never be grabbed.
    const selected = selectedFeature(features);
    const handle = selected
      ? pickFeatureHandle(buildFeatureHandles(selected, context.transform), context.point, radius)
      : null;

    if (handle) {
      begin(event, selected.id, handle.id, null);
      return;
    }

    const hit = pickFeatureAt(features, context.transform, context.point, radius);
    if (!hit) {
      // A click on bare ground clears the selection rather than doing nothing,
      // so there is a way out of a selection on a touch screen.
      onSelect?.('');
      return;
    }
    if (hit.id !== (getSelectedId?.() || '')) onSelect?.(hit.id);
    begin(event, hit.id, 'move', grabOffsetFor(hit, context.pointFt));
  }

  function begin(event, featureId, handleId, grabOffsetFt) {
    state.featureId = featureId;
    state.handleId = handleId;
    state.grabOffsetFt = grabOffsetFt;
    state.pointerId = event.pointerId;
    state.moved = false;
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = 'grabbing';
    event.preventDefault();
  }

  function handlePointerMove(event) {
    if (state.locked) return;
    const context = toContext(event);
    if (!state.handleId || event.pointerId !== state.pointerId) {
      updateHoverCursor(context);
      return;
    }
    if (!context) return;
    const feature = (getFeatures?.() || []).find((entry) => entry.id === state.featureId);
    if (!feature) return;
    state.pending = resolveFeatureDrag(
      feature,
      state.handleId,
      context.pointFt,
      state.grabOffsetFt || { x: 0, y: 0 }
    );
    state.moved = true;
    queueChange();
    event.preventDefault();
  }

  function updateHoverCursor(context) {
    if (!context) return;
    const features = getFeatures?.() || [];
    const radius = MIN_HITBOX_RADIUS_PX * context.scaleFactor;
    const selected = selectedFeature(features);
    const handle = selected
      ? pickFeatureHandle(buildFeatureHandles(selected, context.transform), context.point, radius)
      : null;
    if (handle) {
      svg.style.cursor = 'grab';
      return;
    }
    const hit = pickFeatureAt(features, context.transform, context.point, radius);
    svg.style.cursor = hit ? 'move' : restingCursor();
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    const changed = state.moved;
    // A flick can finish inside a single frame; without this the coalesced
    // change is still pending when release() drops it and the gesture is lost.
    flushPending();
    release();
    if (changed) onCommit?.();
  }

  function flushPending() {
    if (state.frame) {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    }
    if (state.pending) onChange?.(state.pending);
    state.pending = null;
  }

  /** Coalesce to one change per frame: a drag re-renders every view. */
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
    state.handleId = '';
    state.featureId = '';
    state.grabOffsetFt = null;
    state.pointerId = null;
    state.pending = null;
    state.moved = false;
    // Resting cursor comes from is-features-enabled in styles.css, not from
    // here: this element can have several controllers, and whichever last
    // wrote svg.style.cursor used to decide it for all of them (nl-jfm).
    // Clearing the inline value drops back to whatever the class rule says.
    svg.style.removeProperty('cursor');
  }

  function restingCursor() {
    return state.locked ? 'default' : 'crosshair';
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    if (state.locked) release();
    // See dragController: this element has several controllers, so touch-action
    // is expressed as a class rather than an inline property they overwrite.
    svg.classList.toggle('is-features-enabled', !state.locked);
  }

  function destroy() {
    release();
    if (state.frame) cancelAnimationFrame(state.frame);
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return { setLocked, isLocked: () => state.locked, destroy };
}
