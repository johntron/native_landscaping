/**
 * The iNaturalist calls both fetch tools need, in one place.
 *
 * tools/fetch-ecosystem-index.mjs grew these first; tools/fetch-nearby-fauna.mjs
 * needed the same establishment_means lookup and had drifted on the radius unit
 * (nl-a8v), which is exactly the class of bug two copies of a network client
 * produce. Shared here so a unit or an endpoint is defined once.
 */

/**
 * iNaturalist's `radius` parameter is in KILOMETRES. Both tools band their
 * results in miles because that is what the UI says, so every request converts.
 * Verified live 2026-09-13 against the backyard site: `radius=3` returned 166
 * bird species, `radius=4.828` (the same 3 miles, in km) returned 330.
 */
export const MI_TO_KM = 1.60934;

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const USER_AGENT =
  'native-landscaping-app (ecology data fetch; github.com/johntron/native_landscaping)';

/** Retries 429s and 5xx up to three times, honouring `retry-after` when the API sends one. */
export async function fetchWithBackoff(url, options, attempt = 1) {
  const response = await fetch(url, options);
  if ((response.status === 429 || response.status >= 500) && attempt <= 3) {
    const retryAfterMs = Number(response.headers.get('retry-after')) * 1000 || attempt * 5000;
    console.warn(`  HTTP ${response.status} — backing off ${retryAfterMs}ms before retry ${attempt}/3`);
    await sleep(retryAfterMs);
    return fetchWithBackoff(url, options, attempt + 1);
  }
  return response;
}

/**
 * iNaturalist per-taxon "listed_taxa" (native/introduced/invasive/etc,
 * preferred_establishment_means) is checklist data scoped to a PLACE, and
 * coverage varies wildly by which place: empirically, for a Dallas, TX site,
 * the county checklist (place_type 9) flagged only ~15-30% of nearby species,
 * while the STATE checklist (place_type 8) flagged 70-100% of the same
 * species. So this prefers state over the finer county, falls back to country
 * (12) if a site has no enclosing state, and to nothing if neither resolves —
 * leaving establishment_means blank, which excludes nothing (see
 * src/analysis/establishmentMeans.js: unassessed is not the same as non-native).
 */
const PREFERRED_PLACE_TYPES = [8, 12];
const PLACE_BBOX_DEG = 0.05;

export async function resolvePlaceId(lat, lng, { fetchJson }) {
  const url = new URL('https://api.inaturalist.org/v1/places/nearby');
  url.searchParams.set('swlat', lat - PLACE_BBOX_DEG);
  url.searchParams.set('swlng', lng - PLACE_BBOX_DEG);
  url.searchParams.set('nelat', lat + PLACE_BBOX_DEG);
  url.searchParams.set('nelng', lng + PLACE_BBOX_DEG);
  const body = await fetchJson('places/nearby', url);
  const standard = body.results?.standard || [];
  for (const placeType of PREFERRED_PLACE_TYPES) {
    const match = standard.find((p) => p.place_type === placeType);
    if (match) return match.id;
  }
  return null;
}

/** /v1/taxa/{ids} rejects more than 30 ids at once — verified empirically. */
const TAXA_IDS_PER_REQUEST = 30;

/**
 * Map taxon id -> preferred_establishment_means for one place. A failed batch
 * warns and yields nothing for those ids rather than aborting: a blank means
 * "unassessed", which is the safe reading anyway.
 *
 * @returns {Promise<Map<number, string>>}
 */
export async function fetchEstablishmentMeans(taxonIds, placeId, { fetchJson }) {
  const uniqueIds = [...new Set(taxonIds)].filter((id) => Number.isFinite(id));
  const meansById = new Map();
  for (let i = 0; i < uniqueIds.length; i += TAXA_IDS_PER_REQUEST) {
    const chunk = uniqueIds.slice(i, i + TAXA_IDS_PER_REQUEST);
    const url = new URL(`https://api.inaturalist.org/v1/taxa/${chunk.join(',')}`);
    url.searchParams.set('preferred_place_id', String(placeId));
    try {
      const body = await fetchJson('taxa/preferred_establishment_means', url);
      (body.results || []).forEach((taxon) => {
        if (taxon.preferred_establishment_means) {
          meansById.set(taxon.id, taxon.preferred_establishment_means);
        }
      });
    } catch (err) {
      console.warn(`  establishment_means lookup FAILED for a batch of ${chunk.length} taxa — ${err.message}`);
    }
  }
  return meansById;
}
