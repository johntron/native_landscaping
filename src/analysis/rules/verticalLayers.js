import { STATUSES } from '../ecology.js';
import { PLANT_LAYERS, classifyPlantLayer, classifyDeclaredLayer } from '../../state/layers.js';

/**
 * Rule 11 — a planting with structure at several heights shelters and feeds far
 * more than one flat sweep of the same stratum.
 *
 * Buckets come from classifyPlantLayer, which the renderer already uses to hide
 * upper strata. Re-bucketing by height here would let the analysis and the
 * drawing disagree about what a plant is.
 */
const LAYER_LABELS = {
  trees: 'canopy',
  sculptural: 'tall structure',
  accents: 'mid-height',
  groundcover: 'ground layer',
};

export default {
  id: 'vertical-layers',
  title: 'Vertical layers',

  evaluate(ctx) {
    if (!ctx.plants.length) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: 'Nothing is planted yet, so there are no layers to check.',
      };
    }

    // Counted by species, so one layer does not look full because a single
    // species was repeated across the bed nineteen times.
    //
    // entry.layer is precomputed at plant-creation time from a height that
    // defaults undeclared height to 1 ft (a rendering necessity — the drawing
    // needs a size for every plant). Grading on that fabricated bucket is
    // exactly nl-c58's failure mode, so this rule re-derives the layer from
    // the raw catalog row via classifyDeclaredLayer, which returns null rather
    // than guessing when neither shape nor height is genuinely declared.
    const speciesByKey = new Map(ctx.species.map((s) => [s.botanicalKey, s]));
    const speciesPerLayer = new Map(PLANT_LAYERS.map((layer) => [layer, 0]));
    let undeclaredCount = 0;
    ctx.placedSpecies.forEach((entry) => {
      // No fallback to `entry` itself on a lookup miss: `entry` is the plant
      // object, whose height/width are already fabricated defaults
      // (createPlantFromSpecies). Falling back to it would silently
      // reintroduce nl-c58 for any plant whose species row isn't in ctx.species.
      // classifyDeclaredLayer handles `undefined` correctly on its own.
      const declared = speciesByKey.get(entry.botanicalKey);
      const layer = classifyDeclaredLayer(declared);
      if (!layer) {
        undeclaredCount += 1;
        return;
      }
      if (speciesPerLayer.has(layer)) speciesPerLayer.set(layer, speciesPerLayer.get(layer) + 1);
    });

    const empty = PLANT_LAYERS.filter((layer) => !speciesPerLayer.get(layer));
    const findings = PLANT_LAYERS.map(
      (layer) =>
        `${LAYER_LABELS[layer]}: ${speciesPerLayer.get(layer)} species${
          speciesPerLayer.get(layer) ? '' : ' — nothing occupies this layer'
        }`
    );
    if (undeclaredCount) {
      findings.push(
        `${undeclaredCount} species declare${undeclaredCount === 1 ? 's' : ''} no height or shape, so ${
          undeclaredCount === 1 ? 'it is' : 'they are'
        } left out of the layer counts entirely rather than bucketed on a guess.`
      );
    }

    // If nothing placed could be classified, "4 layers empty" would describe an
    // empty yard — not the truth, which is that something is planted and this
    // rule simply has no size/shape data to bucket any of it. That is
    // not-declared, the same input-absent case every other rule uses it for.
    if (undeclaredCount && undeclaredCount === ctx.placedSpecies.length) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: 'No planted species declares a height or growth shape, so layers could not be checked.',
        findings,
      };
    }

    const status = empty.length >= 2 ? STATUSES.GAP : empty.length ? STATUSES.PARTIAL : STATUSES.OK;
    const summary = empty.length
      ? `${empty.map((layer) => LAYER_LABELS[layer]).join(' and ')} ${
          empty.length === 1 ? 'is' : 'are'
        } empty.`
      : 'All four layers are occupied, from ground layer to canopy.';

    return {
      status,
      summary,
      findings,
      suggestions: suggestForLayers(ctx, empty),
    };
  },
};

function suggestForLayers(ctx, emptyLayers, limit = 3) {
  if (!emptyLayers.length) return [];
  const wanted = new Set(emptyLayers);
  return ctx.unplacedSpecies
    .map((entry) => ({ entry, layer: classifyPlantLayer(entry) }))
    .filter(({ layer }) => wanted.has(layer))
    .sort((a, b) => (b.entry.height ?? 0) - (a.entry.height ?? 0))
    .slice(0, limit)
    .map(
      ({ entry, layer }) =>
        `${entry.commonName} (${entry.botanicalName}) would fill the ${LAYER_LABELS[layer]} at ${
          entry.height ?? '?'
        } ft.`
    );
}
