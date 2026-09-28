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
import { isAtFit } from '../render/canvasZoom.js';

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
 */
export function createPhoneEditor({
  elements,
  appState,
  getProject,
  getViewPanels,
  setMaximizedView,
  applyMode,
  getSelectionSize,
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
    onChange: (state) => {
      if (fitBtn) fitBtn.disabled = isAtFit(state);
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
    idleBarEl.hidden = !(active && getSelectionSize() === 0);
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

  return { sync, syncBar, isActive: () => active };
}
