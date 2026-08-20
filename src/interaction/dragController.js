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
    };
  }

  svg.addEventListener('pointerdown', handlePointerDown);
  svg.addEventListener('pointermove', handlePointerMove);
  svg.addEventListener('pointerup', handlePointerUp);
  svg.addEventListener('pointercancel', handlePointerUp);
  svg.addEventListener('lostpointercapture', handlePointerUp);
  svg.addEventListener('pointerleave', handlePointerLeave);

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
    // A plant stays inside the patch of yard the view actually covers.
    const { originFt, extentFt } = transform;
    const clampX = clamp(positionFeet.x - state.offsetFeet.x, originFt.x, originFt.x + extentFt.width);
    const clampY = clamp(positionFeet.y - state.offsetFeet.y, originFt.y, originFt.y + extentFt.height);
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
    svg.style.touchAction = state.locked ? 'auto' : 'pan-y';
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  return {
    setLocked,
    isLocked: () => state.locked,
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
    };
  }

  svg.addEventListener('pointerdown', handlePointerDown);
  svg.addEventListener('pointermove', handlePointerMove);
  svg.addEventListener('pointerup', handlePointerUp);
  svg.addEventListener('pointercancel', handlePointerUp);
  svg.addEventListener('lostpointercapture', handlePointerUp);
  svg.addEventListener('pointerleave', handlePointerLeave);

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
    const { originFt, extentFt } = ctx.transform;
    const axisKey = axisKeyFor(ctx);
    const rawAxis = pointerAxisFeet(ctx) - state.axisOffsetFeet;
    const clamped = clamp(rawAxis, originFt.x, originFt.x + extentFt.width);
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
    svg.style.touchAction = state.locked ? 'auto' : 'pan-y';
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  return {
    setLocked,
    isLocked: () => state.locked,
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

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
