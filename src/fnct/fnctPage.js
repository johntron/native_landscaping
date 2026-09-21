import { fetchCsv, parseCsv } from '../data/csvLoader.js';
import { filterFnctRows } from './fnctSearch.js';

const INDEX_CSV = 'ecology/fnct-species-index.csv';

const searchEl = document.getElementById('fnctSearch');
const bodyEl = document.getElementById('fnctBody');
const countEl = document.getElementById('fnctCount');
const emptyEl = document.getElementById('fnctEmpty');

let rows = [];

async function init() {
  try {
    rows = parseCsv(await fetchCsv(INDEX_CSV));
  } catch (err) {
    countEl.textContent = 'Failed to load flora index.';
    console.error(err);
    return;
  }
  render('');
  searchEl.addEventListener('input', () => render(searchEl.value));
}

function render(query) {
  const matches = filterFnctRows(rows, query);
  countEl.textContent = `${matches.length} of ${rows.length}`;
  emptyEl.hidden = matches.length > 0;
  bodyEl.replaceChildren(...matches.map(rowToTr));
}

function rowToTr(row) {
  const tr = document.createElement('tr');

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

init();
