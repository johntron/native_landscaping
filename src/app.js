import { DEFAULT_PIXELS_PER_INCH, MONTH_NAMES, SCALE_LIMITS } from './constants.js';
import { fetchCsv } from './data/csvLoader.js';
import { buildPlantsFromCsv } from './data/plantParser.js';
import { buildLayoutCsv } from './data/layoutExporter.js';
import { computePlantState } from './state/seasonalState.js';
import { renderViews } from './render/renderViews.js';
import { configureViews } from './render/viewConfig.js';
import { createPlantDragController } from './interaction/dragController.js';
import { buildPlantLabel } from './render/labels.js';
import { formatMonthRange } from './state/seasonalState.js';
import { clampHiddenLayerCount } from './state/layers.js';

const appState = {
  plants: [],
  month: new Date().getMonth() + 1,
  pixelsPerInch: DEFAULT_PIXELS_PER_INCH,
  positionsLocked: true,
  showLabels: false,
  hiddenLayerCount: 0,
};

async function init() {
  const monthSlider = document.getElementById('monthSlider');
  const monthReadout = document.getElementById('monthReadout');
  const scaleInput = document.getElementById('scaleInput');
  const scaleSlider = document.getElementById('scaleSlider');
  const scaleIndicator = document.getElementById('scaleIndicator');
  const svgRefs = {
    topSvg: document.getElementById('topSvg'),
    southSvg: document.getElementById('frontSvg'),
    westSvg: document.getElementById('sideSvg'),
  };
  const containerRefs = {
    topView: document.getElementById('topView'),
    southView: document.getElementById('frontView'),
    westView: document.getElementById('sideView'),
  };
  const lockToggle = document.getElementById('lockToggle');
  const lockStatusText = document.getElementById('lockStatusText');
  const exportButton = document.getElementById('exportLayoutBtn');
  const labelToggle = document.getElementById('labelToggle');
  const layerVisibilitySelect = document.getElementById('layerVisibility');

  configureViews({ svgRefs, containerRefs });

  initMonthSlider(monthSlider, monthReadout, appState.month);

  let render = () => {};
  const applyScale = (value) => {
    appState.pixelsPerInch = value;
    updateScaleIndicator(scaleIndicator, value);
    render();
  };
  initScaleControls(scaleInput, scaleSlider, applyScale);

  const dragController = createPlantDragController({
    svg: svgRefs.topSvg,
    getPlants: () => appState.plants,
    getPixelsPerInch: () => appState.pixelsPerInch,
    onPositionsChange: () => render(),
  });

  const applyLockState = (locked) => {
    appState.positionsLocked = locked;
    dragController.setLocked(locked);
    updateLockStatus(lockStatusText, locked);
  };

  if (lockToggle) {
    lockToggle.checked = true;
    lockToggle.addEventListener('change', (e) => applyLockState(e.target.checked));
  }
  applyLockState(true);
  if (exportButton) {
    exportButton.disabled = true;
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
    layerVisibilitySelect.value = String(appState.hiddenLayerCount);
    layerVisibilitySelect.addEventListener('change', (e) => {
      appState.hiddenLayerCount = clampHiddenLayerCount(Number(e.target.value));
      render();
    });
  }

  try {
    const [speciesCsv, layoutCsv] = await Promise.all([
      fetchCsv(new URL('plants.csv', document.baseURI)),
      fetchCsv(new URL('planting_layout.csv', document.baseURI)),
    ]);
    appState.plants = buildPlantsFromCsv(speciesCsv, layoutCsv);
    renderSpeciesTable(appState.plants);
    if (exportButton) {
      exportButton.disabled = false;
      exportButton.addEventListener('click', () => downloadLayoutCsv(appState.plants));
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
    renderViews(svgRefs, plantStates, appState.pixelsPerInch, {
      showLabels: appState.showLabels,
      hiddenLayerCount: appState.hiddenLayerCount,
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
  updateScaleIndicator(scaleIndicator, appState.pixelsPerInch);
  render();
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

function initScaleControls(inputEl, sliderEl, onChange) {
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

  apply(DEFAULT_PIXELS_PER_INCH);
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

function showLoadError(message) {
  const existing = document.querySelector('.error-banner');
  if (existing) {
    existing.textContent = message;
    return;
  }
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = `${message} Please serve plants.csv and planting_layout.csv over HTTP (for example, via \`npx serve\`).`;
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

function renderSpeciesTable(plants) {
  const container = document.getElementById('speciesTable');
  if (!container) return;
  container.innerHTML = '';
  if (!plants?.length) return;

  const speciesMap = new Map();
  plants.forEach((plant) => {
    const key = plant.botanicalName || plant.botanical_name || plant.commonName || plant.common_name;
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

function downloadLayoutCsv(plants) {
  if (!plants?.length) return;
  const csv = buildLayoutCsv(plants);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'planting_layout.csv';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
