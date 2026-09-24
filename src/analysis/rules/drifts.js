import { STATUSES } from '../ecology.js';
import { getSpeciesKey } from '../../utils/speciesKey.js';

/**
 * Rule 9 — plants read as a MASS, to the eye and to a foraging insect, only
 * when enough of the same species sit close enough to blur into one clump. A
 * yard that plants one of everything looks diverse on the species table and
 * reads as visual (and ecological) noise on the ground — nothing forms the
 * drift a pollinator or a passing eye actually cues in on.
 *
 * This is the exact failure the plan's own survey found waiting:
 * example-frontyard is 17 plants across 12 species with a largest
 * same-species clump of 3, against the 5-10+ plants per drift a habitat
 * planting wants; backyard concentrates properly (64 plants, largest clump
 * 19). The GAP/PARTIAL/OK thresholds below are that same 5/10 split.
 *
 * Unlike keystoneGenera's footprint-area math, this rule is about what the
 * DRAWING shows, not an ecological measurement — so it clusters on
 * `plant.width`, the same defaulted value the renderer draws every plant
 * with, rather than excluding plants with no declared width_ft the way
 * keystoneGenera.js and matureSpacing.js do. A defaulted 1 ft canopy is still
 * a real dot on the plan the eye reads as part of (or apart from) a clump.
 */
const CLUMP_RADIUS_FACTOR = 1.5; // "read as one mass" — 1.5x the combined canopy radius
const GAP_MAX = 5; // largest clump below this is essentially unmet
const PARTIAL_MAX = 10; // largest clump below this is a real but modest drift
const MIN_PLANTS_TO_JUDGE = 5;

export default {
  id: 'drifts',
  title: 'Drifts',

  evaluate(ctx) {
    if (ctx.plants.length < MIN_PLANTS_TO_JUDGE) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: `Only ${ctx.plants.length} plant${ctx.plants.length === 1 ? '' : 's'} placed — too few to judge whether the design uses drifts.`,
      };
    }

    const bySpecies = new Map();
    ctx.plants.forEach((plant) => {
      const key = getSpeciesKey(plant);
      if (!bySpecies.has(key)) bySpecies.set(key, []);
      bySpecies.get(key).push(plant);
    });

    const speciesClumps = [...bySpecies.values()].map((plants) => ({
      name: plants[0].commonName,
      count: plants.length,
      largestClump: largestClumpSize(plants),
    }));

    const largest = speciesClumps.reduce((max, s) => Math.max(max, s.largestClump), 0);
    const singles = speciesClumps.filter((s) => s.largestClump === 1);

    const status =
      largest < GAP_MAX ? STATUSES.GAP : largest < PARTIAL_MAX ? STATUSES.PARTIAL : STATUSES.OK;

    const ranked = [...speciesClumps].sort((a, b) => b.largestClump - a.largestClump);
    const top = ranked[0];
    const findings = [
      `Largest drift: ${top.name}, ${top.largestClump} plant${top.largestClump === 1 ? '' : 's'} clumped together.`,
      ...ranked
        .slice(1, 4)
        .filter((s) => s.largestClump > 1)
        .map((s) => `${s.name}: largest clump ${s.largestClump} of ${s.count} planted.`),
    ];
    if (singles.length > 1) {
      findings.push(
        `${singles.length} species are planted as isolated singles with no clump at all: ${singles
          .slice(0, 6)
          .map((s) => s.name)
          .join(', ')}${singles.length > 6 ? ', ...' : ''}.`
      );
    }

    const summary =
      status === STATUSES.OK
        ? `${top.name} forms a real drift of ${top.largestClump} plants — the design reads as a mass, not a collection.`
        : status === STATUSES.PARTIAL
          ? `${top.name}'s clump of ${top.largestClump} is a real drift, but on the thin side of the 5-10+ a habitat planting wants.`
          : `Nothing here clumps past ${largest} plant${largest === 1 ? '' : 's'} — the design reads as one-of-everything rather than drifts an insect or a passing eye can find.`;

    return { status, summary, findings, suggestions: [] };
  },
};

/** Union-find over one species' individuals, clustered by the 1.5x-radius rule above. */
function largestClumpSize(plants) {
  if (plants.length === 1) return 1;
  const parent = plants.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < plants.length; i += 1) {
    for (let j = i + 1; j < plants.length; j += 1) {
      const a = plants[i];
      const b = plants[j];
      const threshold = ((Number(a.width) || 0) / 2 + (Number(b.width) || 0) / 2) * CLUMP_RADIUS_FACTOR;
      const dx = (a.x ?? 0) - (b.x ?? 0);
      const dy = (a.y ?? 0) - (b.y ?? 0);
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= threshold) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }

  const sizes = new Map();
  plants.forEach((_, i) => {
    const root = find(i);
    sizes.set(root, (sizes.get(root) || 0) + 1);
  });
  return Math.max(...sizes.values());
}
