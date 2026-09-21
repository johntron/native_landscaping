/**
 * Genus-level aggregation over the FNCT species index, plus the filter logic
 * behind each genus's "narrow by what we know" tool.
 *
 * This is NOT a reproduction of the flora's own dichotomous keys — those are
 * the author's copyrighted expression (docs/data-acquisition/corpus/NOTICE.md)
 * and this app never stores or shows their text. Instead this narrows a
 * genus's species using only the controlled-vocabulary facts
 * tools/fnct-species-index.mjs already extracts (life form, duration,
 * habitat tags) — an original tool built from facts, not a copy of anyone's
 * key. For the flora's real key, `citation` points at the page it starts on.
 */

/** One row per genus found in `speciesRows`, sorted alphabetically. Shaped enough like a species row that fnctSearch's matcher works on it unchanged. */
export function aggregateGenusRows(speciesRows) {
  const byGenus = new Map();
  for (const row of speciesRows) {
    if (!byGenus.has(row.genus)) byGenus.set(row.genus, []);
    byGenus.get(row.genus).push(row);
  }

  return [...byGenus.entries()]
    .map(([genus, species]) => {
      const commonNames = uniqueSorted(species.flatMap((s) => splitList(s.common_names)));
      const pages = species.map((s) => Number(s.fnct_page)).filter((n) => Number.isFinite(n));
      return {
        kind: 'genus',
        genus,
        scientific_name: genus,
        common_names: commonNames.join('; '),
        species_count: species.length,
        life_forms: uniqueSorted(species.map((s) => s.life_form).filter(Boolean)),
        durations: uniqueSorted(species.map((s) => s.duration).filter(Boolean)),
        habitat_tags: uniqueSorted(species.flatMap((s) => splitList(s.habitat_tags))),
        min_page: pages.length ? Math.min(...pages) : null,
        source: species[0]?.source ?? '',
      };
    })
    .sort((a, b) => a.genus.localeCompare(b.genus));
}

/** Species rows for one genus, narrowed by any of the three facts (all optional, all must hold when given). */
export function filterGenusSpecies(genus, speciesRows, { lifeForm, duration, habitatTag } = {}) {
  return speciesRows
    .filter((s) => s.genus === genus)
    .filter((s) => !lifeForm || s.life_form === lifeForm)
    .filter((s) => !duration || s.duration === duration)
    .filter((s) => !habitatTag || splitList(s.habitat_tags).includes(habitatTag));
}

function splitList(field) {
  return (field || '').split(';').map((s) => s.trim()).filter(Boolean);
}

function uniqueSorted(items) {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}
