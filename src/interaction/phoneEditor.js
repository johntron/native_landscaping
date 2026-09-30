/**
 * The phone editor (nl-o47.4): Edit mode on a phone-width screen
 * (`max-width: 960px`, the existing phone breakpoint) becomes a full-screen
 * canvas editor instead of a long scrolling page.
 *
 * It REUSES the maximize mechanism from nl-o47.1 (`appState.maximizedViewId`,
 * the `.views[data-maximized]` CSS) rather than building a parallel one:
 * entering the editor is "auto-maximize the plan (or whichever view was
 * already active), plus a few more UI changes only relevant while it is
 * on" —
 *  - a top tab strip in place of the per-panel Maximize/Restore toggle (view
 *    switching without scrolling to a panel; hidden via `body.is-phone-
 *    editor-open .view-panel__header` in styles.css, since the strip covers
 *    what it did);
 *  - ONE bottom bar that is EITHER the idle controls (month, Add plant,
 *    Plants, Undo, Redo, Done) or the selection bar
 *    (src/ui/selectionBar.js, unchanged logic, restructured markup/CSS for
 *    width) but never both — see syncBar();
 *  - pinch-zoom/pan on the canvas itself (src/interaction/canvasGesture.js).
 *
 * "Host, don't duplicate": the REAL #addPlantBtn, #undoLayoutBtn,
 * #redoLayoutBtn, and #speciesTable move (DOM reparent, never a clone) into
 * the editor's own slots while it is open, and move back to their normal
 * toolbar/page positions when it closes — every existing handler, disabled-
 * state, and id (which touch.spec.js's own locators rely on) keeps working
 * unchanged on both sides of the editor's lifetime.
 */
import { MONTH_NAMES } from '../constants.js';
import { clampMonthValue } from '../ui/controls.js';
import { createCanvasGesture } from './canvasGesture.js';
import { createViewTransform } from '../render/viewTransform.js';

// nl-o47.6.5: margin held clear around a reviewed suggestion's own bounding
// box when framing it (focusOnPlants below) — a judgement call, generous
// enough that the suggestion's outline (itself padded past the members'
// discs, src/state/driftGeometry.js's HULL_PADDING_FT) is not left touching
// the clip edge.
const SUGGESTION_FOCUS_PADDING_PX = 32;

// The same breakpoint the rest of the phone layout already uses
// (styles.css's `@media (max-width: 960px)`), so the editor and the CSS it
// depends on always agree on when "phone" starts.
const PHONE_QUERY = '(max-width: 960px)';

/**
 * @param {object} deps
 * @param {object} deps.elements  every DOM node the editor moves or wires;
 *   see design.html's phone-editor markup and the destructure below for the
 *   full shape.
 * @param {object} deps.appState
 * @param {() => object} deps.getProject
 * @param {() => Array<{view:object, svg:SVGSVGElement, panel:HTMLElement, container:HTMLElement}>} deps.getViewPanels
 * @param {(viewId: string) => void} deps.setMaximizedView  always sets (never toggles) — src/app.js
 * @param {(mode: string) => void} deps.applyMode
 * @param {() => number} deps.getSelectionSize
 * @param {() => boolean} [deps.isReviewActive]  the drift-suggestion review
 *   (nl-o47.6.5, src/interaction/driftReviewMode.js): while it is open, the
 *   idle bar must stay hidden too — it and the review bar share the exact
 *   same fixed-bottom slot #selectionBar's own idle/selection split already
 *   guarantees is never doubled, and the review bar is a THIRD occupant of
 *   it, keyed off this rather than off selection size (review keeps the
 *   plant selection empty throughout, which is exactly when the idle bar
 *   would otherwise show).
 */
export function createPhoneEditor({
  elements,
  appState,
  getProject,
  getViewPanels,
  setMaximizedView,
  applyMode,
  getSelectionSize,
  isReviewActive = () => false,
}) {
  const {
    tabsEl,
    tabsListEl,
    fitBtn,
    idleBarEl,
    monthPrevBtn,
    monthNextBtn,
    monthLabelEl,
    addPlantSlot,
    plantsBtn,
    undoSlot,
    redoSlot,
    idleDoneBtn,
    plantsSheetEl,
    plantsCloseEls,
    plantsSheetBody,
    speciesTableEl,
    speciesTableAnchor, // the element #speciesTable sits right after on the normal page
    addPlantButton,
    addPlantAnchor, // #addPlantRow, its normal parent
    undoButton,
    redoButton,
    historyControlsEl, // the normal parent of both undo/redo
    monthSlider,
  } = elements;

  const gesture = createCanvasGesture({
    getSelectionSize,
    onChange: (_state, atRest) => {
      if (fitBtn) fitBtn.disabled = atRest;
    },
  });

  let active = false;
  let phoneQuery = null;
  try {
    phoneQuery = window.matchMedia(PHONE_QUERY);
  } catch {
    phoneQuery = null; // matchMedia unavailable (not expected in a real browser, but never fatal)
  }

  function isPhoneWidth() {
    return phoneQuery ? phoneQuery.matches : window.innerWidth <= 960;
  }

  /** The project's views, plan(s) first — the order the tab strip shows them in. */
  function planFirstViews() {
    const views = getProject()?.views || [];
    const plans = views.filter((view) => view.type === 'plan');
    const rest = views.filter((view) => view.type !== 'plan');
    return [...plans, ...rest];
  }

  function panelFor(viewId) {
    return getViewPanels().find((entry) => entry.view.id === viewId) || null;
  }

  function buildTabs() {
    if (!tabsListEl) return;
    tabsListEl.innerHTML = '';
    planFirstViews().forEach((view) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'phone-editor-tabs__tab';
      tab.textContent = view.label || view.id;
      tab.dataset.viewTab = view.id;
      tab.addEventListener('click', () => switchToView(view.id));
      tabsListEl.appendChild(tab);
    });
    syncTabsActive();
  }

  function syncTabsActive() {
    tabsListEl?.querySelectorAll('[data-view-tab]').forEach((tab) => {
      const isActive = tab.dataset.viewTab === appState.maximizedViewId;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-pressed', String(isActive));
    });
  }

  /** Re-bind the pinch/pan gesture to whichever panel is now maximized, and
   * reset to fit — a fresh view (a different drawing entirely) starting
   * zoomed from the last one's state would be disorienting, not a
   * convenience. */
  function bindGestureToActiveView() {
    const entry = panelFor(appState.maximizedViewId);
    gesture.attachTo(entry?.panel || null, entry?.container || null);
    gesture.reset();
  }

  function switchToView(viewId) {
    if (!viewId || viewId === appState.maximizedViewId) return;
    setMaximizedView(viewId);
    syncTabsActive();
    bindGestureToActiveView();
  }

  /** touch-action: none even with nothing selected (styles.css) — the
   * editor is the one context where a bare one-finger move is always this
   * module's pan, never the page scroller's, since there is no page to
   * scroll behind a `position: fixed; inset: 0` panel. Applied to every
   * panel's svg, not just the visible one: harmless on a hidden panel, and
   * one pass here is simpler than re-applying it on every tab switch. */
  function setEditorTouchClass(on) {
    getViewPanels().forEach(({ svg }) => svg?.classList.toggle('is-phone-editor-active', on));
  }

  function moveMonthBy(delta) {
    if (!monthSlider) return;
    const next = clampMonthValue(Number(monthSlider.value) + delta);
    if (next === null || String(next) === monthSlider.value) return;
    monthSlider.value = String(next);
    // Reuses src/app.js's own 'input' listener (month readout + render()) —
    // this module never renders the drawing itself.
    monthSlider.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function syncMonthReadout() {
    if (!monthSlider) return;
    const value = Number(monthSlider.value);
    if (monthPrevBtn) monthPrevBtn.disabled = value <= 1;
    if (monthNextBtn) monthNextBtn.disabled = value >= 12;
    if (monthLabelEl) monthLabelEl.textContent = MONTH_NAMES[value - 1] || '';
  }

  function openPlants() {
    if (plantsSheetEl) plantsSheetEl.hidden = false;
  }
  function closePlants() {
    if (plantsSheetEl) plantsSheetEl.hidden = true;
  }

  /** Move the real, shared elements into the editor's own slots. */
  function reparentIn() {
    if (addPlantButton && addPlantSlot) addPlantSlot.appendChild(addPlantButton);
    if (undoButton && undoSlot) undoSlot.appendChild(undoButton);
    if (redoButton && redoSlot) redoSlot.appendChild(redoButton);
    if (speciesTableEl && plantsSheetBody) plantsSheetBody.appendChild(speciesTableEl);
  }
  /** ...and back to where the rest of the page expects to find them. */
  function reparentOut() {
    if (addPlantButton && addPlantAnchor) addPlantAnchor.appendChild(addPlantButton);
    if (undoButton && historyControlsEl) historyControlsEl.insertBefore(undoButton, historyControlsEl.firstChild);
    if (redoButton && historyControlsEl) historyControlsEl.appendChild(redoButton);
    if (speciesTableEl && speciesTableAnchor) speciesTableAnchor.insertAdjacentElement('afterend', speciesTableEl);
  }

  function enter() {
    active = true;
    const views = planFirstViews();
    const wanted = views.some((view) => view.id === appState.maximizedViewId)
      ? appState.maximizedViewId
      : views[0]?.id;
    if (wanted) setMaximizedView(wanted);
    buildTabs();
    reparentIn();
    // Both html and body: window.scrollTo/scrollY scroll whichever element
    // is the document's own "scrolling element" (documentElement in
    // standards mode, not body), so overflow:hidden on body alone left the
    // page scrollable underneath the fixed editor.
    document.documentElement.classList.add('is-phone-editor-open');
    document.body.classList.add('is-phone-editor-open');
    if (tabsEl) tabsEl.hidden = false;
    setEditorTouchClass(true);
    bindGestureToActiveView();
    syncMonthReadout();
    syncBar();
  }

  function exit() {
    active = false;
    gesture.detach();
    setEditorTouchClass(false);
    closePlants();
    reparentOut();
    document.documentElement.classList.remove('is-phone-editor-open');
    document.body.classList.remove('is-phone-editor-open');
    if (tabsEl) tabsEl.hidden = true;
    if (idleBarEl) idleBarEl.hidden = true;
    // Auto-maximizing was this module's own doing on the way in; drop it so
    // desktop Edit mode, and View mode on a phone, come back to their own,
    // un-maximized layout (item 5: "Desktop layout and behaviour unchanged").
    setMaximizedView('');
  }

  /** Called from src/app.js's applyMode() (every mode change/rebuild) and
   * from the matchMedia listener below (crossing the phone breakpoint while
   * Edit mode stays on, e.g. a rotation). Idempotent either way. */
  function sync() {
    const shouldBeActive = !appState.readOnly && appState.mode === 'edit' && isPhoneWidth();
    if (shouldBeActive === active) {
      if (active) syncBar();
      return;
    }
    if (shouldBeActive) enter();
    else exit();
  }

  /**
   * Cheap per-render toggle (called from src/app.js's render(), alongside
   * selectionBar.sync()): the idle bar shows only while the editor is open
   * AND nothing is selected. #selectionBar's OWN sync() (unchanged) already
   * hides itself whenever the selection is empty, so the two are mutually
   * exclusive by construction — never two bars stacked, never neither.
   */
  function syncBar() {
    if (!idleBarEl) return;
    idleBarEl.hidden = !(active && getSelectionSize() === 0 && !isReviewActive());
    syncMonthReadout();
  }

  // A drift chip inside the hosted #speciesTable (nl-o47.6.7's Drifts
  // column) selects the drift in Edit mode (src/ui/speciesHighlight.js's own
  // handleDriftClick, unchanged — this is a SECOND, delegated listener
  // alongside it, not a replacement). The sheet then closes so the person
  // can actually see the selection it just made: the canvas is what shows a
  // selected drift's outline, and the sheet sits on top of it. A plain
  // species row's hover highlight (not a click, and not a selection change)
  // is left alone — nothing to reveal by closing the sheet for that.
  plantsSheetBody?.addEventListener('click', (event) => {
    if (appState.mode !== 'edit') return;
    if (event.target instanceof Element && event.target.closest('button[data-drift-id]')) {
      closePlants();
    }
  });

  /** Switch to the plan tab if it is not already showing — a no-op if the
   * editor is not open or there is no plan view. */
  function switchToPlan() {
    if (!active) return;
    const planView = planFirstViews().find((view) => view.type === 'plan');
    if (planView) switchToView(planView.id);
  }

  /**
   * Pan/zoom the (already-maximized) plan so every one of `plants` is in
   * view (nl-o47.6.5's own review, one suggestion at a time) — the phone
   * counterpart of a desktop scrollIntoView. A no-op when the editor is not
   * open, the plan view is missing, or the panel has not been measured yet
   * (0x0 bounds — e.g. its very first render, before layout).
   * @param {Array<{x:number, y:number}>} plants plan-feet points (a
   *   suggestion's own members; HULL_PADDING_FT-ish slack is unnecessary
   *   here since SUGGESTION_FOCUS_PADDING_PX already holds screen-px margin)
   */
  function focusOnPlants(plants) {
    if (!active) return;
    const planView = planFirstViews().find((view) => view.type === 'plan');
    if (!planView) return;
    if (appState.maximizedViewId !== planView.id) switchToView(planView.id);
    const points = (plants || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
    if (!points.length) return;
    const transform = createViewTransform(planView);
    const viewBoxPoints = points.map((p) => transform.planToViewBox(p));
    const bounds = gesture.getBounds();
    if (!(bounds.contentWidth > 0) || !(bounds.contentHeight > 0)) return;
    // "Local" px (canvasZoom.js's own space) is a uniform scale off viewBox
    // units — no origin subtraction, since a view's viewBox always starts at
    // (0,0) (src/render/viewConfig.js) and `.view`'s own CSS keeps its box at
    // the viewBox's aspect ratio (nl-o47.1), so there is no letterbox to
    // account for at rest.
    const sx = bounds.contentWidth / transform.viewBox.width;
    const sy = bounds.contentHeight / transform.viewBox.height;
    const xs = viewBoxPoints.map((p) => p.x * sx);
    const ys = viewBoxPoints.map((p) => p.y * sy);
    const rect = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(Math.max(...xs) - Math.min(...xs), 1),
      height: Math.max(Math.max(...ys) - Math.min(...ys), 1),
    };
    gesture.focusRect(rect, SUGGESTION_FOCUS_PADDING_PX);
  }

  fitBtn?.addEventListener('click', () => gesture.reset());
  monthPrevBtn?.addEventListener('click', () => moveMonthBy(-1));
  monthNextBtn?.addEventListener('click', () => moveMonthBy(1));
  plantsBtn?.addEventListener('click', () => openPlants());
  plantsCloseEls?.forEach((el) => el?.addEventListener('click', () => closePlants()));
  idleDoneBtn?.addEventListener('click', () => applyMode('view'));

  if (phoneQuery) {
    const onChangeBreakpoint = () => sync();
    if (typeof phoneQuery.addEventListener === 'function') {
      phoneQuery.addEventListener('change', onChangeBreakpoint);
    } else if (typeof phoneQuery.addListener === 'function') {
      phoneQuery.addListener(onChangeBreakpoint); // pre-2020 Safari; harmless dead code on Chrome
    }
  }

  return { sync, syncBar, isActive: () => active, closePlants, switchToPlan, focusOnPlants };
}
