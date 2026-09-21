import { fetchCsv, parseCsv } from '../data/csvLoader.js';
import { searchFnctResults } from './fnctSearch.js';
import { matchCatalogRow } from './fnctCatalog.js';
import { findKeystoneRow, lepidopteraHostsForGenus, interactionsForGenus } from './fnctEcology.js';
import { aggregateGenusRows, filterGenusSpecies } from './fnctGenus.js';

const INDEX_CSV = 'ecology/fnct-species-index.csv';
const CATALOG_CSV = 'plants.csv';
const HOST_GENERA_CSV = 'ecology/host-genera.csv';
const LEP_HOSTS_CSV = 'ecology/fnct-lepidoptera-hosts.csv';
const INTERACTIONS_CSV = 'ecology/plant-animal-interactions.csv';

// Every plants.csv column worth showing verbatim, in display order. `id` and
// `botanical_name` are covered elsewhere in the panel (the row link / the
// scientific name heading) so they're left out here.
const CATALOG_FIELD_LABELS = [
  ['common_name', 'Catalog name'],
  ['growth_shape', 'Growth shape'],
  ['growing_season_months', 'Growing season'],
  ['flowering_season_months', 'Bloom season'],
  ['flower_color', 'Flower color'],
  ['foliage_color_spring', 'Foliage (spring)'],
  ['foliage_color_summer', 'Foliage (summer)'],
  ['foliage_color_fall', 'Foliage (fall)'],
  ['foliage_color_winter', 'Foliage (winter)'],
  ['sun_pref', 'Sun'],
  ['water_pref', 'Water'],
  ['soil_pref', 'Soil'],
  ['width_ft', 'Width (ft)'],
  ['height_ft', 'Height (ft)'],
  ['inflorescence', 'Inflorescence'],
  ['flower_count_hint', 'Flower count'],
  ['flower_zone', 'Flower zone'],
  ['fruit_color', 'Fruit color'],
  ['fruit_season_months', 'Fruit season'],
  ['fruit_load', 'Fruit load'],
];

const searchEl = document.getElementById('fnctSearch');
const bodyEl = document.getElementById('fnctBody');
const countEl = document.getElementById('fnctCount');
const emptyEl = document.getElementById('fnctEmpty');
const detailEl = document.getElementById('fnctDetail');
const detailCloseEl = document.getElementById('fnctDetailClose');
const speciesDetailEl = document.getElementById('fnctSpeciesDetail');
const detailNameEl = document.getElementById('fnctDetailName');
const detailCommonEl = document.getElementById('fnctDetailCommon');
const detailFactsEl = document.getElementById('fnctDetailFacts');
const detailSourceEl = document.getElementById('fnctDetailSource');
const catalogNoteEl = document.getElementById('fnctDetailCatalogNote');
const catalogFactsEl = document.getElementById('fnctDetailCatalogFacts');
const keystoneSectionEl = document.getElementById('fnctDetailKeystoneSection');
const keystoneTextEl = document.getElementById('fnctDetailKeystoneText');
const lepSectionEl = document.getElementById('fnctDetailLepSection');
const lepListEl = document.getElementById('fnctDetailLepList');
const interactionsSectionEl = document.getElementById('fnctDetailInteractionsSection');
const interactionsEl = document.getElementById('fnctDetailInteractions');

const genusDetailEl = document.getElementById('fnctGenusDetail');
const genusNameEl = document.getElementById('fnctGenusName');
const genusSummaryEl = document.getElementById('fnctGenusSummary');
const genusCitationEl = document.getElementById('fnctGenusCitation');
const genusFilterLifeFormEl = document.getElementById('fnctGenusFilterLifeForm');
const genusFilterDurationEl = document.getElementById('fnctGenusFilterDuration');
const genusFilterHabitatEl = document.getElementById('fnctGenusFilterHabitat');
const genusSpeciesCountEl = document.getElementById('fnctGenusSpeciesCount');
const genusSpeciesListEl = document.getElementById('fnctGenusSpeciesList');

let rows = [];
let genusRows = [];
let catalogRows = [];
let ecologyData = null; // lazy-loaded: { hostGenera, lepHosts, interactions }

async function init() {
  try {
    [rows, catalogRows] = await Promise.all([
      fetchCsv(INDEX_CSV).then(parseCsv),
      fetchCsv(CATALOG_CSV).then(parseCsv).catch(() => []),
    ]);
    genusRows = aggregateGenusRows(rows);
  } catch (err) {
    countEl.textContent = 'Failed to load flora index.';
    console.error(err);
    return;
  }
  render(searchEl.value);
  searchEl.addEventListener('input', () => render(searchEl.value));
  detailCloseEl.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !detailEl.hidden) closeDetail();
  });
  [genusFilterLifeFormEl, genusFilterDurationEl, genusFilterHabitatEl].forEach((el) =>
    el.addEventListener('change', renderGenusSpeciesList),
  );
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
}

function render(query) {
  const matches = searchFnctResults(genusRows, rows, query);
  countEl.textContent = `${matches.length} of ${genusRows.length + rows.length}`;
  emptyEl.hidden = matches.length > 0;
  bodyEl.replaceChildren(...matches.map(rowToTr));
}

function rowToTr(row) {
  const isGenus = row.kind === 'genus';
  const tr = document.createElement('tr');
  tr.tabIndex = 0;
  if (isGenus) tr.className = 'fnct-table__row--genus';
  tr.addEventListener('click', () => selectRow(row));
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectRow(row);
    }
  });

  const nameTd = document.createElement('td');
  nameTd.className = isGenus ? 'fnct-table__genus-name' : 'fnct-table__name';
  nameTd.textContent = row.scientific_name;
  if (isGenus) {
    const badge = document.createElement('span');
    badge.className = 'fnct-table__genus-badge';
    badge.textContent = `GENUS · ${row.species_count}`;
    nameTd.appendChild(badge);
  }
  tr.appendChild(nameTd);

  const commonTd = document.createElement('td');
  commonTd.textContent = row.common_names.split('; ').slice(0, isGenus ? 6 : undefined).join(', ') || '—';
  tr.appendChild(commonTd);

  const pageTd = document.createElement('td');
  pageTd.className = 'fnct-table__page';
  pageTd.textContent = isGenus ? (row.min_page ?? '') : row.fnct_page;
  tr.appendChild(pageTd);

  return tr;
}

function selectRow(row) {
  window.location.hash = row.kind === 'genus' ? `genus:${encodeURIComponent(row.genus)}` : encodeURIComponent(row.scientific_name);
}

function openFromHash() {
  const raw = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (!raw) {
    closeDetail();
    return;
  }
  if (raw.startsWith('genus:')) {
    const genusRow = genusRows.find((g) => g.genus === raw.slice('genus:'.length));
    if (genusRow) showGenusDetail(genusRow);
    return;
  }
  const row = rows.find((r) => r.scientific_name === raw);
  if (row) showDetail(row);
}

function closeDetail() {
  detailEl.hidden = true;
  document.body.style.overflow = '';
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
}

async function loadEcologyData() {
  if (ecologyData) return ecologyData;
  const [hostGenera, lepHosts, interactions] = await Promise.all([
    fetchCsv(HOST_GENERA_CSV).then(parseCsv).catch(() => []),
    fetchCsv(LEP_HOSTS_CSV).then(parseCsv).catch(() => []),
    fetchCsv(INTERACTIONS_CSV).then(parseCsv).catch(() => []),
  ]);
  ecologyData = { hostGenera, lepHosts, interactions };
  return ecologyData;
}

async function showDetail(row) {
  detailEl.hidden = false;
  speciesDetailEl.hidden = false;
  genusDetailEl.hidden = true;
  document.body.style.overflow = 'hidden';
  detailEl.scrollTop = 0;
  detailEl.querySelector('.fnct-overlay__content').scrollTop = 0;

  detailNameEl.textContent = row.scientific_name;
  const names = row.common_names.split('; ').filter(Boolean);
  detailCommonEl.textContent = names.length ? names.join(', ') : 'No common name given by the flora.';

  detailFactsEl.replaceChildren(...factRows([
    ['Rank', row.rank === 'species' ? 'Species' : row.rank === 'variety' ? 'Variety' : 'Subspecies'],
    ['Genus', row.genus],
    row.infra_epithet ? ['Infraspecific epithet', row.infra_epithet] : null,
    row.life_form ? ['Life form', titleCaseWords(row.life_form)] : null,
    row.duration ? ['Duration', titleCaseWords(row.duration)] : null,
    row.habitat_tags ? ['Habitat', row.habitat_tags.split('; ').map(titleCaseWords).join(', ')] : null,
    ['Native/introduced', nativityLabel(row)],
    ['Flora page', row.fnct_page],
  ].filter(Boolean)));
  detailSourceEl.textContent = row.source;

  const catalogMatch = matchCatalogRow(row, catalogRows);
  if (catalogMatch) {
    catalogNoteEl.textContent = `Already in this project's plant catalog (id: ${catalogMatch.id}).`;
    const facts = CATALOG_FIELD_LABELS.filter(([field]) => catalogMatch[field]).map(([field, label]) => [label, catalogMatch[field]]);
    catalogFactsEl.replaceChildren(...factRows(facts));
  } else {
    catalogNoteEl.textContent = "Not in this project's plant catalog yet.";
    catalogFactsEl.replaceChildren();
  }

  keystoneSectionEl.hidden = true;
  lepSectionEl.hidden = true;
  interactionsSectionEl.hidden = true;

  const { hostGenera, lepHosts, interactions } = await loadEcologyData();
  // A hash change (user clicked another row) could have fired while this
  // fetch was in flight — bail rather than paint a stale species' ecology
  // data onto the now-current heading.
  if (detailNameEl.textContent !== row.scientific_name) return;

  const keystoneRow = findKeystoneRow(row.genus, hostGenera);
  if (keystoneRow) {
    const parts = [];
    if (keystoneRow.lep_host_species) parts.push(`${keystoneRow.lep_host_species} lepidoptera species use ${row.genus} as a larval host`);
    if (keystoneRow.bee_specialist_species) parts.push(`${keystoneRow.bee_specialist_species} specialist bee species`);
    if (keystoneRow.larval_hosts) parts.push(keystoneRow.larval_hosts);
    if (parts.length) {
      keystoneSectionEl.hidden = false;
      keystoneTextEl.textContent = `${parts.join('; ')} (NWF, EPA Level I ecoregion 9).`;
    }
  }

  const hosts = lepidopteraHostsForGenus(row.genus, lepHosts);
  if (hosts.length) {
    lepSectionEl.hidden = false;
    lepListEl.replaceChildren(...hosts.map((h) => {
      const li = document.createElement('li');
      li.textContent = h.species;
      if (h.common) {
        const span = document.createElement('span');
        span.className = 'fnct-detail__list-common';
        span.textContent = ` — ${titleCaseWords(h.common)}`;
        li.appendChild(span);
      }
      return li;
    }));
  }

  const groups = interactionsForGenus(row.genus, interactions);
  if (groups.length) {
    interactionsSectionEl.hidden = false;
    interactionsEl.replaceChildren(...groups.map((group) => {
      const wrap = document.createElement('div');
      wrap.className = 'fnct-detail__interaction-group';
      const h4 = document.createElement('h4');
      h4.textContent = `${interactionLabel(group.type)} (${group.animals.length})`;
      wrap.appendChild(h4);
      const ul = document.createElement('ul');
      ul.className = 'fnct-detail__list';
      ul.replaceChildren(...group.animals.map((a) => {
        const li = document.createElement('li');
        li.textContent = a.common ? `${a.species} — ${a.common}` : a.species;
        return li;
      }));
      wrap.appendChild(ul);
      return wrap;
    }));
  }
}

let currentGenus = null;

function showGenusDetail(genusRow) {
  detailEl.hidden = false;
  speciesDetailEl.hidden = true;
  genusDetailEl.hidden = false;
  document.body.style.overflow = 'hidden';
  detailEl.scrollTop = 0;
  detailEl.querySelector('.fnct-overlay__content').scrollTop = 0;

  currentGenus = genusRow.genus;
  genusNameEl.textContent = genusRow.genus;
  genusSummaryEl.textContent = genusRow.common_names
    ? `${genusRow.species_count} species in this flora — ${genusRow.common_names.split('; ').join(', ')}`
    : `${genusRow.species_count} species in this flora`;
  genusCitationEl.textContent = genusRow.min_page
    ? `${genusRow.source} — the flora's own entries for this genus, including its key to species, begin near p. ${genusRow.min_page}.`
    : genusRow.source;

  fillGenusFilterSelect(genusFilterLifeFormEl, genusRow.life_forms);
  fillGenusFilterSelect(genusFilterDurationEl, genusRow.durations);
  fillGenusFilterSelect(genusFilterHabitatEl, genusRow.habitat_tags);

  renderGenusSpeciesList();
}

function fillGenusFilterSelect(selectEl, values) {
  const previous = selectEl.value;
  selectEl.replaceChildren(...['', ...values].map((v) => {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = v ? titleCaseWords(v) : 'Any';
    return option;
  }));
  selectEl.value = values.includes(previous) ? previous : '';
}

function renderGenusSpeciesList() {
  if (!currentGenus) return;
  const species = filterGenusSpecies(currentGenus, rows, {
    lifeForm: genusFilterLifeFormEl.value || undefined,
    duration: genusFilterDurationEl.value || undefined,
    habitatTag: genusFilterHabitatEl.value || undefined,
  }).sort((a, b) => a.scientific_name.localeCompare(b.scientific_name));

  genusSpeciesCountEl.textContent = species.length;
  genusSpeciesListEl.replaceChildren(...species.map((s) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.textContent = s.scientific_name;
    if (s.common_names) {
      const span = document.createElement('span');
      span.className = 'fnct-detail__list-common';
      span.textContent = ` — ${s.common_names.split('; ').join(', ')}`;
      li.appendChild(span);
    }
    const open = () => selectRow(s);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    return li;
  }));
}

const INTERACTION_LABELS = {
  eatenBy: 'Eaten by',
  hostOf: 'Larval host of',
  pollinatedBy: 'Pollinated by',
  flowersVisitedBy: 'Flowers visited by',
  visitedBy: 'Visited by',
  visitsFlowersOf: 'Visits flowers of',
  pollinator: 'Pollinator of',
};

function interactionLabel(type) {
  return INTERACTION_LABELS[type] || type;
}

function nativityLabel(row) {
  if (row.nativity_status === 'asserted' && row.nativity_value === 'introduced') return 'Introduced';
  if (row.nativity_status === 'asserted' && row.nativity_value === 'native') return 'Native';
  return 'Review flagged by the flora (mixed origin language) — see the flora page';
}

function titleCaseWords(s) {
  return s.toLowerCase().replace(/(^|\s)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

function factRows(pairs) {
  return pairs.flatMap(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  });
}

init();
