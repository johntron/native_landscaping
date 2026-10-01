import { DEFAULT_ZOOM, MONTH_NAMES } from './constants.js';
import { fetchCsv } from './data/csvLoader.js';
import {
  loadProjectConfig,
  loadProjectIndex,
  projectAssetPath,
  resolveActiveProjectId,
  serializeProjectConfig,
} from './data/projectConfig.js';
import { serializeFeatures } from './data/featureConfig.js';
import { parseSpeciesCsv } from './data/plantParser.js';
import { parseSynonymCsv } from './data/speciesResolver.js';
import {
  loadLayoutHistory,
  loadProjectFeatures,
} from './data/persistence.js';
import { computePlantState } from './state/seasonalState.js';
import { renderViews } from './render/renderViews.js';
import { createViewTransform } from './render/viewTransform.js';
import { visiblePlanCenterFt } from './render/visiblePlanCenter.js';
import { clientPointToViewBox } from './render/screenPoint.js';
import { createSetupController } from './interaction/setupController.js';
import { createFeatureController } from './interaction/featureController.js';
import { emptyHostGeneraIndex } from './analysis/hostGenera.js';
import {
  emptyInteractionsIndex,
  emptyNearbyFaunaIndex,
} from './analysis/faunaMatches.js';
import { loadEcologyTables } from './data/ecologyTables.js';
import { loadYardSite } from './data/yardSite.js';
import { configureViews } from './render/viewConfig.js';
import { createPlantDragController, createElevationDragController } from './interaction/dragController.js';
import { createPhoneEditor } from './interaction/phoneEditor.js';
import { createDriftReviewMode } from './interaction/driftReviewMode.js';
import { createPaintController } from './interaction/paintController.js';
import { createPaintDriftMode } from './interaction/paintDriftMode.js';
import { clampHiddenLayerCount } from './state/layers.js';
import { workingExtentFt } from './render/setupOverlay.js';
import { resolveYardBounds } from './render/yardBounds.js';
import { resolvePageScale } from './render/pageScale.js';
import { pageTitle } from './ui/siteRoute.js';
import { createExportActions } from './export/exportActions.js';
import { createDetailSheet } from './ui/detailSheet.js';
import { createFeaturesMode } from './interaction/featuresMode.js';
import { createSetupMode } from './interaction/setupMode.js';
import { createLayoutHistoryController } from './history/layoutHistoryController.js';
import { createSpeciesHighlight } from './ui/speciesHighlight.js';
import { createPlantSelection } from './ui/plantSelection.js';
import { createSelectionBar } from './ui/selectionBar.js';
import { nudgeSelection } from './state/nudgeSelection.js';
import { patchView } from './state/yardEdits.js';
import {
  addDriftFromCatalog,
  addDriftMember,
  cloneDrift,
  cloneDriftAwarePlant,
  removeDrift,
  removeDriftAwarePlant,
  removeDriftMember,
  removePlantFromDrift,
  spreadDrift,
} from './state/driftEdits.js';
import { driftMembers } from './state/driftGeometry.js';
import { createAddPlantSheet } from './ui/addPlantSheet.js';
import { createPlantMenu } from './interaction/plantMenu.js';
import { createPlantLifecyclePanel } from './interaction/plantLifecyclePanel.js';
import { PROJECT_QUERY_PARAM, initNewProjectForm, initProjectPicker } from './ui/projectPicker.js';
import { initExampleBanner } from './ui/exampleBanner.js';
import {
  clampMonthValue,
  initMonthSlider,
  initZoomControls,
  updateScaleIndicator,
} from './ui/controls.js';

const MODE_KEY = 'native-landscaping-mode';
const LEGACY_LOCK_STATE_KEY = 'native-landscaping-positions-locked';
const MODES = ['view', 'edit', 'setup', 'features'];
// Judgement call (nl-o47.6.2): the factor one Tighter press applies to a
// drift's spread; Looser is its exact reciprocal, so a Tighter immediately
// followed by a Looser (or vice versa) lands back where it started.
const DRIFT_SPREAD_STEP = 0.9;


const appState = {
  project: null,
  plants: [],
  // The shared yard model in feet — beds, hardscape, the house — projected into
  // every view rather than drawn per view. Loaded through GET /api/features:
  // fetching features.json straight off disk logs a console 404 on every load
  // of every project that has never drawn one. See src/data/featureConfig.js.
  features: [],
  species: [], // the shared plants.csv catalog, for placing plants not yet in the layout
  // catalog/species-synonyms.csv as normalized name -> species id. Consulted only
  // for a legacy layout row or history entry that names its species instead of
  // carrying its id (src/data/speciesResolver.js). Empty if the file fails to
  // load, which costs only those legacy rows, never a yard saved by id.
  speciesSynonyms: new Map(),
  // The genus-keyed ecology table, filtered to this project's ecoregion. Starts
  // empty and STAYS empty if ecology/host-genera.csv fails to load, which makes
  // the three genus-dependent rules report "not declared" instead of taking the
  // app down — the analysis is advisory and must never be why a yard stops
  // rendering.
  hostGenera: emptyHostGeneraIndex(),
  // Same "advisory, never blocks rendering" contract as hostGenera above, for
  // the local-fauna-support rule and the per-plant detail sheet section.
  interactions: emptyInteractionsIndex(),
  nearbyFauna: emptyNearbyFaunaIndex(),
  // True on the shared example yard (nl-3s5.24): nothing may save.
  readOnly: false,
  month: new Date().getMonth() + 1,
  zoom: DEFAULT_ZOOM,
  mode: 'view',
  showLabels: false,
  hiddenLayerCount: 0,
  highlightedSpeciesKey: '',
  // The View-mode drift highlight (nl-o47.6.7): '' for none, else a driftId
  // clicked in the species table (src/ui/speciesHighlight.js owns it). Unlike
  // highlightedSpeciesKey above (hover-driven, transient) this is a click
  // toggle and stays set across a hover elsewhere — see
  // src/render/topView.js's own comment for why it REPLACES rather than adds
  // to the species highlight when both would otherwise apply.
  highlightedDriftId: '',
  targetedPlantId: '',
  hoveredPlantId: '',
  // The Edit-mode selection (nl-o47.2): a SET of plant ids, owned by
  // src/ui/plantSelection.js, which also derives the drift context from it
  // (nl-o47.6.2/nl-o47.6.12: a whole drift, or one plant drilled into from
  // one — see src/ui/plantSelection.js's own comment; there is no
  // appState.selectedDriftId/driftDrilledIn any more, since both are derived
  // fresh by plantSelection.getDriftContext() rather than stored).
  selectedPlantIds: new Set(),
  // The drift-suggestion review's adjusted membership (nl-o47.6.5, src/
  // interaction/driftReviewMode.js): null when no review is open, else the
  // Set<string> of plant ids the plan outlines (a dashed violet hull,
  // apparatus for a PROPOSAL — never a real drift) and dims around, exactly
  // the way a real whole-drift selection isolates one. Owned entirely by
  // driftReviewMode.js; blanked around an export capture like every other
  // piece of editing apparatus (src/export/exportActions.js).
  suggestedDriftMemberIds: null,
  // "Paint a drift along a stroke"'s live preview (nl-o47.6.6, src/
  // interaction/paintDriftMode.js): null while no stroke is in progress, else
  // `{ tracePoints, positions, radiusFt }` in plan feet for src/render/
  // topView.js's appendPaintPreview to draw. Owned entirely by
  // paintDriftMode.js; never reaches an export (nothing sets it mid-capture).
  paintPreview: null,
  maximizedViewId: '',
  // The Setup-mode ruler: {viewId, from, to} in that view's viewBox pixels,
  // standing from the end of the drag until a length is applied or it is
  // dismissed. See resolveRulerCalibration.
  ruler: null,
};

let loadedSpeciesCsv = '';
let loadedDrawingCsv = '';

async function init() {
  const monthSlider = document.getElementById('monthSlider');
  const monthReadout = document.getElementById('monthReadout');
  const scaleInput = document.getElementById('scaleInput');
  const scaleSlider = document.getElementById('scaleSlider');
  const scaleIndicator = document.getElementById('scaleIndicator');
  const viewsContainer = document.querySelector('.views');
  const viewPanelTemplate = document.getElementById('viewPanelTemplate');
  const projectSelect = document.getElementById('projectSelect');
  const projectNotice = document.getElementById('projectNotice');
  const newProjectBtn = document.getElementById('newProjectBtn');
  const newProjectForm = document.getElementById('newProjectForm');
  const newProjectName = document.getElementById('newProjectName');
  const newProjectCancelBtn = document.getElementById('newProjectCancelBtn');
  const newProjectStatus = document.getElementById('newProjectStatus');
  const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
  const editRow = document.getElementById('editRow');
  const historyRow = document.getElementById('historyRow');
  const setupRow = document.getElementById('setupRow');
  const featureRow = document.getElementById('featureRow');
  const viewToolbar = document.querySelector('.view-toolbar');
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const settingsDrawer = document.getElementById('settingsDrawer');
  const viewControlsRow = document.querySelector('.view-toolbar__row--controls');
  const exportBundleButton = document.getElementById('exportBundleBtn');
  const exportHoaButton = document.getElementById('exportHoaBtn');
  const managePlantsButton = document.getElementById('managePlantsBtn');
  const labelToggle = document.getElementById('labelToggle');
  const layerVisibilitySelect = document.getElementById('layerVisibilitySelect');
  const undoButton = document.getElementById('undoLayoutBtn');
  const redoButton = document.getElementById('redoLayoutBtn');
  const historyStatus = document.getElementById('layoutHistoryStatus');
  const detailSheet = document.getElementById('detailSheet');
  const detailSheetTitle = document.getElementById('detailSheetTitle');
  const detailSheetLines = document.getElementById('detailSheetLines');
  const detailSheetFauna = document.getElementById('detailSheetFauna');
  const detailSheetFaunaLines = document.getElementById('detailSheetFaunaLines');
  const detailSheetEcology = document.getElementById('detailSheetEcology');
  const detailSheetEcologyLines = document.getElementById('detailSheetEcologyLines');
  const detailSheetCloneBtn = document.getElementById('detailSheetCloneBtn');
  const detailSheetRemoveBtn = document.getElementById('detailSheetRemoveBtn');
  const addPlantButton = document.getElementById('addPlantBtn');
  const addPlantSheetEl = document.getElementById('addPlantSheet');
  const addPlantSheetPanel = document.getElementById('addPlantSheetPanel');
  const addPlantSearch = document.getElementById('addPlantSearch');
  const addPlantSort = document.getElementById('addPlantSort');
  const addPlantNativeChip = document.getElementById('addPlantNativeChip');
  const addPlantFavoritesChip = document.getElementById('addPlantFavoritesChip');
  const addPlantStatus = document.getElementById('addPlantStatus');
  const addPlantList = document.getElementById('addPlantList');
  const addPlantCount = document.getElementById('addPlantCount');
  const addPlantCountMinus = document.getElementById('addPlantCountMinus');
  const addPlantCountPlus = document.getElementById('addPlantCountPlus');
  const addPlantCountFields = document.getElementById('addPlantCountFields'); // nl-o47.6.6
  const addPlantModePlaceBtn = document.getElementById('addPlantModePlaceBtn'); // nl-o47.6.6
  const addPlantModePaintBtn = document.getElementById('addPlantModePaintBtn'); // nl-o47.6.6
  // Set once the sheet is built in initAddPlantControl(); the Escape handler
  // near the end of init() closes it the same way it closes detailSheet.
  let closeAddPlantSheet = () => {};
  const selectionBarEl = document.getElementById('selectionBar');
  const selectionBarName = document.getElementById('selectionBarName');
  const selectionDetailsBtn = document.getElementById('selectionDetailsBtn');
  const selectionCloneBtn = document.getElementById('selectionCloneBtn');
  const selectionRemoveBtn = document.getElementById('selectionRemoveBtn');
  const selectionMakeDriftBtn = document.getElementById('selectionMakeDriftBtn'); // nl-o47.6.4
  const selectionDoneBtn = document.getElementById('selectionDoneBtn');
  const selectionBarMoreBtn = document.getElementById('selectionBarMoreBtn'); // nl-o47.4
  const selectionBarMore = document.getElementById('selectionBarMore'); // nl-o47.4
  const selectionUndoBtn = document.getElementById('selectionUndoBtn'); // nl-o47.4
  const selectionRedoBtn = document.getElementById('selectionRedoBtn'); // nl-o47.4
  const selectionNudgeN = document.getElementById('selectionNudgeN');
  const selectionNudgeE = document.getElementById('selectionNudgeE');
  const selectionNudgeS = document.getElementById('selectionNudgeS');
  const selectionNudgeW = document.getElementById('selectionNudgeW');
  // nl-o47.6.2: the drift variants of the selection bar.
  const selectionDriftCountGroup = document.getElementById('selectionDriftCountGroup');
  const selectionDriftCountDecBtn = document.getElementById('selectionDriftCountDecBtn');
  const selectionDriftCountValue = document.getElementById('selectionDriftCountValue');
  const selectionDriftCountIncBtn = document.getElementById('selectionDriftCountIncBtn');
  const selectionDriftGroup = document.getElementById('selectionDriftGroup');
  const selectionSpreadTighterBtn = document.getElementById('selectionSpreadTighterBtn');
  const selectionSpreadLooserBtn = document.getElementById('selectionSpreadLooserBtn');
  const selectionDriftPlantingBtn = document.getElementById('selectionDriftPlantingBtn');
  const selectionCloneDriftBtn = document.getElementById('selectionCloneDriftBtn');
  const selectionRemoveDriftBtn = document.getElementById('selectionRemoveDriftBtn');
  const selectionDriftMemberGroup = document.getElementById('selectionDriftMemberGroup');
  const selectionRemoveFromDriftBtn = document.getElementById('selectionRemoveFromDriftBtn');
  const selectionBackToDriftBtn = document.getElementById('selectionBackToDriftBtn');

  // The drift-suggestion review bar (nl-o47.6.5, src/interaction/driftReviewMode.js).
  const driftReviewBarEl = document.getElementById('driftReviewBar');
  const driftReviewLabelEl = document.getElementById('driftReviewLabel');
  const driftReviewAcceptBtn = document.getElementById('driftReviewAcceptBtn');
  const driftReviewSkipBtn = document.getElementById('driftReviewSkipBtn');
  const driftReviewStopBtn = document.getElementById('driftReviewStopBtn');
  const driftReviewMoreBtn = document.getElementById('driftReviewMoreBtn');
  const driftReviewMoreEl = document.getElementById('driftReviewMore');
  const driftReviewHintEl = document.getElementById('driftReviewHint');
  const driftReviewMovingHintEl = document.getElementById('driftReviewMovingHint'); // nl-o47.6.4
  const driftReviewLifecycleEl = document.getElementById('driftReviewLifecycle');
  const driftReviewLifecycleSummaryEl = document.getElementById('driftReviewLifecycleSummary');
  const driftReviewLifecycleOptionsEl = document.getElementById('driftReviewLifecycleOptions');
  const driftReviewUndoBtn = document.getElementById('driftReviewUndoBtn');
  const driftReviewRedoBtn = document.getElementById('driftReviewRedoBtn');

  // The "paint a drift along a stroke" bar (nl-o47.6.6, src/interaction/paintDriftMode.js).
  const paintBarEl = document.getElementById('paintBar');
  const paintBarLabelEl = document.getElementById('paintBarLabel');
  const paintDoneBtn = document.getElementById('paintDoneBtn');
  const paintMoreBtn = document.getElementById('paintMoreBtn');
  const paintMoreEl = document.getElementById('paintMore');
  const paintHintEl = document.getElementById('paintHint');
  const paintUndoBtn = document.getElementById('paintUndoBtn');
  const paintRedoBtn = document.getElementById('paintRedoBtn');

  // The phone editor (nl-o47.4): full-screen Edit mode on a phone-width
  // screen. See src/interaction/phoneEditor.js for what each piece is.
  const phoneEditorTabsEl = document.getElementById('phoneEditorTabs');
  const phoneEditorTabsListEl = document.getElementById('phoneEditorTabsList');
  const phoneEditorFitBtn = document.getElementById('phoneEditorFitBtn');
  const phoneEditorBarEl = document.getElementById('phoneEditorBar');
  const phoneEditorMonthPrevBtn = document.getElementById('phoneEditorMonthPrevBtn');
  const phoneEditorMonthNextBtn = document.getElementById('phoneEditorMonthNextBtn');
  const phoneEditorMonthLabel = document.getElementById('phoneEditorMonthLabel');
  const phoneEditorAddPlantSlot = document.getElementById('phoneEditorAddPlantSlot');
  const phoneEditorPlantsBtn = document.getElementById('phoneEditorPlantsBtn');
  const phoneEditorUndoSlot = document.getElementById('phoneEditorUndoSlot');
  const phoneEditorRedoSlot = document.getElementById('phoneEditorRedoSlot');
  const phoneEditorDoneBtn = document.getElementById('phoneEditorDoneBtn');
  const plantsSheetEl = document.getElementById('plantsSheet');
  const plantsSheetBody = document.getElementById('plantsSheetBody');
  const plantsCloseEls = Array.from(document.querySelectorAll('[data-plants-close]'));
  const speciesTableEl = document.getElementById('speciesTable');
  const speciesTableAnchor = document.getElementById('ecologyCheck'); // #speciesTable's normal previous sibling
  const addPlantAnchor = document.getElementById('addPlantRow'); // #addPlantBtn's normal parent
  const historyControlsEl = document.querySelector('#historyRow .history-controls'); // undo/redo's normal parent

  let projectIndex;
  let project;
  // The shared example yard (nl-3s5.24) is read-only: the server refuses
  // every write to it with 403, and the page offers no way to make one. Set
  // from the picker entry the server marked, before anything is wired.
  let readOnly = false;
  try {
    projectIndex = await loadProjectIndex(fetch, document.baseURI);
    if (!projectIndex.projects.length) {
      // A signed-in person with no yard yet: the one useful thing on the page
      // is the form that makes one.
      initNewProjectForm({
        button: newProjectBtn,
        form: newProjectForm,
        nameInput: newProjectName,
        cancelButton: newProjectCancelBtn,
        status: newProjectStatus,
      });
      showLoadError('You have no yards yet.', { hint: 'Start one with "+ New project".' });
      return;
    }
    const resolved = resolveActiveProjectId(
      new URLSearchParams(window.location.search).get(PROJECT_QUERY_PARAM),
      projectIndex
    );
    project = await loadProjectConfig(resolved.id, fetch, document.baseURI);
    readOnly = Boolean(projectIndex.projects.find((entry) => entry.id === resolved.id)?.readOnly);
    // Published for every module handed appState (the plant panel, the detail
    // sheet) and for CSS: any control that saves checks this and stays out.
    appState.readOnly = readOnly;
    if (readOnly) document.body.dataset.readOnly = 'true';
    if (resolved.fellBack && projectNotice) {
      projectNotice.hidden = false;
      projectNotice.textContent = `Unknown project "${resolved.requestedId}" — showing ${project.name}.`;
    }
    // There used to be a warning here about views that could draw none of the
    // shared yard. It cannot happen any more: every view is derived from the
    // one declared yard, so a view that misses it is not expressible.
  } catch (err) {
    showLoadError(
      err.status === 401 ? 'Sign in to see your yards.' : 'Unable to load project configuration.',
      err.status === 401 ? { hint: '' } : undefined
    );
    console.error(err);
    return;
  }
  appState.project = project;
  const titleText = readOnly ? `${project.name} (read only)` : `Your yard: ${project.name}`;
  document.title = pageTitle(titleText);
  const projectTitle = document.getElementById('projectTitle');
  if (projectTitle) {
    projectTitle.textContent = titleText;
  }
  if (readOnly) {
    initExampleBanner({
      banner: document.getElementById('exampleBanner'),
      button: document.getElementById('copyExampleBtn'),
      status: document.getElementById('copyExampleStatus'),
    });
    // View is the only mode: Edit, Setup and Features all save.
    modeButtons.forEach((button) => {
      button.hidden = button.dataset.mode !== 'view';
    });
    if (detailSheetCloneBtn) detailSheetCloneBtn.hidden = true;
    if (detailSheetRemoveBtn) detailSheetRemoveBtn.hidden = true;
  }

  const navEcosystemLink = document.getElementById('navEcosystemLink');
  if (navEcosystemLink) {
    const url = new URL(navEcosystemLink.href);
    url.searchParams.set(PROJECT_QUERY_PARAM, project.id);
    navEcosystemLink.href = url.toString();
  }

  initProjectPicker(projectSelect, projectIndex, project.id);
  initNewProjectForm({
    button: newProjectBtn,
    form: newProjectForm,
    nameInput: newProjectName,
    cancelButton: newProjectCancelBtn,
    status: newProjectStatus,
  });
  // Panels are cloned per view, so nothing below may cache a panel-specific
  // element across a rebuild — go through viewPanels instead.
  let viewPanels = configureViews({
    container: viewsContainer,
    template: viewPanelTemplate,
    project,
  });

  const refreshMaximizedView = () => {
    // A rebuild can drop the maximized view. Without this, data-maximized stays
    // set with nothing matching .is-maximized, which hides every panel.
    if (appState.maximizedViewId && !viewPanels.some(({ view }) => view.id === appState.maximizedViewId)) {
      appState.maximizedViewId = '';
    }
    if (viewsContainer) {
      if (appState.maximizedViewId) {
        viewsContainer.dataset.maximized = appState.maximizedViewId;
      } else {
        viewsContainer.removeAttribute('data-maximized');
      }
    }
    viewPanels.forEach(({ view, panel }) => {
      panel.classList.toggle('is-maximized', view.id === appState.maximizedViewId);
      const button = panel.querySelector('[data-maximize-target]');
      if (!button) return;
      const target = button.dataset.maximizeTarget || '';
      const isActive = Boolean(target && target === appState.maximizedViewId);
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      const label = button.querySelector('.view-panel__toggle-text');
      if (label) {
        label.textContent = isActive ? 'Restore' : 'Maximize';
      }
      button.title = isActive ? 'Restore this view' : 'Maximize this view';
    });
  };

  // Always SETS (never toggles) — the desktop/View-mode Maximize button below
  // still wants toggle-off-if-already-maximized, but the phone editor's tab
  // strip (nl-o47.4, src/interaction/phoneEditor.js) wants "switch to this
  // view," full stop: a second tap on the already-active tab must not drop
  // back to the un-maximized (scroll-everything) layout the editor exists to
  // avoid.
  const setMaximizedView = (viewId) => {
    appState.maximizedViewId = viewId ? String(viewId) : '';
    refreshMaximizedView();
  };

  const toggleViewMaximization = (viewId) => {
    const normalized = viewId ? String(viewId) : '';
    setMaximizedView(appState.maximizedViewId === normalized ? '' : normalized);
  };

  // Delegated so the handler survives configureViews replacing panels.
  viewsContainer?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-maximize-target]');
    if (button && viewsContainer.contains(button)) {
      toggleViewMaximization(button.dataset.maximizeTarget);
    }
  });

  refreshMaximizedView();

  initMonthSlider(monthSlider, monthReadout, appState.month);

  let render = () => {};
  // Assigned near the phone editor, below — see that comment for why every
  // reference to it up here is safe despite the forward declaration (the
  // same pattern this file already uses for `render` itself and `applyMode`).
  let driftReview = null;
  // Assigned near driftReview, below — same forward-declaration pattern
  // (nl-o47.6.6's "paint a drift along a stroke").
  let paintMode = null;
  const layoutHistory = createLayoutHistoryController({
    appState,
    undoButton,
    redoButton,
    // nl-o47.6.5/nl-o47.6.6: the drift-review and paint bars' own Undo/Redo
    // mirror the real buttons too, alongside the phone editor's existing pair
    // — see src/history/layoutHistoryController.js's own comment on why this
    // takes a list now.
    undoMirror: [selectionUndoBtn, driftReviewUndoBtn, paintUndoBtn],
    redoMirror: [selectionRedoBtn, driftReviewRedoBtn, paintRedoBtn],
    historyStatus,
    render: () => render(),
    refreshSpeciesTable: () => refreshSpeciesTable(),
    // Undo and redo cross setup and feature saves too (nl-3s5.20). Both modes
    // are built further down; these run only on a click, long after.
    onRestoreConfig: (config) => setupMode.restoreConfig(config),
    onRestoreFeatures: (features) => featuresMode.restore(features),
  });
  const commitLayoutChange = (description) => layoutHistory.commit(description);
  const syncLayerButtons = (hiddenCount) => {
    if (layerVisibilitySelect) layerVisibilitySelect.value = String(hiddenCount);
  };
  const applyHiddenLayers = (count, { shouldRender = true } = {}) => {
    const clamped = clampHiddenLayerCount(count);
    appState.hiddenLayerCount = clamped;
    syncLayerButtons(clamped);
    if (shouldRender) {
      render();
    }
  };

  // Built before speciesHighlight: setTargetedPlant calls back into
  // selectPlants while Edit mode is on (nl-o47.2), so this has to exist
  // first. onSelectionChange reads `dragControllers`, built further down —
  // safe because it is only ever CALLED later, in response to a real
  // selection change, by which point that `let` binding is assigned.
  const plantSelection = createPlantSelection({
    appState,
    render: () => render(),
    onSelectionChange: () => syncSelectionTouchAction(),
  });
  function syncSelectionTouchAction() {
    const active = appState.mode === 'edit' && plantSelection.getSelection().size > 0;
    dragControllers.forEach((controller) => controller?.setSelectionActive?.(active));
  }

  // nl-o47.6.5: while a drift-suggestion review is open, nothing may add to
  // the ORDINARY plant selection — the review bar and #selectionBar share one
  // fixed-bottom slot, and that only stays true because reviewing keeps
  // appState.selectedPlantIds empty throughout (design.html's own comment).
  // Every caller that could otherwise select something on a stray click
  // during review — the drag controllers below, and the species table's own
  // drift chips just here — routes through these guards instead of
  // plantSelection's methods directly. nl-o47.6.6 widens every one of these
  // the exact same way for painting, which keeps the selection empty for the
  // exact same reason (#paintBar is a fourth occupant of the same slot).
  const isDriftReviewActive = () => Boolean(driftReview?.isActive());
  const isPaintActive = () => Boolean(paintMode?.isActive());
  const selectPlantsGuarded = (plantId) => {
    if (isDriftReviewActive() || isPaintActive()) return;
    plantSelection.selectPlants([plantId]);
  };
  const selectDriftGuarded = (driftId) => {
    if (isDriftReviewActive() || isPaintActive()) return;
    plantSelection.selectDrift(driftId);
  };
  // nl-o47.6.12: drilling in is derived, not a separate entry point any more
  // — selecting just this one plant is enough; if it carries a driftId,
  // plantSelection.getDriftContext() reports it drilled in on its own.
  const drillIntoDriftMemberGuarded = (plantId) => {
    if (isDriftReviewActive() || isPaintActive()) return;
    plantSelection.selectPlants([plantId]);
  };
  const clearSelectionGuarded = () => {
    if (isDriftReviewActive() || isPaintActive()) return;
    plantSelection.clearSelection();
  };

  const speciesHighlight = createSpeciesHighlight({
    appState,
    speciesTableContainer: document.getElementById('speciesTable'),
    ecologyContainer: document.getElementById('ecologyCheck'),
    render: () => render(),
    onSelectPlant: selectPlantsGuarded,
    // The species table's per-drift entries (nl-o47.6.7): in Edit mode a
    // click selects the drift (the same plantSelection.selectDrift the drag
    // controllers use, nl-o47.6.2); speciesHighlight.js decides which mode
    // applies and calls this only for Edit — View mode highlights instead,
    // entirely inside speciesHighlight.js's own state.
    onSelectDrift: selectDriftGuarded,
    // The "N possible drifts — Review" banner (nl-o47.6.5), at the top of the
    // species list: Edit mode only, never on the read-only example yard, and
    // hidden while a review OR a paint session is already open (driftReview
    // itself hides the banner the instant start() runs, but this guard also
    // covers every OTHER refreshSpeciesTable call while one is active).
    getSuggestionCount: () =>
      appState.mode === 'edit' && !appState.readOnly && !isDriftReviewActive() && !isPaintActive()
        ? driftReview?.pendingCount() ?? 0
        : 0,
    onReviewSuggestions: () => {
      if (!isPaintActive()) driftReview?.start();
    },
  });
  // Prune the selection everywhere refreshSpeciesTable already runs (add,
  // clone, remove, undo/redo, the initial load): exactly the events that can
  // change which plants exist, and so which ids the selection may still name.
  // A drift-suggestion review (nl-o47.6.5) re-derives itself from the same
  // events — Undo/Redo included — so it never shows a suggestion built on
  // stale plants; driftReview.refresh() is a no-op while inactive.
  const refreshSpeciesTable = () => {
    speciesHighlight.refresh();
    plantSelection.pruneSelection();
    driftReview?.refresh();
  };
  const setTargetedPlant = (plantId) => speciesHighlight.setTargetedPlant(plantId);
  const setHoveredPlant = (plantId) => speciesHighlight.setHoveredPlant(plantId);

  const exportActions = createExportActions({
    appState,
    plantSelection,
    getProject: () => project,
    getViewPanels: () => viewPanels,
    getSpeciesCsv: () => loadedSpeciesCsv,
    getDrawingCsv: () => loadedDrawingCsv,
    render: () => render(),
    applyHiddenLayers,
    syncLayerButtons,
    monthSlider,
    monthReadout,
  });
  const handleBundleExport = () => exportActions.exportBundle(exportBundleButton);
  const handleHoaExport = () => exportActions.exportHoaPacket(exportHoaButton);
  /**
   * Size every panel from the yard it covers, at one scale for the page.
   *
   * Re-run on resize and after any geometry change, because the scale is
   * chosen to FIT: the widest view fills the available width, or the tallest
   * fills the height budget, whichever binds first. Zoom multiplies it, which
   * is the only thing zoom has ever done.
   */
  const applyPageScale = () => {
    if (!viewsContainer) return;
    // Setup shows one view, so it is the only one that has to fit — sizing to
    // the tallest of four would leave the one on screen small for no reason.
    const focused = viewsContainer.hasAttribute('data-setup-focus');
    // Sized to the widened window, which is what the focused panel shows.
    // Guarded rather than computed up front: applyPageScale runs once during
    // init, before setupPanel exists.
    const selected = focused
      ? project.views.find((view) => view.id === setupPanel.getSelectedId())
      : null;
    const shown = selected ? [{ extentFt: workingExtentFt(selected) }] : project.views;
    const pxPerFt = resolvePageScale({
      views: shown.length ? shown : project.views,
      availableWidthPx: viewsContainer.clientWidth,
      availableHeightPx: window.innerHeight,
      zoom: appState.zoom,
      focused,
    });
    viewsContainer.style.setProperty('--page-px-per-ft', String(pxPerFt));
    // The toolbar's scale reference is finally telling the truth about every
    // panel rather than about the first one.
    updateScaleIndicator(scaleIndicator, pxPerFt);
  };

  const applyZoom = (value) => {
    appState.zoom = value;
    applyPageScale();
  };
  initZoomControls(scaleInput, scaleSlider, applyZoom, appState.zoom);
  window.addEventListener('resize', applyPageScale);

  // One controller per panel; which one to build follows the view's type, and
  // an elevation reads its axis and mirroring off the view's own transform.
  const liveView = (viewId) => project.views.find((entry) => entry.id === viewId);
  const buildDragControllers = () =>
    viewPanels.map(({ view, svg }) => {
      const shared = {
        svg,
        getPlants: () => appState.plants,
        // Resolved by id, not captured: a Setup-mode edit replaces the view
        // object, and a controller holding the old one would drag against
        // geometry the drawing no longer uses.
        getTransform: () => createViewTransform(liveView(view.id) || view),
        // Every view clamps to the yard, not to its own extent: a view draws a
        // margin of padding past the yard on every side, and a plant dragged
        // out into it would be standing off the property.
        getBounds: () => resolveYardBounds(project),
        onPositionsChange: () => render(),
        onHoverPlant: setHoveredPlant,
        onChangeCommit: () => commitLayoutChange('Moved plant'),
        getSelection: () => plantSelection.getSelection(),
        onSelectPlant: selectPlantsGuarded,
        onClearSelection: clearSelectionGuarded,
        getDriftContext: () => plantSelection.getDriftContext(),
        onSelectDrift: selectDriftGuarded,
        onDrillIntoDriftMember: drillIntoDriftMemberGuarded,
        // nl-o47.6.5: only the PLAN controller reads these (createElevationDragController
        // ignores extra props it does not destructure) — a tap/click while
        // reviewing bypasses selection, isolation, and dragging entirely, in
        // favor of toggling the nearest hit in/out of the suggestion. The
        // elevation controllers are locked outright for the review's
        // duration instead (src/app.js's lockNonPlanControllers), since
        // review restricts its own taps to the plan.
        isReviewActive: isDriftReviewActive,
        onReviewTap: (plantId) => driftReview?.handleTap(plantId),
      };
      return view.type === 'plan'
        ? createPlantDragController(shared)
        : createElevationDragController(shared);
    });
  let dragControllers = buildDragControllers();

  /**
   * Locks every non-plan (elevation) drag controller for the drift-
   * suggestion review's duration (nl-o47.6.5) — review restricts its own
   * taps to the plan, whose outline is plan-only too (topView.js). Safe to
   * call with `locked: false` unconditionally: a controller only actually
   * unlocks when Edit mode is still current, so a Stop racing a mode change
   * away from Edit cannot wrongly re-unlock one Edit itself has already
   * locked.
   * @param {boolean} locked
   */
  const lockNonPlanControllers = (locked) => {
    dragControllers.forEach((controller, index) => {
      if (viewPanels[index]?.view.type === 'plan') return;
      controller?.setLocked?.(locked || appState.mode !== 'edit');
    });
  };

  /**
   * Re-applies EVERY dragController's locked state (plan included, unlike
   * lockNonPlanControllers above) from appState.mode and isPaintActive()
   * together — the single source of truth both applyMode's own mode-change
   * sync and paintDriftMode.js's start/stop call, so a same-mode re-apply
   * elsewhere (Setup's rebuildViews, say) can never silently re-unlock what
   * an open paint session locked. Painting (nl-o47.6.6) needs the PLAN
   * controller locked too, unlike a drift review, which still needs it alive
   * for its own tap-to-toggle — src/interaction/paintController.js is the
   * only pointer consumer the plan's svg has while a stroke is possible.
   */
  const syncDragControllerLocks = () => {
    const locked = appState.mode !== 'edit' || isPaintActive();
    dragControllers.forEach((controller) => controller?.setLocked?.(locked));
  };

  // One per panel, but only the selected view's is ever unlocked: two panels
  // accepting a camera drag at once would be two answers to "which view is
  // being set up".
  /**
   * Every background's intrinsic proportions, by path.
   *
   * A placement is a rectangle of yard, and it has to have the picture's own
   * shape or the picture is stretched into it — so a gesture on an unplaced
   * photo needs the aspect before it can start from the rectangle CSS is
   * already drawing. Nothing else in the app has ever needed it, so nothing
   * loaded it, and the first attempt at photo positioning started from the
   * PANEL's shape instead and distorted every picture it touched (nl-0di).
   *
   * Keyed by path, which the upload endpoint content-hashes, so a cached aspect
   * can never belong to a different image than the one being drawn.
   */
  const photoAspects = new Map();

  function photoAspectFor(view) {
    const path = view?.background;
    if (!path) return 0;
    if (photoAspects.has(path)) return photoAspects.get(path);
    photoAspects.set(path, 0); // in flight; one load per path
    const image = new Image();
    image.onload = () => {
      const aspect = image.naturalWidth / image.naturalHeight;
      if (!(aspect > 0)) return;
      photoAspects.set(path, aspect);
      // It arrives a frame or two after the drawing that wanted it.
      setupMode.sync();
    };
    image.src = new URL(projectAssetPath(project.id, path), document.baseURI).toString();
    return 0;
  }

  const buildSetupControllers = () =>
    viewPanels.map(({ view, svg }) =>
      createSetupController({
        svg,
        getView: () => liveView(view.id),
        getViews: () => project.views,
        getLayout: () => ({ yardFt: project.yardFt, paddingFt: project.paddingFt }),
        getPhotoAspect: () => photoAspectFor(liveView(view.id)),
        // A camera is dragged on the PLAN and belongs to an elevation, so its
        // patch names its own view rather than the one under the pointer; a
        // photo patch belongs to the view being drawn in.
        onChange: (patch) =>
          setupMode.applyViewEdit({
            views: patch.id
              ? patchView(project.views, patch.id, { viewerAtFt: patch.viewerAtFt })
              : patchView(project.views, view.id, patch),
          }),
      })
    );
  let setupControllers = buildSetupControllers();

  // Only plan panels get one: a footprint is edited in plan space, so a
  // controller on an elevation would be a pointer consumer that never unlocks.
  const buildFeatureControllers = () =>
    viewPanels.map(({ view, svg }) =>
      view.type !== 'plan'
        ? null
        : createFeatureController({
            svg,
            getTransform: () => createViewTransform(liveView(view.id) || view),
            getFeatures: () => appState.features,
            getSelectedId: () => featuresMode.panel.getSelectedId(),
            onSelect: (id) => {
              featuresMode.panel.setSelectedId(id);
              featuresMode.sync();
            },
            onChange: (candidate) =>
              featuresMode.apply(featuresMode.replaceFeature(appState.features, candidate)),
          })
    );
  let featureControllers = buildFeatureControllers();

  // Only plan panels get one, same reasoning as featureControllers above: a
  // bed is traced in plan space (nl-o47.6.6). References `paintMode` (the
  // forward-declared `let` above) inside its callbacks, never called until a
  // real stroke happens, by which point it is assigned — the same pattern
  // `render`/`applyMode`/`driftReview` already rely on throughout this file.
  const buildPaintControllers = () =>
    viewPanels.map(({ view, svg }) =>
      view.type !== 'plan'
        ? null
        : createPaintController({
            svg,
            getTransform: () => createViewTransform(liveView(view.id) || view),
            onStrokeMove: (points) => paintMode?.handleStrokeMove(points),
            onStrokeEnd: (points) => paintMode?.handleStrokeEnd(points),
            onStrokeCancel: () => paintMode?.handleStrokeCancel(),
          })
    );
  let paintControllers = buildPaintControllers();

  /**
   * Rebuild the panels from the current project. configureViews reuses the SVG
   * of any view whose id is unchanged, so the old controllers must be torn down
   * first or they would double-bind to those elements.
   */
  const rebuildViews = () => {
    const previousSvgs = viewPanels.map((panel) => panel.svg);
    viewPanels = configureViews({ container: viewsContainer, template: viewPanelTemplate, project });

    // Rebuild controllers only when the elements under them changed. Editing a
    // view's geometry reuses its panel, and tearing down the controller that is
    // mid-drag would drop the gesture on its first frame.
    const sameElements =
      viewPanels.length === previousSvgs.length &&
      viewPanels.every((panel, index) => panel.svg === previousSvgs[index]);
    if (!sameElements) {
      dragControllers.forEach((controller) => controller?.destroy?.());
      setupControllers.forEach((controller) => controller?.destroy?.());
      featureControllers.forEach((controller) => controller?.destroy?.());
      paintControllers.forEach((controller) => controller?.destroy?.());
      dragControllers = buildDragControllers();
      setupControllers = buildSetupControllers();
      featureControllers = buildFeatureControllers();
      paintControllers = buildPaintControllers();
    }

    // The yard may have changed size, and the page scale is derived from it.
    applyPageScale();
    applyMode(appState.mode);
    refreshMaximizedView();
    render();
  };

  /**
   * Drop the plant from the layout. Clearing the pointer state first matters:
   * renderViews is handed targeted/hovered ids, and an id with no plant behind
   * it would survive as a highlight nothing can clear. Goes through
   * removeDriftAwarePlant, not plantEdits.js's removePlantById directly, so a
   * drift a drilled-in Remove (or the detail sheet's, or the plant menu's)
   * leaves with exactly one member drops that member's driftId label too
   * (nl-o47.6.9: a drift always has >= 2 members) — this is the ONE place
   * every one of those three callers deletes a plant.
   */
  const removePlant = (plantId) => {
    if (!removeDriftAwarePlant(appState, plantId)) return;
    plantMenu.hide();
    closeDetailSheet();
    appState.hoveredPlantId = '';
    appState.targetedPlantId = '';
    render();
    refreshSpeciesTable();
    commitLayoutChange('Removed plant');
  };

  const plantMenu = createPlantMenu({
    onClone: (plantId) => {
      // cloneDriftAwarePlant: clonePlantById's own rules (a clone starts
      // planned, no source), except a clone that stays in a drift copies
      // that drift's lifecycle instead (nl-o47.6.10).
      const clone = cloneDriftAwarePlant(appState, plantId);
      if (clone) {
        plantMenu.hide();
        setTargetedPlant('');
        render();
        refreshSpeciesTable();
        commitLayoutChange('Cloned plant');
      }
    },
    onRemove: (plantId) => removePlant(plantId),
    onClose: () => setTargetedPlant(''),
  });

  /** One selected plant's id, or '' — only single selection has UI today. */
  const soleSelectedPlantId = () => {
    const [id] = plantSelection.getSelection();
    return id || '';
  };

  const handleNudge = (direction) => {
    const selection = plantSelection.getSelection();
    if (!selection.size) return;
    const moved = nudgeSelection(appState, selection, direction, resolveYardBounds(project));
    if (!moved) return;
    render();
    // Every nudge is its own history entry: coalescing a burst into one would
    // race Undo (an Undo pressed while a delayed commit is still pending
    // could record the just-undone position as a new "Nudged plant" entry and
    // drop the redo tail), so nl-o47.2 does not attempt it.
    commitLayoutChange('Nudged plant');
  };

  const selectionBar = createSelectionBar({
    elements: {
      bar: selectionBarEl,
      name: selectionBarName,
      detailsBtn: selectionDetailsBtn,
      cloneBtn: selectionCloneBtn,
      removeBtn: selectionRemoveBtn,
      makeDriftBtn: selectionMakeDriftBtn,
      doneBtn: selectionDoneBtn,
      moreBtn: selectionBarMoreBtn,
      moreGroup: selectionBarMore,
      undoBtn: selectionUndoBtn,
      redoBtn: selectionRedoBtn,
      undoRealBtn: undoButton,
      redoRealBtn: redoButton,
      nudgeN: selectionNudgeN,
      nudgeE: selectionNudgeE,
      nudgeS: selectionNudgeS,
      nudgeW: selectionNudgeW,
      driftCountGroup: selectionDriftCountGroup,
      driftCountDecBtn: selectionDriftCountDecBtn,
      driftCountValue: selectionDriftCountValue,
      driftCountIncBtn: selectionDriftCountIncBtn,
      driftGroup: selectionDriftGroup,
      spreadTighterBtn: selectionSpreadTighterBtn,
      spreadLooserBtn: selectionSpreadLooserBtn,
      driftPlantingBtn: selectionDriftPlantingBtn,
      cloneDriftBtn: selectionCloneDriftBtn,
      removeDriftBtn: selectionRemoveDriftBtn,
      driftMemberGroup: selectionDriftMemberGroup,
      removeFromDriftBtn: selectionRemoveFromDriftBtn,
      backToDriftBtn: selectionBackToDriftBtn,
    },
    appState,
    getDriftContext: () => plantSelection.getDriftContext(),
    onDetails: () => {
      const id = soleSelectedPlantId();
      if (id) openDetailSheet(id);
    },
    onClone: () => {
      const id = soleSelectedPlantId();
      if (!id) return;
      // cloneDriftAwarePlant: clonePlantById copies every field but the
      // lifecycle ones, driftId included — a drilled-in member's clone stays
      // in its drift (nl-o47.6's own design), and plantSelection infers that
      // from the clone's own driftId the same way any selectPlants call
      // would — except that the clone copies the drift's own shared
      // lifecycle instead of always starting planned (nl-o47.6.10).
      const clone = cloneDriftAwarePlant(appState, id);
      if (!clone) return;
      render();
      refreshSpeciesTable();
      // Clone selects the clone, not the plant it came from — the point of
      // cloning is to then place the new one.
      plantSelection.selectPlants([clone.id]);
      commitLayoutChange('Cloned plant');
    },
    onRemove: () => {
      const id = soleSelectedPlantId();
      if (id) removePlant(id);
    },
    onDone: () => plantSelection.clearSelection(),
    onNudge: handleNudge,
    onCountChange: (delta) => {
      const driftId = plantSelection.getDriftContext().selectedDriftId;
      if (driftId) {
        const { plant, reason } =
          delta > 0 ? addDriftMember(appState, { driftId }) : removeDriftMember(appState, driftId);
        if (!plant) return; // the bar's own disabled state already guards this; stay defensive
        render();
        refreshSpeciesTable(); // if that was the drift's 2nd-to-last member, pruneSelection lands on the plain survivor (nl-o47.6.9)
        commitLayoutChange(delta > 0 ? 'Added drift member' : 'Removed drift member');
        return;
      }
      // nl-o47.6.9: "+" on a single plain plant (no drift context) makes it a
      // drift of 2 — "-" there is always disabled (Remove deletes the plant
      // instead), so the bar never calls this with delta <= 0 in that mode,
      // but stay defensive rather than trust the DOM's disabled state alone.
      if (delta <= 0) return;
      const id = soleSelectedPlantId();
      if (!id) return;
      // nl-o47.6.12: addDriftMember's plantId path mints the drift (folded
      // in from what used to be a separate convertToDrift).
      const result = addDriftMember(appState, { plantId: id });
      if (!result.driftId) return; // refused (already in a drift, no room, species gone) — the bar's own disabled state already guards the common case
      render();
      refreshSpeciesTable();
      plantSelection.selectDrift(result.driftId); // whole-drift mode, both new members
      const label = result.plant?.commonName || result.plant?.botanicalName || '';
      commitLayoutChange(`Made a drift of 2${label ? ` ${label}` : ''}`);
    },
    onSpread: (direction) => {
      const driftId = plantSelection.getDriftContext().selectedDriftId;
      if (!driftId) return;
      const factor = direction === 'looser' ? 1 / DRIFT_SPREAD_STEP : DRIFT_SPREAD_STEP;
      // spreadDrift returns success-shaped results even on a no-op (already
      // at MIN_SPREAD_FACTOR, or the requested factor rounds to no visible
      // change once clamped) — check positions actually moved before committing.
      const before = new Map(appState.plants.map((p) => [String(p.id), { x: p.x, y: p.y }]));
      const { reason } = spreadDrift(appState, driftId, factor);
      if (reason) return;
      const moved = appState.plants.some((p) => {
        const prev = before.get(String(p.id));
        return prev && (Math.abs(prev.x - p.x) > 1e-6 || Math.abs(prev.y - p.y) > 1e-6);
      });
      if (!moved) return;
      render();
      refreshSpeciesTable();
      commitLayoutChange(direction === 'looser' ? 'Spread drift looser' : 'Spread drift tighter');
    },
    onCloneDrift: () => {
      const driftId = plantSelection.getDriftContext().selectedDriftId;
      if (!driftId) return;
      const result = cloneDrift(appState, driftId);
      if (!result.driftId) return;
      render();
      refreshSpeciesTable();
      plantSelection.selectDrift(result.driftId);
      commitLayoutChange('Cloned drift');
    },
    onRemoveDrift: () => {
      const driftId = plantSelection.getDriftContext().selectedDriftId;
      if (!driftId) return;
      const { removedCount, dissolvedCount, reason } = removeDrift(appState, driftId);
      if (reason || (!removedCount && !dissolvedCount)) return;
      render();
      refreshSpeciesTable();
      // The drift itself no longer exists; leaving the automatic prune to
      // pick a plain multi-select of whatever planted members survived would
      // land in a state nl-o47.2 has no real UI for. Done is the clean exit.
      plantSelection.clearSelection();
      commitLayoutChange('Removed drift');
    },
    onRemoveFromDrift: () => {
      const id = soleSelectedPlantId();
      if (!id) return;
      const before = appState.plants.find((p) => String(p.id) === id);
      if (!before?.driftId) return; // already not in a drift (shouldn't be reachable): nothing to do
      removePlantFromDrift(appState, id);
      render();
      // refreshSpeciesTable's pruneSelection drops the drift context on its
      // own here (the drilled-into plant no longer carries this driftId),
      // landing back on a plain single-plant selection of the same plant.
      refreshSpeciesTable();
      commitLayoutChange('Removed plant from drift');
    },
    onBackToDrift: () => {
      const driftId = plantSelection.getDriftContext().selectedDriftId;
      if (driftId) plantSelection.selectDrift(driftId); // a selection change, not an edit: no commit
    },
    onDriftPlanting: () => {
      const driftId = plantSelection.getDriftContext().selectedDriftId;
      if (driftId) openDriftPlantingSheet(driftId);
    },
    // nl-o47.6.4: only ever shown for a single plant not already in a drift
    // (selectionBar.js's own plainSingleMode) — opens driftReview's group
    // mode, seeded with just this one plant.
    onMakeDrift: () => {
      const id = soleSelectedPlantId();
      if (id) driftReview?.startGroup(id);
    },
  });

  // The phone editor (nl-o47.4). applyMode is referenced before its own
  // declaration further down — safe, since it is a hoisted function
  // declaration and phoneEditor only ever CALLS it later, from a click.
  const phoneEditor = createPhoneEditor({
    elements: {
      tabsEl: phoneEditorTabsEl,
      tabsListEl: phoneEditorTabsListEl,
      fitBtn: phoneEditorFitBtn,
      idleBarEl: phoneEditorBarEl,
      monthPrevBtn: phoneEditorMonthPrevBtn,
      monthNextBtn: phoneEditorMonthNextBtn,
      monthLabelEl: phoneEditorMonthLabel,
      addPlantSlot: phoneEditorAddPlantSlot,
      plantsBtn: phoneEditorPlantsBtn,
      undoSlot: phoneEditorUndoSlot,
      redoSlot: phoneEditorRedoSlot,
      idleDoneBtn: phoneEditorDoneBtn,
      plantsSheetEl,
      plantsCloseEls,
      plantsSheetBody,
      speciesTableEl,
      speciesTableAnchor,
      addPlantButton,
      addPlantAnchor,
      undoButton,
      redoButton,
      historyControlsEl,
      monthSlider,
    },
    appState,
    getProject: () => project,
    getViewPanels: () => viewPanels,
    setMaximizedView,
    applyMode: (mode) => applyMode(mode),
    getSelectionSize: () => plantSelection.getSelection().size,
    isReviewActive: () => isDriftReviewActive(),
    isPaintActive: () => isPaintActive(),
  });

  /** The desktop counterpart of phoneEditor's own focusOnPlants (nl-o47.6.5):
   * scroll the plan panel into view when a reviewed suggestion needs it. */
  const scrollPlanIntoView = () => {
    const planView = appState.project?.views?.find((view) => view.type === 'plan');
    const entry = planView ? viewPanels.find((candidate) => candidate.view.id === planView.id) : null;
    entry?.panel?.scrollIntoView({ block: 'center', inline: 'center' });
  };

  driftReview = createDriftReviewMode({
    elements: {
      bar: driftReviewBarEl,
      label: driftReviewLabelEl,
      acceptBtn: driftReviewAcceptBtn,
      skipBtn: driftReviewSkipBtn,
      stopBtn: driftReviewStopBtn,
      moreBtn: driftReviewMoreBtn,
      moreGroup: driftReviewMoreEl,
      hintEl: driftReviewHintEl,
      movingHintEl: driftReviewMovingHintEl,
      lifecycleGroup: driftReviewLifecycleEl,
      lifecycleSummaryEl: driftReviewLifecycleSummaryEl,
      lifecycleOptionsEl: driftReviewLifecycleOptionsEl,
      undoBtn: driftReviewUndoBtn,
      redoBtn: driftReviewRedoBtn,
      undoRealBtn: undoButton,
      redoRealBtn: redoButton,
    },
    appState,
    render: () => render(),
    refreshSpeciesTable: () => refreshSpeciesTable(),
    commitLayoutChange,
    clearSelection: () => plantSelection.clearSelection(),
    lockNonPlanControllers,
    phoneEditor,
    scrollPlanIntoView,
    // nl-o47.6.4: group mode's Accept selects the new drift whole once review
    // is out of the way, same as every other drift-making action here.
    selectDrift: (driftId) => plantSelection.selectDrift(driftId),
  });

  paintMode = createPaintDriftMode({
    elements: {
      bar: paintBarEl,
      label: paintBarLabelEl,
      doneBtn: paintDoneBtn,
      moreBtn: paintMoreBtn,
      moreGroup: paintMoreEl,
      hintEl: paintHintEl,
      undoBtn: paintUndoBtn,
      redoBtn: paintRedoBtn,
      undoRealBtn: undoButton,
      redoRealBtn: redoButton,
    },
    appState,
    render: () => render(),
    refreshSpeciesTable: () => refreshSpeciesTable(),
    commitLayoutChange,
    clearSelection: () => plantSelection.clearSelection(),
    selectDrift: (driftId) => plantSelection.selectDrift(driftId),
    selectPlants: (ids) => plantSelection.selectPlants(ids),
    isReviewActive: isDriftReviewActive,
    syncDragLocks: syncDragControllerLocks,
    getPaintControllers: () => paintControllers,
    phoneEditor,
  });

  // Arrow keys nudge on desktop while a selection exists and focus is not in
  // a form field (a cheap bonus, not exercised by the e2e suite). Yard y
  // increases north, drawn "up" in the plan, so Up/Down/Left/Right map to the
  // compass the way a person reading the plan would expect.
  const ARROW_KEY_DIRECTION = { ArrowUp: 'N', ArrowDown: 'S', ArrowRight: 'E', ArrowLeft: 'W' };
  const FORM_FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  document.addEventListener('keydown', (event) => {
    const direction = ARROW_KEY_DIRECTION[event.key];
    if (!direction) return;
    if (appState.mode !== 'edit' || !plantSelection.getSelection().size) return;
    if (FORM_FIELD_TAGS.has(document.activeElement?.tagName)) return;
    event.preventDefault();
    handleNudge(direction);
  });

  /**
   * Where a newly added plant should land: the centre, in yard feet, of the
   * part of the plan view actually on screen right now (nl-o47.3) — the
   * plan's true middle is routinely scrolled off a phone screen. Screen-rect
   * math is delegated to the pure src/render/visiblePlanCenter.js; this is
   * the one place that reads the DOM and window for it.
   * @returns {{ at: {x:number,y:number}|null, planEntry: object|null }}
   *   `at` is null when no part of the plan is on screen (or there is no
   *   plan view yet), in which case addDriftFromCatalog (nl-o47.6.3, which
   *   calls addPlantFromCatalog for its own centre point) falls back to the
   *   plan's own middle and the caller scrolls the plan into view instead.
   */
  function computeAddPlantAtPoint() {
    const planView = appState.project?.views?.find((view) => view.type === 'plan');
    const planEntry = planView ? viewPanels.find((entry) => entry.view.id === planView.id) : null;
    if (!planView || !planEntry?.svg) return { at: null, planEntry };
    const svgRect = planEntry.svg.getBoundingClientRect();
    // visualViewport's offsetLeft/offsetTop are already in the same CSS-px
    // frame as getBoundingClientRect() (see visiblePlanCenterFt's own doc
    // comment), so this is a plain rect, not a coordinate conversion.
    const viewportRect = window.visualViewport
      ? {
          left: window.visualViewport.offsetLeft,
          top: window.visualViewport.offsetTop,
          width: window.visualViewport.width,
          height: window.visualViewport.height,
        }
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const transform = createViewTransform(planView);
    const at = visiblePlanCenterFt(svgRect, viewportRect, (point) => {
      const mapped = clientPointToViewBox(planEntry.svg, point.x, point.y);
      return mapped ? transform.viewBoxToPlan(mapped.point) : null;
    });
    return { at, planEntry };
  }

  /**
   * Wire the "Add plant" button to its sheet (src/ui/addPlantSheet.js) once
   * the catalog has loaded — until then it stays disabled, because there is
   * nothing to add. Never wired at all on the read-only example yard, which
   * keeps Add disabled the way it always has (Edit mode itself never shows
   * there, but this is the sheet's own guard too).
   */
  function initAddPlantControl() {
    if (!addPlantButton) return;
    if (readOnly) return;
    if (!appState.species.length) return;
    addPlantButton.disabled = false;
    const addPlantSheet = createAddPlantSheet({
      elements: {
        sheet: addPlantSheetEl,
        panel: addPlantSheetPanel,
        search: addPlantSearch,
        nativeChip: addPlantNativeChip,
        favoritesChip: addPlantFavoritesChip,
        sort: addPlantSort,
        status: addPlantStatus,
        list: addPlantList,
        count: addPlantCount,
        countMinus: addPlantCountMinus,
        countPlus: addPlantCountPlus,
        countFields: addPlantCountFields,
        modePlaceBtn: addPlantModePlaceBtn,
        modePaintBtn: addPlantModePaintBtn,
      },
      appState,
      trigger: addPlantButton,
      onPick: (speciesId, count, { paint = false } = {}) => {
        // Paint (nl-o47.6.6): closes the sheet into paint mode for this
        // species instead of placing anything itself — count is meaningless
        // here (the sheet already hid that stepper the instant Paint was
        // chosen). paintMode.start() re-checks Edit mode and read-only on its
        // own, same as every guard below.
        if (paint) {
          paintMode?.start(speciesId);
          return;
        }
        const { at, planEntry } = computeAddPlantAtPoint();
        const { plants: added, driftId } = addDriftFromCatalog(appState, speciesId, count, at ? { at } : undefined);
        if (!added.length) return;
        render();
        refreshSpeciesTable();
        if (driftId) {
          // count > 1 (nl-o47.6.3): one history entry for the whole drift,
          // then select every member so the next drag moves the whole clump
          // (group drag, nl-o47.2) rather than targeting a single plant.
          const label = added[0].commonName || added[0].botanicalName || speciesId;
          commitLayoutChange(`Added drift of ${added.length} ${label}`);
          setTargetedPlant(''); // clear any stale single-plant highlight
          // nl-o47.6.5/nl-o47.6.6: adding is still reachable on desktop mid-
          // review or mid-paint (its button is not locked for either), but the
          // new clump must not populate the ORDINARY selection while either is
          // open — see selectPlantsGuarded's own comment on why they never coexist.
          if (!isDriftReviewActive() && !isPaintActive()) plantSelection.selectPlants(added.map((plant) => plant.id));
        } else {
          commitLayoutChange('Added plant');
          // Target the new plant the way a click on it would (speciesHighlight);
          // a later bead (nl-o47.2) turns this into a real selection.
          setTargetedPlant(added[0].id);
        }
        if (!at) planEntry?.panel?.scrollIntoView({ block: 'center', inline: 'center' });
      },
    });
    addPlantButton.addEventListener('click', () => addPlantSheet.open());
    closeAddPlantSheet = addPlantSheet.close;
  }

  // Status, planting date and source (nl-3s5.22): each edit is one planting
  // revision through the same commit as a drag. Auto-scopes to a whole drift
  // when the opened plant has a driftId (nl-o47.6.10) — see the panel's own
  // module comment.
  const lifecyclePanel = createPlantLifecyclePanel({
    sheet: detailSheet,
    appState,
    onCommit: (description) => {
      render();
      refreshSpeciesTable();
      commitLayoutChange(description);
    },
  });
  const { open: openDetailSheet, close: closeDetailSheet } = createDetailSheet({
    elements: {
      sheet: detailSheet,
      title: detailSheetTitle,
      lines: detailSheetLines,
      ecology: detailSheetEcology,
      ecologyLines: detailSheetEcologyLines,
      fauna: detailSheetFauna,
      faunaLines: detailSheetFaunaLines,
    },
    appState,
    setTargetedPlant,
    lifecyclePanel,
  });

  if (detailSheetCloneBtn) {
    detailSheetCloneBtn.addEventListener('click', () => {
      const plantId = detailSheet?.dataset.plantId;
      // cloneDriftAwarePlant (nl-o47.6.10): copies the drift's own lifecycle
      // when the cloned plant stays in one.
      const clone = cloneDriftAwarePlant(appState, plantId);
      if (clone) {
        closeDetailSheet();
        render();
        refreshSpeciesTable();
        commitLayoutChange('Cloned plant');
      }
    });
  }
  if (detailSheetRemoveBtn) {
    // No confirmation: the change is undoable and the sheet closes behind it.
    detailSheetRemoveBtn.addEventListener('click', () => {
      removePlant(detailSheet?.dataset.plantId);
    });
  }

  /**
   * The drift-wide planting editor (nl-o47.6.10), reachable from the whole-
   * drift selection bar's "Planting" entry (in More): opens #detailSheet at
   * one of the drift's own members (any one — they are all the same
   * species), but with `{ drift: true }` so it never touches the selection
   * (see src/ui/detailSheet.js's own comment). lifecyclePanel auto-scopes to
   * the whole drift from that member's driftId the same way a drilled-in
   * member's own Details already does.
   */
  function openDriftPlantingSheet(driftId) {
    const members = driftMembers(appState.plants, driftId);
    if (!members.length) return;
    openDetailSheet(members[0].id, { drift: true });
  }

  /**
   * Plant dragging belongs to Edit mode alone — in Setup mode the pointer
   * belongs to the setup controller, so the plant controllers stay locked.
   */
  function applyMode(mode) {
    const next = !readOnly && MODES.includes(mode) ? mode : 'view';
    const changingMode = next !== appState.mode;
    appState.mode = next;
    modeButtons.forEach((button) => {
      const isActive = button.dataset.mode === next;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    if (editRow) editRow.hidden = next !== 'edit';
    if (historyRow) historyRow.hidden = next === 'view';
    if (setupRow) setupRow.hidden = next !== 'setup';
    if (featureRow) featureRow.hidden = next !== 'features';
    viewToolbar?.classList.toggle('is-setup', next === 'setup' || next === 'features');
    // The legend, season, and layer controls describe how a finished planting
    // is drawn — noise while framing views or tracing yard geometry, where
    // nothing they touch is even on screen.
    const browsing = next === 'view' || next === 'edit';
    if (viewControlsRow) viewControlsRow.hidden = !browsing;
    if (settingsToggleBtn) settingsToggleBtn.hidden = !browsing;
    if (!browsing && settingsDrawer && !settingsDrawer.hidden) {
      settingsDrawer.hidden = true;
      settingsToggleBtn?.setAttribute('aria-expanded', 'false');
    }
    // Three pointer consumers share each SVG, so exactly one mode may unlock
    // one of them. Deciding it in one place is what keeps them from fighting
    // over svg.style.cursor the way two controllers on one element do.
    // syncDragControllerLocks also accounts for isPaintActive() (nl-o47.6.6):
    // a same-mode re-apply here (Setup's rebuildViews, say) must not silently
    // re-unlock what an open paint session locked.
    syncDragControllerLocks();
    // The selection means nothing outside Edit mode (nl-o47.2); only clear it
    // on an actual change, not on the same-mode call rebuildViews makes after
    // a Setup edit, which would otherwise drop a selection on every geometry
    // tweak. syncSelectionTouchAction always re-applies, since a rebuild hands
    // out fresh controller instances that start with no class of their own.
    // The View-mode drift highlight means nothing once Edit mode's own
    // selection takes over that ring (or once leaving Edit for some other
    // mode) — cleared on any real mode change, the same trigger that already
    // clears the plain selection.
    if (changingMode) {
      plantSelection.clearSelection();
      speciesHighlight.clearHighlightedDrift();
      // A review only ever makes sense in Edit mode (nl-o47.6.5); leaving it
      // for any real reason ends one in progress. lockNonPlanControllers(false)
      // inside stop() is safe even here: it re-checks appState.mode (already
      // settled to `next` above), so it cannot wrongly re-unlock an elevation
      // controller this same mode change has already locked.
      driftReview?.stop();
      // Same reasoning, same safety (paintMode.stop()'s own finish() re-checks
      // appState.mode through syncDragControllerLocks): painting only ever
      // makes sense in Edit mode either (nl-o47.6.6). A forced stop selects
      // nothing (see that module's own stop() vs. done()).
      paintMode?.stop();
      // The "N possible drifts" banner is Edit-mode-only and depends on
      // isDriftReviewActive()/isPaintActive(); neither is re-read on its own,
      // so a mode change needs its own refresh to show or hide it.
      refreshSpeciesTable();
    }
    syncSelectionTouchAction();
    setupMode.sync();
    featuresMode.sync();
    // Phone editor last: it reads appState.mode (just settled above) and may
    // itself set appState.maximizedViewId, which the maximize refresh above
    // has therefore already run once for — rebuildViews (Setup) calls
    // applyMode again with the SAME mode, and phoneEditor.sync() is a no-op
    // whenever shouldBeActive already matches, so this costs nothing there.
    phoneEditor.sync();
    // Not over the example: its forced View must not become the mode the
    // viewer's own yards open in.
    if (!readOnly) persistMode(next);
  }


  modeButtons.forEach((button) => {
    button.addEventListener('click', () => applyMode(button.dataset.mode));
  });

  if (settingsToggleBtn && settingsDrawer) {
    settingsToggleBtn.addEventListener('click', () => {
      const willOpen = settingsDrawer.hidden;
      settingsDrawer.hidden = !willOpen;
      settingsToggleBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
  }

  const featuresMode = createFeaturesMode({
    root: featureRow,
    appState,
    getProject: () => project,
    getViewPanels: () => viewPanels,
    getControllers: () => featureControllers,
    liveView,
    render: () => render(),
    saveFeatures: (features, status) => layoutHistory.commitFeatures(features, status),
  });

  const setupMode = createSetupMode({
    root: setupRow,
    appState,
    project,
    viewsContainer,
    getViewPanels: () => viewPanels,
    getControllers: () => setupControllers,
    photoAspectFor,
    applyPageScale,
    rebuildViews,
    render: () => render(),
    commitLayoutChange: (description) => commitLayoutChange(description),
    saveSetup: (config, status) => layoutHistory.commitSetup(config, status),
    featuresMode,
    onProjectRenamed: (renamed) => {
      document.title = pageTitle(`Your yard: ${renamed.name}`);
      const projectTitle = document.getElementById('projectTitle');
      if (projectTitle) projectTitle.textContent = `Your yard: ${renamed.name}`;
      const activeOption = projectSelect?.querySelector(`option[value="${renamed.id}"]`);
      if (activeOption) activeOption.textContent = renamed.name;
    },
  });
  const setupPanel = setupMode.panel;

  applyMode(readPersistedMode());
  setupPanel.render(project);
  featuresMode.panel.render(appState.features);
  if (exportBundleButton) {
    exportBundleButton.disabled = true;
  }
  if (exportHoaButton) {
    exportHoaButton.disabled = true;
  }
  if (managePlantsButton) {
    managePlantsButton.disabled = false;
    managePlantsButton.addEventListener('click', () => {
      alert('Manage plants is coming soon. Edit plants.csv to add or update species for now.');
    });
  }
  if (labelToggle) {
    labelToggle.checked = true;
    appState.showLabels = true;
    labelToggle.addEventListener('change', (e) => {
      appState.showLabels = e.target.checked;
      render();
    });
  } else {
    appState.showLabels = false;
  }

  if (layerVisibilitySelect) {
    syncLayerButtons(appState.hiddenLayerCount);
    layerVisibilitySelect.addEventListener('change', (e) => {
      applyHiddenLayers(Number(e.target.value));
    });
  }

  // Started first so it runs alongside the CSVs; never rejects.
  const yardSite = loadYardSite(project.id);
  try {
    const [speciesCsv, drawingCsv, synonymCsv, ecology] = await Promise.all([
      fetchCsv(new URL('plants.csv', document.baseURI)),
      // How each species is drawn (nl-3s5.21): required, like plants.csv, since
      // a species without its drawing row is refused rather than drawn in
      // fallback colours.
      fetchCsv(new URL('plant-drawing.csv', document.baseURI)),
      fetchCsv(new URL('catalog/species-synonyms.csv', document.baseURI)).catch(() => ''),
      // A missing or unreadable ecology table costs checks, not the app, so
      // this never joins the failure path above — which stops the yard
      // rendering at all. loadEcologyTables owns that tolerance.
      loadEcologyTables({ ecoregion: project.ecoregion }),
    ]);
    appState.hostGenera = ecology.hostGenera;
    appState.interactions = ecology.interactions;
    // The yard's own nearby fauna (nl-3s5.31), owner-scoped on the server.
    // Tolerant like the tables above: a failure leaves an empty index, and
    // the local-fauna-support check reports not-declared.
    appState.nearbyFauna = (await yardSite).nearbyFauna;
    loadedSpeciesCsv = speciesCsv;
    loadedDrawingCsv = drawingCsv;
    appState.species = parseSpeciesCsv(speciesCsv, drawingCsv);
    appState.speciesSynonyms = parseSynonymCsv(synonymCsv);
    // History is the yard (nl-3s5.3): the plants shown are the entry at its
    // cursor, built from plants.csv. There is no stored layout file to load
    // first and reconcile against any more.
    const historyData = await loadLayoutHistory(layoutHistory.updateStatus, {
      projectId: project.id,
    });
    appState.features = (await loadProjectFeatures(undefined, { projectId: project.id })).features;
    // The panel was built before this await resolved, so it is holding the empty
    // list the app started with. Re-render it here rather than inside render():
    // the panel rebuilds its DOM outright, and doing that on every month-slider
    // frame would take the focus out of the field being typed in.
    featuresMode.panel.render(appState.features);
    // The setup and features the page loaded are the base of a yard with no
    // history yet; every stored revision carries its own.
    appState.plants = layoutHistory.start(historyData, {
      config: serializeProjectConfig(project),
      features: serializeFeatures({ features: appState.features }),
    });
    // The layout arrives after the panel is first built, and whether the yard
    // still contains it is the panel's loudest section — so it is rebuilt here
    // rather than left reporting the empty list it was born with.
    setupPanel.render(project);

    refreshSpeciesTable();
    initAddPlantControl();
    if (exportBundleButton) {
      exportBundleButton.disabled = false;
      exportBundleButton.addEventListener('click', handleBundleExport);
    }
    if (exportHoaButton) {
      exportHoaButton.disabled = false;
      exportHoaButton.addEventListener('click', handleHoaExport);
    }
  } catch (err) {
    showLoadError('Unable to load plants and layout data.');
    console.error(err);
    return;
  }

  render = () => {
    const month = parseInt(monthSlider.value, 10);
    appState.month = month;
    const plantStates = appState.plants.map((plant) => ({
      plant,
      state: computePlantState(plant, month),
    }));
    renderViews(viewPanels, plantStates, {
      showLabels: appState.showLabels,
      hiddenLayerCount: appState.hiddenLayerCount,
      highlightedSpeciesKey: appState.highlightedSpeciesKey,
      highlightedDriftId: appState.highlightedDriftId,
      // The right-click/detail-sheet "target" ring would double up with the
      // selection ring below in Edit mode, since setTargetedPlant also
      // selects there (nl-o47.2, src/ui/speciesHighlight.js) — show only the
      // selection ring while editing, and the target ring everywhere else.
      targetedPlantId: appState.mode === 'edit' ? '' : appState.targetedPlantId,
      hoveredPlantId: appState.hoveredPlantId,
      selectedPlantIds: appState.selectedPlantIds,
      // Derived fresh from the selection (nl-o47.6.12: there is no stored
      // appState.selectedDriftId any more). Like selectedPlantIds above,
      // this is already '' outside Edit mode (applyMode clears the whole
      // selection, drift context included, on every real mode change) —
      // nothing extra to gate here.
      selectedDriftId: plantSelection.getDriftContext().selectedDriftId,
      // The drift-suggestion review's outline/dimming (nl-o47.6.5) — null
      // outside a review, owned entirely by src/interaction/driftReviewMode.js.
      suggestedMemberIds: appState.suggestedDriftMemberIds,
      // "Paint a drift along a stroke"'s own live preview (nl-o47.6.6) — null
      // outside an active stroke, owned entirely by src/interaction/paintDriftMode.js.
      paintPreview: appState.paintPreview,
      features: appState.features,
    });
    selectionBar.sync();
    // Cheap: toggles one hidden attribute against the current selection size,
    // never rebuilds anything — safe to run on every render(), including a
    // bare month-slider tick.
    phoneEditor.syncBar();
    paintMode?.sync();
    setupMode.sync();
    featuresMode.sync();
    // An undo or redo can change the open plant's status under the sheet.
    lifecyclePanel.refresh();
  };

  monthSlider.addEventListener('input', (e) => {
    const month = clampMonthValue(e.target.value);
    if (month === null) return;
    monthSlider.value = String(month);
    monthReadout.textContent = MONTH_NAMES[month - 1] || '';
    render();
  });
  let lastViewportWidth = window.innerWidth;
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (window.innerWidth === lastViewportWidth) return;
      lastViewportWidth = window.innerWidth;
      render();
    }, 150);
  });

  document.addEventListener('contextmenu', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const group = target.closest('[data-plant-id]');
    if (!group) {
      plantMenu.hide();
      setTargetedPlant('');
      return;
    }
    event.preventDefault();
    const plantId = group.getAttribute('data-plant-id');
    setTargetedPlant(plantId);
    // The menu's two actions (clone, remove) both change the yard.
    if (readOnly) return;
    plantMenu.show({
      x: event.clientX,
      y: event.clientY,
      plantId,
    });
  });

  document.addEventListener('click', (event) => {
    if (plantMenu.contains(event.target)) return;
    if (detailSheet && !detailSheet.hidden && detailSheet.contains(event.target)) return;
    if (selectionBar.contains(event.target)) return;
    if (driftReview?.contains(event.target)) return;
    if (paintMode?.contains(event.target)) return;
    const target = event.target;
    const group = target instanceof Element ? target.closest('[data-plant-id]') : null;
    if (group) {
      // In Edit mode a tap/click on a plant SELECTS it instead (nl-o47.2):
      // the drag controller's own pointerdown/tap already did that, and this
      // click is only that same gesture's tail reaching here. Selection is
      // never cleared or changed from a click, only from a tap or a press —
      // see the drag controller for why (only a tap may change it).
      if (appState.mode === 'edit') return;
      openDetailSheet(group.getAttribute('data-plant-id'));
      return;
    }
    plantMenu.hide();
    closeDetailSheet();
    // Selection on an empty-drawing click is the drag controller's job (a
    // mouse press with no hit, or a touch tap with no candidates), not this
    // handler's — see its own comment for why a click here must not also
    // clear it (a click that lands here right after a completed drag is
    // common, and clearing would undo the very selection that drag just
    // relied on).
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      plantMenu.hide();
      closeDetailSheet();
      closeAddPlantSheet();
    }
  });

  applyPageScale();
  render();
}

const DEFAULT_LOAD_ERROR_HINT =
  'Serve the app with `node server.js` (npm run serve): yards load through its /api routes.';

function showLoadError(message, { hint = DEFAULT_LOAD_ERROR_HINT } = {}) {
  const text = hint ? `${message} ${hint}` : message;
  const existing = document.querySelector('.error-banner');
  if (existing) {
    existing.textContent = text;
    return;
  }
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = text;
  const main = document.querySelector('main');
  if (main) {
    main.insertAdjacentElement('beforebegin', banner);
  } else {
    document.body.appendChild(banner);
  }
}

/**
 * Mode used to be a locked/unlocked boolean, which cannot express a third mode.
 * Old values migrate on first read: locked meant View, unlocked meant Edit.
 */
function readPersistedMode() {
  if (typeof localStorage === 'undefined') return 'view';
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (MODES.includes(raw)) return raw;
    const legacy = localStorage.getItem(LEGACY_LOCK_STATE_KEY);
    if (legacy === 'false') return 'edit';
    if (legacy === 'true') return 'view';
  } catch (err) {
    console.warn('Unable to read persisted mode', err);
  }
  return 'view';
}

function persistMode(mode) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MODE_KEY, mode);
    localStorage.removeItem(LEGACY_LOCK_STATE_KEY);
  } catch (err) {
    console.warn('Unable to persist mode', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
