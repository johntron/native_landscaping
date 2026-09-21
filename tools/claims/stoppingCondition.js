// The stopping condition (nl-scx.12), implementing docs/data-acquisition/
// 10-prioritization.md §4:
//
//   Every species in the plantable set has, for every blocking field in
//   01 §2's "Blank tolerable? No" column, EITHER a sourced claim OR a
//   recorded reason it cannot be sourced. Everything else is opportunistic
//   and never a blocker.
//
// "Sourced claim" is checked the way 04 §5's Missing lookup defines it: a
// species is NOT missing a field the moment any claim row exists for it, of
// ANY status (asserted, review, or unknown) — a status of 'unknown' already
// means a source was checked and came back empty, which is itself a recorded
// fact, distinct from nobody having asked. "Recorded reason it cannot be
// sourced" is unsourceableRegister.js. A cell not covered by either is
// outstanding.
import { openClaimsStore } from './claimsStore.js';
import { explainUnsourceable } from './unsourceableRegister.js';

// 01 §2's "Blank tolerable? No" rows (##4-6, 9-11, 13-14), restated as
// claims.field names (see tools/claims/usdaIngest.js / npinIngest.js for
// where each is written). Two rows are deliberately left out:
//
// - #8 genus: not a claims field at all. It is read off taxa.scientific_name
//   at export/analysis time (the join key into host-genera.csv), always
//   present by construction for any seeded taxa row — there is nothing here
//   for a claim, missing-lookup, or register entry to say about it.
// - #7 width_ft: table-strict reading marks it "Partly" tolerable (blocking
//   only for the still-deferred R9/R12), not "No". It is included here
//   anyway, per nl-scx.12's own DESIGN: leaving it out would let R9/R12
//   build on a column measured absent everywhere (10 §3.1) without that fact
//   ever surfacing in this query, which is exactly the silent-gap failure
//   the stopping condition's second clause exists to prevent.
export const BLOCKING_FIELDS = [
  'fruit_load', // 01 §2 #4
  'height_ft', // 01 §2 #5
  'growth_shape', // 01 §2 #6
  'width_ft', // 01 §2 #7 ("Partly") — see note above
  'sun_pref', // 01 §2 #9
  'water_pref', // 01 §2 #10
  'soil_pref', // 01 §2 #11
  'county_presence_48113', // 01 §2 #13
  // 01 §2 #14 asks for COUNTY nativity; this store only carries NCTX-REGION
  // nativity (precedence.js's own comment: no USDA fallback, retired by
  // nl-scx.14 — an unscoped continental flag could silently shrink
  // plantable_set). 10 §2.1 accepts that substitution explicitly, with a
  // named limitation: a claim here means "not known to be non-native to
  // NCTX," not "confirmed native to Dallas County." Do not read a sourced
  // nativity_nctx claim as having answered #14 at county grain.
  'nativity_nctx',
];

/** All plantable_set taxa (10 §2.1's gate/exclude view), joined to their taxa row. */
function plantableSetTaxa(db) {
  return db
    .prepare(
      `SELECT t.* FROM plantable_set ps JOIN taxa t ON t.id = ps.taxa_id ORDER BY t.scientific_name`,
    )
    .all();
}

/**
 * Whether `taxon` has any claim row (any status) for `field`, walking the
 * cultivar-inherits-from-parent rule (04 §2.3) the same way
 * claimsTools.js's coverageFor does: an own claim of any status wins
 * outright and stops the walk; only a total absence of own claims falls
 * through to the parent.
 */
function hasAnyClaim(db, taxon, field) {
  const own = db
    .prepare('SELECT 1 FROM claims WHERE species_id = ? AND field = ? AND superseded_by IS NULL LIMIT 1')
    .get(taxon.id, field);
  if (own) return true;
  if (taxon.rank === 'cultivar' && taxon.parent_id) {
    const parent = db.prepare('SELECT * FROM taxa WHERE id = ?').get(taxon.parent_id);
    if (parent) return hasAnyClaim(db, parent, field);
  }
  return false;
}

/**
 * Run the stopping-condition query (10 §4): plantable set x BLOCKING_FIELDS,
 * partitioned into sourced / explained-by-register / outstanding. The
 * condition is met exactly when `outstanding` is empty.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ blockingFields?: string[] }} [opts]
 */
export function checkStoppingCondition(db, { blockingFields = BLOCKING_FIELDS } = {}) {
  const taxa = plantableSetTaxa(db);

  const sourced = [];
  const explained = [];
  const outstanding = [];

  for (const taxon of taxa) {
    for (const field of blockingFields) {
      const cell = { species: taxon.scientific_name, speciesId: taxon.id, field };
      if (hasAnyClaim(db, taxon, field)) {
        sourced.push(cell);
        continue;
      }
      const entry = explainUnsourceable(field, taxon);
      if (entry) {
        explained.push({ ...cell, reason: entry.reason, citedIn: entry.citedIn });
        continue;
      }
      outstanding.push(cell);
    }
  }

  return {
    blockingFields,
    plantableSetSize: taxa.length,
    totalCells: taxa.length * blockingFields.length,
    sourced,
    explained,
    outstanding,
    met: outstanding.length === 0,
  };
}

/**
 * CLI entry point: `node tools/claims/stoppingCondition.js [claims.db path]`.
 * Prints the query's result and exits non-zero when the condition is not
 * met, so this is scriptable (e.g. from a rebuild) without importing it.
 */
async function main() {
  const dbPath = process.argv[2];
  const db = dbPath ? openClaimsStore(dbPath) : openClaimsStore();
  try {
    db.prepare('SELECT 1 FROM taxa LIMIT 1').get();
  } catch {
    console.error('Claim store not built — run tools/claims/rebuild.js to create data/claims.db');
    process.exitCode = 1;
    return;
  }
  const result = checkStoppingCondition(db);
  const { sourced, explained, outstanding, ...summary } = result;
  console.log(JSON.stringify({ ...summary, sourcedCount: sourced.length, explainedCount: explained.length }, null, 2));
  if (outstanding.length) {
    console.log('\nOutstanding (no claim, no register entry):');
    for (const cell of outstanding) console.log(`  ${cell.species} — ${cell.field}`);
  }
  process.exitCode = result.met ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
