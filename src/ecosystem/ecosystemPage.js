/**
 * Page for browsing the local ecosystem index (nl-a7e), plus its "next
 * phase" (matchNearbyKeystoneGenera, see src/analysis/plantMatches.js):
 * which ecoregion keystone/larval-host genera are confirmed growing wild
 * near this site per /api/ecosystem, cross-referenced against the catalog.
 */
import { loadProjectIndex, loadProjectConfig, resolveActiveProjectId } from '../data/projectConfig.js';
import { fetchCsv, parseCsv } from '../data/csvLoader.js';
import { computePlantMatches, renderPlantMatchItem, escapeHtml } from './plantMatches.view.js';
import { pageTitle } from '../ui/siteRoute.js';
import { candidateSize, formatDistance, groupAnchors, kindLabel } from '../analysis/anchors.js';

const PROJECT_QUERY_PARAM = 'project';

const taxonFilter = document.getElementById('taxonFilter');
const searchFilter = document.getElementById('searchFilter');
const rowsEl = document.getElementById('ecosystemRows');
const countEl = document.getElementById('ecosystemCount');
const titleEl = document.getElementById('ecosystemTitle');
const noteEl = document.getElementById('ecosystemNote');
const navDesignLink = document.getElementById('navDesignLink');
const plantMatchesNoteEl = document.getElementById('plantMatchesNote');
const plantMatchCandidatesEl = document.getElementById('plantMatchCandidates');
const plantMatchCatalogEl = document.getElementById('plantMatchCatalog');
const habitatSectionEl = document.getElementById('habitatNearby');
const habitatAnchorsEl = document.getElementById('habitatAnchors');
const habitatCandidatesEl = document.getElementById('habitatCandidates');
const habitatCreditEl = document.getElementById('habitatNearbyCredit');

let allRows = [];
let sortKey = 'observation_count';
let sortDir = -1;
let siteLocation = null; // { lat, lng } for the active project, if one is set in app.db and the viewer owns the yard — used to scope outbound iNaturalist links

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
    rowsEl.innerHTML = `<tr><td colspan="7">Unable to load project configuration.</td></tr>`;
    console.error(err);
    return;
  }

  if (navDesignLink) {
    const url = new URL(navDesignLink.href);
    url.searchParams.set(PROJECT_QUERY_PARAM, project.id);
    navDesignLink.href = url.toString();
  }

  const place = String(project.place || '').trim();
  if (titleEl) titleEl.textContent = `What’s nearby: ${project.name}`;
  document.title = pageTitle(`What’s nearby: ${project.name}`);
  if (!place) {
    rowsEl.innerHTML = `<tr><td colspan="7">"${project.name}" declares no "place" — add one before indexing.</td></tr>`;
    return;
  }
  // Independent of the species index below: a missing anchors table costs this
  // section, never the page.
  renderHabitatNearby(place).catch((err) => console.warn('Habitat anchors unavailable', err));
  if (noteEl) {
    noteEl.innerHTML = `Species reported on iNaturalist near "${place}", banded by how far each taxon
      plausibly ranges to find a newly planted specimen. See
      <a href="tools/fetch-ecosystem-index.mjs">tools/fetch-ecosystem-index.mjs</a> for how the
      index is built and refreshed
      (<code>docker compose exec web npm run ecosystem:fetch -- --project ${project.id}</code>).
      Species iNaturalist itself hides the true location of (protected raptors, poaching-targeted
      plants — e.g. Bald Eagle) are left out entirely, since their public coordinates are a randomized
      point that can be tens of miles off, making any radius label for them meaningless. Species
      iNaturalist's own checklists flag as introduced, naturalized, or invasive in this state are
      excluded too (a species with no checklist entry is left in — unassessed isn't the same as
      non-native).`;
  }

  const response = await fetch(
    `/api/ecosystem?place=${encodeURIComponent(place)}&${PROJECT_QUERY_PARAM}=${encodeURIComponent(project.id)}`
  );
  if (!response.ok) {
    rowsEl.innerHTML = `<tr><td colspan="7">Failed to load (${response.status}). Run <code>docker compose exec web npm run ecosystem:fetch -- --project ${project.id}</code> first.</td></tr>`;
    return;
  }
  const body = await response.json();
  allRows = body.rows || [];
  siteLocation = body.location || null;

  const taxa = [...new Set(allRows.map((r) => r.iconic_taxon))].sort();
  taxonFilter.innerHTML =
    '<option value="">All</option>' + taxa.map((t) => `<option value="${t}">${t}</option>`).join('');

  render();
  await loadPlantMatches(project);
}

/**
 * The "next phase" cross-reference: every ecoregion keystone/larval-host
 * genus (ecology/host-genera.csv), split by whether plants.csv already
 * carries it, and prioritized by TWO kinds of local evidence: an animal
 * GloBI documents as using the genus is confirmed nearby (primary — the
 * genus itself need not have been observed), or the genus itself is
 * confirmed growing wild nearby (secondary, shown as supporting evidence).
 * Loaded after the main index so a failure here never blocks the table above.
 */
async function loadPlantMatches(project) {
  const { note, candidates, alreadyInCatalog } = await computePlantMatches(project, allRows);
  plantMatchesNoteEl.textContent = note;
  if (!candidates) return;
  plantMatchCandidatesEl.innerHTML = candidates;
  plantMatchCatalogEl.innerHTML = alreadyInCatalog;
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
        <td>${photoThumb(r)}</td>
        <td>${escapeHtml(r.iconic_taxon)}</td>
        <td><em>${escapeHtml(r.taxon_name)}</em></td>
        <td>${escapeHtml(r.common_name)}</td>
        <td>${r.radius_mi} mi</td>
        <td>${r.observation_count}</td>
        <td>${inaturalistLink(r)}</td>
      </tr>`
    )
    .join('');
}

/** Hotlinked from iNaturalist's own CDN; the fetch script already excludes "all rights reserved" photos, keeping only openly-licensed ones. Attribution (required by most of those licenses) is kept in the title tooltip. */
function photoThumb(row) {
  if (!row.photo_url) return '';
  const attribution = escapeHtml(row.photo_attribution || '');
  return `<img src="${row.photo_url}" alt="${escapeHtml(row.common_name || row.taxon_name)}" title="${attribution}" loading="lazy" class="ecosystem-thumb" />`;
}

const MI_TO_KM = 1.60934;

/**
 * Links to the taxon's observations map, centered and radius-limited to the
 * site — using the SAME radius this row was actually found at, so the link
 * shows exactly the evidence behind that row's distance claim rather than a
 * generic global search. Coordinates come from /api/ecosystem's `location`
 * (server-side only, read from app.db's projects.location_json, for the yard's owner)
 * and are sent to iNaturalist.org only when this specific link is clicked —
 * by request; see the ecosystem note for the tradeoff this makes explicit.
 */
function inaturalistLink(row) {
  if (!row.taxon_id) return '';
  const url = new URL('https://www.inaturalist.org/observations');
  url.searchParams.set('taxon_id', row.taxon_id);
  if (siteLocation) {
    url.searchParams.set('lat', siteLocation.lat);
    url.searchParams.set('lng', siteLocation.lng);
    url.searchParams.set('radius', (row.radius_mi * MI_TO_KM).toFixed(3));
  }
  return `<a href="${url.toString()}" target="_blank" rel="noopener">View observations</a>`;
}


document.querySelectorAll('.ecosystem-table th[data-sort-key]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sortKey;
    sortDir = sortKey === key ? -sortDir : -1;
    sortKey = key;
    render();
  });
});

taxonFilter.addEventListener('change', render);
searchFilter.addEventListener('input', render);

load();

/**
 * Streams and green space near the site (ecology/anchors.csv, nl-3hi.7). Name and
 * straight-line distance only, by design: no score or ranking beyond distance.
 * The section stays hidden when this place has no rows.
 */
async function renderHabitatNearby(place) {
  if (!habitatSectionEl) return;
  const rows = parseCsv(await fetchCsv(new URL('ecology/anchors.csv', document.baseURI)));
  const { anchors, candidates, fetchedOn } = groupAnchors(rows, place);
  if (!anchors.length && !candidates.length) return;

  const renderList = (listEl, entries, describe) => {
    listEl.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'plant-matches__empty';
      empty.textContent = 'None found within range.';
      listEl.appendChild(empty);
      return;
    }
    entries.forEach((entry) => {
      const item = document.createElement('li');
      item.className = 'plant-matches__item';
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const facts = document.createElement('div');
      facts.className = 'plant-matches__evidence';
      facts.textContent = describe(entry);
      item.append(name, facts);
      listEl.appendChild(item);
    });
  };

  renderList(habitatAnchorsEl, anchors, (entry) => `${formatDistance(entry.distanceMi)} away`);
  renderList(habitatCandidatesEl, candidates, (entry) =>
    [kindLabel(entry.kind), candidateSize(entry.detail), `${formatDistance(entry.distanceMi)} away`]
      .filter(Boolean)
      .join(' · ')
  );
  if (habitatCreditEl && fetchedOn) {
    habitatCreditEl.append(` Fetched ${fetchedOn}.`);
  }
  habitatSectionEl.hidden = false;
}
