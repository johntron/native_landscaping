import { fetchCsv, parseCsv } from '../data/csvLoader.js';
import { filterFnctRows } from './fnctSearch.js';
import { matchCatalogRow } from './fnctCatalog.js';

const INDEX_CSV = 'ecology/fnct-species-index.csv';
const CATALOG_CSV = 'plants.csv';

const searchEl = document.getElementById('fnctSearch');
const bodyEl = document.getElementById('fnctBody');
const countEl = document.getElementById('fnctCount');
const emptyEl = document.getElementById('fnctEmpty');
const detailEl = document.getElementById('fnctDetail');
const detailCloseEl = document.getElementById('fnctDetailClose');
const detailNameEl = document.getElementById('fnctDetailName');
const detailCommonEl = document.getElementById('fnctDetailCommon');
const detailFactsEl = document.getElementById('fnctDetailFacts');
const detailCatalogEl = document.getElementById('fnctDetailCatalog');
const detailSourceEl = document.getElementById('fnctDetailSource');

let rows = [];
let catalogRows = [];

async function init() {
  try {
    [rows, catalogRows] = await Promise.all([
      fetchCsv(INDEX_CSV).then(parseCsv),
      fetchCsv(CATALOG_CSV).then(parseCsv).catch(() => []),
    ]);
  } catch (err) {
    countEl.textContent = 'Failed to load flora index.';
    console.error(err);
    return;
  }
  render(searchEl.value);
  searchEl.addEventListener('input', () => render(searchEl.value));
  detailCloseEl.addEventListener('click', closeDetail);
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
}

function render(query) {
  const matches = filterFnctRows(rows, query);
  countEl.textContent = `${matches.length} of ${rows.length}`;
  emptyEl.hidden = matches.length > 0;
  bodyEl.replaceChildren(...matches.map(rowToTr));
}

function rowToTr(row) {
  const tr = document.createElement('tr');
  tr.tabIndex = 0;
  tr.addEventListener('click', () => selectRow(row));
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectRow(row);
    }
  });

  const nameTd = document.createElement('td');
  nameTd.className = 'fnct-table__name';
  nameTd.textContent = row.scientific_name;
  tr.appendChild(nameTd);

  const commonTd = document.createElement('td');
  commonTd.textContent = row.common_names.split('; ').join(', ') || '—';
  tr.appendChild(commonTd);

  const pageTd = document.createElement('td');
  pageTd.className = 'fnct-table__page';
  pageTd.textContent = row.fnct_page;
  tr.appendChild(pageTd);

  return tr;
}

function selectRow(row) {
  window.location.hash = encodeURIComponent(row.scientific_name);
}

function openFromHash() {
  const name = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (!name) {
    closeDetail();
    return;
  }
  const row = rows.find((r) => r.scientific_name === name);
  if (row) showDetail(row);
}

function closeDetail() {
  detailEl.hidden = true;
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
}

function showDetail(row) {
  detailEl.hidden = false;
  detailNameEl.textContent = row.scientific_name;
  const names = row.common_names.split('; ').filter(Boolean);
  detailCommonEl.textContent = names.length ? names.join(', ') : 'No common name given by the flora.';

  detailFactsEl.replaceChildren(...factRows([
    ['Rank', row.rank === 'species' ? 'Species' : row.rank === 'variety' ? 'Variety' : 'Subspecies'],
    ['Genus', row.genus],
    row.infra_epithet ? ['Infraspecific epithet', row.infra_epithet] : null,
  ].filter(Boolean)));

  const catalogMatch = matchCatalogRow(row, catalogRows);
  detailCatalogEl.textContent = catalogMatch
    ? `In this project's plant catalog as "${catalogMatch.common_name}" — ${[catalogMatch.growth_shape, catalogMatch.sun_pref, catalogMatch.water_pref].filter(Boolean).join(', ')}.`
    : "Not in this project's plant catalog yet.";

  detailSourceEl.innerHTML = '';
  const link = document.createElement('span');
  link.textContent = row.source;
  detailSourceEl.appendChild(link);

  detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
