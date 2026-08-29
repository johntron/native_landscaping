// Source probe (nl-41o.9, phase 1 of nl-41o.8's introspection surface).
//
// Scope, deliberately small per the bead: probe a source for one species,
// return its RAW response (no normalization — a parse bug must stay
// distinguishable from a source gap, the nl-jsm.1 Alnus lesson — see
// docs/data-acquisition/03-document-corpus.md §6), and report
// which of a target-field list that response actually populated. No claim
// store, no writes to plants.csv or any committed file — read and report
// only.
//
// Extends tools/usda-plants rather than sitting beside it (epic decision,
// 2026-08-27): one probe vocabulary, not two overlapping MCP servers.

import { cached } from "./probeCache.js";

// Fields already known missing or in doubt, per nl-41o.1/02's findings —
// the starting sniff list the bead's notes name explicitly. Grows as new
// fields get named; not meant to be exhaustive on day one.
//
// `read(profile, charMap)` returns either the raw value found (or
// null/undefined), or — for a field with no single canonical characteristic
// name (mature_width) — `{ value, diagnostic }`, where `diagnostic` records
// what the scan actually checked. `populated` is always "did this source's
// response contain a non-empty value for this", never an inference: a note
// like "confirmed absent" must be backed by a scan over THIS response's own
// keys, not by three names guessed once and never re-checked.
const WIDTH_KEY_PATTERN = /width|spread|crown|diameter/i;

export const USDA_TARGET_FIELDS = [
  {
    key: "county_nativity",
    label: "County-level nativity",
    read: (profile) =>
      profile?.NativeStatuses?.length
        ? profile.NativeStatuses.map((s) => `${s.Region}:${s.Status}`).join("|")
        : null,
    note:
      "profile.NativeStatuses is REGIONAL (L48/AK/HI/PR/VI/CAN), never county — a " +
      "populated value here is NOT county nativity and must not be read as one. See " +
      "docs/data-acquisition/02-source-inventory.md §5.",
  },
  {
    key: "mature_width",
    label: "Mature width",
    read: (_profile, c) => {
      // Near-misses are reported, never auto-adopted as the value: "Seed
      // Spread Rate" and "Vegetative Spread Rate" both match /spread/ on a
      // real probed species (Quercus shumardii) and are propagation-rate
      // fields, not width — treating a regex hit as the answer would be
      // exactly the "invent nothing" violation this whole project exists to
      // avoid. A near-miss is a pointer for a human to go look, not a value.
      const exact = c.get("Width") ?? c.get("Width, Mature (feet)") ?? c.get("Crown Width") ?? null;
      const nearMisses = [...c.keys()].filter((k) => WIDTH_KEY_PATTERN.test(k));
      const diagnostic = exact
        ? `matched an exact width key`
        : nearMisses.length
          ? `no exact width key; ${nearMisses.length} key(s) matched /width|spread|crown|diameter/i and need a human look, NOT auto-adopted as width: ${nearMisses.join(", ")}`
          : `scanned ${c.size} characteristic key(s) in this response; none matched Width/Width, Mature (feet)/Crown Width or /width|spread|crown|diameter/i`;
      return { value: exact, diagnostic };
    },
    note: "No single canonical USDA key for this; see the per-probe diagnostic for what was actually scanned.",
  },
  {
    key: "soil_tolerance_coarse",
    label: "Soil tolerance: coarse-textured",
    read: (_profile, c) => c.get("Adapted to Coarse Textured Soils") ?? null,
  },
  {
    key: "soil_tolerance_medium",
    label: "Soil tolerance: medium-textured",
    read: (_profile, c) => c.get("Adapted to Medium Textured Soils") ?? null,
  },
  {
    key: "soil_tolerance_fine",
    label: "Soil tolerance: fine-textured",
    read: (_profile, c) => c.get("Adapted to Fine Textured Soils") ?? null,
  },
  {
    key: "light_tolerance",
    label: "Light/shade tolerance",
    read: (_profile, c) => c.get("Shade Tolerance") ?? null,
    note:
      "A single ordinal (an optimum), not a tolerance range — see mapCharacteristics.js's " +
      "documented Low/Medium/High-vs-Swagger-enum inversion before trusting this value's " +
      "direction for any new species class.",
  },
  {
    key: "water_tolerance_drought",
    label: "Water tolerance: drought",
    read: (_profile, c) => c.get("Drought Tolerance") ?? null,
  },
  {
    key: "water_tolerance_moisture",
    label: "Water tolerance: moisture use",
    read: (_profile, c) => c.get("Moisture Use") ?? null,
  },
  {
    key: "commercial_availability",
    label: "Commercial availability",
    read: (_profile, c) => c.get("Commercial Availability") ?? null,
  },
];

function toCharMap(characteristics) {
  const map = new Map();
  for (const c of characteristics) map.set(c.PlantCharacteristicName, c.PlantCharacteristicValue);
  return map;
}

export function sniffFields(targetFields, profile, characteristics) {
  const charMap = toCharMap(characteristics);
  return targetFields.map(({ key, label, read, note }) => {
    const result = read(profile, charMap);
    const isDiagnosticShape = result && typeof result === "object" && "value" in result;
    const value = (isDiagnosticShape ? result.value : result) ?? null;
    const diagnostic = isDiagnosticShape ? result.diagnostic : null;
    return {
      key,
      label,
      populated: value != null && value !== "",
      value,
      note,
      ...(diagnostic ? { diagnostic } : {}),
    };
  });
}

// Probes USDA for one plant id: raw profile + raw characteristics, cached
// per endpoint so repeated probes (the availability audit hits the same
// species across several sittings, per the bead) don't re-fetch. Returns the
// RAW responses untouched, plus the field sniff computed over them.
export async function probeUsda(client, cache, plantId, { force = false } = {}) {
  const profileResult = await cached(cache, "usda", "PlantProfile", plantId, () => client.getProfile(plantId), {
    force,
  });
  const characteristicsResult = await cached(
    cache,
    "usda",
    "PlantCharacteristics",
    plantId,
    () => client.getCharacteristics(plantId),
    { force },
  );

  const fieldSniff = sniffFields(USDA_TARGET_FIELDS, profileResult.raw, characteristicsResult.raw);

  return {
    source: "usda",
    plantId,
    // A response with zero characteristics (a taxon USDA never characterized
    // at all, e.g. a newer name whose data is filed under an older synonym's
    // id — measured for Symphyotrichum oblongifolium, id 40799) would
    // otherwise look identical to "has a record but lacks these fields" —
    // every fieldSniff entry reads populated:false either way. This count is
    // what tells the two apart without opening `raw`.
    characteristicsCount: characteristicsResult.raw.length,
    raw: {
      profile: profileResult.raw,
      characteristics: characteristicsResult.raw,
    },
    cached: {
      profile: profileResult.cached,
      characteristics: characteristicsResult.cached,
    },
    fetchedAt: {
      profile: profileResult.fetchedAt,
      characteristics: characteristicsResult.fetchedAt,
    },
    fieldSniff,
  };
}
