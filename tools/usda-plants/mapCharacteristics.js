import { parseSeasonPhrase, parseSeasonRange } from "./seasonMonths.js";
import { colorNameToHex } from "./colorNames.js";

// plants.csv's header, in order — see AGENTS.md "Plant Data (CSV)".
export const PLANTS_CSV_COLUMNS = [
  "id",
  "common_name",
  "botanical_name",
  "growth_shape",
  "growing_season_months",
  "flowering_season_months",
  "flower_color",
  "foliage_color_spring",
  "foliage_color_summer",
  "foliage_color_fall",
  "foliage_color_winter",
  "sun_pref",
  "water_pref",
  "soil_pref",
  "width_ft",
  "height_ft",
  "inflorescence",
  "flower_count_hint",
  "flower_zone",
  "fruit_color",
  "fruit_season_months",
  "fruit_load",
];

// Extra columns carrying the raw USDA source values through to the
// intermediate CSV. These are what the LLM augmentation pass (or a human)
// should read to fill in the plants.csv columns this script can't derive
// deterministically — width_ft, per-season foliage colors, inflorescence,
// flower_count_hint, flower_zone — and to sanity-check the ones it can.
export const USDA_RAW_COLUMNS = [
  "usda_symbol",
  "usda_scientific_name_full",
  "usda_growth_habit",
  "usda_native_status",
  "usda_growth_form",
  "usda_shape_and_orientation",
  "usda_foliage_texture",
  "usda_foliage_porosity_summer",
  "usda_foliage_porosity_winter",
  "usda_leaf_retention",
  "usda_flower_conspicuous",
  "usda_fruit_conspicuous",
  "usda_fall_conspicuous",
  "usda_bloom_period",
  "usda_active_growth_period",
  "usda_fruit_seed_period_begin",
  "usda_fruit_seed_period_end",
  "usda_height_mature_ft",
  "usda_shade_tolerance",
  "usda_drought_tolerance",
  "usda_moisture_use",
  "usda_soil_coarse",
  "usda_soil_medium",
  "usda_soil_fine",
  "usda_ph_min",
  "usda_ph_max",
];

export const INTERMEDIATE_CSV_COLUMNS = [...PLANTS_CSV_COLUMNS, ...USDA_RAW_COLUMNS];

function stripHtml(s) {
  return s ? s.replace(/<[^>]+>/g, "").trim() : s;
}

function toSlug(commonName, scientificName) {
  const base = (commonName || scientificName || "").toLowerCase();
  return base
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const SHADE_TOLERANCE_TO_SUN_PREF = {
  intolerant: "full-sun",
  intermediate: "part-sun",
  tolerant: "shade",
};

const WATER_LEVEL = { low: "low", medium: "medium", high: "high" };

const FRUIT_ABUNDANCE_TO_LOAD = { low: "light", medium: "moderate", high: "heavy" };

// Best-effort default; the LLM/human pass should override using
// usda_growth_form + usda_shape_and_orientation for anything unusual.
const GROWTH_HABIT_TO_SHAPE = {
  tree: "tree",
  shrub: "vase",
  subshrub: "mound",
  "forb/herb": "mound",
  graminoid: "grass",
  vine: "low-climber",
};

function characteristicMap(characteristics) {
  const map = new Map();
  for (const c of characteristics) {
    map.set(c.PlantCharacteristicName, c.PlantCharacteristicValue);
  }
  return map;
}

function soilPref({ coarse, medium, fine }) {
  const parts = [];
  if (coarse === "Yes") parts.push("sandy");
  if (medium === "Yes") parts.push("loamy");
  if (fine === "Yes") parts.push("clay");
  return parts.join(",") || null;
}

// profile: result of UsdaClient#getCharacteristics's sibling PlantProfile call
// (Symbol, ScientificName, CommonName, GrowthHabits, NativeStatuses).
// characteristics: raw array from UsdaClient#getCharacteristics.
export function mapPlantToIntermediateRow(profile, characteristics) {
  const c = characteristicMap(characteristics);
  const scientificName = stripHtml(profile.ScientificName);
  const commonName = profile.CommonName || null;
  const growthHabit = (profile.GrowthHabits || [])[0] || null;
  const shadeTolerance = c.get("Shade Tolerance");

  const row = {
    id: toSlug(commonName, scientificName),
    common_name: commonName,
    botanical_name: scientificName,
    growth_shape: growthHabit ? GROWTH_HABIT_TO_SHAPE[growthHabit.toLowerCase()] || null : null,
    growing_season_months: parseSeasonPhrase(c.get("Active Growth Period")),
    flowering_season_months: parseSeasonPhrase(c.get("Bloom Period")),
    flower_color: colorNameToHex(c.get("Flower Color")),
    foliage_color_spring: null,
    foliage_color_summer: colorNameToHex(c.get("Foliage Color")),
    foliage_color_fall: null,
    foliage_color_winter: null,
    sun_pref: shadeTolerance
      ? SHADE_TOLERANCE_TO_SUN_PREF[shadeTolerance.toLowerCase()] || null
      : null,
    water_pref: (() => {
      const v = c.get("Moisture Use") || c.get("Drought Tolerance");
      return v ? WATER_LEVEL[v.toLowerCase()] || null : null;
    })(),
    soil_pref: soilPref({
      coarse: c.get("Adapted to Coarse Textured Soils"),
      medium: c.get("Adapted to Medium Textured Soils"),
      fine: c.get("Adapted to Fine Textured Soils"),
    }),
    width_ft: null,
    height_ft: (() => {
      const v = c.get("Height, Mature (feet)");
      return v ? Number(v) || null : null;
    })(),
    inflorescence: null,
    flower_count_hint: null,
    flower_zone: null,
    fruit_color: colorNameToHex(c.get("Fruit/Seed Color")),
    fruit_season_months: parseSeasonRange(
      c.get("Fruit/Seed Period Begin"),
      c.get("Fruit/Seed Period End"),
    ),
    fruit_load: (() => {
      const v = c.get("Fruit/Seed Abundance");
      return v ? FRUIT_ABUNDANCE_TO_LOAD[v.toLowerCase()] || null : null;
    })(),

    usda_symbol: profile.Symbol,
    usda_scientific_name_full: scientificName,
    usda_growth_habit: growthHabit,
    usda_native_status: (profile.NativeStatuses || [])
      .map((s) => `${s.Region}:${s.Status}`)
      .join("|"),
    usda_growth_form: c.get("Growth Form"),
    usda_shape_and_orientation: c.get("Shape and Orientation"),
    usda_foliage_texture: c.get("Foliage Texture"),
    usda_foliage_porosity_summer: c.get("Foliage Porosity Summer"),
    usda_foliage_porosity_winter: c.get("Foliage Porosity Winter"),
    usda_leaf_retention: c.get("Leaf Retention"),
    usda_flower_conspicuous: c.get("Flower Conspicuous"),
    usda_fruit_conspicuous: c.get("Fruit/Seed Conspicuous"),
    usda_fall_conspicuous: c.get("Fall Conspicuous"),
    usda_bloom_period: c.get("Bloom Period"),
    usda_active_growth_period: c.get("Active Growth Period"),
    usda_fruit_seed_period_begin: c.get("Fruit/Seed Period Begin"),
    usda_fruit_seed_period_end: c.get("Fruit/Seed Period End"),
    usda_height_mature_ft: c.get("Height, Mature (feet)"),
    usda_shade_tolerance: c.get("Shade Tolerance"),
    usda_drought_tolerance: c.get("Drought Tolerance"),
    usda_moisture_use: c.get("Moisture Use"),
    usda_soil_coarse: c.get("Adapted to Coarse Textured Soils"),
    usda_soil_medium: c.get("Adapted to Medium Textured Soils"),
    usda_soil_fine: c.get("Adapted to Fine Textured Soils"),
    usda_ph_min: c.get("pH, Minimum"),
    usda_ph_max: c.get("pH, Maximum"),
  };
  return row;
}
