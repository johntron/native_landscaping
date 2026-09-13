/** Page for browsing the local ecosystem index (nl-a7e). Reads /api/ecosystem, which reads data/ecosystem.db. */
import { loadProjectIndex, loadProjectConfig, resolveActiveProjectId } from '../data/projectConfig.js';

const PROJECT_QUERY_PARAM = 'project';

const taxonFilter = document.getElementById('taxonFilter');
const searchFilter = document.getElementById('searchFilter');
const rowsEl = document.getElementById('ecosystemRows');
const countEl = document.getElementById('ecosystemCount');
const titleEl = document.getElementById('ecosystemTitle');
const noteEl = document.getElementById('ecosystemNote');
const navDesignLink = document.getElementById('navDesignLink');

let allRows = [];
let sortKey = 'observation_count';
let sortDir = -1;

async function load() {
  let project;
  try {
    const projectIndex = await loadProjectIndex(fetch, document.baseURI);
    const resolved = resolveActiveProjectId(
      new URLSearchParams(window.location.search).get(PROJECT_QUERY_PARAM),
      projectIndex
    );
    project = await loadProjectConfig(resolved.id, fetch, document.baseURI);
  } catch (err) {
    rowsEl.innerHTML = `<tr><td colspan="5">Unable to load project configuration.</td></tr>`;
    console.error(err);
    return;
  }

  if (navDesignLink) {
    const url = new URL(navDesignLink.href);
    url.searchParams.set(PROJECT_QUERY_PARAM, project.id);
    navDesignLink.href = url.toString();
  }

  const place = String(project.place || '').trim();
  if (titleEl) titleEl.textContent = `Nearby Ecosystem — ${project.name}`;
  if (!place) {
    rowsEl.innerHTML = `<tr><td colspan="5">"${project.name}" declares no "place" in project.json — add one before indexing.</td></tr>`;
    return;
  }
  if (noteEl) {
    noteEl.innerHTML = `Species reported on iNaturalist near "${place}", banded by how far each taxon
      plausibly ranges to find a newly planted specimen. Indexing only — this does not yet
      suggest which plants to add; see
      <a href="tools/fetch-ecosystem-index.mjs">tools/fetch-ecosystem-index.mjs</a> for how the
      index is built and refreshed
      (<code>docker compose exec web npm run ecosystem:fetch -- --project ${project.id}</code>).`;
  }

  const response = await fetch(`/api/ecosystem?place=${encodeURIComponent(place)}`);
  if (!response.ok) {
    rowsEl.innerHTML = `<tr><td colspan="5">Failed to load (${response.status}). Run <code>docker compose exec web npm run ecosystem:fetch -- --project ${project.id}</code> first.</td></tr>`;
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
