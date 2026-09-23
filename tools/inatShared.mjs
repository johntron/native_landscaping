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

/**
 * Restrict an observation query to wild, species-vetted records whose public
 * location is the real one. Both fetch tools call this; the nearby-fauna tool
 * went without it until nl-hr5, which is the drift this module exists to stop.
 *
 * - captive=false + quality_grade=research: without these a Dallas search for
 *   Amphibia returned a captive axolotl and red-eyed tree frog alongside
 *   actually-wild species.
 * - Two INDEPENDENT obscuring mechanisms, both of which randomize the public
 *   location within a large cell, and both need excluding — one does not imply
 *   the other:
 *   - taxon_geoprivacy=open excludes species iNaturalist itself force-obscures
 *     (raptors, poaching-targeted plants). Confirmed on Haliaeetus
 *     leucocephalus (Bald Eagle): every nearby record had
 *     public_positional_accuracy=29039m (~18 mi); geoprivacy=open alone did
 *     NOT catch it.
 *   - geoprivacy=open excludes an individual observer's own choice to obscure
 *     a record. Confirmed on a nearby Phyllanthus polygonoides record
 *     (geoprivacy=obscured, taxon_geoprivacy=None); taxon_geoprivacy=open
 *     alone did NOT catch it. It drops nearby Plantae by only ~1.5%
 *     (1062 -> 1046), so it is not excluding ordinary public records.
 *
 * Sets the params in this order on purpose: the probe cache keys on the full
 * URL, so a reordering would orphan every cached response.
 * @param {URL} url
 */
export function restrictToWildPreciseRecords(url) {
  url.searchParams.set('captive', 'false');
  url.searchParams.set('quality_grade', 'research');
  url.searchParams.set('taxon_geoprivacy', 'open');
  url.searchParams.set('geoprivacy', 'open');
}

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
  const { establishmentMeansById } = await fetchTaxaFacts(taxonIds, placeId, { fetchJson });
  return establishmentMeansById;
}

/**
 * Batched /v1/taxa/{ids} lookup (nl-1qy.4.2) that pulls BOTH facts the
 * response already carries in one request per chunk — preferred_establishment_
 * means (what fetchEstablishmentMeans always returned) and conservation_status
 * (added for the rarity feed's conservation-status fact). Splitting these into
 * two functions would mean two separate batched requests against the same
 * ids, doubling the network/cache traffic for no reason; fetchEstablishmentMeans
 * above stays as a thin wrapper so existing callers that only want the means
 * map are unaffected.
 *
 * conservation_status, when `preferred_place_id` is set, reflects the
 * place-specific listing when iNaturalist has one and falls back to the
 * global IUCN-style status otherwise — same "unassessed is not the same as
 * secure" reasoning as establishment_means: a taxon with no status here is
 * left out of the map rather than treated as "not of concern."
 *
 * @returns {Promise<{establishmentMeansById: Map<number, string>, conservationStatusById: Map<number, {status: string, statusName: string, authority: string}>}>}
 */
export async function fetchTaxaFacts(taxonIds, placeId, { fetchJson }) {
  const uniqueIds = [...new Set(taxonIds)].filter((id) => Number.isFinite(id));
  const establishmentMeansById = new Map();
  const conservationStatusById = new Map();
  for (let i = 0; i < uniqueIds.length; i += TAXA_IDS_PER_REQUEST) {
    const chunk = uniqueIds.slice(i, i + TAXA_IDS_PER_REQUEST);
    const url = new URL(`https://api.inaturalist.org/v1/taxa/${chunk.join(',')}`);
    url.searchParams.set('preferred_place_id', String(placeId));
    try {
      const body = await fetchJson('taxa/preferred_establishment_means', url);
      (body.results || []).forEach((taxon) => {
        if (taxon.preferred_establishment_means) {
          establishmentMeansById.set(taxon.id, taxon.preferred_establishment_means);
        }
        const status = taxon.conservation_status;
        if (status && status.status) {
          conservationStatusById.set(taxon.id, {
            status: status.status,
            statusName: status.status_name || '',
            authority: status.authority || '',
          });
        }
      });
    } catch (err) {
      console.warn(`  taxa lookup FAILED for a batch of ${chunk.length} taxa — ${err.message}`);
    }
  }
  return { establishmentMeansById, conservationStatusById };
}
