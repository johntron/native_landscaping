/*
 * The plant-matches lookup, renderable anywhere.
 *
 * This is the half of the ecosystem page that answers a question you ask WHILE
 * doing something else -- "is this genus supported near me, and what would use
 * it?" -- so it has to be available from the design tool and the argument page,
 * not only from a third destination. The other half, the full observation
 * index, is a browse: sorting a few hundred rows inside a 380px drawer is worse
 * than a page, so that stays one.
 *
 * Extracted rather than duplicated: the drawer and the full page must not drift
 * into saying different things about the same genus.
 */
import { loadProjectIndex, loadProjectConfig, resolveActiveProjectId } from '../data/projectConfig.js';
import { fetchCsv, parseCsv } from '../data/csvLoader.js';
import { describeHostGeneraRow } from '../analysis/hostGenera.js';
import { catalogGenusKeys, matchNearbyKeystoneGenera } from '../analysis/plantMatches.js';
import { loadEcologyTables } from '../data/ecologyTables.js';

export const PROJECT_QUERY_PARAM = 'project';

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/** The active project, from ?project= falling back to the index default. */
export async function resolveProject() {
  const index = await loadProjectIndex(fetch, document.baseURI);
  const resolved = resolveActiveProjectId(
    new URLSearchParams(window.location.search).get(PROJECT_QUERY_PARAM),
    index
  );
  return loadProjectConfig(resolved.id, fetch, document.baseURI);
}

/**
 * The nearby-observation index for a project, or a reason it is unavailable.
 *
 * The index is per yard (nl-3s5.6): it needs a location, not a place label,
 * and feed-poller builds it on its own once a location is set. `index.state`
 * says where that stands (no-location | queued | building | ready | failed);
 * `waiting` is the sentence to show instead of rows while there are none to
 * show, or null.
 *
 * @returns {Promise<{ rows: object[], location?: object | null, index?: { state: string, fetchedOn: string | null }, waiting?: string | null, error?: string }>}
 */
export async function fetchObservationRows(project) {
  const response = await fetch(`/api/ecosystem?${PROJECT_QUERY_PARAM}=${encodeURIComponent(project.id)}`);
  if (!response.ok) {
    return { rows: [], error: `The nearby index could not be loaded (${response.status}).` };
  }
  const body = await response.json();
  const rows = body.rows || [];
  const index = body.index || { state: 'ready', fetchedOn: null };
  return { rows, location: body.location || null, index, waiting: describeIndexWait(index, rows, project) };
}

/**
 * What to say while a yard's index has no rows to show, or null when it has
 * rows (or is built and simply found nothing, which the empty table says).
 * Shared by the page and the drawer so they never disagree.
 */
export function describeIndexWait(index, rows, project) {
  const name = project?.name ? `“${project.name}”` : 'This yard';
  switch (index?.state) {
    case 'no-location':
      return `${name} has no location set, so there is nothing to be near yet. Set one under Setup on Your yard (the Location section), and its index of species reported nearby builds automatically.`;
    case 'queued':
    case 'building':
      return `Building the index of species reported near ${name}… It is fetched from iNaturalist in the background and usually appears within half an hour. Reload to check.`;
    case 'failed':
      return rows.length
        ? null
        : `The last attempt to build the index for ${name} did not finish. It is retried automatically; reload later to check.`;
    default:
      return null;
  }
}

export function renderPlantMatchItem({ genus, hostGeneraRow, associatedFauna, nearbySpecies }) {
  const evidence = [];
  if (associatedFauna.length) {
    const named = associatedFauna
      .slice(0, 3)
      .map((m) => `${m.animalCommon || m.animalSpecies} (${m.nearestRadiusMi} mi)`)
      .join(', ');
    const more = associatedFauna.length > 3 ? `, +${associatedFauna.length - 3} more` : '';
    evidence.push(
      `<div class="plant-matches__evidence">Animals confirmed nearby documented to use it: ${escapeHtml(named)}${escapeHtml(more)}</div>`
    );
  }
  if (nearbySpecies.length) {
    const named = nearbySpecies
      .slice(0, 3)
      .map((s) => `${s.commonName || s.taxonName} (${s.radiusMi} mi)`)
      .join(', ');
    const more = nearbySpecies.length > 3 ? `, +${nearbySpecies.length - 3} more` : '';
    evidence.push(
      `<div class="plant-matches__evidence plant-matches__evidence--secondary">Also confirmed growing wild nearby: ${escapeHtml(named)}${escapeHtml(more)}</div>`
    );
  }
  return `<li class="plant-matches__item">
    <strong>${escapeHtml(genus)}</strong> — ${escapeHtml(describeHostGeneraRow(hostGeneraRow))}.
    ${evidence.join('')}
  </li>`;
}

/**
 * Computes the two match groups. Returns `{ note, candidates, alreadyInCatalog }`
 * with `candidates`/`alreadyInCatalog` already rendered to HTML, or `{ note }`
 * alone when the inputs do not permit an answer -- the caller decides how loudly
 * to say so.
 */
export async function computePlantMatches(project, observationRows) {
  if (!project.ecoregion) {
    return { note: `"${project.name}" declares no ecoregion, and the keystone lists are per ecoregion.` };
  }

  // The catalog is required -- without it there is no "already carried" split to
  // make -- but a missing ecology table only empties an index, and an empty index
  // is what these matchers are written to return nothing from.
  let speciesRows;
  let ecology;
  try {
    const [plantsCsv, tables] = await Promise.all([
      fetchCsv(new URL('plants.csv', document.baseURI)),
      loadEcologyTables({ ecoregion: project.ecoregion }),
    ]);
    speciesRows = parseCsv(plantsCsv);
    ecology = tables;
  } catch (err) {
    console.error(err);
    return { note: 'Could not load the plant catalog, so plant matches could not be computed.' };
  }
  if (ecology.warnings.length) {
    return { note: `Some ecology tables did not load, so this list is incomplete: ${ecology.warnings.join('; ')}.` };
  }

  const { candidates, alreadyInCatalog } = matchNearbyKeystoneGenera({
    observationRows,
    hostGenera: ecology.hostGenera,
    catalogGenusKeys: catalogGenusKeys(speciesRows),
    interactions: ecology.interactions,
    place: String(project.place || '').trim(),
  });

  const withFauna = candidates.filter((c) => c.associatedFauna.length).length;
  const note = candidates.length
    ? `${candidates.length} ecoregion-${project.ecoregion} keystone genus${candidates.length === 1 ? '' : 'es'} ${candidates.length === 1 ? 'is' : 'are'} missing from the catalog; ${withFauna} of those already ${withFauna === 1 ? 'has' : 'have'} an animal confirmed nearby that documented interactions say would use it.`
    : `No ecoregion-${project.ecoregion} keystone genus is missing from the catalog.`;

  const list = (items) =>
    items.length ? items.map(renderPlantMatchItem).join('') : '<li class="plant-matches__empty">None found.</li>';

  return { note, candidates: list(candidates), alreadyInCatalog: list(alreadyInCatalog) };
}
