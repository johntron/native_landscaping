/**
 * The species table under the design tool: one row per species placed in the
 * yard, with a Details toggle for the columns hidden on a phone. The caller
 * passes the container, keeping DOM lookups in src/app.js.
 */
import { buildPlantLabel, driftLabel } from './labels.js';
import { formatSoil } from './tooltip.js';
import { formatMonthRange } from '../state/seasonalState.js';
import { ecologicalFitNotes } from '../analysis/hostGenera.js';
import { getGenus, getSpeciesKey } from '../utils/speciesKey.js';
import { driftCentroid } from '../state/driftGeometry.js';

// The columns before this one (Label, Botanical name, Common name, Drifts)
// stay visible on a phone; everything from here on hides behind the row's
// own Details toggle (species-table__extra, styles.css). Drifts sits with
// the always-visible three, not the details, because it is the compact
// per-drift ENTRY POINT (nl-o47.6.7) a person taps to select/highlight a
// drift — the same reason it is never a mouseenter/mouseleave affordance
// like a plain species row's hover highlight.
const FIRST_EXTRA_COLUMN_INDEX = 4;

export function renderSpeciesTable(container, plants, hostGenera, handlers = {}) {
  const {
    onHoverStart,
    onHoverEnd,
    onDriftClick,
    highlightedDriftId = '',
    suggestionCount = 0,
    onReviewSuggestions,
  } = handlers;
  if (!container) return;
  container.innerHTML = '';
  // "Suggest drifts" (nl-o47.6.5): at the top of the list, the one place a
  // person already meets their plants — the caller (src/ui/speciesHighlight.js)
  // has already zeroed suggestionCount outside Edit mode, on the read-only
  // example yard, and while a review is already open, so this needs no mode
  // check of its own.
  if (suggestionCount > 0) {
    container.appendChild(buildSuggestDriftsBanner(suggestionCount, onReviewSuggestions));
  }
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
    'Drifts',
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
    const speciesLabel = plant.commonName || plant.common_name || plant.botanicalName || plant.botanical_name || '';
    const cells = [
      { value: buildPlantLabel(plant), className: 'species-table__label' },
      { value: plant.botanicalName || plant.botanical_name || '', italic: true },
      { value: plant.commonName || plant.common_name || '' },
      null, // the Drifts cell is built separately below — it holds buttons, not text
      { value: formatFeet(plant.height) },
      { value: formatFeet(plant.width) },
      { value: plant.growthShape || plant.growth_shape || '' },
      { value: plant.sunPref || plant.sun_pref || '' },
      { value: plant.waterPref || plant.water_pref || '' },
      { value: formatSoil(plant.soilPref ?? plant.soil_pref) },
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
      if (idx === 3) {
        tr.appendChild(
          buildDriftCell({
            label: headers[idx],
            plants,
            speciesKey,
            speciesLabel,
            highlightedDriftId,
            onDriftClick,
          })
        );
        return;
      }
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
      if (idx >= FIRST_EXTRA_COLUMN_INDEX) td.classList.add('species-table__extra');
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

/**
 * A species' plants split into its drifts and its ungrouped ("single")
 * members, for the species table's compact per-species drift summary
 * (nl-o47.6.7): "Winecup — 2 drifts, 17 plants" plus one entry per drift and
 * an "N single" count for whatever is left. Pure (no DOM) so it is unit
 * tested on its own; `renderSpeciesTable` is the only caller.
 *
 * `speciesKey` must be the same lower-cased key src/utils/speciesKey.js's
 * getSpeciesKey groups table ROWS by — never a raw speciesId, which
 * src/state/driftGeometry.js's own driftsOfSpecies compares case-sensitively
 * and this table does not.
 *
 * `drifts` is ordered west to east, then south to north (nl-o47.6.11) by each
 * drift's own centroid — position on the plan, not first appearance in
 * `plants` (a drift's members need not sit together in the array) — since two
 * drifts of one species read identically once their labels are just species
 * initials plus a count (driftLabel), and there is no name left to order them
 * by.
 * @param {Array<object>} plants every plant in the yard (the table's own list)
 * @param {string} speciesKey
 * @returns {{ drifts: Array<{driftId: string, members: object[]}>, singleCount: number, totalCount: number }}
 */
export function groupSpeciesDrifts(plants, speciesKey) {
  const ofSpecies = (plants || []).filter((plant) => getSpeciesKey(plant) === speciesKey);
  const order = [];
  const membersById = new Map();
  let singleCount = 0;
  ofSpecies.forEach((plant) => {
    const driftId = plant?.driftId;
    if (!driftId) {
      singleCount += 1;
      return;
    }
    if (!membersById.has(driftId)) {
      membersById.set(driftId, []);
      order.push(driftId);
    }
    membersById.get(driftId).push(plant);
  });
  const drifts = order
    .map((driftId) => ({ driftId, members: membersById.get(driftId) }))
    .sort((a, b) => {
      const ca = driftCentroid(a.members);
      const cb = driftCentroid(b.members);
      return ca.x - cb.x || ca.y - cb.y;
    });
  return { drifts, singleCount, totalCount: ofSpecies.length };
}

/**
 * The Drifts column's cell (nl-o47.6.7): empty for a species with no drifts
 * ("keep the table's existing behaviour for species rows" — nothing new to
 * show), else a short summary line plus one button per drift (driftLabel's
 * "CV (12x)", nl-o47.6.11) and an "N single" count for whatever is left. A
 * drift's button click routes through `onDriftClick`, which
 * src/ui/speciesHighlight.js resolves against the current mode (Edit selects
 * it, View highlights it) — this module knows nothing about modes or
 * selection, only DOM.
 */
function buildDriftCell({ label, plants, speciesKey, speciesLabel, highlightedDriftId, onDriftClick }) {
  const td = document.createElement('td');
  td.dataset.label = label;
  td.className = 'species-table__drifts';
  const { drifts, singleCount, totalCount } = groupSpeciesDrifts(plants, speciesKey);
  if (!drifts.length) return td;

  const summary = document.createElement('div');
  summary.className = 'species-table__drifts-summary';
  summary.textContent = `${speciesLabel} — ${drifts.length} drift${drifts.length === 1 ? '' : 's'}, ${totalCount} plant${totalCount === 1 ? '' : 's'}`;
  td.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'species-table__drift-list';
  drifts.forEach(({ driftId, members }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'species-table__drift-chip';
    btn.dataset.driftId = driftId;
    btn.textContent = driftLabel(members);
    if (driftId === highlightedDriftId) btn.classList.add('is-highlighted');
    btn.addEventListener('click', () => onDriftClick?.(driftId, btn));
    list.appendChild(btn);
  });
  if (singleCount > 0) {
    const single = document.createElement('span');
    single.className = 'species-table__drift-single';
    single.textContent = `${singleCount} single`;
    list.appendChild(single);
  }
  td.appendChild(list);
  return td;
}

/**
 * "N possible drifts — Review" (nl-o47.6.5): the entry point into the
 * suggestion review, at the top of the species list — on a phone this same
 * element sits inside the Plants sheet (src/interaction/phoneEditor.js hosts
 * the whole #speciesTable, banner included), on desktop it is simply the
 * table's first child.
 * @param {number} count
 * @param {() => void} [onClick]
 */
function buildSuggestDriftsBanner(count, onClick) {
  const banner = document.createElement('div');
  banner.className = 'species-table__suggest-drifts';
  const text = document.createElement('span');
  text.textContent = `${count} possible drift${count === 1 ? '' : 's'}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'suggestDriftsBtn';
  button.className = 'button pill-button';
  button.textContent = 'Review';
  button.addEventListener('click', () => onClick?.());
  banner.append(text, button);
  return banner;
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
