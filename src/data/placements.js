/**
 * A placement is where one plant of one species stands: `{ id, speciesId, x, y }`.
 * It is what a saved yard, a history entry and a layout POST carry (nl-3s5.19).
 * Everything else a displayed plant has (names, sizes, colours, months,
 * preferences, layer) belongs to the species and comes from plants.csv every
 * time, through createPlantFromSpecies(species, placement).
 *
 * Other fields on a placement are carried through untouched, so a later bead
 * can add per-plant facts (a lifecycle `status`, a `source`) without another
 * change to the (de)serialisers. What is stripped is a fixed list of species
 * attributes, SPECIES_ATTRIBUTE_KEYS; tests/placements.test.js fails if
 * createPlantFromSpecies grows a key that list does not name.
 *
 * One exception: an object with no `speciesId` is a legacy snapshot from before
 * nl-3s5.18 (or a stray test row) that nothing could resolve. It is kept
 * verbatim, never trimmed, because its botanical name is the only reference
 * left to it and its old attributes are the only ones left to draw it with.
 *
 * Pure: no DOM, no fetch. The server and the migration tool import it too.
 */
import { formatLayoutNumber } from './layoutExporter.js';

/** The fields every placement has. */
export const PLACEMENT_CORE_KEYS = Object.freeze(['id', 'speciesId', 'x', 'y']);

/**
 * Species attributes a full plant object carries and a placement never does:
 * everything createPlantFromSpecies copies from the species row, the computed
 * `layer`, and `speciesEpithet`, which pre-nl-3s5.18 snapshots still hold.
 */
export const SPECIES_ATTRIBUTE_KEYS = Object.freeze([
  'commonName',
  'botanicalName',
  'botanicalKey',
  'speciesEpithet',
  'width',
  'height',
  'growthShape',
  'growingMonths',
  'floweringMonths',
  'flowerColor',
  'leafColor',
  'foliageColors',
  'dormantColor',
  'sunPref',
  'waterPref',
  'soilPref',
  'inflorescence',
  'flowerCountHint',
  'flowerZone',
  'fruitColor',
  'fruitMonths',
  'fruitLoad',
  'layer',
]);

const STRIPPED = new Set([...PLACEMENT_CORE_KEYS, ...SPECIES_ATTRIBUTE_KEYS]);

/**
 * The optional per-plant fields a placement carries beyond its core: anything
 * that is neither core nor a species attribute (`status`, `source`, ...).
 * @param {object} source a placement or a full plant
 * @returns {object}
 */
export function placementExtras(source) {
  const extras = {};
  if (!source || typeof source !== 'object') return extras;
  Object.keys(source).forEach((key) => {
    if (!STRIPPED.has(key) && source[key] !== undefined) extras[key] = source[key];
  });
  return extras;
}

function cloneValue(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Reduce a plant (a full plant object, a legacy history snapshot, or a
 * placement already) to its placement. A copy: the input is never shared.
 * @param {object} plant
 * @returns {object} `{ id, speciesId, x, y, ...extras }`, or a verbatim copy
 *   of a legacy snapshot with no speciesId
 */
export function toPlacement(plant) {
  if (!plant || typeof plant !== 'object') return plant;
  if (!plant.speciesId) return cloneValue(plant);
  return {
    id: plant.id,
    speciesId: plant.speciesId,
    x: plant.x,
    y: plant.y,
    ...cloneValue(placementExtras(plant)),
  };
}

/**
 * @param {Array<object>} plants
 * @returns {Array<object>} placements; [] for anything that is not an array
 */
export function toPlacements(plants) {
  return Array.isArray(plants) ? plants.map(toPlacement) : [];
}

/**
 * A history entry with its plants reduced to placements. The entry's own
 * fields (id, timestamp, description, anything else) are kept, in order.
 * @param {object} entry
 */
export function toPlacementEntry(entry) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.plants)) return entry;
  return { ...entry, plants: toPlacements(entry.plants) };
}

/**
 * Whether two plant lists are the same layout as planting_layout.csv records
 * it: the same plants in the same order, each with the same id and speciesId,
 * at the same coordinates once written with the layout file's own number
 * format. This is exactly the comparison the old CSV-text match made
 * (buildLayoutCsv on both sides), without building the text. A list with a
 * plant lacking a speciesId never matches, since it has no layout row.
 * @param {Array<object>} a
 * @param {Array<object>} b
 */
export function sameLayout(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i];
    if (!left?.speciesId || !right?.speciesId) return false;
    return (
      String(left.id ?? '') === String(right.id ?? '') &&
      String(left.speciesId) === String(right.speciesId) &&
      formatLayoutNumber(left.x) === formatLayoutNumber(right.x) &&
      formatLayoutNumber(left.y) === formatLayoutNumber(right.y)
    );
  });
}
