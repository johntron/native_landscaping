import { parseCsv } from './csvLoader.js';
import { classifyPlantLayer } from '../state/layers.js';

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
 * @param {string} csvText
 */
export function parseSpeciesCsv(csvText) {
  const rows = parseCsv(csvText);
  return rows.map((row, idx) => {
    const botanicalName = row.botanical_name || row.botanicalName || '';
    const normalizedBotanicalName = normalizeBotanicalName(botanicalName);
  const speciesEpithet = (row.species_epithet || deriveSpeciesEpithet(botanicalName) || '').toLowerCase();
  const baseLeaf = row.leafColor || row.foliage_color_summer || DEFAULT_LEAF_COLOR;
  const flowerCountHint = pickNumber(row, ['flower_count_hint', 'flowerCountHint']);
  const flowerZone = normalizeFlowerZone(row.flower_zone || row.flowerZone);
  const inflorescence = normalizeInflorescence(row.inflorescence || row.inflorescence_type || row.inflorescenceType);
  const fruitLoad = normalizeFruitLoad(row.fruit_load || row.fruitLoad);
  const id = row.id || normalizedBotanicalName || speciesEpithet || `species-${idx + 1}`;
  const commonName = row.common_name || row.name || id;

    return {
      id,
      speciesEpithet,
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
 * Parse the yard layout CSV that references species by epithet.
 * @param {string} csvText
 */
export function parsePlantLayoutCsv(csvText) {
  const rows = parseCsv(csvText);
  const placements = rows.map((row, idx) => ({
    id: row.id || row.name || `plant-${idx + 1}`,
    botanicalKey: normalizeBotanicalName(row.botanical_name || row.botanicalName || ''),
    speciesEpithet: (row.species_epithet || row.species || '').toLowerCase(),
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

/** {byEpithet, byBotanical} lookup maps, shared by every placement-to-species join below. */
function indexSpeciesForLookup(species) {
  const byEpithet = new Map();
  const byBotanical = new Map();
  species.forEach((entry) => {
    if (entry.speciesEpithet) byEpithet.set(entry.speciesEpithet, entry);
    if (entry.botanicalKey) byBotanical.set(entry.botanicalKey, entry);
  });
  return { byEpithet, byBotanical };
}

function lookupSpeciesEntry({ byEpithet, byBotanical }, { botanicalKey, speciesEpithet }) {
  return (
    (botanicalKey ? byBotanical.get(botanicalKey) : null) ||
    (speciesEpithet ? byEpithet.get(speciesEpithet) : null) ||
    null
  );
}

/**
 * Merge species data with per-plant layout rows into renderable plant instances.
 * @param {string} speciesCsvText
 * @param {string} layoutCsvText
 */
export function buildPlantsFromCsv(speciesCsvText, layoutCsvText) {
  const species = parseSpeciesCsv(speciesCsvText);
  const layout = parsePlantLayoutCsv(layoutCsvText);
  const index = indexSpeciesForLookup(species);

  return layout.map((placement, idx) => {
    const botanicalKey = placement.botanicalKey || (placement.speciesEpithet ? null : '');
    if (!botanicalKey && !placement.speciesEpithet) {
      throw new LayoutDataError(`Layout row ${placement.id} is missing botanical_name`);
    }

    const speciesEntry = lookupSpeciesEntry(index, { botanicalKey, speciesEpithet: placement.speciesEpithet });

    if (!speciesEntry) {
      const missing = botanicalKey || placement.speciesEpithet || 'unknown';
      throw new LayoutDataError(`Unknown plant "${missing}" in layout row ${placement.id}`);
    }

    return createPlantFromSpecies(speciesEntry, {
      id: placement.id || `plant-${idx + 1}`,
      x: placement.x,
      y: placement.y,
      botanicalKey: placement.botanicalKey,
      speciesEpithet: placement.speciesEpithet,
    });
  });
}

/**
 * Re-derive a plant list's ATTRIBUTES from the current species catalog, keeping only
 * each plant's identity and position (id, botanical key/epithet, x, y).
 *
 * Layout history and the server's saved history entries hold full plant objects —
 * attributes included — because that is the simplest thing to snapshot for undo/redo.
 * But `plants.csv` is supposed to be the single source of truth for species
 * attributes (see AGENTS.md), and a history entry is a snapshot from whenever it was
 * recorded: restoring one verbatim after the catalog has since been corrected quietly
 * un-corrects it, and a plant placed months ago never picks up a catalog fix at all
 * until something else moves it. History should only ever answer "where were things",
 * never "what did the catalog say" — so every plant list this app is about to show
 * (on boot, and after undo/redo) goes through here first.
 *
 * A plant whose species has since been removed from the catalog is left exactly as
 * it was in the snapshot rather than dropped — better a stale plant than a vanished
 * one, and its old attributes are the only ones left to draw it with.
 *
 * @param {Array<object>} plants plant objects (from history, possibly stale)
 * @param {Array<object>} species fresh rows from parseSpeciesCsv
 */
export function rehydratePlants(plants, species) {
  if (!Array.isArray(plants) || !plants.length) return plants || [];
  const index = indexSpeciesForLookup(species);

  return plants.map((plant) => {
    const speciesEntry = lookupSpeciesEntry(index, {
      botanicalKey: plant.botanicalKey || normalizeBotanicalName(plant.botanicalName),
      speciesEpithet: plant.speciesEpithet,
    });
    if (!speciesEntry) return plant;

    return createPlantFromSpecies(speciesEntry, {
      id: plant.id,
      x: plant.x,
      y: plant.y,
      botanicalKey: plant.botanicalKey,
      speciesEpithet: plant.speciesEpithet,
    });
  });
}

/**
 * Build one renderable plant from a species row plus a placement. Every plant
 * the app holds — whether it came from planting_layout.csv or was added in the
 * browser — is minted here, so the two can never drift into different shapes.
 *
 * @param {Object} speciesEntry a row from parseSpeciesCsv
 * @param {{id: string, x: number, y: number, botanicalKey?: string, speciesEpithet?: string}} placement
 * @returns {Object} plant, including its computed layer
 */
export function createPlantFromSpecies(speciesEntry, placement = {}) {
  const plant = {
    id: placement.id,
    commonName: speciesEntry.commonName,
    botanicalName: speciesEntry.botanicalName,
    botanicalKey: speciesEntry.botanicalKey || placement.botanicalKey,
    speciesEpithet: speciesEntry.speciesEpithet || placement.speciesEpithet,
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
  if (v === 'sparse' || v === 'light') return 'sparse';
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

function deriveSpeciesEpithet(botanicalName) {
  if (!botanicalName) return '';
  const parts = botanicalName.trim().split(/\s+/);
  return parts[parts.length - 1];
}

function normalizeBotanicalName(name) {
  return (name || '').trim().toLowerCase();
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
