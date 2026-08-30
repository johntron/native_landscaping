import { DEFAULT_ZOOM, INCHES_PER_FOOT, MONTH_NAMES, ZOOM_LIMITS } from './constants.js';
import { fetchCsv } from './data/csvLoader.js';
import {
  loadProjectConfig,
  loadProjectIndex,
  normalizeProjectConfig,
  serializeProjectConfig,
  projectAssetPath,
  projectLayoutPath,
  resolveActiveProjectId,
} from './data/projectConfig.js';
import {
  buildPlantsFromCsv,
  createPlantFromSpecies,
  parseSpeciesCsv,
  rehydratePlants,
  LayoutDataError,
} from './data/plantParser.js';
import { buildLayoutCsv } from './data/layoutExporter.js';
import {
  loadLayoutHistory,
  loadProjectFeatures,
  persistFeatures,
  persistLayout,
  persistProjectConfig,
  updateHistoryCursor,
} from './data/persistence.js';
import { compressBackgroundImage, uploadViewBackground } from './data/backgroundUpload.js';
import { computePlantState } from './state/seasonalState.js';
import { renderViews } from './render/renderViews.js';
import { createViewTransform } from './render/viewTransform.js';
import { createSetupPanel } from './interaction/setupPanel.js';
import { createSetupController } from './interaction/setupController.js';
import { createFeaturePanel } from './interaction/featurePanel.js';
import { normalizeFeatures } from './data/featureConfig.js';
import { createFeatureController } from './interaction/featureController.js';
import { analyzeEcology, buildEcologyContext } from './analysis/ecology.js';
import { buildHostGeneraIndex, emptyHostGeneraIndex } from './analysis/hostGenera.js';
import { renderEcologyPanel } from './render/ecologyPanel.js';
import {
  clearFeatureOverlay,
  createFeatureShape,
  renderFeatureOverlay,
} from './render/featureOverlay.js';
import {
  clearSetupOverlay,
  renderSetupOverlay,
} from './render/setupOverlay.js';
import { configureViews } from './render/viewConfig.js';
import { createPlantDragController, createElevationDragController } from './interaction/dragController.js';
import { buildPlantLabel } from './render/labels.js';
import { formatMonthRange } from './state/seasonalState.js';
import { clampHiddenLayerCount, classifyPlantLayer } from './state/layers.js';
import { buildCloneId, buildNewPlantId } from './state/plantIds.js';
import { getSpeciesKey } from './utils/speciesKey.js';
import { buildTooltipLines } from './render/tooltip.js';
import { createLayoutHistory } from './history/layoutHistory.js';
import { captureViewToPng } from './export/viewCapture.js';
import { resolvePhotoPlacement } from './render/photoPlacement.js';
import { viewBoxAttribute, workingExtentFt } from './render/setupOverlay.js';
import { resolveYardBounds } from './render/yardBounds.js';
import { resolvePageScale } from './render/pageScale.js';

const MODE_KEY = 'native-landscaping-mode';
const LEGACY_LOCK_STATE_KEY = 'native-landscaping-positions-locked';
const MODES = ['view', 'edit', 'setup', 'features'];

const EXPORT_MONTH = 6; // June
const PROJECT_QUERY_PARAM = 'project';

const appState = {
  project: null,
  plants: [],
  // The shared yard model in feet — beds, hardscape, the house — projected into
  // every view rather than drawn per view. Loaded through GET /api/features:
  // fetching features.json straight off disk logs a console 404 on every load
  // of every project that has never drawn one. See src/data/featureConfig.js.
  features: [],
  species: [], // the shared plants.csv catalog, for placing plants not yet in the layout
  // The genus-keyed ecology table, filtered to this project's ecoregion. Starts
  // empty and STAYS empty if ecology/host-genera.csv fails to load, which makes
  // the three genus-dependent rules report "not declared" instead of taking the
  // app down — the analysis is advisory and must never be why a yard stops
  // rendering.
  hostGenera: emptyHostGeneraIndex(),
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
let isBundleExporting = false;
const JSZipLib = typeof window !== 'undefined' ? window.JSZip : null;

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
  const setupRow = document.getElementById('setupRow');
  const featureRow = document.getElementById('featureRow');
  const viewToolbar = document.querySelector('.view-toolbar');
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const settingsDrawer = document.getElementById('settingsDrawer');
  const viewControlsRow = document.querySelector('.view-toolbar__row--controls');
  const exportBundleButton = document.getElementById('exportBundleBtn');
  const managePlantsButton = document.getElementById('managePlantsBtn');
  const labelToggle = document.getElementById('labelToggle');
  const layerVisibilitySelect = document.getElementById('layerVisibilitySelect');
  const undoButton = document.getElementById('undoLayoutBtn');
  const redoButton = document.getElementById('redoLayoutBtn');
  const historyStatus = document.getElementById('layoutHistoryStatus');
  const detailSheet = document.getElementById('detailSheet');
  const detailSheetTitle = document.getElementById('detailSheetTitle');
  const detailSheetLines = document.getElementById('detailSheetLines');
  const detailSheetCloneBtn = document.getElementById('detailSheetCloneBtn');
  const detailSheetRemoveBtn = document.getElementById('detailSheetRemoveBtn');
  const addPlantSelect = document.getElementById('addPlantSelect');
  const addPlantButton = document.getElementById('addPlantBtn');

  let projectIndex;
  let project;
  try {
    projectIndex = await loadProjectIndex(fetch, document.baseURI);
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
    showLoadError('Unable to load project configuration.');
    console.error(err);
    return;
  }
  appState.project = project;
  document.title = `${project.name} Visualization`;
  const projectTitle = document.getElementById('projectTitle');
  if (projectTitle) {
    projectTitle.textContent = `${project.name} Visualization`;
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
  let highlightedRowEl = null;
  let layoutHistoryInstance = null;
  let commitLayoutChange = () => {};
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

  const updateHistoryStatus = (message, state = '') => {
    if (!historyStatus) return;
    historyStatus.textContent = message || '';
    if (state) {
      historyStatus.dataset.state = state;
    } else {
      historyStatus.removeAttribute('data-state');
    }
  };

  const updateHistoryControls = () => {
    const canUndo = layoutHistoryInstance?.canUndo() ?? false;
    const canRedo = layoutHistoryInstance?.canRedo() ?? false;
    if (undoButton) undoButton.disabled = !canUndo;
    if (redoButton) redoButton.disabled = !canRedo;
  };

  const applyHistoryPlants = (plants) => {
    if (!Array.isArray(plants)) return;
    // Same reasoning as the boot-time restore: a history entry's attributes are a
    // snapshot from whenever it was recorded, not necessarily what the catalog says
    // now. Undo/redo move POSITIONS through history; attributes stay live.
    appState.plants = rehydratePlants(plants, appState.species);
    render();
    // Undoing an add or a remove changes which species are placed.
    refreshSpeciesTable();
    updateHistoryControls();
  };

  const handleUndo = () => {
    if (!layoutHistoryInstance) return;
    const plants = layoutHistoryInstance.undo();
    if (!plants) return;
    applyHistoryPlants(plants);
    updateHistoryCursor(layoutHistoryInstance.getCursor(), updateHistoryStatus, {
      projectId: appState.project?.id,
    });
  };

  const handleRedo = () => {
    if (!layoutHistoryInstance) return;
    const plants = layoutHistoryInstance.redo();
    if (!plants) return;
    applyHistoryPlants(plants);
    updateHistoryCursor(layoutHistoryInstance.getCursor(), updateHistoryStatus, {
      projectId: appState.project?.id,
    });
  };

  if (undoButton) {
    undoButton.addEventListener('click', handleUndo);
  }
  if (redoButton) {
    redoButton.addEventListener('click', handleRedo);
  }

  const setHighlightedSpecies = (speciesKey, rowEl) => {
    const normalized = (speciesKey || '').toLowerCase();
    if (highlightedRowEl && highlightedRowEl !== rowEl) {
      highlightedRowEl.classList.remove('is-highlighted');
    }
    if (normalized && rowEl) {
      rowEl.classList.add('is-highlighted');
      highlightedRowEl = rowEl;
    } else if (!normalized) {
      if (highlightedRowEl) highlightedRowEl.classList.remove('is-highlighted');
      highlightedRowEl = null;
    }
    if (appState.highlightedSpeciesKey !== normalized) {
      appState.highlightedSpeciesKey = normalized;
      render();
    }
  };

  const clearHighlightedSpecies = (rowEl) => {
    if (rowEl && highlightedRowEl && rowEl !== highlightedRowEl) return;
    if (highlightedRowEl) {
      highlightedRowEl.classList.remove('is-highlighted');
      highlightedRowEl = null;
    }
    if (appState.highlightedSpeciesKey) {
      appState.highlightedSpeciesKey = '';
      render();
    }
  };

  /**
   * Re-grade the design. Rides refreshSpeciesTable rather than render() for the
   * same reason the table does: render() fires on every month-slider input
   * event, and rebuilding this DOM mid-drag would collapse a row the reader had
   * just opened. What changes the grade is what is planted, and that is exactly
   * when refreshSpeciesTable runs.
   */
  const refreshEcologyPanel = () => {
    const container = document.getElementById('ecologyCheck');
    if (!container) return;
    const results = analyzeEcology(
      buildEcologyContext({
        plants: appState.plants,
        species: appState.species,
        hostGenera: appState.hostGenera,
        site: appState.project?.site,
        ecoregion: appState.project?.ecoregion,
      })
    );
    renderEcologyPanel(results, container);
  };

  /**
   * Rebuild the species legend from the current plants. Adding, removing, or
   * undoing changes which species are placed, and the table is built from the
   * layout rather than from the catalog. Deliberately not called from render():
   * the month slider renders on every input event, and rebuilding the table
   * mid-drag would orphan the row this closure is holding.
   */
  const refreshSpeciesTable = () => {
    highlightedRowEl = null;
    const stillPlaced = appState.plants.some(
      (plant) => getSpeciesKey(plant) === appState.highlightedSpeciesKey
    );
    if (appState.highlightedSpeciesKey && !stillPlaced) {
      appState.highlightedSpeciesKey = '';
    }
    renderSpeciesTable(appState.plants, {
      onHoverStart: (speciesKey, rowEl) => setHighlightedSpecies(speciesKey, rowEl),
      onHoverEnd: (_speciesKey, rowEl) => clearHighlightedSpecies(rowEl),
    });
    refreshEcologyPanel();
  };


  const setTargetedPlant = (plantId) => {
    const normalized = plantId ? String(plantId) : '';
    if (normalized === appState.targetedPlantId) return;
    appState.targetedPlantId = normalized;
    render();
  };
  const findSpeciesRowEl = (speciesKey) => {
    if (!speciesKey) return null;
    const container = document.getElementById('speciesTable');
    if (!container) return null;
    return (
      Array.from(container.querySelectorAll('tr[data-species-key]')).find(
        (row) => row.dataset.speciesKey === speciesKey
      ) || null
    );
  };
  const setHoveredPlant = (plantId) => {
    const normalized = plantId ? String(plantId) : '';
    if (normalized === appState.hoveredPlantId) return;
    appState.hoveredPlantId = normalized;
    const plant = normalized ? appState.plants.find((p) => String(p.id) === normalized) : null;
    if (plant) {
      const speciesKey = getSpeciesKey(plant);
      setHighlightedSpecies(speciesKey, findSpeciesRowEl(speciesKey));
    } else {
      clearHighlightedSpecies();
    }
    render();
  };
  const handleBundleExport = async () => {
    if (isBundleExporting) return;
    if (!viewPanels.length || viewPanels.some(({ svg }) => !svg)) return;
    if (!loadedSpeciesCsv) {
      console.warn('No plants.csv loaded; cannot export bundle.');
      return;
    }
    isBundleExporting = true;
    const restoreToken = snapshotViewState({
      monthSlider,
      monthReadout,
      state: appState,
    });
    toggleButtonBusy(exportBundleButton, true, 'Preparing bundle…');
    applyHiddenLayers(0, { shouldRender: false });
    appState.hoveredPlantId = '';
    appState.targetedPlantId = '';
    appState.month = EXPORT_MONTH;
    if (monthSlider) monthSlider.value = String(EXPORT_MONTH);
    if (monthReadout) monthReadout.textContent = MONTH_NAMES[EXPORT_MONTH - 1] || '';
    render();
    await nextFrame();

    try {
      if (!JSZipLib) {
        throw new Error('JSZip is not loaded');
      }
      const panels = viewPanels.map(({ view, svg }) => ({
        view,
        svg,
        fileName: `${view.id}-view.png`,
      }));
      const pngs = await Promise.all(
        panels.map(({ view, svg }) =>
          captureViewToPng({
            svg,
            viewBox: view.viewBox,
            ...backgroundForCapture(project, view),
          })
        )
      );

      const zip = new JSZipLib();
      zip.file('plants.csv', loadedSpeciesCsv);
      zip.file('planting_layout.csv', buildLayoutCsv(appState.plants));
      pngs.forEach((png, index) => {
        zip.file(`images/${panels[index].fileName}`, png);
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      triggerDownload(blob, `${project.id}-plan.zip`);
    } catch (err) {
      console.error('Failed to export plan bundle', err);
      alert('Unable to export plan bundle. Check console for details.');
    } finally {
      restoreViewState(restoreToken, {
        monthSlider,
        monthReadout,
        state: appState,
        onRestore: () => {
          syncLayerButtons(appState.hiddenLayerCount);
          render();
        },
      });
      toggleButtonBusy(exportBundleButton, false);
      isBundleExporting = false;
    }
  };
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
      syncSetupOverlay();
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
          applyViewEdit({
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
            getSelectedId: () => featurePanel.getSelectedId(),
            onSelect: (id) => {
              featurePanel.setSelectedId(id);
              syncFeatureOverlay();
            },
            onChange: (candidate) => applyFeatureEdit(replaceFeature(appState.features, candidate)),
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
      .filter((entry) => entry.botanicalName)
      .sort((a, b) =>
        (a.commonName || a.botanicalName).localeCompare(b.commonName || b.botanicalName)
      );
    addPlantSelect.innerHTML = '';
    options.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.botanicalKey || entry.botanicalName;
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

  const closeDetailSheet = () => {
    if (!detailSheet || detailSheet.hidden) return;
    detailSheet.hidden = true;
    delete detailSheet.dataset.plantId;
    setTargetedPlant('');
  };

  const openDetailSheet = (plantId) => {
    if (!detailSheet) return;
    const plant = appState.plants.find((p) => String(p.id) === String(plantId));
    if (!plant) return;
    const state = computePlantState(plant, appState.month);
    if (detailSheetTitle) {
      detailSheetTitle.innerHTML = '';
      if (plant.botanicalName) {
        const em = document.createElement('em');
        em.textContent = plant.botanicalName;
        detailSheetTitle.appendChild(em);
      } else {
        detailSheetTitle.textContent = plant.commonName || 'Plant details';
      }
    }
    if (detailSheetLines) {
      detailSheetLines.innerHTML = '';
      buildTooltipLines(plant, state)
        .filter(Boolean)
        .filter((line) => line !== plant.botanicalName)
        .forEach((line) => {
          const li = document.createElement('li');
          li.textContent = line;
          detailSheetLines.appendChild(li);
        });
    }
    detailSheet.dataset.plantId = plantId;
    detailSheet.hidden = false;
    setTargetedPlant(plantId);
  };

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
  if (detailSheet) {
    detailSheet.querySelectorAll('[data-detail-close]').forEach((el) => {
      el.addEventListener('click', closeDetailSheet);
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
    syncSetupOverlay();
    syncFeatureOverlay();
    persistMode(next);
  }


  /**
   * Move the plants a resized yard has left outside it.
   *
   * Never automatic. Resizing is exploratory — you type 6, look, type 8 — so a
   * yard edit redraws and reports, and only a button here moves anything. Both
   * actions are one entry in the layout history, so either is one undo.
   *
   * The two are not two mechanisms, they are two intents, and the panel says so:
   *
   * - **scale** is the "I mis-measured" correction. Every plant AND every
   *   feature moves together, uniformly, about the yard's corner, so the design
   *   keeps its shape. Uniform and never enlarging: a non-uniform fit would
   *   distort the spacing between plants, which is most of what a planting plan
   *   is, and growing a design to fill a yard is not a repair.
   * - **clamp** is the "that ground is gone" correction, and touches only what
   *   is stranded.
   *
   * @param {{ action: 'scale'|'clamp', ids?: Array<string> }} request
   */
  function resolveStrandedPlants({ action, ids }) {
    const yardFt = project.yardFt;
    if (!(yardFt?.width > 0) || !(yardFt?.depth > 0)) return;

    if (action === 'clamp') {
      const wanted = new Set(ids || []);
      appState.plants = appState.plants.map((plant) =>
        wanted.has(plant.id)
          ? { ...plant, x: clamp(plant.x, 0, yardFt.width), y: clamp(plant.y, 0, yardFt.depth) }
          : plant
      );
      commitLayoutChange(
        wanted.size === 1 ? 'Moved a plant inside the yard' : 'Moved plants inside the yard'
      );
      setupPanel.render(project);
      setupPanel.setStatus(
        `Moved ${wanted.size} inside the boundary.`,
        'success'
      );
      render();
      return;
    }

    // The factor comes from what is actually drawn, not from the yard's own
    // previous size — which nothing remembers by the time a resize has been
    // typed, deleted, and retyped a few times.
    const reach = contentReach();
    if (!reach) return;
    const factor = Math.min(1, yardFt.width / reach.x, yardFt.depth / reach.y);
    if (!(factor > 0) || factor >= 1) {
      // Nothing overshoots the far side, so everything stranded is off the
      // SOUTH or WEST edge — at a negative coordinate, which shrinking about
      // the origin only pushes further out. Saying so beats a button that
      // appears to do nothing.
      setupPanel.setStatus(
        'Scaling cannot help here: what is outside is off the south or west edge, ' +
          'and scaling about the yard corner only moves it further out. Move those ' +
          'inside the boundary instead.',
        'error'
      );
      return;
    }

    appState.plants = appState.plants.map((plant) => ({
      ...plant,
      x: round2(plant.x * factor),
      y: round2(plant.y * factor),
    }));
    const features = scaleFeatures(appState.features, factor);
    commitLayoutChange('Scaled the design to fit the yard');
    // The layout is written the moment it changes and features are not, so
    // leaving these to a separate Save would land a reload in exactly the state
    // this action exists to prevent: beds at one size, the plants in them at
    // another.
    const featuresChanged = features !== appState.features && applyFeatureEdit(features);
    if (featuresChanged) saveFeatures();
    setupPanel.render(project);
    setupPanel.setStatus(
      `Scaled everything to ${Math.round(factor * 100)}% about the yard corner` +
        (featuresChanged ? ', features included.' : '.'),
      'success'
    );
    render();
  }

  /**
   * How far the design reaches from the yard's corner, plants and features alike.
   *
   * Only the far side: scaling about the origin is what "fit" means here, and a
   * negative coordinate is not something it can pull in.
   */
  function contentReach() {
    let x = 0;
    let y = 0;
    appState.plants.forEach((plant) => {
      x = Math.max(x, plant.x);
      y = Math.max(y, plant.y);
    });
    featurePoints(appState.features).forEach((point) => {
      x = Math.max(x, point.x);
      y = Math.max(y, point.y);
    });
    return x > 0 && y > 0 ? { x, y } : null;
  }

  /**
   * Setup draws ONE view: the selected one, scaled to the whole page.
   *
   * Every panel used to draw the guides so the foot grid could be compared
   * across views, because each view carried its own rectangle and had to be
   * aligned against its neighbours by eye. The yard is declared now, so there
   * is nothing left to align — and the page's whole width spent on one drawing
   * beats four small ones for the work that remains, which is framing photos
   * and placing cameras.
   *
   * Rendering clears each SVG, so this runs after every render rather than once.
   */
  function syncSetupOverlay() {
    const inSetup = appState.mode === 'setup';
    const selectedId = inSetup ? setupPanel.getSelectedId() : '';
    const show = inSetup ? setupPanel.getShow() : { plants: true, features: true };

    // Setup shows ONE view at a time. Every panel used to draw its guides so the
    // foot grid could be compared across views, which mattered when each view
    // carried its own rectangle and had to be aligned by eye. The yard is
    // declared now, so there is nothing left to align — and the whole page's
    // width spent on one drawing is worth far more than four small ones.
    if (viewsContainer) {
      viewsContainer.toggleAttribute('data-setup-focus', inSetup);
      viewsContainer.toggleAttribute('data-hide-plants', inSetup && !show.plants);
      viewsContainer.toggleAttribute('data-hide-features', inSetup && !show.features);
    }

    viewPanels.forEach(({ view, svg, panel, container }, index) => {
      const isSelected = view.id === selectedId;
      const focused = inSetup && isSelected;
      panel.classList.toggle('is-setup-focus', focused);
      setupControllers[index]?.setLocked?.(!isSelected);
      // Setup widens the drawing's window so a photo reaching past the view is
      // visible while it is being positioned; same units and origin, larger box.
      svg.setAttribute('viewBox', viewBoxAttribute(view, { working: focused }));
      // The panel is sized to whichever window it is showing, so the widened
      // one is not letterboxed inside a panel shaped for the narrow one.
      if (container?.style) {
        const extentFt = focused ? workingExtentFt(view) : view.extentFt;
        container.style.setProperty('--extent-w', String(extentFt.width));
        container.style.setProperty('--extent-h', String(extentFt.height));
        container.style.setProperty(
          '--view-aspect-ratio',
          `${extentFt.width} / ${extentFt.height}`
        );
      }
      // Only the shown view is drawn. Guides on a hidden panel are work nobody
      // sees, and they used to be the neighbours' cross-view reference — which
      // a declared yard has made unnecessary.
      if (!focused) {
        clearSetupOverlay(svg);
        return;
      }
      renderSetupOverlay(svg, view, {
        interactive: isSelected,
        yardFt: project.yardFt,
        paddingFt: project.paddingFt,
        photoAspect: photoAspectFor(view),
        // Setup draws the photo itself rather than leaving it to the panel's
        // CSS background, which is clipped to its element.
        photoUrl: view.background
          ? new URL(projectAssetPath(project.id, view.background), document.baseURI).toString()
          : '',
        // A plan draws every elevation's camera, so it needs the whole list;
        // the selected one is emphasised so the list and the drawing agree
        // about which view is being set up.
        views: project.views,
        highlightId: selectedId,
      });
    });
    // The focused panel has the page to itself, so it is scaled to fill it.
    applyPageScale();
  }

  /**
   * The feature handles belong to the plan alone, and only in Features mode.
   * Rendering clears each SVG, so this runs after every render rather than once.
   */
  function syncFeatureOverlay() {
    const editing = appState.mode === 'features';
    viewPanels.forEach(({ view, svg }, index) => {
      const active = editing && view.type === 'plan';
      featureControllers[index]?.setLocked?.(!active);
      if (!active) {
        clearFeatureOverlay(svg);
        return;
      }
      renderFeatureOverlay(
        svg,
        appState.features,
        featurePanel.getSelectedId(),
        createViewTransform(liveView(view.id) || view)
      );
    });
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

  const featurePanel = createFeaturePanel({
    root: featureRow,
    onCommit: (features) => applyFeatureEdit(features),
    onSave: () => saveFeatures(),
    onSelect: () => syncFeatureOverlay(),
    onAdd: (type) => addFeature(type),
  });

  const setupPanel = createSetupPanel({
    root: setupRow,
    onCommit: (candidate) => applyViewEdit(candidate),
    onSelect: () => syncSetupOverlay(),
    onShowChange: () => syncSetupOverlay(),
    onResolveConflicts: (request) => resolveStrandedPlants(request),
    getPlants: () => appState.plants,
    /**
     * Picked photo to live background: compress, upload, then commit the path
     * the server chose. The view is only patched after the bytes are on disk —
     * committing first would point the drawing at a file that may never arrive.
     */
    onUploadBackground: async (file, viewId) => {
      setupPanel.setStatus('Preparing photo…', 'info');
      try {
        const { blob, contentType, width, height } = await compressBackgroundImage(file);
        setupPanel.setStatus(`Uploading ${formatFileSize(blob.size)}…`, 'info');
        const background = await uploadViewBackground({
          projectId: project.id,
          viewId,
          blob,
          contentType,
        });
        // The photo is on disk either way, but if the candidate views[] is
        // refused the panel is still showing the old background — and
        // applyViewEdit has already explained why. Reporting success over the
        // top of that would be a straight lie.
        // A new photo is a new picture: whatever placement the last one had
        // describes a rectangle of a different image, so it goes with it.
        if (!applyViewEdit({ views: patchView(project.views, viewId, { background, photoFt: undefined }) }))
          return;
        setupPanel.setStatus(
          `Background set — ${width}×${height}, ${formatFileSize(blob.size)}. Save views to keep it.`,
          'success'
        );
      } catch (err) {
        console.warn('Background upload failed', err);
        setupPanel.setStatus(err.message || 'Background upload failed', 'error');
      }
    },
    onSave: async () => {
      setupPanel.setStatus('Saving…', 'info');
      const saved = await persistProjectConfig(project, (message, state) =>
        setupPanel.setStatus(message, state)
      );
      if (saved) setupPanel.setStatus('Views saved', 'success');
    },
  });

  /**
   * Validate a candidate project the same way a reload would, then swap it in.
   * Round-tripping through serialize + normalize means a rejected edit leaves
   * the drawing on the last good state instead of throwing mid-render.
   *
   * @param {object} candidate the full next project — setupPanel's commit()
   * always spreads its own state.project under the patch before calling this,
   * so candidate already carries everything, including any optional field the
   * edit cleared. Merging it back onto `serializeProjectConfig(project)` would
   * undo exactly that: an optional field's serializer omits it once cleared
   * (falsy), and the old value would resurface from the base object instead of
   * staying gone.
   * @returns {boolean} whether the edit was applied — a caller that reports its
   * own success afterwards must not paper over the rejection message set here.
   */
  function applyViewEdit(candidate) {
    let validated;
    try {
      validated = normalizeProjectConfig(serializeCandidate(candidate), project.id);
    } catch (err) {
      setupPanel.setStatus(err.message, 'error');
      return false;
    }
    Object.assign(project, validated);
    appState.project = project;
    document.title = `${project.name} Visualization`;
    const projectTitle = document.getElementById('projectTitle');
    if (projectTitle) projectTitle.textContent = `${project.name} Visualization`;
    const activeOption = projectSelect?.querySelector(`option[value="${project.id}"]`);
    if (activeOption) activeOption.textContent = project.name;
    rebuildViews();
    setupPanel.render(project);
    return true;
  }

  /**
   * A candidate carries normalized views, which serializeProjectConfig would
   * refuse to read from a half-built object. Run it through the same serializer
   * so the yard, the padding, and each view's photo arrive in file shape.
   */
  function serializeCandidate(candidate) {
    return serializeProjectConfig({ ...project, ...candidate });
  }

  /** Swap one feature for its edited candidate, keeping the list's z-order. */
  function replaceFeature(features, candidate) {
    return features.map((feature) => (feature.id === candidate.id ? candidate : feature));
  }

  /**
   * Validate a candidate feature list before it becomes live.
   *
   * The same contract applyViewEdit has, and for the same reason: a drag that
   * produces something normalizeFeatures refuses must leave the drawing on the
   * last good state rather than half-applying. Nothing here mutates
   * appState.features until the whole list has passed.
   */
  function applyFeatureEdit(features) {
    let validated;
    try {
      // Normalized directly rather than serialized first: a freshly added shape
      // carries no style yet, and normalizeFeatures is what supplies one.
      validated = normalizeFeatures({ features }, project.id);
    } catch (err) {
      featurePanel.setStatus(err.message, 'error');
      return false;
    }
    appState.features = validated.features;
    render();
    featurePanel.render(appState.features);
    return true;
  }

  /**
   * Add a shape in the middle of the yard, then select it.
   *
   * Not the middle of the plan panel: that includes the padding drawn around
   * the yard, and a shape placed there would start life off the property.
   */
  function addFeature(type) {
    const planView = project.views.find((view) => view.type === 'plan');
    if (!planView) {
      featurePanel.setStatus('Add a plan view before drawing features', 'error');
      return;
    }
    const transform = createViewTransform(planView);
    const bounds = resolveYardBounds(project) || {
      x: { min: transform.originFt.x, max: transform.originFt.x + transform.extentFt.width },
      y: { min: transform.originFt.y, max: transform.originFt.y + transform.extentFt.height },
    };
    const center = {
      x: (bounds.x.min + bounds.x.max) / 2,
      y: (bounds.y.min + bounds.y.max) / 2,
    };
    const shape = createFeatureShape(type, center, appState.features.map((f) => f.id), bounds);
    if (!applyFeatureEdit([...appState.features, shape])) return;
    featurePanel.setSelectedId(shape.id);
    syncFeatureOverlay();
  }

  /**
   * Features are setup, like the view config and unlike the layout: they save
   * when asked rather than on every gesture, and there is no undo stack behind
   * them. Auto-saving each drag frame would be a write per pointer release.
   */
  function saveFeatures() {
    persistFeatures(
      appState.features,
      (message, state) => featurePanel.setStatus(message, state),
      { projectId: project.id }
    );
  }

  applyMode(readPersistedMode());
  setupPanel.render(project);
  featurePanel.render(appState.features);
  if (exportBundleButton) {
    exportBundleButton.disabled = true;
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
    const [speciesCsv, layoutCsv, hostGeneraCsv] = await Promise.all([
      fetchCsv(new URL('plants.csv', document.baseURI)),
      fetchCsv(new URL(projectLayoutPath(project.id), document.baseURI)),
      // A missing or unreadable table costs three of the six checks, not the
      // app: caught here so it can never join the failure path above, which
      // stops the yard rendering at all.
      fetchCsv(new URL('ecology/host-genera.csv', document.baseURI)).catch((err) => {
        console.warn('Ecology host-genera table unavailable; genus checks will report as not declared', err);
        return '';
      }),
    ]);
    if (hostGeneraCsv) {
      appState.hostGenera = buildHostGeneraIndex(hostGeneraCsv, { ecoregion: project.ecoregion });
    }
    loadedSpeciesCsv = speciesCsv;
    appState.species = parseSpeciesCsv(speciesCsv);
    const initialPlants = buildPlantsFromCsv(speciesCsv, layoutCsv);
    const layoutCsvSnapshot = buildLayoutCsv(initialPlants);
    const historyData = await loadLayoutHistory(updateHistoryStatus, {
      layoutCsv: layoutCsvSnapshot,
      projectId: project.id,
    });
    appState.features = (await loadProjectFeatures(undefined, { projectId: project.id })).features;
    // The panel was built before this await resolved, so it is holding the empty
    // list the app started with. Re-render it here rather than inside render():
    // the panel rebuilds its DOM outright, and doing that on every month-slider
    // frame would take the focus out of the field being typed in.
    featurePanel.render(appState.features);
    const historyEntries = historyData.entries || [];
    const historyCursor = typeof historyData.cursor === 'number' ? historyData.cursor : -1;
    layoutHistoryInstance = createLayoutHistory(initialPlants, {
      seedEntries: historyEntries,
      initialCursor: historyCursor,
    });
    const currentPlants = layoutHistoryInstance.getCurrentPlants();
    // A history entry snapshots full plant objects, attributes included, so a
    // restored entry would otherwise un-correct any catalog fix made since it was
    // recorded — see rehydratePlants. Positions and identity come from history;
    // attributes always come fresh from the catalog just parsed above.
    appState.plants = rehydratePlants(currentPlants.length ? currentPlants : initialPlants, appState.species);
    updateHistoryControls();
    // The layout arrives after the panel is first built, and whether the yard
    // still contains it is the panel's loudest section — so it is rebuilt here
    // rather than left reporting the empty list it was born with.
    setupPanel.render(project);

    commitLayoutChange = (description) => {
      if (!layoutHistoryInstance) return;
      const previousPlants = layoutHistoryInstance.getCurrentPlants();
      layoutHistoryInstance.record(appState.plants, { description });
      updateHistoryControls();
      persistLayout(appState.plants, description, updateHistoryStatus, {
        previousPlants,
        projectId: project.id,
      }).then((result) => {
        if (result) {
          console.log('Layout persisted', {
            entryId: result.entry?.id || 'unknown',
            cursor: result.cursor,
          });
        }
        if (result?.entry) {
          layoutHistoryInstance.annotateCurrentEntry(result.entry);
        }
        if (typeof result?.cursor === 'number') {
          layoutHistoryInstance.setCursor(result.cursor);
        }
        updateHistoryControls();
      });
    };

    refreshSpeciesTable();
    initAddPlantControl();
    if (exportBundleButton) {
      exportBundleButton.disabled = false;
      exportBundleButton.addEventListener('click', handleBundleExport);
    }
  } catch (err) {
    if (err instanceof LayoutDataError) {
      // The files loaded; their contents are wrong. Say which row so a hand-edit
      // mistake is fixable without opening the console.
      showLoadError(err.message, { hint: 'Fix the layout CSV for this project, then reload.' });
    } else {
      showLoadError('Unable to load plants and layout data.');
    }
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
    syncSetupOverlay();
    syncFeatureOverlay();
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

/**
 * Populate the project picker. Switching navigates to `?project=<id>` and lets the
 * page reload — the render loop, history stack, and drag controllers are all built
 * once against a single project, so a reload is both simpler and linkable.
 */
function initProjectPicker(selectEl, projectIndex, activeId) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  projectIndex.projects.forEach((entry) => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    option.selected = entry.id === activeId;
    selectEl.appendChild(option);
  });
  selectEl.disabled = projectIndex.projects.length < 2;
  selectEl.addEventListener('change', (event) => {
    const nextId = event.target.value;
    if (!nextId || nextId === activeId) return;
    const url = new URL(window.location.href);
    url.searchParams.set(PROJECT_QUERY_PARAM, nextId);
    window.location.assign(url.toString());
  });
}

/**
 * "+ New project": a name, a server-derived slug, and a reload onto it —
 * the same navigation `initProjectPicker` uses to switch, so a freshly
 * created project boots exactly like any other rather than needing its own
 * in-place initialization path.
 */
function initNewProjectForm({ button, form, nameInput, cancelButton, status }) {
  if (!button || !form || !nameInput) return;

  const setStatus = (message, state) => {
    if (!status) return;
    status.textContent = message || '';
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };

  const close = () => {
    form.hidden = true;
    nameInput.value = '';
    setStatus('');
  };

  button.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) nameInput.focus();
  });
  cancelButton?.addEventListener('click', close);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const id = slugifyProjectName(name);
    if (!id) {
      setStatus('Enter a name first.', 'error');
      return;
    }
    setStatus('Creating…');
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      const url = new URL(window.location.href);
      url.searchParams.set(PROJECT_QUERY_PARAM, id);
      window.location.assign(url.toString());
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });
}

/** A project id is a path segment — see PROJECT_ID_PATTERN in projectConfig.js. */
function slugifyProjectName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Background to composite under a view's export: an absolute URL plus, for a
 * photo that has been placed, the rectangle of the drawing it occupies. Both
 * are null when the view has no image yet — captureViewToPng then skips the
 * background rather than fetching projects/<slug>/null.
 */
function backgroundForCapture(project, view) {
  const { path, rect } = resolvePhotoPlacement(view);
  if (!path) return { backgroundUrl: null, destRect: null };
  return {
    backgroundUrl: new URL(projectAssetPath(project.id, path), document.baseURI).toString(),
    destRect: rect,
  };
}

function initMonthSlider(sliderEl, readoutEl, initialMonth) {
  if (!sliderEl) return;
  sliderEl.min = '1';
  sliderEl.max = '12';
  sliderEl.step = '1';
  const clamped = clampMonthValue(initialMonth);
  sliderEl.value = String(clamped);
  if (readoutEl) {
    readoutEl.textContent = MONTH_NAMES[clamped - 1] || '';
  }
}

function initZoomControls(inputEl, sliderEl, onChange, initialValue = DEFAULT_ZOOM) {
  if (!inputEl || !sliderEl) return;

  const { min, max, step } = ZOOM_LIMITS;
  [inputEl, sliderEl].forEach((el) => {
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
  });

  const apply = (rawValue) => {
    const parsed = clampZoomValue(Number(rawValue));
    if (parsed === null) return;
    inputEl.value = formatZoomValue(parsed);
    sliderEl.value = String(parsed);
    onChange?.(parsed);
  };

  inputEl.addEventListener('change', (e) => apply(e.target.value));
  sliderEl.addEventListener('input', (e) => apply(e.target.value));

  apply(initialValue);
}

/**
 * The reference bars are drawn at the view's own scale, which no longer moves —
 * zoom resizes the panel around them rather than restretching the yard.
 */
function updateScaleIndicator(container, pxPerFt) {
  if (!container) return;
  const items = container.querySelectorAll('.scale-indicator__item');
  items.forEach((item) => {
    const inches = resolveInches(item);
    if (!inches) return;
    const width = Math.max((inches / INCHES_PER_FOOT) * pxPerFt, 4);
    const line = item.querySelector('.scale-indicator__line');
    if (line) {
      line.style.width = `${width}px`;
    }
  });
}

const DEFAULT_LOAD_ERROR_HINT =
  'Please serve plants.csv and the projects/ directory over HTTP (for example, via `npx serve`).';

function showLoadError(message, { hint = DEFAULT_LOAD_ERROR_HINT } = {}) {
  const text = `${message} ${hint}`;
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

function clampZoomValue(value) {
  if (!Number.isFinite(value)) return null;
  const { min, max } = ZOOM_LIMITS;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampMonthValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1) return 1;
  if (parsed > 12) return 12;
  return Math.round(parsed);
}

function formatZoomValue(value) {
  return value.toFixed(2);
}

function renderSpeciesTable(plants, handlers = {}) {
  const { onHoverStart, onHoverEnd } = handlers;
  const container = document.getElementById('speciesTable');
  if (!container) return;
  container.innerHTML = '';
  if (!plants?.length) return;

  const speciesMap = new Map();
  plants.forEach((plant) => {
    const key =
      getSpeciesKey(plant) || plant.botanicalName || plant.botanical_name || plant.commonName || plant.common_name;
    if (!key || speciesMap.has(key)) return;
    speciesMap.set(key, plant);
  });

  const rows = Array.from(speciesMap.values()).sort((a, b) => {
    const labelA = buildPlantLabel(a);
    const labelB = buildPlantLabel(b);
    if (labelA && labelB) {
      return labelA.localeCompare(labelB);
    }
    const nameA = (a.commonName || a.botanicalName || '').toLowerCase();
    const nameB = (b.commonName || b.botanicalName || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const table = document.createElement('table');
  table.className = 'species-table__table';
  const thead = document.createElement('thead');
  const headers = ['Label', 'Botanical name', 'Common name', 'Height (ft)', 'Width (ft)', 'Growth form', 'Sun', 'Water', 'Soil', 'Bloom months'];
  const headerRow = document.createElement('tr');
  headers.forEach((title) => {
    const th = document.createElement('th');
    th.textContent = title;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((plant) => {
    const tr = document.createElement('tr');
    const speciesKey = getSpeciesKey(plant);
    tr.dataset.speciesKey = speciesKey;
    tr.addEventListener('mouseenter', () => onHoverStart?.(speciesKey, tr));
    tr.addEventListener('mouseleave', () => onHoverEnd?.(speciesKey, tr));
    const cells = [
      { value: buildPlantLabel(plant), className: 'species-table__label' },
      { value: plant.botanicalName || plant.botanical_name || '', italic: true },
      { value: plant.commonName || plant.common_name || '' },
      { value: formatFeet(plant.height) },
      { value: formatFeet(plant.width) },
      { value: plant.growthShape || plant.growth_shape || '' },
      { value: plant.sunPref || plant.sun_pref || '' },
      { value: plant.waterPref || plant.water_pref || '' },
      { value: plant.soilPref || plant.soil_pref || '' },
      {
        value: formatMonthRange(
          plant.floweringMonths ||
            plant.flowering_season_months ||
            plant.floweringSeasonMonths
        ),
      },
    ];

    cells.forEach((cell, idx) => {
      const td = document.createElement('td');
      if (cell.italic && cell.value) {
        const em = document.createElement('em');
        em.textContent = cell.value;
        td.appendChild(em);
      } else {
        td.textContent = cell.value ?? '';
      }
      td.dataset.label = headers[idx];
      if (cell.className) td.className = cell.className;
      if (idx > 2) td.classList.add('species-table__extra');
      tr.appendChild(td);
    });

    const toggleTd = document.createElement('td');
    toggleTd.className = 'species-table__toggle-cell';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'species-table__toggle-btn';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.textContent = 'Details';
    toggleBtn.addEventListener('click', () => {
      const expanded = tr.classList.toggle('is-expanded');
      toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggleBtn.textContent = expanded ? 'Hide details' : 'Details';
    });
    toggleTd.appendChild(toggleBtn);
    tr.appendChild(toggleTd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function formatFeet(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return num.toFixed(1);
}

function formatFileSize(bytes) {
  const kb = Number(bytes) / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Every authored point in the feature model, whatever primitive holds it. */
function featurePoints(features) {
  return (Array.isArray(features) ? features : []).flatMap(
    (feature) => feature.footprintFt || feature.pathFt || []
  );
}

/**
 * Scale the feature model about the yard's corner.
 *
 * Features move with the plants or not at all: a bed scaled while the plants in
 * it stay put is worse than either alone. Heights scale too — a fence is not
 * the same fence at 60% of its footprint — and so does a stroke width in feet.
 */
function scaleFeatures(features, factor) {
  if (!Array.isArray(features) || !features.length) return features;
  const point = (p) => ({ ...p, x: round2(p.x * factor), y: round2(p.y * factor) });
  return features.map((feature) => {
    const next = { ...feature };
    if (Array.isArray(feature.footprintFt)) next.footprintFt = feature.footprintFt.map(point);
    if (Array.isArray(feature.pathFt)) next.pathFt = feature.pathFt.map(point);
    if (Number.isFinite(feature.heightFt)) next.heightFt = round2(feature.heightFt * factor);
    if (Number.isFinite(feature.baseFt)) next.baseFt = round2(feature.baseFt * factor);
    if (Number.isFinite(feature.style?.strokeWidthFt)) {
      next.style = { ...feature.style, strokeWidthFt: round2(feature.style.strokeWidthFt * factor) };
    }
    return next;
  });
}

/** Replace one view in a list with a shallow-merged copy. */
function patchView(views, viewId, patch) {
  return views.map((view) => (view.id === viewId ? { ...view, ...patch } : view));
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

function resolveInches(item) {
  const inchesAttr = item.dataset.inches;
  if (inchesAttr) {
    const val = Number(inchesAttr);
    return Number.isFinite(val) ? val : null;
  }
  const feetAttr = item.dataset.feet;
  if (feetAttr) {
    const val = Number(feetAttr);
    return Number.isFinite(val) ? val * 12 : null;
  }
  return null;
}

function triggerDownload(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'download';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function snapshotViewState({ monthSlider, monthReadout, state }) {
  return {
    month: state.month,
    hiddenLayerCount: state.hiddenLayerCount,
    highlightedSpeciesKey: state.highlightedSpeciesKey,
    targetedPlantId: state.targetedPlantId,
    hoveredPlantId: state.hoveredPlantId,
    monthSliderValue: monthSlider ? monthSlider.value : null,
    monthReadoutText: monthReadout ? monthReadout.textContent : null,
  };
}

function restoreViewState(snapshot, { monthSlider, monthReadout, state, onRestore }) {
  if (!snapshot) return;
  state.month = snapshot.month;
  state.hiddenLayerCount = snapshot.hiddenLayerCount;
  state.highlightedSpeciesKey = snapshot.highlightedSpeciesKey;
  state.targetedPlantId = snapshot.targetedPlantId;
  state.hoveredPlantId = snapshot.hoveredPlantId;
  if (monthSlider && snapshot.monthSliderValue !== null) {
    monthSlider.value = snapshot.monthSliderValue;
  }
  if (monthReadout && snapshot.monthReadoutText !== null) {
    monthReadout.textContent = snapshot.monthReadoutText;
  }
  onRestore?.();
}

function toggleButtonBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent || '';
    }
    button.disabled = true;
    if (busyText) {
      button.textContent = busyText;
    }
    return;
  }
  button.disabled = false;
  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function createPlantMenu({ onClone, onRemove, onClose }) {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  const list = document.createElement('ul');
  list.className = 'context-menu__list';
  const addItem = (label, handler, modifier) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = modifier ? `context-menu__item ${modifier}` : 'context-menu__item';
    button.textContent = label;
    button.addEventListener('click', () => {
      const plantId = menu.dataset.plantId;
      if (plantId) {
        handler?.(plantId);
      }
    });
    item.appendChild(button);
    list.appendChild(item);
  };
  addItem('Clone plant', onClone);
  addItem('Remove plant', onRemove, 'context-menu__item--danger');
  menu.appendChild(list);
  document.body.appendChild(menu);

  const api = {
    show: ({ x, y, plantId }) => {
      if (!plantId) return;
      const offsetX = window.scrollX || 0;
      const offsetY = window.scrollY || 0;
      const menuWidth = 180;
      const menuHeight = 88; // two items
      const maxLeft = offsetX + window.innerWidth - menuWidth - 8;
      const maxTop = offsetY + window.innerHeight - menuHeight - 8;
      menu.style.left = `${Math.min(x + offsetX, maxLeft)}px`;
      menu.style.top = `${Math.min(y + offsetY, maxTop)}px`;
      menu.dataset.plantId = plantId;
      menu.classList.add('is-open');
    },
    hide: () => {
      menu.classList.remove('is-open');
      delete menu.dataset.plantId;
      onClose?.();
    },
    contains: (node) => node instanceof Node && menu.contains(node),
    isOpen: () => menu.classList.contains('is-open'),
  };

  return api;
}

function clonePlantById(state, plantId) {
  if (!plantId) return null;
  const source = state.plants.find((p) => String(p.id) === String(plantId));
  if (!source) return null;
  const planView = state.project.views.find((view) => view.type === 'plan');
  const { originFt, extentFt } = createViewTransform(planView);
  const offset = 1.1;
  const clone = {
    ...source,
    id: buildCloneId(state.plants, source.id),
    x: clampFeet(source.x + offset, originFt.x, originFt.x + extentFt.width),
    y: clampFeet(source.y + offset * 0.6, originFt.y, originFt.y + extentFt.height),
  };
  clone.layer = classifyPlantLayer(clone);
  state.plants = [...state.plants, clone];
  return clone;
}

/**
 * Place one plant of the chosen species at the middle of the plan view — the
 * one spot guaranteed to be on the drawing, from which it can be dragged.
 * @param {typeof appState} state
 * @param {string} botanicalKey the select's value: a normalized botanical name
 * @returns {Object|null} the new plant, or null if the species or plan view is gone
 */
function addPlantFromCatalog(state, botanicalKey) {
  const key = String(botanicalKey || '');
  if (!key) return null;
  const speciesEntry = state.species.find(
    (entry) => (entry.botanicalKey || entry.botanicalName) === key
  );
  // buildLayoutCsv writes botanicalName and buildPlantsFromCsv matches on it, so
  // a species without one would write a row that cannot be read back.
  if (!speciesEntry || !speciesEntry.botanicalName) return null;
  const planView = state.project?.views?.find((view) => view.type === 'plan');
  if (!planView) return null;
  const { originFt, extentFt } = createViewTransform(planView);
  const plant = createPlantFromSpecies(speciesEntry, {
    id: buildNewPlantId(state.plants, speciesEntry.botanicalName),
    x: originFt.x + extentFt.width / 2,
    y: originFt.y + extentFt.height / 2,
  });
  state.plants = [...state.plants, plant];
  return plant;
}

/**
 * Drop a plant from the layout.
 * @returns {boolean} whether a plant was actually removed
 */
function removePlantById(state, plantId) {
  if (!plantId) return false;
  const id = String(plantId);
  const remaining = state.plants.filter((plant) => String(plant.id) !== id);
  if (remaining.length === state.plants.length) return false;
  state.plants = remaining;
  return true;
}

function clampFeet(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
