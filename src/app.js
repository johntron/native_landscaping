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
import { createSetupController } from './interaction/setupController.js';
import { createFeatureController } from './interaction/featureController.js';
import { emptyHostGeneraIndex } from './analysis/hostGenera.js';
import {
  emptyInteractionsIndex,
  emptyNearbyFaunaIndex,
} from './analysis/faunaMatches.js';
import { loadEcologyTables } from './data/ecologyTables.js';
import { configureViews } from './render/viewConfig.js';
import { createPlantDragController, createElevationDragController } from './interaction/dragController.js';
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
import { patchView } from './state/yardEdits.js';
import { addPlantFromCatalog, clonePlantById, removePlantById } from './state/plantEdits.js';
import { createPlantMenu } from './interaction/plantMenu.js';
import { PROJECT_QUERY_PARAM, initNewProjectForm, initProjectPicker } from './ui/projectPicker.js';
import {
  clampMonthValue,
  initMonthSlider,
  initZoomControls,
  updateScaleIndicator,
} from './ui/controls.js';

const MODE_KEY = 'native-landscaping-mode';
const LEGACY_LOCK_STATE_KEY = 'native-landscaping-positions-locked';
const MODES = ['view', 'edit', 'setup', 'features'];


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
  month: new Date().getMonth() + 1,
  zoom: DEFAULT_ZOOM,
  mode: 'view',
  showLabels: false,
  hiddenLayerCount: 0,
  highlightedSpeciesKey: '',
  targetedPlantId: '',
  hoveredPlantId: '',
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
  const addPlantSelect = document.getElementById('addPlantSelect');
  const addPlantButton = document.getElementById('addPlantBtn');

  let projectIndex;
  let project;
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
  document.title = pageTitle(`Your yard: ${project.name}`);
  const projectTitle = document.getElementById('projectTitle');
  if (projectTitle) {
    projectTitle.textContent = `Your yard: ${project.name}`;
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

  const toggleViewMaximization = (viewId) => {
    const normalized = viewId ? String(viewId) : '';
    appState.maximizedViewId = appState.maximizedViewId === normalized ? '' : normalized;
    refreshMaximizedView();
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
  const layoutHistory = createLayoutHistoryController({
    appState,
    undoButton,
    redoButton,
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

  const speciesHighlight = createSpeciesHighlight({
    appState,
    speciesTableContainer: document.getElementById('speciesTable'),
    ecologyContainer: document.getElementById('ecologyCheck'),
    render: () => render(),
  });
  const refreshSpeciesTable = () => speciesHighlight.refresh();
  const setTargetedPlant = (plantId) => speciesHighlight.setTargetedPlant(plantId);
  const setHoveredPlant = (plantId) => speciesHighlight.setHoveredPlant(plantId);

  const exportActions = createExportActions({
    appState,
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
      };
      return view.type === 'plan'
        ? createPlantDragController(shared)
        : createElevationDragController(shared);
    });
  let dragControllers = buildDragControllers();

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
      dragControllers = buildDragControllers();
      setupControllers = buildSetupControllers();
      featureControllers = buildFeatureControllers();
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
   * it would survive as a highlight nothing can clear.
   */
  const removePlant = (plantId) => {
    if (!removePlantById(appState, plantId)) return;
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
      const clone = clonePlantById(appState, plantId);
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

  /**
   * Fill the species picker from the shared catalog and wire the Add button.
   * Runs once the catalog has loaded — until then both controls stay disabled,
   * because there is nothing to choose from.
   */
  function initAddPlantControl() {
    if (!addPlantSelect || !addPlantButton) return;
    const options = appState.species
      .filter((entry) => entry.speciesId && entry.botanicalName)
      .sort((a, b) =>
        (a.commonName || a.botanicalName).localeCompare(b.commonName || b.botanicalName)
      );
    addPlantSelect.innerHTML = '';
    options.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.speciesId;
      option.textContent = entry.commonName
        ? `${entry.commonName} (${entry.botanicalName})`
        : entry.botanicalName;
      addPlantSelect.appendChild(option);
    });
    const hasOptions = options.length > 0;
    addPlantSelect.disabled = !hasOptions;
    addPlantButton.disabled = !hasOptions;
    if (!hasOptions) return;
    addPlantButton.addEventListener('click', () => {
      const added = addPlantFromCatalog(appState, addPlantSelect.value);
      if (!added) return;
      render();
      refreshSpeciesTable();
      commitLayoutChange('Added plant');
    });
  }

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
  });

  if (detailSheetCloneBtn) {
    detailSheetCloneBtn.addEventListener('click', () => {
      const plantId = detailSheet?.dataset.plantId;
      const clone = clonePlantById(appState, plantId);
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
   * Plant dragging belongs to Edit mode alone — in Setup mode the pointer
   * belongs to the setup controller, so the plant controllers stay locked.
   */
  function applyMode(mode) {
    const next = MODES.includes(mode) ? mode : 'view';
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
    dragControllers.forEach((controller) => controller?.setLocked?.(next !== 'edit'));
    setupMode.sync();
    featuresMode.sync();
    persistMode(next);
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
    appState.nearbyFauna = ecology.nearbyFauna;
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
      targetedPlantId: appState.targetedPlantId,
      hoveredPlantId: appState.hoveredPlantId,
      features: appState.features,
    });
    setupMode.sync();
    featuresMode.sync();
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
    plantMenu.show({
      x: event.clientX,
      y: event.clientY,
      plantId,
    });
  });

  document.addEventListener('click', (event) => {
    if (plantMenu.contains(event.target)) return;
    if (detailSheet && !detailSheet.hidden && detailSheet.contains(event.target)) return;
    const target = event.target;
    const group = target instanceof Element ? target.closest('[data-plant-id]') : null;
    if (group) {
      openDetailSheet(group.getAttribute('data-plant-id'));
      return;
    }
    plantMenu.hide();
    closeDetailSheet();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      plantMenu.hide();
      closeDetailSheet();
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
