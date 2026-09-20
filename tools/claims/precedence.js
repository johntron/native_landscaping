// Per-field precedence rule (nl-scx.5), implementing
// docs/data-acquisition/09-conflict-resolution.md §1, §1.1.
//
// Precedence is a lookup against 02 §2's existing PRIMARY/CORROBORATING role
// per field, decided once per field — never computed per claim. No
// confidence-weighting, no "newest wins".

// Source name constants, matching what ingestion writes into claims.source.
export const SOURCE = {
  USDA_CHARACTERISTICS: 'usda-plants-characteristics',
  USDA_COUNTY: 'usda-plants-county',
  NPIN: 'npin',
  NWF_KEYSTONE: 'nwf-keystone',
  NCTX_FLORA: 'nctx-flora',
  MANUAL_CORRECTION: 'manual-correction',
  INATURALIST: 'inaturalist',
};

// A field absent here falls to DEFAULT_ORDER — 09 §1's first table row
// ("County distribution, the 81 characteristics ... | USDA PLANTS | —").
const DEFAULT_ORDER = [SOURCE.USDA_CHARACTERISTICS];

// 09 §1's table, restated as field -> ordered [primary, ...fallbacks].
const FIELD_ORDER = {
  county_presence_48113: [SOURCE.USDA_COUNTY],

  // NPIN primary for month-precision bloom, light-as-a-set, deer resistance,
  // species-level larval host, soil/water description; falls back to USDA's
  // coarser ordinal (09 §1 row 2). sun_pref is 08 §1.2's Passiflora lutea
  // correction, the worked example for this exact row.
  sun_pref: [SOURCE.NPIN, SOURCE.USDA_CHARACTERISTICS],
  water_pref: [SOURCE.NPIN, SOURCE.USDA_CHARACTERISTICS],
  soil_pref: [SOURCE.NPIN, SOURCE.USDA_CHARACTERISTICS],
  bloom_month: [SOURCE.NPIN, SOURCE.USDA_CHARACTERISTICS],
  deer_resistance: [SOURCE.NPIN, SOURCE.USDA_CHARACTERISTICS],
  larval_host_species: [SOURCE.NPIN, SOURCE.USDA_CHARACTERISTICS],

  // Keystone counts, genus-level (09 §1 row 3).
  lep_host_species: [SOURCE.NWF_KEYSTONE],
  bee_specialist_species: [SOURCE.NWF_KEYSTONE],

  // County nativity: the flora is primary, reviewed per-taxon (09 §1 row 4).
  // No USDA fallback — retired by owner decision (nl-scx.14, 2026-09-20).
  // USDA's NativeStatuses is L48-scope, not county-scope, and can be
  // dual-valued at that granularity (Achillea millefolium: L48:I|L48:N);
  // an unscoped fallback claim could silently shrink plantable_set in ways
  // this precedence table never intended. usdaIngest.js stores the raw
  // value as usda_native_status instead, never as a nativity_nctx claim.
  nativity_nctx: [SOURCE.NCTX_FLORA],
};

function orderFor(field) {
  return FIELD_ORDER[field] ?? DEFAULT_ORDER;
}

// A manual correction outranks every source in the table by construction
// (09 §2.1) — it is what a human already applied this rule to and decided
// the table's default answer was wrong for this one species. iNaturalist is
// never admissible as a value source at all (09 §1 row 5); a claim from it
// carries no rank and can never win or tie, which is what "not admissible"
// means for a resolver that only sees claims already in the store.
function rankOf(order, source) {
  if (source === SOURCE.MANUAL_CORRECTION) return -1;
  if (source === SOURCE.INATURALIST) return Infinity;
  const idx = order.indexOf(source);
  return idx === -1 ? Infinity : idx;
}

/**
 * Resolve a (species, field)'s active claims — asserted, not superseded — to
 * one value, or to a review state, per 09 §1/§1.1.
 *
 * @param {Array<{value: string, source: string, citation?: string}>} claims
 * @param {string} field
 * @returns {{ value: string, source: string, reason: string }
 *   | { status: 'review', reason: string }
 *   | null}
 */
export function resolveField(claims, field) {
  if (!claims.length) return null;

  const order = orderFor(field);
  const ranked = claims.map((claim) => ({ claim, rank: rankOf(order, claim.source) }));
  const bestRank = Math.min(...ranked.map((r) => r.rank));
  const top = ranked.filter((r) => r.rank === bestRank).map((r) => r.claim);

  const distinctValues = new Set(top.map((c) => c.value));
  if (distinctValues.size === 1) {
    const [winner] = top;
    const reason =
      winner.source === SOURCE.MANUAL_CORRECTION
        ? `manual-correction outranks every source for ${field} (09 §2.1)`
        : bestRank === Infinity
          ? `only source asserting ${field}, unranked (09 §1)`
          : `${winner.source} is primary for ${field} (09 §1)`;
    return { value: winner.value, source: winner.source, reason };
  }

  // 09 §1.1: two asserted claims disagreeing, tied under the precedence
  // table — including two citations inside one source, e.g. Callicarpa
  // americana's LargeMammals (Martin vs Miller, both /api/PlantWildlife) —
  // route to review and stop. No majority vote, no first-seen, no
  // alphabetical pick; a human adjudicates via claims_correct.
  return {
    status: 'review',
    reason:
      `${top.length} tied claims for ${field} disagree in value (09 §1.1): ` +
      top.map((c) => `${c.source}${c.citation ? ` (${c.citation})` : ''}=${c.value}`).join(' vs '),
  };
}

/** Convenience: resolveField over a species' active claims for one field, read from the store. */
export function resolveSpeciesField(db, speciesId, field) {
  const claims = db
    .prepare(
      `SELECT value, source, citation FROM claims
       WHERE species_id = ? AND field = ? AND status = 'asserted' AND superseded_by IS NULL`,
    )
    .all(speciesId, field);
  return resolveField(claims, field);
}
