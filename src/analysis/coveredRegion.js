/**
 * Is a yard's saved location inside the region this project's data covers
 * (nl-3s5.30, from nl-3s5.8)? A warning, never a refusal: the nearby-species
 * index is built from iNaturalist around wherever the yard is, but the curated
 * tables behind it (plants.csv, catalog/dfw-*.csv, ecology/host-genera.csv,
 * the FNCT genus screen, the sourcing tables) are Blackland Prairie / Cross
 * Timbers around Dallas-Fort Worth. A yard far outside that gets thin or
 * wrong-footed results, and the owner should hear so instead of guessing why.
 *
 * Two checks, both computable from the stored { lat, lng } alone, so the
 * verdict is the same at preview, at save and on every later read:
 *
 * 1. SOURCED: the EPA Level I ecoregion at the point (tools/ecoregionLookup.mjs,
 *    a point-in-polygon lookup against CEC/EPA boundaries) must be one this
 *    project has keystone-genus data for (src/data/ecoregionInput.js
 *    KNOWN_ECOREGIONS, today only 9, Great Plains). This is what excludes
 *    East Texas (Level I 8) a short drive east of Dallas.
 * 2. OUR JUDGEMENT: the point must be within COVERED_RADIUS_MI of Dallas.
 *    Level I 9 runs from Texas to Canada, so on its own it would call Kansas
 *    covered. The radius is ours, not a published boundary: it takes in the
 *    DFW metroplex and the Blackland Prairie / Cross Timbers towns around it
 *    (Denton, McKinney, Sherman, Waxahachie, Weatherford, Cleburne), which is
 *    where the catalog, the nursery list and the plant sales are drawn from.
 *    The Flora of North Central Texas covers more (its 50 counties reach
 *    "south nearly to Austin ... west nearly to Wichita Falls and Abilene",
 *    FNCT p. 3), so a yard a little past the radius is still inside the flora;
 *    the warning says the radius is ours so the owner can weigh it.
 *
 * A failed ecoregion lookup does not make a yard "outside": the verdict is
 * then 'unknown' unless the radius alone already rules it out.
 *
 * Pure: no DOM, no fetch.
 */
import { KNOWN_ECOREGIONS } from '../data/ecoregionInput.js';

/** Great-circle miles; the same formula as tools/geoShared.mjs, kept here so src/ imports nothing from tools/. */
function haversineMi(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Downtown Dallas: the same reference point tools/ecoregionLookup.mjs was
 * live-tested against (it returns Level I 9 there).
 */
export const COVERED_CENTER = Object.freeze({ lat: 32.7767, lng: -96.797, label: 'Dallas' });

/** Judgement (ours, not a sourced boundary): see the header. */
export const COVERED_RADIUS_MI = 100;

/**
 * @param {{ lat: number, lng: number }} point
 * @param {{ code: string, name: string } | null | undefined} ecoregion  the
 *   lookup's answer; null when it found nothing or failed
 * @returns {{ status: 'covered'|'outside'|'unknown', distanceMi: number,
 *   radiusMi: number, center: string, ecoregion: { code: string, name: string, known: boolean } | null,
 *   message: string }}
 */
export function coveredRegionVerdict(point, ecoregion) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('coveredRegionVerdict needs finite lat and lng');
  }
  const distanceMi = Math.round(haversineMi(COVERED_CENTER.lat, COVERED_CENTER.lng, lat, lng));
  const withinRadius = distanceMi <= COVERED_RADIUS_MI;
  const eco = ecoregion?.code
    ? {
        code: String(ecoregion.code),
        name: String(ecoregion.name || ''),
        known: Object.prototype.hasOwnProperty.call(KNOWN_ECOREGIONS, String(ecoregion.code)),
      }
    : null;

  const radiusNote =
    `(${COVERED_RADIUS_MI} miles is our own cut-off for "around Dallas-Fort Worth", ` +
    'not a published boundary)';
  const ecoName = eco ? `${eco.name || 'ecoregion'} (EPA Level I ${eco.code})` : '';
  const knownNames = Object.entries(KNOWN_ECOREGIONS)
    .map(([code, name]) => `${name} (${code})`)
    .join(', ');

  let status;
  let message;
  if (eco && !eco.known) {
    status = 'outside';
    message =
      `This location is in the ${ecoName}, and this project's plant data covers only the ` +
      `${knownNames}, around Dallas-Fort Worth. Nearby sightings will still be shown, but the ` +
      'plant lists and keystone-genus checks were written for the Blackland Prairie and Cross ' +
      'Timbers and may not fit this yard.';
  } else if (!withinRadius) {
    status = 'outside';
    message =
      `This location is about ${distanceMi} miles from ${COVERED_CENTER.label}, farther than the ` +
      `${COVERED_RADIUS_MI} miles this project's plant data is drawn from ${radiusNote}. Nearby ` +
      'sightings will still be shown, but the plant lists, nurseries and plant sales are for the ' +
      'Blackland Prairie and Cross Timbers around Dallas-Fort Worth.';
  } else if (!eco) {
    status = 'unknown';
    message =
      `This location is about ${distanceMi} miles from ${COVERED_CENTER.label}, inside our ` +
      `${COVERED_RADIUS_MI}-mile cut-off, but its ecoregion could not be looked up just now, so ` +
      'whether the plant data fits it is unchecked.';
  } else {
    status = 'covered';
    message =
      `In the ${ecoName}, about ${distanceMi} miles from ${COVERED_CENTER.label}: inside the region ` +
      `this project's plant data covers ${radiusNote}.`;
  }
  return { status, distanceMi, radiusMi: COVERED_RADIUS_MI, center: COVERED_CENTER.label, ecoregion: eco, message };
}
