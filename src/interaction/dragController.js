import { clientPointToViewBox } from '../render/screenPoint.js';
import { exceedsTapThreshold, resolveTapSelection } from './tapSelection.js';
import { clampGroupAxisDelta, clampGroupDelta } from '../render/groupClamp.js';

const MIN_HITBOX_RADIUS_PX = 28; // generous target for touch devices

/**
 * Enables drag-to-move on the plan view while keeping rendering logic separate.
 * Hit-testing is based on proximity, so even tiny plants get a workable handle.
 *
 * Mouse and touch/pen diverge here (nl-o47.2). Mouse keeps the original
 * grab-on-press model: pointerdown finds and grabs the nearest plant outright,
 * because "press and drag" works well with a precise pointer and a hover
 * preview. Touch/pen no longer grabs on pointerdown at all — a TAP (little
 * enough movement between down and up) SELECTS a plant instead, and only once
 * something is selected does a one-finger drag, starting ANYWHERE on this
 * drawing, move the whole selection by the finger's delta. That is what stops
 * a drag from ever grabbing the wrong small plant: only a tap can change the
 * selection.
 *
 * @param {Object} options
 * @param {SVGSVGElement} options.svg
 * @param {() => Array<any>} options.getPlants
 * @param {() => object} options.getTransform view transform for the panel being dragged
 * @param {() => {x:{min,max},y:{min,max}}|null} [options.getBounds]
 * @param {() => void} options.onPositionsChange
 * @param {(plantId: string) => void} [options.onHoverPlant]
 * @param {() => void} [options.onChangeCommit]
 * @param {() => Set<string>} [options.getSelection]   the current Edit-mode selection
 * @param {(plantId: string) => void} [options.onSelectPlant]   replace the selection with just this plant
 * @param {() => void} [options.onClearSelection]
 */
export function createPlantDragController({
  svg,
  getPlants,
  getTransform,
  getBounds,
  onPositionsChange,
  onHoverPlant,
  onChangeCommit,
  getSelection = () => new Set(),
  onSelectPlant = () => {},
  onClearSelection = () => {},
}) {
  const state = {
    locked: true,
    renderQueued: false,
    hoveredPlantId: '',
    hasMoved: false,
    pointerId: null,
    pointerType: '',

    // Mouse only: the single plant grabbed on pointerdown.
    activePlant: null,
    offsetFeet: { x: 0, y: 0 },

    // Touch/pen only: the pending gesture, decided at pointerup as a tap or a
    // (group) drag. downCtx is the full pointer context computed at
    // pointerdown, reused at pointerup for hit-testing — the SVG's screenCTM
    // has no reason to change mid-gesture.
    downClient: null,
    downCtx: null,
    groupStartFeet: null, // Map<plantId, {x,y}> snapshot, or null if nothing was selected
    isDraggingGroup: false,
    // The tap-cycle tracker, kept ACROSS gestures (reset only on setLocked):
    // {point, order, index}. See tapSelection.js.
    tapCandidate: null,
  };

  if (!svg) {
    return {
      setLocked: () => {},
      isLocked: () => true,
      setSelectionActive: () => {},
      destroy: () => {},
    };
  }

  const listeners = [
    ['pointerdown', handlePointerDown],
    ['pointermove', handlePointerMove],
    ['pointerup', handlePointerUp],
    ['pointercancel', handlePointerCancel],
    ['lostpointercapture', handlePointerCancel],
    ['pointerleave', handlePointerLeave],
  ];
  listeners.forEach(([type, handler]) => svg.addEventListener(type, handler));

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;

    if (event.pointerType === 'mouse') {
      if (event.button !== 0) return;
      const ctx = buildPointerContext(svg, event, getTransform());
      if (!ctx) {
        notifyHover('');
        return;
      }
      const hit = pickPlantHit(getPlants(), ctx);
      if (!hit) {
        notifyHover('');
        onClearSelection();
        return;
      }
      state.activePlant = hit.plant;
      state.pointerId = event.pointerId;
      state.pointerType = 'mouse';
      state.offsetFeet = {
        x: ctx.positionFeet.x - hit.plant.x,
        y: ctx.positionFeet.y - hit.plant.y,
      };
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
      notifyHover(state.activePlant.id);
      state.hasMoved = false;
      // Pressing a plant also selects it (nl-o47.2) — mouse never needs a
      // separate tap step the way touch does. This renders SYNCHRONOUSLY
      // (selectPlants -> render()), unlike anything pointerdown used to
      // trigger, which is exactly what exposed setupController.js/
      // featureController.js's own setLocked to being called redundantly
      // inside this same call stack and clearing the cursor just set above —
      // see their setLocked for the idempotency guard that now prevents it.
      onSelectPlant(state.activePlant.id);
      event.preventDefault();
      return;
    }

    // Touch/pen: no grab yet. Snapshot enough to decide, on pointerup,
    // whether this was a tap (select) or a drag (move the selection).
    const ctx = buildPointerContext(svg, event, getTransform());
    state.pointerId = event.pointerId;
    state.pointerType = event.pointerType;
    state.downClient = { x: event.clientX, y: event.clientY };
    state.downCtx = ctx;
    state.isDraggingGroup = false;
    state.hasMoved = false;
    state.groupStartFeet = null;

    const selection = getSelection();
    if (selection.size && ctx) {
      const snapshot = new Map();
      getPlants().forEach((plant) => {
        if (selection.has(String(plant.id))) {
          snapshot.set(String(plant.id), { x: plant.x, y: plant.y });
        }
      });
      if (snapshot.size) state.groupStartFeet = snapshot;
    }
    // Captured unconditionally, whether or not a drag turns out to be
    // possible: once a group move starts, onPositionsChange re-renders the
    // panel on every frame, which REPLACES the element that received this
    // touch's implicit target. Without an explicit capture on `svg` itself,
    // later pointermove/pointerup events would have nothing to bubble from.
    // This is not preventDefault — touch-action alone decides whether the
    // browser also scrolls, and long-press contextmenu is untouched (nl-3vs).
    svg.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event) {
    if (event.pointerType === 'mouse') {
      const ctx = buildPointerContext(svg, event, getTransform());
      updateHoverFromContext(event, ctx);
      if (!state.activePlant || event.pointerId !== state.pointerId) return;
      if (!ctx) return;
      updatePlantPosition(ctx);
      event.preventDefault();
      return;
    }

    if (event.pointerId !== state.pointerId) return;
    if (!state.groupStartFeet) return; // nothing selected at down: let the page scroll
    const dxClient = event.clientX - state.downClient.x;
    const dyClient = event.clientY - state.downClient.y;
    if (!state.isDraggingGroup) {
      if (!exceedsTapThreshold(dxClient, dyClient)) return;
      state.isDraggingGroup = true;
    }
    const ctx = buildPointerContext(svg, event, getTransform());
    if (!ctx || !state.downCtx) return;
    updateGroupPosition(ctx);
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;

    if (state.pointerType === 'mouse') {
      const ctx = buildPointerContext(svg, event, getTransform());
      const moved = state.hasMoved;
      cancelActive();
      if (moved) onChangeCommit?.();
      updateHoverFromContext(event, ctx);
      return;
    }

    const wasDraggingGroup = state.isDraggingGroup;
    const moved = state.hasMoved;
    const downCtx = state.downCtx;
    const downClient = state.downClient;
    cancelActive();
    if (wasDraggingGroup) {
      if (moved) onChangeCommit?.();
      return;
    }
    resolveTap(downCtx, downClient);
  }

  function handlePointerCancel(event) {
    if (event.pointerId !== state.pointerId) return;
    const pointerType = state.pointerType;
    const wasDraggingGroup = state.isDraggingGroup;
    const moved = state.hasMoved;
    cancelActive();
    // A cancel/lost-capture with no move in progress usually means the
    // browser took the gesture over (a scroll it decided on, mid-slop); that
    // is not a completed tap, so the selection is left alone. A drag already
    // under way is salvaged, same as pointerup would have done.
    if (moved && (pointerType === 'mouse' || wasDraggingGroup)) {
      onChangeCommit?.();
    }
  }

  /** A completed tap (touch/pen): select the nearest candidate at the down
   * position, or cycle to the next one if this repeats the last tap's spot. */
  function resolveTap(ctx, point) {
    const candidates = ctx
      ? pickPlantHits(getPlants(), ctx).map((hit) => ({ id: hit.plant.id }))
      : [];
    const { selectedId, nextTap } = resolveTapSelection(candidates, point, state.tapCandidate);
    state.tapCandidate = nextTap;
    if (selectedId) {
      onSelectPlant(selectedId);
    } else {
      onClearSelection();
    }
  }

  function handlePointerLeave() {
    if (state.activePlant) return;
    notifyHover('');
  }

  /** Mouse-only: hover has no touch equivalent, and updating it from a
   * touch's pointermove would draw a target ring chasing the finger during a
   * group drag (nl-o47.2). */
  function updateHoverFromContext(event, context) {
    if (!event?.isPrimary) return;
    if (state.activePlant) {
      notifyHover(state.activePlant.id);
      return;
    }
    if (!context) {
      notifyHover('');
      return;
    }
    const hit = pickPlantHit(getPlants(), context);
    notifyHover(hit ? hit.plant.id : '');
  }

  function notifyHover(plantId) {
    const normalized = plantId ? String(plantId) : '';
    if (state.hoveredPlantId === normalized) return;
    state.hoveredPlantId = normalized;
    if (typeof onHoverPlant === 'function') {
      onHoverPlant(normalized);
    }
  }

  /** Mouse only: move the single grabbed plant, exactly as before nl-o47.2. */
  function updatePlantPosition(ctx) {
    const { transform, positionFeet } = ctx;
    // A plant stays inside the shared yard bounds, not this view's own extent —
    // see render/yardBounds.js for why the two differ.
    const bounds = boundsFor(getBounds, transform);
    const clampX = clamp(positionFeet.x - state.offsetFeet.x, bounds.x.min, bounds.x.max);
    const clampY = clamp(positionFeet.y - state.offsetFeet.y, bounds.y.min, bounds.y.max);
    const previousX = state.activePlant.x;
    const previousY = state.activePlant.y;

    state.activePlant.x = clampX;
    state.activePlant.y = clampY;

    const movedEnough = Math.abs(clampX - previousX) > 1e-6 || Math.abs(clampY - previousY) > 1e-6;
    if (movedEnough) {
      state.hasMoved = true;
    }
    queueRender();
  }

  /**
   * Touch/pen group drag: every selected plant moves by the SAME delta from
   * where it stood at pointerdown, clamped as a group (src/render/groupClamp.js)
   * so the group keeps its shape rather than each member independently
   * hugging the yard edge.
   */
  function updateGroupPosition(ctx) {
    const rawDelta = {
      x: ctx.positionFeet.x - state.downCtx.positionFeet.x,
      y: ctx.positionFeet.y - state.downCtx.positionFeet.y,
    };
    const bounds = boundsFor(getBounds, ctx.transform);
    const positions = [...state.groupStartFeet.values()];
    const clampedDelta = clampGroupDelta(positions, rawDelta, bounds);
    const plants = getPlants();
    let moved = false;
    state.groupStartFeet.forEach((start, id) => {
      const plant = plants.find((candidate) => String(candidate.id) === id);
      if (!plant) return; // pruned meanwhile (shouldn't happen mid-gesture, but never assume)
      const nextX = start.x + clampedDelta.x;
      const nextY = start.y + clampedDelta.y;
      if (Math.abs(nextX - plant.x) > 1e-6 || Math.abs(nextY - plant.y) > 1e-6) {
        moved = true;
      }
      plant.x = nextX;
      plant.y = nextY;
    });
    if (moved) state.hasMoved = true;
    queueRender();
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      onPositionsChange?.();
    });
  }

  function cancelActive() {
    if (state.pointerId !== null && svg.hasPointerCapture(state.pointerId)) {
      svg.releasePointerCapture(state.pointerId);
    }
    state.activePlant = null;
    state.pointerId = null;
    state.pointerType = '';
    state.offsetFeet = { x: 0, y: 0 };
    state.hasMoved = false;
    state.downClient = null;
    state.downCtx = null;
    state.groupStartFeet = null;
    state.isDraggingGroup = false;
    // Resting cursor comes from is-drag-enabled in styles.css, not from here:
    // this element can have several controllers, and whichever last wrote
    // svg.style.cursor used to decide it for all of them (nl-jfm). Clearing
    // the inline value just drops this controller's own grabbing cursor back
    // to whatever the class rule says.
    svg.style.removeProperty('cursor');
  }

  function setLocked(locked) {
    const next = Boolean(locked);
    // Idempotent: applyMode calls this on every rebuild/mode-apply, changed or
    // not (see setupController.js's own copy of this guard for the render-
    // reentrancy this protects against, found via nl-o47.2's onSelectPlant).
    if (next === state.locked) return;
    state.locked = next;
    if (state.locked) {
      cancelActive();
      notifyHover('');
      // A stale cycle position must not survive a mode change (nl-o47.2):
      // "clear on mode change" applies to where the NEXT tap starts from too.
      state.tapCandidate = null;
      svg.classList.remove('is-selection-active');
    }
    // A class, not svg.style.touchAction: the setup controller shares this
    // element and also has a say, and whichever wrote the inline property last
    // silently won. Each controller now toggles its own class and CSS combines
    // them. See the touch rules in styles.css.
    svg.classList.toggle('is-drag-enabled', !state.locked);
  }

  /**
   * Touch-action is keyed to the SELECTION now, not to Edit mode outright
   * (nl-o47.2): the drawing claims a touch only once something is selected,
   * so an empty selection still scrolls like the rest of the page. Called by
   * src/app.js whenever the selection changes, and after every mode change/
   * rebuild (through applyMode), never from inside this controller itself —
   * it has no way to hear about a selection change on its own.
   */
  function setSelectionActive(active) {
    svg.classList.toggle('is-selection-active', Boolean(active) && !state.locked);
  }

  /**
   * Setup mode rebuilds panels, and configureViews reuses the SVG of a view
   * whose id did not change — so a controller that outlives its rebuild would
   * double-bind to the same element.
   */
  function destroy() {
    cancelActive();
    svg.classList.remove('is-drag-enabled', 'is-selection-active');
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return {
    setLocked,
    isLocked: () => state.locked,
    setSelectionActive,
    destroy,
  };
}

/**
 * Drag along one yard axis from an elevation view.
 *
 * The pointer maps back through the view's own transform, so the mirrored
 * directions come out right without this file knowing the compass table —
 * otherwise dragging in a mirrored view moves plants backwards.
 *
 * Touch/pen follows the same tap-selects / drag-moves-the-selection model as
 * the plan controller above (nl-o47.2), one axis instead of two. Hit-testing
 * here goes through the DOM (findPlantIdFromEvent), so the id under a touch
 * has to be read AT POINTERDOWN — once this controller captures the pointer,
 * `event.target` on later events is the svg itself, not whatever silhouette
 * the finger first landed on.
 */
export function createElevationDragController({
  svg,
  getPlants,
  getTransform,
  getBounds,
  onPositionsChange,
  onHoverPlant,
  onChangeCommit,
  getSelection = () => new Set(),
  onSelectPlant = () => {},
  onClearSelection = () => {},
}) {
  const state = {
    locked: true,
    renderQueued: false,
    hoveredPlantId: '',
    hasMoved: false,
    pointerId: null,
    pointerType: '',

    // Mouse only.
    activePlant: null,
    axisOffsetFeet: 0,

    // Touch/pen only.
    downClient: null,
    downPlantId: '', // read from the DOM at pointerdown; see the module comment
    downAxisFeet: null,
    axisKey: '',
    groupStartAxis: null, // Map<plantId, axisValue>, or null if nothing was selected
    isDraggingGroup: false,
    tapCandidate: null,
  };

  if (!svg) {
    return {
      setLocked: () => {},
      isLocked: () => true,
      setSelectionActive: () => {},
      destroy: () => {},
    };
  }

  const listeners = [
    ['pointerdown', handlePointerDown],
    ['pointermove', handlePointerMove],
    ['pointerup', handlePointerUp],
    ['pointercancel', handlePointerCancel],
    ['lostpointercapture', handlePointerCancel],
    ['pointerleave', handlePointerLeave],
  ];
  listeners.forEach(([type, handler]) => svg.addEventListener(type, handler));

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;

    if (event.pointerType === 'mouse') {
      if (event.button !== 0) return;
      const ctx = buildPointerContext(svg, event, getTransform());
      if (!ctx) {
        notifyHover('');
        return;
      }
      const plantId = findPlantIdFromEvent(event);
      if (!plantId) {
        notifyHover('');
        onClearSelection();
        return;
      }
      const target = getPlants().find((plant) => String(plant.id) === String(plantId));
      if (!target) {
        notifyHover('');
        onClearSelection();
        return;
      }
      state.activePlant = target;
      state.pointerId = event.pointerId;
      state.pointerType = 'mouse';
      const axisPosition = pointerAxisFeet(ctx);
      const axisValue = Number(target[axisKeyFor(ctx)]) || 0;
      state.axisOffsetFeet = axisPosition - axisValue;
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
      notifyHover(target.id);
      state.hasMoved = false;
      onSelectPlant(target.id);
      event.preventDefault();
      return;
    }

    const ctx = buildPointerContext(svg, event, getTransform());
    state.pointerId = event.pointerId;
    state.pointerType = event.pointerType;
    state.downClient = { x: event.clientX, y: event.clientY };
    state.downPlantId = findPlantIdFromEvent(event);
    state.isDraggingGroup = false;
    state.hasMoved = false;
    state.groupStartAxis = null;
    state.downAxisFeet = ctx ? pointerAxisFeet(ctx) : null;
    state.axisKey = ctx ? axisKeyFor(ctx) : '';

    const selection = getSelection();
    if (selection.size && ctx) {
      const axisKey = state.axisKey;
      const snapshot = new Map();
      getPlants().forEach((plant) => {
        if (selection.has(String(plant.id))) {
          snapshot.set(String(plant.id), Number(plant[axisKey]) || 0);
        }
      });
      if (snapshot.size) state.groupStartAxis = snapshot;
    }
    // See the plan controller's own comment: captured unconditionally so a
    // group move's re-renders cannot orphan later pointer events.
    svg.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event) {
    if (event.pointerType === 'mouse') {
      const ctx = buildPointerContext(svg, event, getTransform());
      updateHoverFromContext(event);
      if (!state.activePlant || event.pointerId !== state.pointerId) return;
      if (!ctx) return;
      updatePlantPosition(ctx);
      event.preventDefault();
      return;
    }

    if (event.pointerId !== state.pointerId) return;
    if (!state.groupStartAxis) return;
    const dxClient = event.clientX - state.downClient.x;
    const dyClient = event.clientY - state.downClient.y;
    if (!state.isDraggingGroup) {
      if (!exceedsTapThreshold(dxClient, dyClient)) return;
      state.isDraggingGroup = true;
    }
    const ctx = buildPointerContext(svg, event, getTransform());
    if (!ctx || state.downAxisFeet === null) return;
    updateGroupAxisPosition(ctx);
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;

    if (state.pointerType === 'mouse') {
      const moved = state.hasMoved;
      cancelActive();
      if (moved) onChangeCommit?.();
      updateHoverFromContext(event);
      return;
    }

    const wasDraggingGroup = state.isDraggingGroup;
    const moved = state.hasMoved;
    const downPlantId = state.downPlantId;
    const downClient = state.downClient;
    cancelActive();
    if (wasDraggingGroup) {
      if (moved) onChangeCommit?.();
      return;
    }
    const candidates = downPlantId ? [{ id: downPlantId }] : [];
    const { selectedId, nextTap } = resolveTapSelection(candidates, downClient, state.tapCandidate);
    state.tapCandidate = nextTap;
    if (selectedId) {
      onSelectPlant(selectedId);
    } else {
      onClearSelection();
    }
  }

  function handlePointerCancel(event) {
    if (event.pointerId !== state.pointerId) return;
    const pointerType = state.pointerType;
    const wasDraggingGroup = state.isDraggingGroup;
    const moved = state.hasMoved;
    cancelActive();
    if (moved && (pointerType === 'mouse' || wasDraggingGroup)) {
      onChangeCommit?.();
    }
  }

  function handlePointerLeave() {
    if (state.activePlant) return;
    notifyHover('');
  }

  /** Mouse-only, same reasoning as the plan controller. */
  function updateHoverFromContext(event) {
    if (!event?.isPrimary) return;
    if (state.activePlant) {
      notifyHover(state.activePlant.id);
      return;
    }
    const plantId = findPlantIdFromEvent(event);
    notifyHover(plantId);
  }

  function notifyHover(plantId) {
    const normalized = plantId ? String(plantId) : '';
    if (state.hoveredPlantId === normalized) return;
    state.hoveredPlantId = normalized;
    if (typeof onHoverPlant === 'function') {
      onHoverPlant(normalized);
    }
  }

  function axisKeyFor(ctx) {
    return ctx.transform.orientation.axisKey;
  }

  function pointerAxisFeet(ctx) {
    return ctx.transform.xToAxis(ctx.viewBoxPoint.x);
  }

  /** Mouse only: move the single grabbed plant, exactly as before nl-o47.2. */
  function updatePlantPosition(ctx) {
    const axisKey = axisKeyFor(ctx);
    // The drawing may reach farther along this axis than the yard does; clamp to
    // the yard so the plant cannot slide out of the plan view. Without shared
    // bounds, fall back to the horizontal extent of this drawing — originFt.x
    // and extentFt.width are the axis, whichever yard axis that happens to be.
    const { originFt, extentFt } = ctx.transform;
    const shared = typeof getBounds === 'function' ? getBounds() : null;
    const axisBounds = shared?.[axisKey] || {
      min: originFt.x,
      max: originFt.x + extentFt.width,
    };
    const rawAxis = pointerAxisFeet(ctx) - state.axisOffsetFeet;
    const clamped = clamp(rawAxis, axisBounds.min, axisBounds.max);
    const previous = state.activePlant[axisKey];
    state.activePlant[axisKey] = clamped;
    if (Math.abs(clamped - previous) > 1e-6) {
      state.hasMoved = true;
    }
    queueRender();
  }

  /** Touch/pen group drag along this elevation's one axis; see groupClamp.js. */
  function updateGroupAxisPosition(ctx) {
    const axisKey = state.axisKey;
    const { originFt, extentFt } = ctx.transform;
    const shared = typeof getBounds === 'function' ? getBounds() : null;
    const axisBounds = shared?.[axisKey] || {
      min: originFt.x,
      max: originFt.x + extentFt.width,
    };
    const rawDelta = pointerAxisFeet(ctx) - state.downAxisFeet;
    const values = [...state.groupStartAxis.values()];
    const clampedDelta = clampGroupAxisDelta(values, rawDelta, axisBounds);
    const plants = getPlants();
    let moved = false;
    state.groupStartAxis.forEach((startValue, id) => {
      const plant = plants.find((candidate) => String(candidate.id) === id);
      if (!plant) return;
      const next = startValue + clampedDelta;
      if (Math.abs(next - plant[axisKey]) > 1e-6) moved = true;
      plant[axisKey] = next;
    });
    if (moved) state.hasMoved = true;
    queueRender();
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      onPositionsChange?.();
    });
  }

  function cancelActive() {
    if (state.pointerId !== null && svg.hasPointerCapture(state.pointerId)) {
      svg.releasePointerCapture(state.pointerId);
    }
    state.activePlant = null;
    state.pointerId = null;
    state.pointerType = '';
    state.axisOffsetFeet = 0;
    state.hasMoved = false;
    state.downClient = null;
    state.downPlantId = '';
    state.downAxisFeet = null;
    state.axisKey = '';
    state.groupStartAxis = null;
    state.isDraggingGroup = false;
    // See createPlantDragController's cancelActive: this element can have
    // several controllers sharing svg.style.cursor (nl-jfm), so this one only
    // clears its own inline value and lets the is-drag-enabled rule resume.
    svg.style.removeProperty('cursor');
  }

  function setLocked(locked) {
    const next = Boolean(locked);
    // Idempotent — see createPlantDragController's copy of this guard.
    if (next === state.locked) return;
    state.locked = next;
    if (state.locked) {
      cancelActive();
      notifyHover('');
      state.tapCandidate = null;
      svg.classList.remove('is-selection-active');
    }
    // A class, not svg.style.touchAction: the setup controller shares this
    // element and also has a say, and whichever wrote the inline property last
    // silently won. Each controller now toggles its own class and CSS combines
    // them. See the touch rules in styles.css.
    svg.classList.toggle('is-drag-enabled', !state.locked);
  }

  /** See createPlantDragController's setSelectionActive. */
  function setSelectionActive(active) {
    svg.classList.toggle('is-selection-active', Boolean(active) && !state.locked);
  }

  /**
   * Setup mode rebuilds panels, and configureViews reuses the SVG of a view
   * whose id did not change — so a controller that outlives its rebuild would
   * double-bind to the same element.
   */
  function destroy() {
    cancelActive();
    svg.classList.remove('is-drag-enabled', 'is-selection-active');
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return {
    setLocked,
    isLocked: () => state.locked,
    setSelectionActive,
    destroy,
  };
}

function pickPlantHits(plants, ctx) {
  const { transform, viewBoxPoint, scaleFactor } = ctx;
  const toPixels = transform.toPx;
  const minRadius = MIN_HITBOX_RADIUS_PX * scaleFactor;
  const candidates = [];

  plants.forEach((plant) => {
    const { x: cx, y: cy } = transform.planToViewBox(plant);
    const dx = viewBoxPoint.x - cx;
    const dy = viewBoxPoint.y - cy;
    const baseRadius = toPixels(plant.width) / 2;
    const hitRadius = Math.max(baseRadius, minRadius);
    const distSq = dx * dx + dy * dy;

    if (distSq <= hitRadius * hitRadius) {
      candidates.push({
        plant,
        distSq,
        height: plant.height || 0,
        hitRadius,
      });
    }
  });

  candidates.sort((a, b) => {
    if (a.distSq !== b.distSq) return a.distSq - b.distSq;
    if (a.height !== b.height) return b.height - a.height;
    return b.hitRadius - a.hitRadius;
  });

  return candidates;
}

/** The single nearest candidate, for mouse's immediate grab. Touch/pen uses
 * the full list from pickPlantHits so a repeat tap can cycle through it. */
function pickPlantHit(plants, ctx) {
  return pickPlantHits(plants, ctx)[0] || null;
}

function findPlantIdFromEvent(event) {
  if (!(event?.target instanceof Element)) return '';
  const group = event.target.closest('[data-plant-id]');
  if (!group) return '';
  return group.getAttribute('data-plant-id') || '';
}

/**
 * Screen point -> viewBox point -> yard feet, using the panel's own transform.
 * The client->viewBox mapping goes through the SVG's screenCTM
 * (src/render/screenPoint.js), which is correct under letterboxing — a rect-
 * based x/y scale is only right when the box has the viewBox's own aspect
 * ratio, which a maximized phone panel need not (nl-o47.1).
 */
function buildPointerContext(svg, event, transform) {
  if (!transform) return null;
  const mapped = clientPointToViewBox(svg, event.clientX, event.clientY);
  if (!mapped) return null;
  const { point: viewBoxPoint, scaleFactor } = mapped;

  return {
    transform,
    viewBoxPoint,
    positionFeet: transform.type === 'plan' ? transform.viewBoxToPlan(viewBoxPoint) : null,
    scaleFactor,
  };
}

/**
 * Shared yard bounds when the app supplies them, otherwise the view's own
 * extent — which keeps the controllers usable on their own in tests.
 */
function boundsFor(getBounds, transform) {
  const bounds = typeof getBounds === 'function' ? getBounds() : null;
  if (bounds?.x && bounds?.y) return bounds;
  const { originFt, extentFt } = transform;
  return {
    x: { min: originFt.x, max: originFt.x + extentFt.width },
    y: { min: originFt.y, max: originFt.y + extentFt.height },
  };
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
