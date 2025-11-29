import { ELEVATION_VIEWBOX, MONTH_NAMES, PLAN_VIEWBOX } from './constants.js';
import { fetchCsv } from './data/csvLoader.js';
import { parsePlantsFromCsv } from './data/plantParser.js';
import { computePlantState } from './state/seasonalState.js';
import { renderViews } from './render/renderViews.js';

const appState = {
  plants: [],
  month: new Date().getMonth() + 1,
};

async function init() {
  const monthSelect = document.getElementById('monthSelect');
  const svgRefs = {
    topSvg: document.getElementById('topSvg'),
    southSvg: document.getElementById('frontSvg'),
    westSvg: document.getElementById('sideSvg'),
  };

  configureViewBoxes(svgRefs);

  initMonthSelector(monthSelect, appState.month);

  try {
    const csvText = await fetchCsv(new URL('plants.csv', document.baseURI));
    appState.plants = parsePlantsFromCsv(csvText);
  } catch (err) {
    showLoadError('Unable to load plants data.');
    console.error(err);
    return;
  }

  const update = () => {
    const month = parseInt(monthSelect.value, 10);
    appState.month = month;
    const plantStates = appState.plants.map((plant) => ({
      plant,
      state: computePlantState(plant, month),
    }));
    renderViews(svgRefs, plantStates);
  };

  monthSelect.addEventListener('change', update);
  window.addEventListener('resize', update);
  update();
}

function configureViewBoxes(svgRefs) {
  const { topSvg, southSvg, westSvg } = svgRefs;
  topSvg.setAttribute('viewBox', `0 0 ${PLAN_VIEWBOX.width} ${PLAN_VIEWBOX.height}`);
  southSvg.setAttribute('viewBox', `0 0 ${ELEVATION_VIEWBOX.width} ${ELEVATION_VIEWBOX.height}`);
  westSvg.setAttribute('viewBox', `0 0 ${ELEVATION_VIEWBOX.width} ${ELEVATION_VIEWBOX.height}`);

  [topSvg, southSvg, westSvg].forEach((svg) => {
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  });
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

function showLoadError(message) {
  const existing = document.querySelector('.error-banner');
  if (existing) {
    existing.textContent = message;
    return;
  }
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = `${message} Please serve plants.csv over HTTP (for example, via \`npx serve\`).`;
  const main = document.querySelector('main');
  if (main) {
    main.insertAdjacentElement('beforebegin', banner);
  } else {
    document.body.appendChild(banner);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
