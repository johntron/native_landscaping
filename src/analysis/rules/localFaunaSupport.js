import { STATUSES } from '../ecology.js';
import { getGenus } from '../../utils/speciesKey.js';
import { matchesForGenus } from '../faunaMatches.js';

/**
 * Which animals ALREADY reported near this site would plausibly use the
 * planted genera — a check the other six dimensions cannot make, because they
 * grade against ecoregion-wide lists (host-genera.csv) rather than what is
 * actually confirmed present at this address.
 *
 * **No score, no ranking of plants.** Matches are presence + distance band,
 * not a likelihood a reader could be misled into treating as precise — see
 * src/analysis/faunaMatches.js. And no recommender lives here: the catalog's
 * keystone genera (rule keystone-genera) are already the reusable answer to
 * "what would help", so this rule points at that rather than re-deriving its
 * own suggestion list.
 */
const AMPLE_COUNT = 8;
const SOME_COUNT = 1;

export default {
  id: 'local-fauna-support',
  title: 'Local fauna support',

  evaluate(ctx) {
    // The yard's own nearby-fauna rows (nl-3s5.31), not a place label's: none
    // means no location is set yet, the list is still being fetched, or it did
    // not load. The page says which; this rule only says it could not run.
    if (!ctx.nearbyFauna.size) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary:
          'No animals are recorded near this yard yet (it has no location set, its nearby-wildlife list is still being fetched, or the list did not load), so this check could not run.',
      };
    }
    if (!ctx.interactions.size) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: 'The plant-animal interaction table did not load, so this check could not run.',
      };
    }
    if (!ctx.plants.length) {
      return { status: STATUSES.NOT_DECLARED, summary: 'Nothing is planted yet.' };
    }

    const byGenus = [...ctx.placedGenera]
      .map((genus) => ({
        genus,
        matches: matchesForGenus(genus, {
          interactions: ctx.interactions,
          nearbyFauna: ctx.nearbyFauna,
        }).filter((match) => match.inRange !== false),
      }))
      .filter(({ matches }) => matches.length);

    const distinctAnimals = new Set();
    const iconicTaxa = new Set();
    let pollinatorCount = 0;
    byGenus.forEach(({ matches }) => {
      matches.forEach((match) => {
        distinctAnimals.add(match.animalSpecies);
        iconicTaxa.add(match.iconicTaxon);
        if (match.category === 'pollinator') pollinatorCount += 1;
      });
    });

    const findings = byGenus
      .slice()
      .sort((a, b) => b.matches.length - a.matches.length)
      .slice(0, 6)
      .map(({ genus, matches }) => {
        const named = matches
          .slice(0, 3)
          .map((m) => m.animalCommon || m.animalSpecies)
          .join(', ');
        return `${genus}: ${matches.length} nearby species reported using it (e.g. ${named}), within their expected range.`;
      });
    if (!byGenus.length) {
      findings.push(
        'No planted genus has a documented interaction with an animal species reported near this site.'
      );
    } else {
      findings.push(
        `${distinctAnimals.size} distinct animal species across ${iconicTaxa.size} taxonomic group${iconicTaxa.size === 1 ? '' : 's'} match, ${pollinatorCount} of those matches through flower visitation.`
      );
    }

    const status =
      distinctAnimals.size >= AMPLE_COUNT
        ? STATUSES.OK
        : distinctAnimals.size >= SOME_COUNT
          ? STATUSES.PARTIAL
          : STATUSES.GAP;
    const summary = !distinctAnimals.size
      ? 'Nothing planted here matches an animal species already confirmed nearby.'
      : `${distinctAnimals.size} animal species already reported near this yard have a documented use for something planted here.`;

    return {
      status,
      summary,
      findings,
      suggestions: distinctAnimals.size < AMPLE_COUNT ? suggest(ctx, byGenus) : [],
    };
  },
};

/**
 * Reuse the keystone-genera check rather than re-deriving a recommendation:
 * the catalog's keystone genera are the reliable, already-computed answer to
 * "what would grow the number of local animals served", and this rule's own
 * per-species matches are too dependent on what iNaturalist happened to have
 * observations for to rank catalog species against each other.
 */
function suggest(ctx, byGenus) {
  const covered = new Set(byGenus.map(({ genus }) => genus));
  const uncoveredUnplaced = ctx.unplacedSpecies.filter((entry) => !covered.has(getGenus(entry))).length;
  const note =
    uncoveredUnplaced > 0
      ? ` ${uncoveredUnplaced} unplanted catalog species bring a genus not yet matched here.`
      : '';
  return [
    `See the "Keystone genera" check below — planting more of this ecoregion's keystone genera is the most reliable way to grow the number of local animals this yard can support.${note}`,
  ];
}
