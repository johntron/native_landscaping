import { parseCsv } from './csvLoader.js';
import { classifyPlantLayer } from '../state/layers.js';
import { buildSpeciesIndex, normalizeBotanicalName, resolveSpeciesRef } from './speciesResolver.js';
import { placementExtras } from './placements.js';

const DEFAULT_LEAF_COLOR = '#6b8e23';

/**
 * Raised when the CSV loads fine but its contents are invalid — a hand-edit
 * mistake the user can fix, as opposed to a fetch/serving failure. Callers use
 * this to show the real reason instead of generic "couldn't load" advice.
 */
export class LayoutDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LayoutDataError';
  }
}

const numberFieldAliases = {
  x: ['x_ft', 'x'],
  y: ['y_ft', 'y'],
  width: ['width_ft', 'width'],
  height: ['height_ft', 'height'],
};

/**
 * Median width/height ratio per growth_shape, computed once from every plants.csv
 * row that declares both — not recomputed live. Used only when a species declares
 * height but not width, so a newly added species still gets a shape-appropriate
 * footprint instead of a flat 1 ft circle. Re-derive by rerunning that computation
 * against the catalog if the mix of species shifts enough to be worth it.
 */
const WIDTH_HEIGHT_RATIO_BY_SHAPE = Object.freeze({
  'low-climber': 0.25, // tall and narrow — climbs rather than spreads
  vertical: 0.5,
  tree: 0.73,
  grass: 0.59,
  vase: 1,
  arch: 1.22,
  mound: 1.21,
  creeping: 7.5, // groundcovers spread far wider than they stand tall
});
const DEFAULT_WIDTH_HEIGHT_RATIO = 1;

/** Fallback for a species missing width_ft — see WIDTH_HEIGHT_RATIO_BY_SHAPE. */
function estimateWidthFt(heightFt, growthShape) {
  const ratio = WIDTH_HEIGHT_RATIO_BY_SHAPE[growthShape] ?? DEFAULT_WIDTH_HEIGHT_RATIO;
  return Math.round(heightFt * ratio * 10) / 10;
}

/**
 * Parse species-level data (no coordinates) from CSV.
 *
 * Every row must carry a unique `id`: it is the species key saved yards,
 * history, the rules and the exports reference (nl-3s5.18). A row without one
 * would be unreachable, and a repeated one would silently hand every yard that
 * names it the later row's attributes, so both are refused here.
 * @param {string} csvText
 */
export function parseSpeciesCsv(csvText) {
  const rows = parseCsv(csvText);
  const firstRowById = new Map();
  return rows.map((row, idx) => {
    const botanicalName = row.botanical_name || row.botanicalName || '';
    const normalizedBotanicalName = normalizeBotanicalName(botanicalName);
    const id = String(row.id || '').trim();
    if (!id) {
      throw new LayoutDataError(
        `plants.csv data row ${idx + 1} (${botanicalName || 'no botanical name'}) has no id; every species needs a unique id`
      );
    }
    const firstRow = firstRowById.get(id);
    if (firstRow !== undefined) {
      throw new LayoutDataError(`Duplicate species id "${id}" in plants.csv (data rows ${firstRow + 1} and ${idx + 1})`);
    }
    firstRowById.set(id, idx);

    const baseLeaf = row.leafColor || row.foliage_color_summer || DEFAULT_LEAF_COLOR;
    const flowerCountHint = pickNumber(row, ['flower_count_hint', 'flowerCountHint']);
    const flowerZone = normalizeFlowerZone(row.flower_zone || row.flowerZone);
    const inflorescence = normalizeInflorescence(row.inflorescence || row.inflorescence_type || row.inflorescenceType);
    const fruitLoad = normalizeFruitLoad(row.fruit_load || row.fruitLoad);
    const commonName = row.common_name || row.name || id;

    return {
      id,
      speciesId: id,
      taxonId: String(row.taxon_id || '').trim(),
      botanicalKey: normalizedBotanicalName,
      commonName,
      botanicalName,
      growthShape: normalizeGrowthShape(row.growth_shape || row.shape),
      growingMonths: parseMonthField(row.growing_season_months, row.growthStart, row.growthEnd),
      floweringMonths: parseMonthField(row.flowering_season_months, row.flowerStart, row.flowerEnd),
      flowerColor: row.flowerColor || row.flower_color || '#d95f5f',
      leafColor: baseLeaf,
      foliageColors: buildFoliagePalette(row, baseLeaf),
      dormantColor: row.dormant_color || null,
      sunPref: row.sun_pref || row.sunPref || '',
      waterPref: row.water_pref || row.waterPref || '',
      soilPref: row.soil_pref || row.soilPref || '',
      width: pickNumber(row, numberFieldAliases.width),
      height: pickNumber(row, numberFieldAliases.height),
      inflorescence,
      flowerCountHint,
      flowerZone,
      fruitColor: normalizeHexColor(row.fruit_color || row.fruitColor),
      fruitMonths: parseMonthField(row.fruit_season_months, row.fruitStart, row.fruitEnd),
      fruitLoad,
    };
  });
}

/**
 * Parse a yard's planting_layout.csv: `id,species_id,x_ft,y_ft`.
 *
 * `species_id` is plants.csv's `id`. A file in the pre-nl-3s5.18 shape
 * (`id,botanical_name,x_ft,y_ft`) still loads: its name goes through the
 * resolver (exact name, then the synonym table), never an epithet. The next
 * save rewrites it with species ids.
 * @param {string} csvText
 */
export function parsePlantLayoutCsv(csvText) {
  const rows = parseCsv(csvText);
  const placements = rows.map((row, idx) => ({
    id: row.id || row.name || `plant-${idx + 1}`,
    speciesId: String(row.species_id || row.speciesId || '').trim(),
    botanicalName: String(row.botanical_name || row.botanicalName || '').trim(),
    x: pickNumber(row, numberFieldAliases.x) ?? 0,
    y: pickNumber(row, numberFieldAliases.y) ?? 0,
  }));

  assertUniqueIds(placements);
  return placements;
}

/**
 * Ids address plants for dragging, cloning, and highlighting, so a repeat makes
 * every row after the first unreachable. Fail loudly instead of silently losing one.
 * @param {Array<{id: string}>} placements
 */
function assertUniqueIds(placements) {
  const firstRowById = new Map();
  placements.forEach((placement, idx) => {
    const id = String(placement.id);
    const firstRow = firstRowById.get(id);
    if (firstRow !== undefined) {
      throw new LayoutDataError(
        `Duplicate plant id "${id}" in layout (data rows ${firstRow + 1} and ${idx + 1}, excluding the header); ids must be unique`
      );
    }
    firstRowById.set(id, idx);
  });
}

/**
 * Merge species data with per-plant layout rows into renderable plant instances.
 * @param {string} speciesCsvText plants.csv
 * @param {string} layoutCsvText planting_layout.csv
 * @param {{synonyms?: Map<string, string>}} [options] synonyms from parseSynonymCsv,
 *   consulted only for a legacy row that names its species instead of giving its id
 */
export function buildPlantsFromCsv(speciesCsvText, layoutCsvText, { synonyms } = {}) {
  const species = parseSpeciesCsv(speciesCsvText);
  const layout = parsePlantLayoutCsv(layoutCsvText);
  const index = buildSpeciesIndex(species, synonyms);

  return layout.map((placement, idx) => {
    if (!placement.speciesId && !placement.botanicalName) {
      throw new LayoutDataError(`Layout row ${placement.id} is missing species_id`);
    }

    const resolved = resolveSpeciesRef(index, placement);
    if (!resolved) {
      const missing = placement.speciesId
        ? `species id "${placement.speciesId}"`
        : `plant "${placement.botanicalName}"`;
      throw new LayoutDataError(`Unknown ${missing} in layout row ${placement.id}`);
    }

    return createPlantFromSpecies(resolved.entry, {
      id: placement.id || `plant-${idx + 1}`,
      x: placement.x,
      y: placement.y,
    });
  });
}

/**
 * Build the plants to display from a list of placements: each one is
 * createPlantFromSpecies(species, placement), with the species found in the
 * catalog just parsed. This is how every plant list that comes out of history
 * (on boot, and after undo/redo) is shown, so an entry recorded before a
 * catalog correction shows the corrected values: history answers "where were
 * things", and plants.csv alone answers "what is this species like".
 *
 * The species is found by `speciesId`. A legacy snapshot from before species
 * ids (tools/migrate-species-ids.mjs adds them) falls back to its botanical
 * name, exactly or through the synonym table, never its epithet. A legacy
 * full-object snapshot works the same way; its stored attributes are ignored.
 *
 * A placement whose species cannot be found is returned exactly as it was
 * rather than dropped: better a stale plant than a vanished one. For a legacy
 * snapshot its old attributes are the only ones left to draw it with; a bare
 * placement whose species has left plants.csv has none (see the report on
 * nl-3s5.19).
 *
 * @param {Array<object>} placements placements (or legacy plant snapshots)
 * @param {Array<object>} species fresh rows from parseSpeciesCsv
 * @param {{synonyms?: Map<string, string>}} [options]
 */
export function plantsFromPlacements(placements, species, { synonyms } = {}) {
  if (!Array.isArray(placements) || !placements.length) return placements || [];
  const index = buildSpeciesIndex(species, synonyms);

  return placements.map((placement) => {
    const resolved = resolveSpeciesRef(index, {
      speciesId: placement.speciesId,
      botanicalName: placement.botanicalName || placement.botanicalKey,
    });
    if (!resolved) return placement;
    return createPlantFromSpecies(resolved.entry, placement);
  });
}

/**
 * Build one renderable plant from a species row plus a placement. Every plant
 * the app holds — whether it came from planting_layout.csv or was added in the
 * browser — is minted here, so the two can never drift into different shapes.
 *
 * The plant's `speciesId` comes from the species row and nothing else: it is
 * what buildLayoutCsv writes and what every later load resolves by.
 *
 * Optional per-plant fields on the placement (anything that is neither core
 * nor a species attribute, see src/data/placements.js) ride along on the plant,
 * so toPlacement(plant) gives the placement back. Species attributes on the
 * placement, as a legacy snapshot has, are overwritten by the catalog's.
 *
 * @param {Object} speciesEntry a row from parseSpeciesCsv
 * @param {{id: string, x: number, y: number}} placement
 * @returns {Object} plant, including its computed layer
 */
export function createPlantFromSpecies(speciesEntry, placement = {}) {
  const plant = {
    ...placementExtras(placement),
    id: placement.id,
    commonName: speciesEntry.commonName,
    botanicalName: speciesEntry.botanicalName,
    speciesId: speciesEntry.speciesId || null,
    botanicalKey: speciesEntry.botanicalKey || normalizeBotanicalName(speciesEntry.botanicalName),
    x: placement.x,
    y: placement.y,
    width: speciesEntry.width ?? estimateWidthFt(speciesEntry.height ?? 1, speciesEntry.growthShape),
    height: speciesEntry.height ?? 1,
    growthShape: speciesEntry.growthShape,
    growingMonths: speciesEntry.growingMonths,
    floweringMonths: speciesEntry.floweringMonths,
    flowerColor: speciesEntry.flowerColor,
    leafColor: speciesEntry.leafColor,
    foliageColors: speciesEntry.foliageColors,
    dormantColor: speciesEntry.dormantColor,
    sunPref: speciesEntry.sunPref,
    waterPref: speciesEntry.waterPref,
    soilPref: speciesEntry.soilPref,
    inflorescence: speciesEntry.inflorescence,
    flowerCountHint: speciesEntry.flowerCountHint,
    flowerZone: speciesEntry.flowerZone,
    fruitColor: speciesEntry.fruitColor,
    fruitMonths: speciesEntry.fruitMonths,
    fruitLoad: speciesEntry.fruitLoad,
  };

  return { ...plant, layer: classifyPlantLayer(plant) };
}

function pickNumber(row, keys) {
  for (const key of keys) {
    const val = row[key];
    const num = normaliseNumber(val);
    if (num !== null) return num;
  }
  return null;
}

function normaliseNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeGrowthShape(value) {
  const v = (value || '').toLowerCase();
  if (!v) return 'mound';
  const aliases = {
    bush: 'mound',
    shrub: 'mound',
    flower: 'mound',
    groundcover: 'creeping',
    succulent: 'vertical',
  };
  return aliases[v] || v;
}

function normalizeFruitLoad(value) {
  const v = (value || '').toLowerCase();
  if (v === 'none') return 'none';
  if (v === 'sparse' || v === 'light' || v === 'low') return 'sparse';
  if (v === 'moderate' || v === 'medium') return 'moderate';
  if (v === 'heavy' || v === 'abundant') return 'heavy';
  return '';
}

function normalizeHexColor(value) {
  const v = (value || '').trim();
  if (!v) return '';
  if (v === 'none') return '';
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
    return v.startsWith('#') ? v : `#${v}`;
  }
  return '';
}

function buildFoliagePalette(row, fallback) {
  return {
    spring: row.foliage_color_spring || fallback,
    summer: row.foliage_color_summer || fallback,
    fall: row.foliage_color_fall || fallback,
    winter: row.foliage_color_winter || fallback,
  };
}

function parseMonthField(monthListValue, startValue, endValue) {
  const months = new Set();

  if (monthListValue) {
    const parts = monthListValue.split(',').map((p) => p.trim()).filter(Boolean);
    parts.forEach((part) => addMonthSpec(part, months));
  }

  const start = normaliseNumber(startValue);
  const end = normaliseNumber(endValue);
  if (start !== null && end !== null) {
    addRange(start, end, months);
  }

  return Array.from(months);
}

function addMonthSpec(part, set) {
  if (part.includes('-')) {
    const [rawStart, rawEnd] = part.split('-');
    addRange(normaliseNumber(rawStart), normaliseNumber(rawEnd), set);
    return;
  }
  const month = normaliseNumber(part);
  if (month) set.add(clampMonth(month));
}

function addRange(start, end, set) {
  if (!start || !end) return;
  const s = clampMonth(start);
  const e = clampMonth(end);
  for (let i = 0; i < 12; i++) {
    const m = ((s - 1 + i) % 12) + 1;
    set.add(m);
    if (m === e) break;
  }
}

function clampMonth(month) {
  if (month < 1) return 1;
  if (month > 12) return 12;
  return month;
}

function normalizeFlowerZone(value) {
  const v = (value || '').toLowerCase();
  if (v === 'upper' || v === 'mid' || v === 'full') return v;
  return '';
}

function normalizeInflorescence(value) {
  const v = (value || '').toLowerCase();
  if (!v) return '';
  const aliases = {
    'umbel': 'umbel/head',
    'head': 'umbel/head',
    'umbel/head': 'umbel/head',
    'panicle': 'panicle/spray',
    'spray': 'panicle/spray',
    'panicle/spray': 'panicle/spray',
    'spike': 'spike/raceme',
    'raceme': 'spike/raceme',
    'spike/raceme': 'spike/raceme',
    'scatter': 'scatter',
  };
  return aliases[v] || v;
}
