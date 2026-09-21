// The unsourceable register (nl-scx.12), implementing docs/data-acquisition/
// 10-prioritization.md §4's second clause: a field can be "explained" rather
// than "outstanding" for the stopping condition even with zero claims, if a
// measured, cited reason says no source this project can use carries it.
//
// This is deliberately a small authored table, same shape as precedence.js's
// FIELD_ORDER — decided once per field (or per species x field, for the rare
// case a gap is specific to one species rather than the whole field), never
// inferred from the absence of claims itself. An empty claims_coverage result
// is evidence a field MIGHT belong here; it is never sufficient on its own —
// that would let a field nobody has gotten around to collecting yet silently
// count as "explained," exactly the failure 10 §4 warns against ("all of it"
// is ruled out, but so is "nothing is ever missing").
//
// Every entry needs a `measuredAbsentFrom` list — the sources actually
// checked — and a `citedIn` list pointing at where that measurement is
// written up, per this project's own "MEASURED, not assumed" discipline
// (10-prioritization.md §0 / every doc under docs/data-acquisition/).

/**
 * @typedef {object} UnsourceableEntry
 * @property {string} field - a claims.field value (or, for a field that has
 *   never had a claim row written at all, the name it would use).
 * @property {'all-species'|'species'} scope - 'all-species' means the
 *   reason applies catalog-wide (no source exists for anyone); 'species'
 *   scopes it to specific taxa (usda_symbol or scientific_name), for a gap
 *   that is real for one plant but not structural for the field in general.
 * @property {string[]} [species] - required when scope is 'species':
 *   usda_symbol or scientific_name values this entry explains.
 * @property {string} reason - human-readable, citable explanation.
 * @property {string[]} measuredAbsentFrom - sources actually checked and
 *   confirmed not to carry this field.
 * @property {string[]} citedIn - doc sections (path + heading) where the
 *   measurement backing this entry is written up.
 */

/** @type {UnsourceableEntry[]} */
export const UNSOURCEABLE_FIELDS = [
  {
    field: 'width_ft',
    scope: 'all-species',
    reason:
      'Mature spread has no general source this project can use. USDA publishes no ' +
      'spread/width characteristic at all (checked across all 81), a taxonomic flora ' +
      'states height, not spread, and neither regional candidate CSV carries it. This is ' +
      'unsourced, not under-collected — filling it needs a horticultural-book class of ' +
      'source this epic has not resolved (03 §8). Per-species manual lookups have worked ' +
      'for a handful of rows (08 §1.3) but do not generalize into a source this register ' +
      'can point at.',
    measuredAbsentFrom: [
      'usda-plants-characteristics (0/81 characteristics carry width or spread, all species tried)',
      'npin (fetched full field set, 87db298 — no width/spread field)',
      'nctx-flora (fa98521 — a taxonomic flora states height, not spread)',
      'blackland-prairie-natives.csv (0/469 rows filled)',
      'dfw-nctx-natives.csv (0/61 rows filled)',
    ],
    citedIn: [
      'docs/data-acquisition/01-goals-and-required-fields.md §3.4',
      'docs/data-acquisition/03-document-corpus.md §8',
      'docs/data-acquisition/08-known-gaps.md §3.1',
      'docs/data-acquisition/10-prioritization.md §3.1',
    ],
  },
  {
    field: 'larval_host_species',
    scope: 'all-species',
    reason:
      'No API this project has tried publishes species-level insect associations: ' +
      '/api/PlantPollinator returned [] for every species tried, including the strongest ' +
      'possible positive controls (both milkweeds and a passionflower) — if a milkweed has ' +
      'no pollinator record, nothing does. NPIN curates a species-level larval-host claim as ' +
      'unstructured prose on some species pages (e.g. Ilex vomitoria -> "Larval Host: Henrys ' +
      'Elfin butterfly"), and nl-scx.8\'s NPIN ingest already writes an asserted claim for a ' +
      'species when that prose exists — so a species WITH an asserted or unknown ' +
      'larval_host_species claim is explained the ordinary way (04 §5\'s missing lookup), not ' +
      'through this register entry. This entry explains the field for a species NPIN\'s pages ' +
      'do not curate it for either: no API supplies it and no further re-crawl of an already- ' +
      'covered source will produce it, which is what makes the gap structural rather than a ' +
      'collection backlog for that species.',
    measuredAbsentFrom: [
      '/api/PlantPollinator (USDA) — [] for every species tried, including Asclepias asperula, ' +
        'Asclepias viridis, Passiflora incarnata, Salix nigra, Quercus shumardii',
    ],
    citedIn: [
      'docs/data-acquisition/01-goals-and-required-fields.md §3.6',
      'docs/data-acquisition/10-prioritization.md §3.5',
    ],
  },
];

function normalize(name) {
  return name.trim().toLowerCase();
}

/**
 * Whether a (field, taxon) pair is explained by the register, independent of
 * whether any claim exists for it. `taxon` is the taxa row (needs
 * scientific_name and, optionally, usda_symbol) — required only for a
 * 'species'-scoped entry; omit it to check field-wide entries only.
 *
 * @param {string} field
 * @param {{ scientific_name?: string, usda_symbol?: string }} [taxon]
 * @param {UnsourceableEntry[]} [entries] - defaults to the real register;
 *   overridable so a 'species'-scoped entry is unit-testable without adding
 *   a synthetic row to the real, cited table.
 * @returns {UnsourceableEntry | null} the explaining entry, or null if none applies
 */
export function explainUnsourceable(field, taxon, entries = UNSOURCEABLE_FIELDS) {
  for (const entry of entries) {
    if (entry.field !== field) continue;
    if (entry.scope === 'all-species') return entry;
    if (entry.scope === 'species' && taxon) {
      const names = entry.species.map(normalize);
      if (
        (taxon.scientific_name && names.includes(normalize(taxon.scientific_name))) ||
        (taxon.usda_symbol && names.includes(normalize(taxon.usda_symbol)))
      ) {
        return entry;
      }
    }
  }
  return null;
}
