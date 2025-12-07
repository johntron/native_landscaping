import { INCHES_PER_FOOT, PLAN_VIEWBOX } from '../constants.js';

const MIN_HITBOX_RADIUS_PX = 28; // generous target for touch devices

/**
 * Enables drag-to-move on the plan view while keeping rendering logic separate.
 * Hit-testing is based on proximity, so even tiny plants get a workable handle.
 * @param {Object} options
 * @param {SVGSVGElement} options.svg
 * @param {() => Array<any>} options.getPlants
 * @param {() => number} options.getPixelsPerInch
 * @param {() => void} options.onPositionsChange
 */
export function createPlantDragController({
  svg,
  getPlants,
  getPixelsPerInch,
  onPositionsChange,
  onHoverPlant,
}) {
  const state = {
    locked: true,
    activePlant: null,
    pointerId: null,
    offsetFeet: { x: 0, y: 0 },
    renderQueued: false,
    hoveredPlantId: '',
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

    const ctx = buildPointerContext(svg, event, getPixelsPerInch());
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
    event.preventDefault();
  }

  function handlePointerMove(event) {
    const ctx = buildPointerContext(svg, event, getPixelsPerInch());
    updateHoverFromContext(event, ctx);
    if (!state.activePlant || event.pointerId !== state.pointerId) return;
    if (!ctx) return;
    updatePlantPosition(ctx);
    event.preventDefault();
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    const ctx = buildPointerContext(svg, event, getPixelsPerInch());
    cancelActive();
    updateHoverFromContext(event, ctx);
  }

  function handlePointerLeave() {
    if (state.activePlant) return;
    notifyHover('');
  }

  function updateHoverFromContext(event, context) {
    if (!event?.isPrimary) return;
    if (state.locked) {
      notifyHover('');
      return;
    }
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
    const { viewBox, pixelsPerInch, positionFeet } = ctx;
    const clampX = clamp(positionFeet.x - state.offsetFeet.x, 0, viewBoxToFeet(viewBox.width, pixelsPerInch));
    const clampY = clamp(positionFeet.y - state.offsetFeet.y, 0, viewBoxToFeet(viewBox.height, pixelsPerInch));

    state.activePlant.x = clampX;
    state.activePlant.y = clampY;
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
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    if (state.locked) {
      cancelActive();
      notifyHover('');
    }
    svg.style.touchAction = state.locked ? 'auto' : 'none';
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  return {
    setLocked,
    isLocked: () => state.locked,
  };
}

export function createElevationDragController({
  svg,
  axis = 'x',
  getPlants,
  getPixelsPerInch,
  onPositionsChange,
  onHoverPlant,
}) {
  const axisKey = axis === 'y' ? 'y' : 'x';
  const state = {
    locked: true,
    activePlant: null,
    pointerId: null,
    axisOffsetFeet: 0,
    renderQueued: false,
    hoveredPlantId: '',
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

    const ctx = buildPointerContext(svg, event, getPixelsPerInch());
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
    const axisPosition = ctx.positionFeet.x;
    const axisValue = Number(target[axisKey]) || 0;
    state.axisOffsetFeet = axisPosition - axisValue;
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = 'grabbing';
    notifyHover(target.id);
    event.preventDefault();
  }

  function handlePointerMove(event) {
    const ctx = buildPointerContext(svg, event, getPixelsPerInch());
    updateHoverFromContext(event);
    if (!state.activePlant || event.pointerId !== state.pointerId) return;
    if (!ctx) return;
    updatePlantPosition(ctx);
    event.preventDefault();
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    cancelActive();
    updateHoverFromContext(event);
  }

  function handlePointerLeave() {
    if (state.activePlant) return;
    notifyHover('');
  }

  function updateHoverFromContext(event) {
    if (!event?.isPrimary) return;
    if (state.locked) {
      notifyHover('');
      return;
    }
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

  function updatePlantPosition(ctx) {
    const axisLimit = viewBoxToFeet(ctx.viewBox.width, ctx.pixelsPerInch);
    const rawAxis = ctx.positionFeet.x - state.axisOffsetFeet;
    const clamped = clamp(rawAxis, 0, axisLimit);
    state.activePlant[axisKey] = clamped;
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
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    if (state.locked) {
      cancelActive();
      notifyHover('');
    }
    svg.style.touchAction = state.locked ? 'auto' : 'none';
    svg.style.cursor = state.locked ? 'default' : 'grab';
  }

  return {
    setLocked,
    isLocked: () => state.locked,
  };
}

function pickPlantHit(plants, ctx) {
  const { viewBox, pixelsPerInch, viewBoxPoint, scaleFactor } = ctx;
  const toPixels = (feet) => feet * INCHES_PER_FOOT * pixelsPerInch;
  const minRadius = MIN_HITBOX_RADIUS_PX * scaleFactor;
  const candidates = [];

  plants.forEach((plant) => {
    const cx = toPixels(plant.x);
    const cy = viewBox.height - toPixels(plant.y);
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

function buildPointerContext(svg, event, pixelsPerInch) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const vb = svg.viewBox?.baseVal || PLAN_VIEWBOX;

  const scaleX = vb.width / rect.width;
  const scaleY = vb.height / rect.height;
  const viewBoxX = (event.clientX - rect.left) * scaleX;
  const viewBoxY = (event.clientY - rect.top) * scaleY;

  return {
    viewBox: { width: vb.width, height: vb.height },
    viewBoxPoint: { x: viewBoxX, y: viewBoxY },
    positionFeet: {
      x: viewBoxX / (INCHES_PER_FOOT * pixelsPerInch),
      y: (vb.height - viewBoxY) / (INCHES_PER_FOOT * pixelsPerInch),
    },
    pixelsPerInch,
    scaleFactor: Math.max(scaleX, scaleY),
  };
}

function viewBoxToFeet(viewBoxDimension, pixelsPerInch) {
  return viewBoxDimension / (INCHES_PER_FOOT * pixelsPerInch);
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
