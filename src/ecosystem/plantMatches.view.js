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

/** The nearby-observation index for a project, or a reason it is unavailable. */
export async function fetchObservationRows(project) {
  const place = String(project.place || '').trim();
  if (!place) return { rows: [], error: `"${project.name}" declares no "place" in project.json.` };
  const response = await fetch(
    `/api/ecosystem?place=${encodeURIComponent(place)}&${PROJECT_QUERY_PARAM}=${encodeURIComponent(project.id)}`
  );
  if (!response.ok) {
    return { rows: [], error: `The nearby index has not been built for this project yet (${response.status}).` };
  }
  const body = await response.json();
  return { rows: body.rows || [], location: body.location || null };
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
