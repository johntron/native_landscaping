import { buildNearbyFaunaIndex, emptyNearbyFaunaIndex } from '../analysis/faunaMatches.js';

/**
 * One yard's site layers (nl-3s5.31): its habitat anchors (streams and green
 * space) and the animals reported near it, from the owner-scoped
 * /api/ecosystem/site. They were the committed, place-keyed
 * ecology/anchors.csv and ecology/nearby-fauna.csv until those put the
 * owner's site in a public repo.
 *
 * **A failed load costs checks, not the page**, the same tolerance as
 * loadEcologyTables: the caller always gets an empty-but-usable result, and
 * `error` says what went wrong so a page can say so.
 *
 * @param {string} projectSlug the yard's ?project= slug
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{
 *   anchors: Array<Record<string, any>>,
 *   nearbyFauna: { size: number, animals: Map<string, object> },
 *   layers: Record<'fauna'|'streams'|'greenspace', { state: string, fetchedOn: string | null }>,
 *   error: string | null,
 * }>}
 */
export async function loadYardSite(projectSlug, { fetchImpl = fetch } = {}) {
  const empty = { anchors: [], nearbyFauna: emptyNearbyFaunaIndex(), layers: {}, error: null };
  if (!projectSlug) return { ...empty, error: 'no yard' };
  try {
    const response = await fetchImpl(`/api/ecosystem/site?project=${encodeURIComponent(projectSlug)}`);
    if (!response.ok) return { ...empty, error: `the yard's site layers could not be loaded (${response.status})` };
    const body = await response.json();
    return {
      anchors: Array.isArray(body.anchors) ? body.anchors : [],
      nearbyFauna: buildNearbyFaunaIndex(Array.isArray(body.fauna) ? body.fauna : []),
      layers: body.layers || {},
      error: null,
    };
  } catch (err) {
    console.warn('Site layers unavailable', err);
    return { ...empty, error: "the yard's site layers could not be loaded" };
  }
}
