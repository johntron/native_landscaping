import { STATUSES } from '../ecology.js';
import { PLANT_LAYERS, classifyPlantLayer } from '../../state/layers.js';

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
    const speciesPerLayer = new Map(PLANT_LAYERS.map((layer) => [layer, 0]));
    ctx.placedSpecies.forEach((entry) => {
      const layer = entry.layer || classifyPlantLayer(entry);
      if (speciesPerLayer.has(layer)) speciesPerLayer.set(layer, speciesPerLayer.get(layer) + 1);
    });

    const empty = PLANT_LAYERS.filter((layer) => !speciesPerLayer.get(layer));
    const findings = PLANT_LAYERS.map(
      (layer) =>
        `${LAYER_LABELS[layer]}: ${speciesPerLayer.get(layer)} species${
          speciesPerLayer.get(layer) ? '' : ' — nothing occupies this layer'
        }`
    );

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
