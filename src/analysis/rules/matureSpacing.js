import { STATUSES } from '../ecology.js';
import { getSpeciesKey } from '../../utils/speciesKey.js';

/**
 * Rule 12 — the opposite mistake from rule 9's drifts. A same-species pair
 * planted closer than their combined mature width is what rule 9 rewards: it
 * grows into one clump, not a collision. This rule instead flags two
 * DIFFERENT species planted so close their mature canopies will collide —
 * always a problem, since one will end up shading or crowding out the other
 * whatever layer either sits in.
 *
 * Mirrors keystoneGenera.js's footprint-area reasoning exactly: `plant.width`
 * is already defaulted to 1 ft for anything with a blank width_ft
 * (createPlantFromSpecies), and treating that fabricated number as real
 * mature size here would silently invent or hide a collision. Every pair is
 * checked against the DECLARED width_ft from `ctx.species`, and a pair where
 * either side has none is excluded and counted, not defaulted — the same
 * choice drifts.js makes in the opposite direction, on purpose, for the
 * opposite reason (see the comment there).
 */
const MILD_MAX = 0.25; // overlap/combinedRadius below this reads as mild
const REAL_MAX = 0.75; // below this is a real crowd; at or above is a near-total collision
const MAX_FINDINGS = 5;

export default {
  id: 'mature-spacing',
  title: 'Mature-size spacing',

  evaluate(ctx) {
    if (ctx.plants.length < 2) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: 'Fewer than two plants placed, so there is nothing to check spacing against.',
      };
    }

    const declaredWidth = (plant) => {
      const entry = ctx.species.find((row) => getSpeciesKey(row) === getSpeciesKey(plant));
      const width = Number(entry?.width);
      return width > 0 ? width : null;
    };

    const plants = ctx.plants;
    const overlaps = [];
    let checked = 0;
    let excluded = 0;

    for (let i = 0; i < plants.length; i += 1) {
      for (let j = i + 1; j < plants.length; j += 1) {
        const a = plants[i];
        const b = plants[j];
        if (getSpeciesKey(a) === getSpeciesKey(b)) continue; // same species: rule 9's territory, not this rule's
        const widthA = declaredWidth(a);
        const widthB = declaredWidth(b);
        if (widthA === null || widthB === null) {
          excluded += 1;
          continue;
        }
        checked += 1;
        const combinedRadius = (widthA + widthB) / 2;
        const dx = (a.x ?? 0) - (b.x ?? 0);
        const dy = (a.y ?? 0) - (b.y ?? 0);
        const distance = Math.sqrt(dx * dx + dy * dy);
        const overlap = combinedRadius - distance;
        if (overlap <= 0) continue;
        const ratio = overlap / combinedRadius;
        const severity = ratio >= REAL_MAX ? 'hard' : ratio >= MILD_MAX ? 'real' : 'mild';
        overlaps.push({ a, b, overlap, severity });
      }
    }

    if (checked === 0) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: excluded
          ? `No cross-species pair declares a mature width_ft, so spacing could not be checked (${excluded} pair${excluded === 1 ? '' : 's'} excluded).`
          : 'No two different species are placed together, so there is nothing to check spacing between.',
      };
    }

    const hard = overlaps.filter((o) => o.severity === 'hard');
    const status = hard.length ? STATUSES.GAP : overlaps.length ? STATUSES.PARTIAL : STATUSES.OK;

    const ranked = [...overlaps].sort((x, y) => y.overlap - x.overlap);
    const findings = overlaps.length
      ? []
      : ['No cross-species pair is planted closer than their combined mature width.'];
    findings.push(
      ...ranked
        .slice(0, MAX_FINDINGS)
        .map(
          (o) =>
            `${o.a.commonName} and ${o.b.commonName} are planted close enough that their mature canopies overlap by about ${round(o.overlap)} ft (${o.severity}).`
        )
    );
    if (overlaps.length > MAX_FINDINGS) {
      const rest = overlaps.length - MAX_FINDINGS;
      findings.push(`${rest} more overlapping pair${rest === 1 ? '' : 's'} not shown.`);
    }
    if (excluded) {
      findings.push(
        `${excluded} cross-species pair${excluded === 1 ? '' : 's'} could not be checked — one or both species declare no width_ft.`
      );
    }

    const summary = hard.length
      ? `${hard.length} pair${hard.length === 1 ? '' : 's'} of different species will badly crowd each other at maturity.`
      : overlaps.length
        ? `${overlaps.length} pair${overlaps.length === 1 ? '' : 's'} of different species sit closer than their combined mature width.`
        : 'No different-species pair is planted closer than their mature canopies allow.';

    return { status, summary, findings, suggestions: [] };
  },
};

function round(n) {
  return Math.round(n * 10) / 10;
}
