const MIN_HITBOX_RADIUS_PX = 28; // generous target for touch devices

/**
 * Enables drag-to-move on the plan view while keeping rendering logic separate.
 * Hit-testing is based on proximity, so even tiny plants get a workable handle.
 * @param {Object} options
 * @param {SVGSVGElement} options.svg
 * @param {() => Array<any>} options.getPlants
 * @param {() => object} options.getTransform view transform for the panel being dragged
 * @param {() => void} options.onPositionsChange
 */
export function createPlantDragController({
  svg,
  getPlants,
  getTransform,
  getBounds,
  onPositionsChange,
  onHoverPlant,
  onChangeCommit,
}) {
  const state = {
    locked: true,
    activePlant: null,
    pointerId: null,
    offsetFeet: { x: 0, y: 0 },
    renderQueued: false,
    hoveredPlantId: '',
    hasMoved: false,
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
    ['pointerleave', handlePointerLeave],
  ];
  listeners.forEach(([type, handler]) => svg.addEventListener(type, handler));

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const ctx = buildPointerContext(svg, event, getTransform());
    if (!ctx) {
      notifyHover('');
      return;
    }

    const hit = pickPlantHit(getPlants(), ctx);
    if (!hit) {
      notifyHover('');
      return;
    }

    state.activePlant = hit.plant;
    state.pointerId = event.pointerId;
    state.offsetFeet = {
      x: ctx.positionFeet.x - hit.plant.x,
      y: ctx.positionFeet.y - hit.plant.y,
    };
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = 'grabbing';
    notifyHover(state.activePlant.id);
    state.hasMoved = false;
    event.preventDefault();
  }

  function handlePointerMove(event) {
    const ctx = buildPointerContext(svg, event, getTransform());
    updateHoverFromContext(event, ctx);
    if (!state.activePlant || event.pointerId !== state.pointerId) return;
    if (!ctx) return;
    updatePlantPosition(ctx);
    event.preventDefault();
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    const ctx = buildPointerContext(svg, event, getTransform());
    const moved = state.hasMoved;
    cancelActive();
    if (moved) {
      onChangeCommit?.();
    }
    updateHoverFromContext(event, ctx);
  }

  function handlePointerLeave() {
    if (state.activePlant) return;
    notifyHover('');
  }

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
    state.offsetFeet = { x: 0, y: 0 };
    state.hasMoved = false;
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    if (state.locked) {
      cancelActive();
      notifyHover('');
    }
    // A class, not svg.style.touchAction: the setup controller shares this
    // element and also has a say, and whichever wrote the inline property last
    // silently won. Each controller now toggles its own class and CSS combines
    // them. See the touch rules in styles.css.
    svg.classList.toggle('is-drag-enabled', !state.locked);
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  /**
   * Setup mode rebuilds panels, and configureViews reuses the SVG of a view
   * whose id did not change — so a controller that outlives its rebuild would
   * double-bind to the same element.
   */
  function destroy() {
    cancelActive();
    svg.classList.remove('is-drag-enabled');
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return {
    setLocked,
    isLocked: () => state.locked,
    destroy,
  };
}

/**
 * Drag along one yard axis from an elevation view.
 *
 * The pointer maps back through the view's own transform, so the mirrored
 * directions come out right without this file knowing the compass table —
 * otherwise dragging in a mirrored view moves plants backwards.
 */
export function createElevationDragController({
  svg,
  getPlants,
  getTransform,
  getBounds,
  onPositionsChange,
  onHoverPlant,
  onChangeCommit,
}) {
  const state = {
    locked: true,
    activePlant: null,
    pointerId: null,
    axisOffsetFeet: 0,
    renderQueued: false,
    hoveredPlantId: '',
    hasMoved: false,
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
    ['pointerleave', handlePointerLeave],
  ];
  listeners.forEach(([type, handler]) => svg.addEventListener(type, handler));

  function handlePointerDown(event) {
    if (state.locked || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const ctx = buildPointerContext(svg, event, getTransform());
    if (!ctx) {
      notifyHover('');
      return;
    }

    const plantId = findPlantIdFromEvent(event);
    if (!plantId) {
      notifyHover('');
      return;
    }
    const target = getPlants().find((plant) => String(plant.id) === String(plantId));
    if (!target) {
      notifyHover('');
      return;
    }

    state.activePlant = target;
    state.pointerId = event.pointerId;
    const axisPosition = pointerAxisFeet(ctx);
    const axisValue = Number(target[axisKeyFor(ctx)]) || 0;
    state.axisOffsetFeet = axisPosition - axisValue;
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = 'grabbing';
    notifyHover(target.id);
    state.hasMoved = false;
    event.preventDefault();
  }

  function handlePointerMove(event) {
    const ctx = buildPointerContext(svg, event, getTransform());
    updateHoverFromContext(event);
    if (!state.activePlant || event.pointerId !== state.pointerId) return;
    if (!ctx) return;
    updatePlantPosition(ctx);
    event.preventDefault();
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    const moved = state.hasMoved;
    cancelActive();
    if (moved) {
      onChangeCommit?.();
    }
    updateHoverFromContext(event);
  }

  function handlePointerLeave() {
    if (state.activePlant) return;
    notifyHover('');
  }

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
    state.axisOffsetFeet = 0;
    state.hasMoved = false;
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    if (state.locked) {
      cancelActive();
      notifyHover('');
    }
    // A class, not svg.style.touchAction: the setup controller shares this
    // element and also has a say, and whichever wrote the inline property last
    // silently won. Each controller now toggles its own class and CSS combines
    // them. See the touch rules in styles.css.
    svg.classList.toggle('is-drag-enabled', !state.locked);
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  /**
   * Setup mode rebuilds panels, and configureViews reuses the SVG of a view
   * whose id did not change — so a controller that outlives its rebuild would
   * double-bind to the same element.
   */
  function destroy() {
    cancelActive();
    svg.classList.remove('is-drag-enabled');
    listeners.forEach(([type, handler]) => svg.removeEventListener(type, handler));
  }

  return {
    setLocked,
    isLocked: () => state.locked,
    destroy,
  };
}

function pickPlantHit(plants, ctx) {
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

  return candidates[0] || null;
}

function findPlantIdFromEvent(event) {
  if (!(event?.target instanceof Element)) return '';
  const group = event.target.closest('[data-plant-id]');
  if (!group) return '';
  return group.getAttribute('data-plant-id') || '';
}

/**
 * Screen point -> viewBox point -> yard feet, using the panel's own transform.
 * The viewBox comes from the transform rather than the DOM so the pointer and
 * the renderer cannot disagree about what the panel covers.
 */
function buildPointerContext(svg, event, transform) {
  if (!transform) return null;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const { viewBox } = transform;

  const scaleX = viewBox.width / rect.width;
  const scaleY = viewBox.height / rect.height;
  const viewBoxPoint = {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };

  return {
    transform,
    viewBoxPoint,
    positionFeet: transform.type === 'plan' ? transform.viewBoxToPlan(viewBoxPoint) : null,
    scaleFactor: Math.max(scaleX, scaleY),
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
