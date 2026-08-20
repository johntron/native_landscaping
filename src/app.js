import { DEFAULT_ZOOM, INCHES_PER_FOOT, MONTH_NAMES, ZOOM_LIMITS } from './constants.js';
import { fetchCsv } from './data/csvLoader.js';
import {
  loadProjectConfig,
  loadProjectIndex,
  projectAssetPath,
  projectLayoutPath,
  resolveActiveProjectId,
} from './data/projectConfig.js';
import { buildPlantsFromCsv, LayoutDataError } from './data/plantParser.js';
import { buildLayoutCsv } from './data/layoutExporter.js';
import { loadLayoutHistory, persistLayout, updateHistoryCursor } from './data/persistence.js';
import { computePlantState } from './state/seasonalState.js';
import { renderViews } from './render/renderViews.js';
import { createViewTransform } from './render/viewTransform.js';
import { configureViews } from './render/viewConfig.js';
import { createPlantDragController, createElevationDragController } from './interaction/dragController.js';
import { buildPlantLabel } from './render/labels.js';
import { formatMonthRange } from './state/seasonalState.js';
import { clampHiddenLayerCount, classifyPlantLayer } from './state/layers.js';
import { buildCloneId } from './state/plantIds.js';
import { getSpeciesKey } from './utils/speciesKey.js';
import { buildTooltipLines } from './render/tooltip.js';
import { createLayoutHistory } from './history/layoutHistory.js';
import { captureViewToPng } from './export/viewCapture.js';

const LOCK_STATE_KEY = 'native-landscaping-positions-locked';
const EXPORT_MONTH = 6; // June
const PROJECT_QUERY_PARAM = 'project';

const appState = {
  project: null,
  plants: [],
  month: new Date().getMonth() + 1,
  zoom: DEFAULT_ZOOM,
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
  const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
  const editRow = document.getElementById('editRow');
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const settingsDrawer = document.getElementById('settingsDrawer');
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
        { view: planView, svg: svgRefs.topSvg, fileName: 'plan-view.png' },
        ...elevationViews.map((elevation, index) => ({
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
  // Zoom only resizes the panels; plant coordinates and the background photo
  // are fixed by each view's own feet-to-pixels transform.
  const applyZoom = (value) => {
    appState.zoom = value;
    viewsContainer?.style.setProperty('--view-zoom', String(value));
  };
  initZoomControls(scaleInput, scaleSlider, applyZoom, appState.zoom);

  const planView = project.views.find((view) => view.type === 'plan');
  const elevationViews = project.views.filter((view) => view.type === 'elevation');
  const dragController = createPlantDragController({
    svg: svgRefs.topSvg,
    getPlants: () => appState.plants,
    getTransform: () => createViewTransform(planView),
    onPositionsChange: () => render(),
    onHoverPlant: setHoveredPlant,
    onChangeCommit: () => commitLayoutChange('Moved plant'),
  });
  const elevationDragControllers = elevationViews.map((elevation, index) =>
    createElevationDragController({
      svg: svgRefs.elevationSvgs[index],
      // Which yard axis a drag edits, and how a mirrored view flips it, both
      // come from the view's transform.
      getPlants: () => appState.plants,
      getTransform: () => createViewTransform(elevation),
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
        commitLayoutChange('Cloned plant');
      }
    });
  }
  if (detailSheet) {
    detailSheet.querySelectorAll('[data-detail-close]').forEach((el) => {
      el.addEventListener('click', closeDetailSheet);
    });
  }

  const applyLockState = (locked) => {
    appState.positionsLocked = locked;
    dragControllers.forEach((controller) => controller?.setLocked?.(locked));
    persistLockState(locked);
  };

  const applyMode = (mode) => {
    const locked = mode !== 'edit';
    modeButtons.forEach((button) => {
      const isActive = button.dataset.mode === mode;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    if (editRow) editRow.hidden = mode !== 'edit';
    applyLockState(locked);
  };

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

  const persistedLockState = readPersistedLockState();
  const initialLockState = persistedLockState !== null ? persistedLockState : true;
  applyMode(initialLockState ? 'view' : 'edit');
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
    renderViews(svgRefs, plantStates, {
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
    if (detailSheet && !detailSheet.hidden && detailSheet.contains(event.target)) return;
    const target = event.target;
    const group = target instanceof Element ? target.closest('[data-plant-id]') : null;
    if (group) {
      openDetailSheet(group.getAttribute('data-plant-id'));
      return;
    }
    cloneMenu.hide();
    closeDetailSheet();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      cloneMenu.hide();
      closeDetailSheet();
    }
  });

  updateScaleIndicator(scaleIndicator, createViewTransform(planView).pxPerFt);
  updateScaleSummaries(scaleSummaryEls, project.views);
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
 * Absolute URL for a background declared relative to the project directory, or
 * null when the view has no image yet — captureViewToPng skips the background
 * rather than fetching projects/<slug>/null.
 */
function backgroundUrlFor(project, view) {
  if (!view?.background) return null;
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

/** Each panel reports its own scale; views no longer have to share one. */
function updateScaleSummaries(summaryEls, views) {
  if (!summaryEls?.length) return;
  const ordered = [
    ...views.filter((view) => view.type === 'plan'),
    ...views.filter((view) => view.type !== 'plan'),
  ];
  summaryEls.forEach((el, index) => {
    if (!el) return;
    const view = ordered[index];
    const perFoot = view ? Math.round(createViewTransform(view).pxPerFt) : 0;
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
