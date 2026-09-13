/** Standalone page: browse the local ecosystem index (nl-a7e). Reads /api/ecosystem, which reads data/ecosystem.db. */

const taxonFilter = document.getElementById('taxonFilter');
const searchFilter = document.getElementById('searchFilter');
const rowsEl = document.getElementById('ecosystemRows');
const countEl = document.getElementById('ecosystemCount');

let allRows = [];
let sortKey = 'observation_count';
let sortDir = -1;

async function load() {
  const response = await fetch('/api/ecosystem?place=home');
  if (!response.ok) {
    rowsEl.innerHTML = `<tr><td colspan="5">Failed to load (${response.status}). Run <code>node tools/fetch-ecosystem-index.mjs --project backyard</code> first.</td></tr>`;
    return;
  }
  const body = await response.json();
  allRows = body.rows || [];

  const taxa = [...new Set(allRows.map((r) => r.iconic_taxon))].sort();
  taxonFilter.innerHTML =
    '<option value="">All</option>' + taxa.map((t) => `<option value="${t}">${t}</option>`).join('');

  render();
}

function render() {
  const taxon = taxonFilter.value;
  const search = searchFilter.value.trim().toLowerCase();

  const filtered = allRows.filter((r) => {
    if (taxon && r.iconic_taxon !== taxon) return false;
    if (search && !`${r.taxon_name} ${r.common_name}`.toLowerCase().includes(search)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });

  countEl.textContent = `${filtered.length} of ${allRows.length} species`;
  rowsEl.innerHTML = filtered
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.iconic_taxon)}</td>
        <td><em>${escapeHtml(r.taxon_name)}</em></td>
        <td>${escapeHtml(r.common_name)}</td>
        <td>${r.radius_mi} mi</td>
        <td>${r.observation_count}</td>
      </tr>`
    )
    .join('');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

document.querySelectorAll('.ecosystem-table th').forEach((th, i) => {
  const keys = ['iconic_taxon', 'taxon_name', 'common_name', 'radius_mi', 'observation_count'];
  th.addEventListener('click', () => {
    const key = keys[i];
    sortDir = sortKey === key ? -sortDir : -1;
    sortKey = key;
    render();
  });
});

taxonFilter.addEventListener('change', render);
searchFilter.addEventListener('input', render);

load();
