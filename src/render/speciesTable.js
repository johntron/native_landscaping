/**
 * The species table under the design tool: one row per species placed in the
 * yard, with a Details toggle for the columns hidden on a phone. The caller
 * passes the container, keeping DOM lookups in src/app.js.
 */
import { buildPlantLabel } from './labels.js';
import { formatMonthRange } from '../state/seasonalState.js';
import { ecologicalFitNotes } from '../analysis/hostGenera.js';
import { getGenus, getSpeciesKey } from '../utils/speciesKey.js';

export function renderSpeciesTable(container, plants, hostGenera, handlers = {}) {
  const { onHoverStart, onHoverEnd } = handlers;
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
  const headers = [
    'Label',
    'Botanical name',
    'Common name',
    'Height (ft)',
    'Width (ft)',
    'Growth form',
    'Sun',
    'Water',
    'Soil',
    'Bloom months',
    'Inflorescence',
    'Fruit',
    'Ecological fit',
  ];
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
      { value: formatInflorescenceCell(plant) },
      { value: formatFruitCell(plant) },
      buildEcologicalFitCell(plant, hostGenera),
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
      if (cell.title) td.title = cell.title;
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

/** Species-table counterpart of tooltip.js's formatInflorescenceLine, without the current-month state. */
function formatInflorescenceCell(plant) {
  const type = plant.inflorescence || plant.inflorescenceType || plant.inflorescence_type;
  const count = plant.flowerCountHint ?? plant.flower_count_hint;
  const zone = plant.flowerZone || plant.flower_zone;
  const pieces = [];
  if (type) pieces.push(type);
  if (count) pieces.push(`≈${count}`);
  if (zone) pieces.push(`${zone} canopy`);
  return pieces.join(', ');
}

/** Species-table counterpart of tooltip.js's formatFruitLine, without the current-month state. */
function formatFruitCell(plant) {
  const pieces = [];
  if (plant.fruitColor) pieces.push(plant.fruitColor);
  if (plant.fruitLoad) pieces.push(`${plant.fruitLoad} load`);
  return pieces.join(', ');
}

/**
 * Same source data the keystone-genera and larval-hosts rules grade against
 * (see ecologicalFitNotes), shown as a short badge with the full sentence in
 * the cell's title so a reader can hover for the number without every row
 * growing to fit "253 caterpillar species — listed as Quercus."
 */
function buildEcologicalFitCell(plant, hostGenera) {
  const notes = ecologicalFitNotes(getGenus(plant), hostGenera);
  if (!notes.length) return { value: '' };
  const badges = [];
  if (notes.some((note) => note.startsWith('Keystone genus'))) badges.push('Keystone');
  if (notes.some((note) => note.startsWith('Documented larval host'))) badges.push('Larval host');
  return { value: badges.join(', '), title: notes.join(' ') };
}
