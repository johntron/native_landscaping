import { clientPointToViewBox } from '../render/screenPoint.js';
import { exceedsTapThreshold, resolveTapSelection } from './tapSelection.js';
import { clampGroupAxisDelta, clampGroupDelta } from '../render/groupClamp.js';
import { driftMembers } from '../state/driftGeometry.js';
import {
  containingDriftIdsByDistance,
  isPointInsideDrift,
  resolveDriftAction,
  resolveGapTapAction,
} from './driftHitTest.js';

const MIN_HITBOX_RADIUS_PX = 28; // generous target for touch devices

/** Every current member id of `driftId`, as strings, for filtering candidates. */
function memberIdSet(plants, driftId) {
  return new Set(driftMembers(plants, driftId).map((m) => String(m.id)));
}

/** A selection's current positions, keyed by id — the group-drag start snapshot
 * (nl-o47.2's touch path and, since nl-o47.6.2, mouse's drift group-drag too). */
function snapshotGroupStartFeet(selection, plants) {
  if (!selection || !selection.size) return null;
  const snapshot = new Map();
  plants.forEach((plant) => {
    if (selection.has(String(plant.id))) snapshot.set(String(plant.id), { x: plant.x, y: plant.y });
  });
  return snapshot.size ? snapshot : null;
}

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
 * @param {() => {selectedDriftId: string, driftDrilledIn: boolean}} [options.getDriftContext]
 *   the selection's drift context (nl-o47.6.2, src/ui/plantSelection.js)
 * @param {(driftId: string) => void} [options.onSelectDrift]   select every current member of a drift
 * @param {(plantId: string, driftId: string) => void} [options.onDrillIntoDriftMember]
 *   narrow the selection to one member, keeping the drift context active
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
  getDriftContext = () => ({ selectedDriftId: '', driftDrilledIn: false }),
  onSelectDrift = () => {},
  onDrillIntoDriftMember = () => {},
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
    // Mouse only (nl-o47.6.2): pressing a member of an ALREADY whole-selected
    // drift starts a group drag immediately (so the whole drift can still be
    // dragged), but only drills into that specific member if the press turns
    // out to be a plain click (no movement) — resolved at pointerup, since a
    // single mouse gesture both selects and starts a drag with no separate
    // "tap" step the way touch has. { plantId, driftId } or null.
    pendingDrillIn: null,

    // Touch/pen only: the pending gesture, decided at pointerup as a tap or a
    // (group) drag. downCtx is the full pointer context computed at
    // pointerdown, reused at pointerup for hit-testing — the SVG's screenCTM
    // has no reason to change mid-gesture.
    downClient: null,
    downCtx: null,
    groupStartFeet: null, // Map<plantId, {x,y}> snapshot, or null if nothing was selected
    isDraggingGroup: false,
    // Touch/pen only (nl-o47.4): past the tap-movement threshold, tracked
    // regardless of whether anything is selected. Without a selection,
    // groupStartFeet is null and pointermove below returns before ever
    // touching hasMoved — a large swipe past MIN_HITBOX_RADIUS_PX would
    // otherwise still read as a stationary tap at pointerup. In the phone
    // editor (touch-action: none even with nothing selected, since the
    // canvas — not the page — owns every one-finger gesture there) that swipe
    // is the pan gesture (src/interaction/canvasGesture.js), so it must not
    // also select or clear whatever sat under the finger when it landed.
    movedPastThreshold: false,
    // The tap-cycle tracker, kept ACROSS gestures (reset only on setLocked):
    // {point, order, index}. See tapSelection.js. Reset to a fresh {index:-1}
    // tracker the instant a tap ENTERS a drift (see resolveTap), so the very
    // next tap lands on the nearest overlapping member rather than resuming a
    // cycle computed before isolation existed.
    tapCandidate: null,
    // The gap-tap cycle tracker (nl-o47.6.2): same shape as tapCandidate, but
    // over driftIds from containingDriftIdsByDistance rather than plant ids —
    // a separate sequence because a tap between members (no plant hit at all)
    // and a tap ON a member are different candidate spaces.
    gapTapCandidate: null,
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

  /** Start a whole-drift group drag from a mouse press, common to a fresh
   * entry (member or gap hit) and a press on an already whole-selected
   * drift's member (which additionally arms a deferred drill-in). */
  function beginMouseGroupDrag(event, ctx, plants) {
    state.activePlant = null;
    state.groupStartFeet = snapshotGroupStartFeet(getSelection(), plants);
    state.downCtx = ctx;
    notifyHover('');
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = 'grabbing';
    event.preventDefault();
  }

  /**
   * Mouse pointerdown: pick the nearest hit, filtered to the isolated drift's
   * own members when one is active (a non-member is dimmed and unhittable,
   * nl-o47.6.2). No hit at all either leaves an isolated drift (a click
   * outside its outline) — clearing, unless the point is still inside that
   * SAME outline (a gap between members, a no-op) — enters a fresh drift from
   * a gap click, or plainly clears.
   */
  function handleMousePointerDown(event) {
    if (event.button !== 0) return;
    const ctx = buildPointerContext(svg, event, getTransform());
    if (!ctx) {
      notifyHover('');
      return;
    }
    const plants = getPlants();
    const driftContext = getDriftContext();
    const isolatedMemberIds = driftContext.selectedDriftId ? memberIdSet(plants, driftContext.selectedDriftId) : null;
    const hits = pickPlantHits(plants, ctx);
    const filteredHits = isolatedMemberIds ? hits.filter((h) => isolatedMemberIds.has(String(h.plant.id))) : hits;
    const selectedId = filteredHits[0] ? String(filteredHits[0].plant.id) : null;

    state.pendingDrillIn = null;

    if (!selectedId) {
      if (isolatedMemberIds) {
        // Already isolated: a click still inside the SAME drift's own
        // outline (a gap between its members) is a no-op; anywhere else leaves it.
        if (ctx.positionFeet && isPointInsideDrift(plants, driftContext.selectedDriftId, ctx.positionFeet)) {
          return;
        }
        notifyHover('');
        onClearSelection();
        return;
      }
      // Not isolated: a click in a gap between some drift's members, inside
      // its outline, enters it — the nearest one, if more than one outline
      // covers the point. A precise pointer needs no cycling through an
      // overlap the way touch's repeat-tap does (resolveTap's own comment).
      const containing = ctx.positionFeet ? containingDriftIdsByDistance(plants, ctx.positionFeet) : [];
      if (!containing.length) {
        notifyHover('');
        onClearSelection();
        return;
      }
      onSelectDrift(containing[0]);
      state.pointerId = event.pointerId;
      state.pointerType = 'mouse';
      state.hasMoved = false;
      beginMouseGroupDrag(event, ctx, plants);
      return;
    }

    const action = resolveDriftAction({ selectedId, driftContext, plants });
    state.pointerId = event.pointerId;
    state.pointerType = 'mouse';
    state.hasMoved = false;

    if (action.type === 'selectDrift' || (action.type === 'drillInto' && !driftContext.driftDrilledIn)) {
      // A fresh press entering a whole drift, OR a press on a member of one
      // ALREADY whole-selected: either way, drag the WHOLE group. Only the
      // second case might still drill in — deferred to pointerup, since a
      // plain click (no movement) and the start of a drag look identical here.
      if (action.type === 'drillInto') {
        state.pendingDrillIn = { plantId: action.plantId, driftId: action.driftId };
      } else {
        onSelectDrift(action.driftId);
      }
      beginMouseGroupDrag(event, ctx, plants);
    } else {
      // Already drilled into some member (press switches the target
      // immediately), or a plain non-drift plant: single-plant drag, exactly
      // as before nl-o47.6.2.
      if (action.type === 'drillInto') {
        onDrillIntoDriftMember(action.plantId, action.driftId);
      } else {
        onSelectPlant(action.plantId);
      }
      const target = plants.find((p) => String(p.id) === action.plantId);
      state.activePlant = target;
      state.offsetFeet = { x: ctx.positionFeet.x - target.x, y: ctx.positionFeet.y - target.y };
      notifyHover(target.id);
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
      event.preventDefault();
    }
  }

  function handlePointerDown(event) {
    if (state.locked) return;
    if (!event.isPrimary) {
      // A second touch/pen finger arriving mid-gesture hands off to the
      // phone editor's pinch/pan (src/interaction/canvasGesture.js, nl-
      // o47.4): "two fingers always pinch-zoom and pan." Cancel cleanly —
      // salvaging a group drag already under way exactly like a lost
      // pointer/pointercancel does below — rather than let this controller
      // keep tracking its own (now stale) first finger underneath the
      // gesture module's. Mouse has no secondary pointer to worry about, and
      // an idle controller (nothing tracked) has nothing to cancel.
      if (event.pointerType !== 'mouse' && state.pointerType !== 'mouse' && state.pointerId !== null) {
        cancelTouchForSecondPointer();
      }
      return;
    }

    if (event.pointerType === 'mouse') {
      handleMousePointerDown(event);
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
    state.movedPastThreshold = false;
    state.groupStartFeet = ctx ? snapshotGroupStartFeet(getSelection(), getPlants()) : null;
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
      if (event.pointerId !== state.pointerId) return;
      if (!ctx) return;
      if (state.activePlant) {
        updatePlantPosition(ctx);
        event.preventDefault();
      } else if (state.groupStartFeet) {
        // A whole-drift group drag (nl-o47.6.2): any movement here means the
        // press was a drag, not the plain click a pending drill-in waits for.
        state.pendingDrillIn = null;
        updateGroupPosition(ctx);
        event.preventDefault();
      }
      return;
    }

    if (event.pointerId !== state.pointerId) return;
    const dxClient = event.clientX - state.downClient.x;
    const dyClient = event.clientY - state.downClient.y;
    if (!state.movedPastThreshold && exceedsTapThreshold(dxClient, dyClient)) {
      // Past the tap threshold regardless of whether anything is selected
      // (see the movedPastThreshold field comment): with a selection this is
      // where the drag itself begins, below; with none, the pan gesture
      // (src/interaction/canvasGesture.js) owns the move instead, and either
      // way handlePointerUp must not read the release as a completed tap.
      state.movedPastThreshold = true;
      if (state.groupStartFeet) state.isDraggingGroup = true;
    }
    if (!state.groupStartFeet) return; // nothing selected: the pan gesture owns this move
    const ctx = buildPointerContext(svg, event, getTransform());
    if (!ctx || !state.downCtx) return;
    updateGroupPosition(ctx);
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;

    if (state.pointerType === 'mouse') {
      const ctx = buildPointerContext(svg, event, getTransform());
      const moved = state.hasMoved;
      const pendingDrillIn = state.pendingDrillIn;
      cancelActive();
      if (moved) {
        onChangeCommit?.();
      } else if (pendingDrillIn) {
        // A plain click (no movement) on a member of an already whole-
        // selected drift: narrow to just that member (nl-o47.6.2).
        onDrillIntoDriftMember(pendingDrillIn.plantId, pendingDrillIn.driftId);
      }
      updateHoverFromContext(event, ctx);
      return;
    }

    const wasDraggingGroup = state.isDraggingGroup;
    const moved = state.hasMoved;
    const movedPastThreshold = state.movedPastThreshold;
    const downCtx = state.downCtx;
    const downClient = state.downClient;
    cancelActive();
    if (wasDraggingGroup) {
      if (moved) onChangeCommit?.();
      return;
    }
    if (movedPastThreshold) return; // a pan (nothing selected) or an aborted drag, not a tap
    resolveTap(downCtx, downClient);
  }

  /** See the module comment on handlePointerDown's !event.isPrimary branch:
   * a second finger cancels this controller's own tracked touch gesture,
   * salvaging a group drag already under way exactly like pointercancel
   * does. */
  function cancelTouchForSecondPointer() {
    const wasDraggingGroup = state.isDraggingGroup;
    const moved = state.hasMoved;
    cancelActive();
    if (moved && wasDraggingGroup) onChangeCommit?.();
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

  /** Apply a resolveDriftAction/resolveGapTapAction result. Shared by both the
   * touch tap resolution below and (with its own drill-in timing) mouse. */
  function applyDriftAction(action) {
    switch (action.type) {
      case 'noop':
        return;
      case 'clear':
        onClearSelection();
        return;
      case 'selectDrift':
        onSelectDrift(action.driftId);
        return;
      case 'drillInto':
        onDrillIntoDriftMember(action.plantId, action.driftId);
        return;
      default:
        onSelectPlant(action.plantId);
    }
  }

  /**
   * A completed tap (touch/pen): select the nearest candidate at the down
   * position, or cycle to the next one if this repeats the last tap's spot —
   * restricted to an isolated drift's own members when one is active
   * (nl-o47.6.2), since a non-member is dimmed and unhittable.
   *
   * With no plant hit at all, a gap between members inside one or more drift
   * outlines is tried next, cycled the SAME way (resolveTapSelection again,
   * over driftIds this time) so a repeat tap into an interwoven planting
   * steps through the overlapping drifts one at a time, exactly like cycling
   * overlapping plants — see driftHitTest.js's own comment on why this is a
   * separate candidate space from the plant-id one above.
   */
  function resolveTap(ctx, point) {
    const plants = getPlants();
    const driftContext = getDriftContext();
    const isolatedMemberIds = driftContext.selectedDriftId ? memberIdSet(plants, driftContext.selectedDriftId) : null;
    const rawCandidateIds = ctx ? pickPlantHits(plants, ctx).map((hit) => String(hit.plant.id)) : [];
    const candidateIds = isolatedMemberIds ? rawCandidateIds.filter((id) => isolatedMemberIds.has(id)) : rawCandidateIds;

    const { selectedId, nextTap } = resolveTapSelection(
      candidateIds.map((id) => ({ id })),
      point,
      state.tapCandidate
    );
    state.tapCandidate = nextTap;

    if (selectedId) {
      state.gapTapCandidate = null; // a real hit always cancels any pending gap-cycle
      const action = resolveDriftAction({ selectedId, driftContext, plants });
      applyDriftAction(action);
      if (action.type === 'selectDrift') {
        // Freshly entered isolation via a direct member hit: the NEXT tap
        // must land on the nearest overlapping member at this same spot, not
        // resume cycling an order computed before isolation existed — see the
        // module comment on tapCandidate.
        const enteredMemberIds = memberIdSet(plants, action.driftId);
        const filteredHere = rawCandidateIds.filter((id) => enteredMemberIds.has(id));
        state.tapCandidate = filteredHere.length ? { point, order: filteredHere, index: -1 } : null;
      }
      return;
    }

    // containingDriftIdsByDistance tests a YARD-FEET point (it compares
    // against driftOutline, which lives in feet); ctx.positionFeet, not the
    // raw client/screen `point` resolveTapSelection's own same-spot check
    // above uses.
    const containingDriftIds = ctx?.positionFeet ? containingDriftIdsByDistance(plants, ctx.positionFeet) : [];
    const { selectedId: gapDriftId, nextTap: nextGapTap } = resolveTapSelection(
      containingDriftIds.map((id) => ({ id })),
      point,
      state.gapTapCandidate
    );
    state.gapTapCandidate = nextGapTap;
    const gapAction = resolveGapTapAction(gapDriftId, driftContext);
    applyDriftAction(gapAction);
    if (gapAction.type === 'selectDrift') state.tapCandidate = null; // entered via a gap: no member was hit to cycle from
  }

  function handlePointerLeave() {
    if (state.activePlant) return;
    notifyHover('');
  }

  /** Mouse-only: hover has no touch equivalent, and updating it from a
   * touch's pointermove would draw a target ring chasing the finger during a
   * group drag (nl-o47.2). Mouse's OWN group drag (nl-o47.6.2, a whole-drift
   * drag) gets the same treatment: no single plant to hover, and re-picking
   * every frame would chase the pointer just the same. */
  function updateHoverFromContext(event, context) {
    if (!event?.isPrimary) return;
    if (state.activePlant) {
      notifyHover(state.activePlant.id);
      return;
    }
    if (state.groupStartFeet) return;
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
    state.movedPastThreshold = false;
    state.pendingDrillIn = null;
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
      state.gapTapCandidate = null;
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
  getDriftContext = () => ({ selectedDriftId: '', driftDrilledIn: false }),
  onSelectDrift = () => {},
  onDrillIntoDriftMember = () => {},
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
    // Mouse only (nl-o47.6.2): see createPlantDragController's own field —
    // the same deferred-drill-in timing, one axis instead of two.
    pendingDrillIn: null,

    // Touch/pen only.
    downClient: null,
    downPlantId: '', // read from the DOM at pointerdown; see the module comment
    downAxisFeet: null,
    axisKey: '',
    groupStartAxis: null, // Map<plantId, axisValue>, or null if nothing was selected
    isDraggingGroup: false,
    // See createPlantDragController's own copy of this field: past the tap
    // threshold regardless of selection, so a one-finger pan with nothing
    // selected (src/interaction/canvasGesture.js, nl-o47.4) cannot also read
    // as a completed tap at pointerup.
    movedPastThreshold: false,
    tapCandidate: null,
  };

  /** A selection's current axis values, keyed by id — this controller's own
   * group-drag start snapshot, one axis instead of x/y. */
  function snapshotAxisStartFor(selection, plants, axisKey) {
    if (!selection || !selection.size) return null;
    const snapshot = new Map();
    plants.forEach((plant) => {
      if (selection.has(String(plant.id))) snapshot.set(String(plant.id), Number(plant[axisKey]) || 0);
    });
    return snapshot.size ? snapshot : null;
  }

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

  /**
   * A DOM hit (findPlantIdFromEvent), filtered to the isolated drift's own
   * members when one is active. Belt-and-suspenders alongside the CSS that
   * dims (and makes unhittable, pointer-events:none) every non-member: this
   * is what keeps that guarantee even if the render pass has not caught up.
   */
  function elevationHitPlantId(event, driftContext) {
    const plantId = findPlantIdFromEvent(event);
    if (!plantId) return '';
    if (!driftContext.selectedDriftId) return plantId;
    const plant = getPlants().find((p) => String(p.id) === String(plantId));
    return plant?.driftId === driftContext.selectedDriftId ? plantId : '';
  }

  function handlePointerDown(event) {
    if (state.locked) return;
    if (!event.isPrimary) {
      // See createPlantDragController's identical branch: a second touch/pen
      // finger hands off to the phone editor's pinch/pan (nl-o47.4).
      if (event.pointerType !== 'mouse' && state.pointerType !== 'mouse' && state.pointerId !== null) {
        cancelTouchForSecondPointer();
      }
      return;
    }

    if (event.pointerType === 'mouse') {
      if (event.button !== 0) return;
      const ctx = buildPointerContext(svg, event, getTransform());
      if (!ctx) {
        notifyHover('');
        return;
      }
      const plants = getPlants();
      const driftContext = getDriftContext();
      const selectedId = elevationHitPlantId(event, driftContext) || null;

      if (!selectedId) {
        notifyHover('');
        onClearSelection();
        return;
      }

      const action = resolveDriftAction({ selectedId, driftContext, plants });
      state.pendingDrillIn = null;
      state.pointerId = event.pointerId;
      state.pointerType = 'mouse';
      state.hasMoved = false;
      const axisKey = axisKeyFor(ctx);

      if (action.type === 'selectDrift' || (action.type === 'drillInto' && !driftContext.driftDrilledIn)) {
        if (action.type === 'drillInto') {
          state.pendingDrillIn = { plantId: action.plantId, driftId: action.driftId };
        } else {
          onSelectDrift(action.driftId);
        }
        state.activePlant = null;
        state.axisKey = axisKey;
        state.groupStartAxis = snapshotAxisStartFor(getSelection(), plants, axisKey);
        state.downAxisFeet = pointerAxisFeet(ctx);
        notifyHover('');
      } else {
        if (action.type === 'drillInto') {
          onDrillIntoDriftMember(action.plantId, action.driftId);
        } else {
          onSelectPlant(action.plantId);
        }
        const target = plants.find((p) => String(p.id) === action.plantId);
        state.activePlant = target;
        const axisPosition = pointerAxisFeet(ctx);
        const axisValue = Number(target[axisKey]) || 0;
        state.axisOffsetFeet = axisPosition - axisValue;
        notifyHover(target.id);
      }

      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
      event.preventDefault();
      return;
    }

    const ctx = buildPointerContext(svg, event, getTransform());
    state.pointerId = event.pointerId;
    state.pointerType = event.pointerType;
    state.downClient = { x: event.clientX, y: event.clientY };
    state.downPlantId = elevationHitPlantId(event, getDriftContext());
    state.isDraggingGroup = false;
    state.hasMoved = false;
    state.movedPastThreshold = false;
    state.groupStartAxis = null;
    state.downAxisFeet = ctx ? pointerAxisFeet(ctx) : null;
    state.axisKey = ctx ? axisKeyFor(ctx) : '';
    state.groupStartAxis = ctx ? snapshotAxisStartFor(getSelection(), getPlants(), state.axisKey) : null;
    // See the plan controller's own comment: captured unconditionally so a
    // group move's re-renders cannot orphan later pointer events.
    svg.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event) {
    if (event.pointerType === 'mouse') {
      const ctx = buildPointerContext(svg, event, getTransform());
      updateHoverFromContext(event);
      if (event.pointerId !== state.pointerId) return;
      if (!ctx) return;
      if (state.activePlant) {
        updatePlantPosition(ctx);
        event.preventDefault();
      } else if (state.groupStartAxis) {
        state.pendingDrillIn = null; // movement: this press is a drag, not a click
        updateGroupAxisPosition(ctx);
        event.preventDefault();
      }
      return;
    }

    if (event.pointerId !== state.pointerId) return;
    const dxClient = event.clientX - state.downClient.x;
    const dyClient = event.clientY - state.downClient.y;
    if (!state.movedPastThreshold && exceedsTapThreshold(dxClient, dyClient)) {
      // See the plan controller's identical fix: tracked regardless of
      // selection, so a pan with nothing selected cannot also read as a tap.
      state.movedPastThreshold = true;
      if (state.groupStartAxis) state.isDraggingGroup = true;
    }
    if (!state.groupStartAxis) return; // nothing selected: the pan gesture owns this move
    const ctx = buildPointerContext(svg, event, getTransform());
    if (!ctx || state.downAxisFeet === null) return;
    updateGroupAxisPosition(ctx);
  }

  function handlePointerUp(event) {
    if (event.pointerId !== state.pointerId) return;

    if (state.pointerType === 'mouse') {
      const moved = state.hasMoved;
      const pendingDrillIn = state.pendingDrillIn;
      cancelActive();
      if (moved) {
        onChangeCommit?.();
      } else if (pendingDrillIn) {
        onDrillIntoDriftMember(pendingDrillIn.plantId, pendingDrillIn.driftId);
      }
      updateHoverFromContext(event);
      return;
    }

    const wasDraggingGroup = state.isDraggingGroup;
    const moved = state.hasMoved;
    const movedPastThreshold = state.movedPastThreshold;
    const downPlantId = state.downPlantId;
    const downClient = state.downClient;
    cancelActive();
    if (wasDraggingGroup) {
      if (moved) onChangeCommit?.();
      return;
    }
    if (movedPastThreshold) return; // a pan (nothing selected) or an aborted drag, not a tap
    const candidates = downPlantId ? [{ id: downPlantId }] : [];
    const { selectedId, nextTap } = resolveTapSelection(candidates, downClient, state.tapCandidate);
    state.tapCandidate = nextTap;
    // No outline/gap concept in an elevation (one axis, no y-depth to test a
    // hull against): a miss here is always either "outside" or "not this
    // drift's own dimmed-and-unhittable member", so resolveDriftAction's
    // plain 'clear' on a miss is exactly right, with no gap-tap fallback.
    applyDriftAction(resolveDriftAction({ selectedId, driftContext: getDriftContext(), plants: getPlants() }));
  }

  /** See createPlantDragController's identical helper. */
  function cancelTouchForSecondPointer() {
    const wasDraggingGroup = state.isDraggingGroup;
    const moved = state.hasMoved;
    cancelActive();
    if (moved && wasDraggingGroup) onChangeCommit?.();
  }

  /** Shared by touch's tap resolution above and mouse's own drift-aware press
   * (with its own drill-in timing) — see the plan controller's own copy. */
  function applyDriftAction(action) {
    switch (action.type) {
      case 'noop':
        return;
      case 'clear':
        onClearSelection();
        return;
      case 'selectDrift':
        onSelectDrift(action.driftId);
        return;
      case 'drillInto':
        onDrillIntoDriftMember(action.plantId, action.driftId);
        return;
      default:
        onSelectPlant(action.plantId);
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
    if (state.groupStartAxis) return; // mid group drag: don't chase the pointer
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
    state.movedPastThreshold = false;
    state.pendingDrillIn = null;
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
