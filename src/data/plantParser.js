import { parseCsv } from './csvLoader.js';

const DEFAULT_LEAF_COLOR = '#6b8e23';

const numberFieldAliases = {
  x: ['x_ft', 'x'],
  y: ['y_ft', 'y'],
  width: ['width_ft', 'width'],
  height: ['height_ft', 'height'],
};

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
    };
  });
}

/**
 * Parse the yard layout CSV that references species by epithet.
 * @param {string} csvText
 */
export function parsePlantLayoutCsv(csvText) {
  const rows = parseCsv(csvText);
  return rows.map((row, idx) => ({
    id: row.id || row.name || `plant-${idx + 1}`,
    botanicalKey: normalizeBotanicalName(row.botanical_name || row.botanicalName || ''),
    speciesEpithet: (row.species_epithet || row.species || '').toLowerCase(),
    x: pickNumber(row, numberFieldAliases.x) ?? 0,
    y: pickNumber(row, numberFieldAliases.y) ?? 0,
    width: pickNumber(row, numberFieldAliases.width),
    height: pickNumber(row, numberFieldAliases.height),
    growthShapeOverride: row.growth_shape || row.shape
      ? normalizeGrowthShape(row.growth_shape || row.shape)
      : null,
  }));
}

/**
 * Merge species data with per-plant layout rows into renderable plant instances.
 * @param {string} speciesCsvText
 * @param {string} layoutCsvText
 */
export function buildPlantsFromCsv(speciesCsvText, layoutCsvText) {
  const species = parseSpeciesCsv(speciesCsvText);
  const layout = parsePlantLayoutCsv(layoutCsvText);

  const speciesByEpithet = new Map();
  const speciesByBotanical = new Map();
  species.forEach((entry) => {
    if (entry.speciesEpithet) speciesByEpithet.set(entry.speciesEpithet, entry);
    if (entry.botanicalKey) speciesByBotanical.set(entry.botanicalKey, entry);
  });

  return layout.map((placement, idx) => {
    const botanicalKey = placement.botanicalKey || (placement.speciesEpithet ? null : '');
    if (!botanicalKey && !placement.speciesEpithet) {
      throw new Error(`Layout row ${placement.id} is missing botanical_name`);
    }

    const speciesEntry =
      (botanicalKey ? speciesByBotanical.get(botanicalKey) : null) ||
      (placement.speciesEpithet ? speciesByEpithet.get(placement.speciesEpithet) : null);

    if (!speciesEntry) {
      const missing = botanicalKey || placement.speciesEpithet || 'unknown';
      throw new Error(`Unknown plant "${missing}" in layout row ${placement.id}`);
    }

    const width = placement.width ?? speciesEntry.width ?? 1;
    const height = placement.height ?? speciesEntry.height ?? 1;
    const growthShape = placement.growthShapeOverride || speciesEntry.growthShape;

    return {
      id: placement.id || `plant-${idx + 1}`,
      commonName: speciesEntry.commonName,
      botanicalName: speciesEntry.botanicalName,
      x: placement.x,
      y: placement.y,
      width,
      height,
      growthShape,
      growingMonths: speciesEntry.growingMonths,
      floweringMonths: speciesEntry.floweringMonths,
      flowerColor: speciesEntry.flowerColor,
      leafColor: speciesEntry.leafColor,
      foliageColors: speciesEntry.foliageColors,
      dormantColor: speciesEntry.dormantColor,
      sunPref: speciesEntry.sunPref,
      waterPref: speciesEntry.waterPref,
      soilPref: speciesEntry.soilPref,
    };
  });
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
    tree: 'vertical',
    bush: 'mound',
    shrub: 'mound',
    flower: 'mound',
    groundcover: 'creeping',
    succulent: 'vertical',
  };
  return aliases[v] || v;
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
