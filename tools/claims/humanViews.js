// Shaping logic for the two human-facing views (nl-scx.10), implementing
// docs/data-acquisition/07-mcp-introspection.md §5 and
// docs/data-acquisition/09-conflict-resolution.md §4.
//
// Deliberately thin: both functions below reshape the existing claims_*
// tool output (tools/claims/claimsTools.js) into what the coverage page and
// the conflicts queue render — no new query against claims.db. Per 07 §5,
// "claims_correct backs a view's submit action, same tool two callers" — so
// there is no humanViews write path either; the queue's submit action calls
// claimsCorrect directly.
import { claimsCoverage, claimsConflicts } from './claimsTools.js';

/**
 * Coverage view roll-up (07 §5's "7 of 12 required fields sourced for this
 * species"): claims_coverage's flat (species, field) list, grouped per
 * species with a completeness count. "Sourced" counts status='asserted'
 * only — 'review' and 'unknown' both mean a human still has work to do on
 * that field, same as 'missing', so none of the three count toward
 * completeness.
 */
export function coverageView(db, { field, species } = {}) {
  const rows = claimsCoverage(db, { field, species });

  const bySpecies = new Map();
  for (const row of rows) {
    let entry = bySpecies.get(row.speciesId);
    if (!entry) {
      entry = { species: row.species, speciesId: row.speciesId, fields: [], assertedCount: 0, totalFields: 0 };
      bySpecies.set(row.speciesId, entry);
    }
    entry.fields.push({ field: row.field, status: row.status, sourcesAsserting: row.sourcesAsserting });
    entry.totalFields += 1;
    if (row.status === 'asserted') entry.assertedCount += 1;
  }

  return [...bySpecies.values()]
    .map((entry) => ({ ...entry, fields: entry.fields.sort((a, b) => a.field.localeCompare(b.field)) }))
    .sort((a, b) => a.species.localeCompare(b.species));
}

/**
 * Conflicts view (07 §5 / 09 §4): claims_conflicts' queue, reshaped for
 * rendering. Per 09 §4, an unadjudicated conflict shows NOTHING as a fact —
 * this function never picks or exposes a "current" value, only the disputed
 * candidates a human chooses among via the submit action (claimsCorrect).
 */
export function conflictsView(db, { field } = {}) {
  return claimsConflicts(db, { field }).map((row) => ({
    species: row.species,
    speciesId: row.speciesId,
    field: row.field,
    candidates: row.claims.map((c) => ({ value: c.value, source: c.source, status: c.status })),
  }));
}
