import { DEFAULT_PIXELS_PER_INCH, MONTH_NAMES, SCALE_LIMITS } from './constants.js';
import { fetchCsv } from './data/csvLoader.js';
import { buildPlantsFromCsv } from './data/plantParser.js';
import { computePlantState } from './state/seasonalState.js';
import { renderViews } from './render/renderViews.js';
import { configureViews } from './render/viewConfig.js';

const appState = {
  plants: [],
  month: new Date().getMonth() + 1,
  pixelsPerInch: DEFAULT_PIXELS_PER_INCH,
};

async function init() {
  const monthSelect = document.getElementById('monthSelect');
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

  configureViews({ svgRefs, containerRefs });

  initMonthSelector(monthSelect, appState.month);

  let render = () => {};
  const applyScale = (value) => {
    appState.pixelsPerInch = value;
    updateScaleIndicator(scaleIndicator, value);
    render();
  };
  initScaleControls(scaleInput, scaleSlider, applyScale);

  try {
    const [speciesCsv, layoutCsv] = await Promise.all([
      fetchCsv(new URL('plants.csv', document.baseURI)),
      fetchCsv(new URL('planting_layout.csv', document.baseURI)),
    ]);
    appState.plants = buildPlantsFromCsv(speciesCsv, layoutCsv);
  } catch (err) {
    showLoadError('Unable to load plants and layout data.');
    console.error(err);
    return;
  }

  render = () => {
    const month = parseInt(monthSelect.value, 10);
    appState.month = month;
    const plantStates = appState.plants.map((plant) => ({
      plant,
      state: computePlantState(plant, month),
    }));
    renderViews(svgRefs, plantStates, appState.pixelsPerInch);
  };

  monthSelect.addEventListener('change', render);
  window.addEventListener('resize', render);
  updateScaleIndicator(scaleIndicator, appState.pixelsPerInch);
  render();
}

function initMonthSelector(selectEl, initialMonth) {
  MONTH_NAMES.forEach((name, idx) => {
    const option = document.createElement('option');
    option.value = String(idx + 1);
    option.textContent = name;
    selectEl.appendChild(option);
  });
  selectEl.value = String(initialMonth);
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

function formatScaleValue(value) {
  return value.toFixed(3);
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
