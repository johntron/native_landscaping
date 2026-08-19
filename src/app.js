import {
  DEFAULT_PIXELS_PER_INCH,
  INCHES_PER_FOOT,
  MONTH_NAMES,
  SCALE_LIMITS,
} from './constants.js';
import { fetchCsv } from './data/csvLoader.js';
import {
  loadProjectConfig,
  loadProjectIndex,
  projectAssetPath,
  projectLayoutPath,
  resolveActiveProjectId,
} from './data/projectConfig.js';
import { resolveElevationOrientation } from './render/elevationOrientation.js';
import { buildPlantsFromCsv, LayoutDataError } from './data/plantParser.js';
import { buildLayoutCsv } from './data/layoutExporter.js';
import { loadLayoutHistory, persistLayout, updateHistoryCursor } from './data/persistence.js';
import { computePlantState } from './state/seasonalState.js';
import { renderViews } from './render/renderViews.js';
import { configureViews } from './render/viewConfig.js';
import { createPlantDragController, createElevationDragController } from './interaction/dragController.js';
import { buildPlantLabel } from './render/labels.js';
import { formatMonthRange } from './state/seasonalState.js';
import { clampHiddenLayerCount, classifyPlantLayer } from './state/layers.js';
import { buildCloneId } from './state/plantIds.js';
import { getSpeciesKey } from './utils/speciesKey.js';
import { createLayoutHistory } from './history/layoutHistory.js';
import { captureViewToPng } from './export/viewCapture.js';

const LOCK_STATE_KEY = 'native-landscaping-positions-locked';
const EXPORT_MONTH = 6; // June
const PROJECT_QUERY_PARAM = 'project';

const appState = {
  project: null,
  plants: [],
  month: new Date().getMonth() + 1,
  pixelsPerInch: DEFAULT_PIXELS_PER_INCH,
  positionsLocked: true,
  showLabels: false,
  hiddenLayerCount: 0,
  highlightedSpeciesKey: '',
  targetedPlantId: '',
  hoveredPlantId: '',
  maximizedViewId: '',
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
  const scaleSummaryEls = Array.from(document.querySelectorAll('[data-scale-summary]'));
  // Elevation panels are positional slots: slot 0 and 1 take whichever compass
  // directions the active project's config assigns to them.
  const svgRefs = {
    topSvg: document.getElementById('topSvg'),
    elevationSvgs: [document.getElementById('frontSvg'), document.getElementById('sideSvg')],
  };
  const containerRefs = {
    topView: document.getElementById('topView'),
    elevationViews: [document.getElementById('frontView'), document.getElementById('sideView')],
  };
  const labelRefs = ['topView', 'frontView', 'sideView'].map((panelId) => {
    const panel = document.querySelector(`[data-view-panel="${panelId}"]`);
    return {
      label: panel?.querySelector('[data-view-label]'),
      sublabel: panel?.querySelector('[data-view-sublabel]'),
    };
  });
  const projectSelect = document.getElementById('projectSelect');
  const projectNotice = document.getElementById('projectNotice');
  const lockToggle = document.getElementById('lockToggle');
  const lockStatusText = document.getElementById('lockStatusText');
  const exportBundleButton = document.getElementById('exportBundleBtn');
  const managePlantsButton = document.getElementById('managePlantsBtn');
  const labelToggle = document.getElementById('labelToggle');
  const layerVisibilityButtons = Array.from(document.querySelectorAll('[data-layer-visibility]'));
  const undoButton = document.getElementById('undoLayoutBtn');
  const redoButton = document.getElementById('redoLayoutBtn');
  const historyStatus = document.getElementById('layoutHistoryStatus');

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
  } catch (err) {
    showLoadError('Unable to load project configuration.');
    console.error(err);
    return;
  }
  appState.project = project;
  appState.pixelsPerInch = project.pixelsPerInch;
  document.title = `${project.name} Visualization`;
  const projectTitle = document.getElementById('projectTitle');
  if (projectTitle) {
    projectTitle.textContent = `${project.name} Visualization`;
  }

  initProjectPicker(projectSelect, projectIndex, project.id);
  configureViews({ svgRefs, containerRefs, labelRefs, project });

  const viewsContainer = document.querySelector('.views');
  const maximizeButtons = Array.from(document.querySelectorAll('[data-maximize-target]'));

  const refreshMaximizedView = () => {
    if (viewsContainer) {
      if (appState.maximizedViewId) {
        viewsContainer.dataset.maximized = appState.maximizedViewId;
      } else {
        viewsContainer.removeAttribute('data-maximized');
      }
    }
    maximizeButtons.forEach((button) => {
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

  maximizeButtons.forEach((button) => {
    button.addEventListener('click', () => toggleViewMaximization(button.dataset.maximizeTarget));
  });

  refreshMaximizedView();

  initMonthSlider(monthSlider, monthReadout, appState.month);

  let render = () => {};
  let highlightedRowEl = null;
  let layoutHistoryInstance = null;
  let commitLayoutChange = () => {};
  const syncLayerButtons = (hiddenCount) => {
    layerVisibilityButtons.forEach((button) => {
      const value = Number(button.dataset.layerVisibility || button.value || 0);
      const isActive = value === hiddenCount;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
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
    appState.plants = plants;
    render();
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

  const setTargetedPlant = (plantId) => {
    const normalized = plantId ? String(plantId) : '';
    if (normalized === appState.targetedPlantId) return;
    appState.targetedPlantId = normalized;
    render();
  };
  const setHoveredPlant = (plantId) => {
    const normalized = plantId ? String(plantId) : '';
    if (normalized === appState.hoveredPlantId) return;
    appState.hoveredPlantId = normalized;
    render();
  };
  const handleBundleExport = async () => {
    if (isBundleExporting) return;
    if (!svgRefs.topSvg || svgRefs.elevationSvgs.some((svg) => !svg)) return;
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
      const panels = [
        { view: project.plan, svg: svgRefs.topSvg, fileName: 'plan-view.png' },
        ...project.elevations.map((elevation, index) => ({
          view: elevation,
          svg: svgRefs.elevationSvgs[index],
          fileName: `${elevation.id}-elevation.png`,
        })),
      ];
      const pngs = await Promise.all(
        panels.map(({ view, svg }) =>
          captureViewToPng({
            svg,
            viewBox: view.viewBox,
            backgroundUrl: backgroundUrlFor(project, view),
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
  const applyScale = (value) => {
    appState.pixelsPerInch = value;
    updateScaleIndicator(scaleIndicator, value);
    updateScaleSummaries(scaleSummaryEls, value);
    render();
  };
  initScaleControls(scaleInput, scaleSlider, applyScale, project.pixelsPerInch);

  const dragController = createPlantDragController({
    svg: svgRefs.topSvg,
    getPlants: () => appState.plants,
    getPixelsPerInch: () => appState.pixelsPerInch,
    onPositionsChange: () => render(),
    onHoverPlant: setHoveredPlant,
    onChangeCommit: () => commitLayoutChange('Moved plant'),
  });
  const elevationDragControllers = project.elevations.map((elevation, index) =>
    createElevationDragController({
      svg: svgRefs.elevationSvgs[index],
      // Dragging in an elevation edits the yard axis that runs horizontally in it.
      axis: resolveElevationOrientation(elevation.viewFrom).axisKey,
      mirrored: resolveElevationOrientation(elevation.viewFrom).mirrored,
      leftOffsetPx: elevation.leftOffsetPx,
      getPlants: () => appState.plants,
      getPixelsPerInch: () => appState.pixelsPerInch,
      onPositionsChange: () => render(),
      onHoverPlant: setHoveredPlant,
      onChangeCommit: () => commitLayoutChange('Moved plant'),
    })
  );
  const dragControllers = [dragController, ...elevationDragControllers];

  const cloneMenu = createCloneMenu({
    onClone: (plantId) => {
      const clone = clonePlantById(appState, plantId);
      if (clone) {
        cloneMenu.hide();
        setTargetedPlant('');
        render();
        commitLayoutChange('Cloned plant');
      }
    },
    onClose: () => setTargetedPlant(''),
  });

  const applyLockState = (locked) => {
    appState.positionsLocked = locked;
    dragControllers.forEach((controller) => controller?.setLocked?.(locked));
    updateLockStatus(lockStatusText, locked);
    persistLockState(locked);
  };

  const persistedLockState = readPersistedLockState();
  const initialLockState = persistedLockState !== null ? persistedLockState : true;
  if (lockToggle) {
    lockToggle.checked = initialLockState;
    lockToggle.addEventListener('change', (e) => applyLockState(e.target.checked));
  }
  applyLockState(initialLockState);
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

  if (layerVisibilityButtons.length) {
    syncLayerButtons(appState.hiddenLayerCount);
    layerVisibilityButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const next = Number(button.dataset.layerVisibility || button.value || 0);
        applyHiddenLayers(next);
      });
    });
  }

  try {
    const [speciesCsv, layoutCsv] = await Promise.all([
      fetchCsv(new URL('plants.csv', document.baseURI)),
      fetchCsv(new URL(projectLayoutPath(project.id), document.baseURI)),
    ]);
    loadedSpeciesCsv = speciesCsv;
    const initialPlants = buildPlantsFromCsv(speciesCsv, layoutCsv);
    const layoutCsvSnapshot = buildLayoutCsv(initialPlants);
    const historyData = await loadLayoutHistory(updateHistoryStatus, {
      layoutCsv: layoutCsvSnapshot,
      projectId: project.id,
    });
    const historyEntries = historyData.entries || [];
    const historyCursor = typeof historyData.cursor === 'number' ? historyData.cursor : -1;
    layoutHistoryInstance = createLayoutHistory(initialPlants, {
      seedEntries: historyEntries,
      initialCursor: historyCursor,
    });
    const currentPlants = layoutHistoryInstance.getCurrentPlants();
    appState.plants = currentPlants.length ? currentPlants : initialPlants;
    updateHistoryControls();

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

    renderSpeciesTable(appState.plants, {
      onHoverStart: (speciesKey, rowEl) => setHighlightedSpecies(speciesKey, rowEl),
      onHoverEnd: (_speciesKey, rowEl) => clearHighlightedSpecies(rowEl),
    });
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
    renderViews(svgRefs, plantStates, appState.pixelsPerInch, {
      showLabels: appState.showLabels,
      hiddenLayerCount: appState.hiddenLayerCount,
      highlightedSpeciesKey: appState.highlightedSpeciesKey,
      targetedPlantId: appState.targetedPlantId,
      hoveredPlantId: appState.hoveredPlantId,
      project,
    });
  };

  monthSlider.addEventListener('input', (e) => {
    const month = clampMonthValue(e.target.value);
    if (month === null) return;
    monthSlider.value = String(month);
    monthReadout.textContent = MONTH_NAMES[month - 1] || '';
    render();
  });
  window.addEventListener('resize', render);

  document.addEventListener('contextmenu', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const group = target.closest('[data-plant-id]');
    if (!group) {
      cloneMenu.hide();
      setTargetedPlant('');
      return;
    }
    event.preventDefault();
    const plantId = group.getAttribute('data-plant-id');
    setTargetedPlant(plantId);
    cloneMenu.show({
      x: event.clientX,
      y: event.clientY,
      plantId,
    });
  });

  document.addEventListener('click', (event) => {
    if (cloneMenu.contains(event.target)) return;
    cloneMenu.hide();
    setTargetedPlant('');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      cloneMenu.hide();
      setTargetedPlant('');
    }
  });

  updateScaleIndicator(scaleIndicator, appState.pixelsPerInch);
  updateScaleSummaries(scaleSummaryEls, appState.pixelsPerInch);
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

/** Absolute URL for a background declared relative to the project directory. */
function backgroundUrlFor(project, view) {
  return new URL(projectAssetPath(project.id, view.background), document.baseURI).toString();
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

function initScaleControls(inputEl, sliderEl, onChange, initialValue = DEFAULT_PIXELS_PER_INCH) {
  if (!inputEl || !sliderEl) return;

  const { min, max, step } = SCALE_LIMITS;
  [inputEl, sliderEl].forEach((el) => {
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
  });

  const apply = (rawValue) => {
    const parsed = clampScaleValue(Number(rawValue));
    if (parsed === null) return;
    inputEl.value = formatScaleValue(parsed);
    sliderEl.value = String(parsed);
    onChange?.(parsed);
  };

  inputEl.addEventListener('change', (e) => apply(e.target.value));
  sliderEl.addEventListener('input', (e) => apply(e.target.value));

  apply(initialValue);
}

function updateScaleIndicator(container, pixelsPerInch) {
  if (!container) return;
  const items = container.querySelectorAll('.scale-indicator__item');
  items.forEach((item) => {
    const inches = resolveInches(item);
    if (!inches) return;
    const width = Math.max(inches * pixelsPerInch, 4);
    const line = item.querySelector('.scale-indicator__line');
    if (line) {
      line.style.width = `${width}px`;
    }
  });
}

function updateScaleSummaries(summaryEls, pixelsPerInch) {
  if (!summaryEls?.length) return;
  const perFoot = Math.round((pixelsPerInch || 0) * INCHES_PER_FOOT);
  summaryEls.forEach((el) => {
    if (!el) return;
    const formatted = Number.isFinite(perFoot) && perFoot > 0 ? perFoot.toLocaleString() : '0';
    el.textContent = `1 ft ≈ ${formatted} px`;
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

function clampScaleValue(value) {
  if (!Number.isFinite(value)) return null;
  const { min, max } = SCALE_LIMITS;
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

function formatScaleValue(value) {
  return value.toFixed(3);
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
  const headers = ['Label', 'Common name', 'Botanical name', 'Height (ft)', 'Width (ft)', 'Growth form', 'Sun', 'Water', 'Soil', 'Bloom months'];
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
      { value: plant.commonName || plant.common_name || '' },
      { value: plant.botanicalName || plant.botanical_name || '' },
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
      td.textContent = cell.value ?? '';
      td.dataset.label = headers[idx];
      if (cell.className) td.className = cell.className;
      tr.appendChild(td);
    });

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

function updateLockStatus(labelEl, locked) {
  if (!labelEl) return;
  labelEl.textContent = locked ? 'Positions locked' : 'Drag to move plants';
}

function readPersistedLockState() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LOCK_STATE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch (err) {
    console.warn('Unable to read persisted lock state', err);
  }
  return null;
}

function persistLockState(locked) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCK_STATE_KEY, locked ? 'true' : 'false');
  } catch (err) {
    console.warn('Unable to persist lock state', err);
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

function createCloneMenu({ onClone, onClose }) {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  const list = document.createElement('ul');
  list.className = 'context-menu__list';
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'context-menu__item';
  button.textContent = 'Clone plant';
  button.addEventListener('click', () => {
    const plantId = menu.dataset.plantId;
    if (plantId) {
      onClone?.(plantId);
    }
  });
  item.appendChild(button);
  list.appendChild(item);
  menu.appendChild(list);
  document.body.appendChild(menu);

  const api = {
    show: ({ x, y, plantId }) => {
      if (!plantId) return;
      const offsetX = window.scrollX || 0;
      const offsetY = window.scrollY || 0;
      const menuWidth = 180;
      const menuHeight = 48;
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
  const planViewBox = state.project.plan.viewBox;
  const maxXFeet = planViewBox.width / (INCHES_PER_FOOT * state.pixelsPerInch);
  const maxYFeet = planViewBox.height / (INCHES_PER_FOOT * state.pixelsPerInch);
  const offset = 1.1;
  const clone = {
    ...source,
    id: buildCloneId(state.plants, source.id),
    x: clampFeet(source.x + offset, 0, maxXFeet),
    y: clampFeet(source.y + offset * 0.6, 0, maxYFeet),
  };
  clone.layer = classifyPlantLayer(clone);
  state.plants = [...state.plants, clone];
  return clone;
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
