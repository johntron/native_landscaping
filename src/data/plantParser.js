import { parseCsv } from './csvLoader.js';

const numberFieldAliases = {
  x: ['x_ft', 'x'],
  y: ['y_ft', 'y'],
  width: ['width_ft', 'width'],
  height: ['height_ft', 'height'],
};

const DEFAULT_LEAF_COLOR = '#6b8e23';

/**
 * Convert CSV text into a normalised list of plant objects ready for state calculations.
 * The parser tolerates both the original column names and the newer AGENTS.md schema.
 * @param {string} csvText
 */
export function parsePlantsFromCsv(csvText) {
  const rows = parseCsv(csvText);
  return rows.map((row, idx) => {
    const baseLeaf = row.leafColor || row.foliage_color_summer || DEFAULT_LEAF_COLOR;
    const id = row.id || row.name || `plant-${idx + 1}`;
    const commonName = row.common_name || row.name || id;

    return {
      id,
      commonName,
      botanicalName: row.botanical_name || row.botanicalName || '',
      x: pickNumber(row, numberFieldAliases.x) ?? 0,
      y: pickNumber(row, numberFieldAliases.y) ?? 0,
      width: pickNumber(row, numberFieldAliases.width) ?? 1,
      height: pickNumber(row, numberFieldAliases.height) ?? 1,
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
