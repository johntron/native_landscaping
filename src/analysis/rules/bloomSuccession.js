import { STATUSES } from '../ecology.js';
import { describeMonths } from '../months.js';

/**
 * Rule 6 — something in bloom through the whole season the yard is awake.
 *
 * The target window is the UNION of the placed plants' growing seasons, not a
 * hardcoded calendar: the design says how long its own season runs, so the same
 * rule works outside North Texas without a table of regional seasons. A month
 * inside that window with nothing blooming is a gap; one with a single species
 * is thin, because losing that one species empties the month.
 *
 * Counted by species, not by plant — a drift of nineteen asters is one answer to
 * "what blooms in October", not nineteen.
 */
export default {
  id: 'bloom-succession',
  title: 'Bloom succession',

  evaluate(ctx) {
    if (!ctx.placedSpecies.length) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: 'Nothing is planted yet, so there is no bloom season to check.',
      };
    }

    const window = monthsIn(ctx.placedSpecies, 'growingMonths');
    if (!window.size) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: 'No planted species declares a growing season, so there is no window to check.',
      };
    }

    const speciesPerMonth = countSpeciesPerMonth(ctx.placedSpecies, 'floweringMonths');
    const inWindow = [...window].sort((a, b) => a - b);
    const bare = inWindow.filter((month) => !speciesPerMonth.get(month));
    const thin = inWindow.filter((month) => speciesPerMonth.get(month) === 1);

    // A month nothing in the CATALOG can bloom in is not a design failure — it
    // is a fact about the flora available here, and scoring it as a gap tells
    // the reader to fix something no planting fixes. December and January are
    // the real case: North Central Texas natives are dormant, and no selection
    // from these species fills them. November is the opposite — five catalog
    // species reach it, so an empty November is a choice.
    const { closable, unavailable } = splitByCatalogCover(ctx, 'floweringMonths', bare);

    const findings = [];
    if (closable.length) {
      findings.push(`Nothing blooms in ${describeMonths(closable)}, inside the growing season.`);
    }
    if (thin.length) {
      findings.push(
        `Only one species blooms in ${describeMonths(thin)} — lose it and the month goes bare.`
      );
    }
    if (unavailable.length) {
      findings.push(
        `Nothing in the catalog blooms in ${describeMonths(unavailable)} — no planting from these species fills those months, so they are not counted against the design. Most local pollinators are dormant then; winter FRUIT is the check that matters in those months.`
      );
    }
    const dormant = [...Array(12).keys()].map((i) => i + 1).filter((m) => !window.has(m));
    if (dormant.length) {
      findings.push(
        `${describeMonths(dormant)} sits outside every planted species' growing season, so it is not counted as a gap.`
      );
    }

    const status = closable.length ? STATUSES.GAP : thin.length ? STATUSES.PARTIAL : STATUSES.OK;
    const summary = closable.length
      ? `${closable.length} month${closable.length === 1 ? ' of the growing season has' : 's of the growing season have'} no bloom, and the catalog can fill ${closable.length === 1 ? 'it' : 'them'} (${describeMonths(closable)}).`
      : thin.length
        ? `Bloom covers every month the catalog can reach, but ${describeMonths(thin)} rests on a single species.`
        : 'Something blooms every month of the growing season the catalog can reach.';

    return {
      status,
      summary,
      findings,
      suggestions: suggestCover(ctx, 'floweringMonths', [...closable, ...thin], 'blooms'),
    };
  },
};

/** @param {Array} entries @param {string} field */
export function monthsIn(entries, field) {
  const months = new Set();
  entries.forEach((entry) => (entry?.[field] || []).forEach((month) => months.add(Number(month))));
  return months;
}

export function countSpeciesPerMonth(entries, field) {
  const counts = new Map();
  entries.forEach((entry) => {
    new Set(entry?.[field] || []).forEach((month) => {
      const m = Number(month);
      counts.set(m, (counts.get(m) || 0) + 1);
    });
  });
  return counts;
}

/**
 * Split wanted months into the ones the catalog could actually cover and the
 * ones no available species reaches.
 *
 * This is the difference between "you left this on the table" and "the flora
 * here does not offer it", and collapsing the two makes the panel demand
 * something impossible. The same helper serves bloom and fruit, which is what
 * produces the asymmetry between them for free: nothing blooms in December, so
 * that month goes unreported, while yaupon fruits straight through it, so an
 * empty December there stays a gap.
 *
 * @returns {{ closable: number[], unavailable: number[] }}
 */
export function splitByCatalogCover(ctx, field, months) {
  const covered = monthsIn(ctx.species, field);
  return {
    closable: months.filter((month) => covered.has(Number(month))),
    unavailable: months.filter((month) => !covered.has(Number(month))),
  };
}

/**
 * Rank the unplanted catalog species by how many of the wanted months each one
 * covers. Suggestions come from plants.csv only — the untracked regional CSVs
 * are uncommitted and partly unpopulated, so recommending from them would point
 * the user at species the app cannot draw.
 */
export function suggestCover(ctx, field, wantedMonths, verb, limit = 3) {
  const wanted = new Set(wantedMonths.map(Number));
  if (!wanted.size) return [];

  return ctx.unplacedSpecies
    .map((entry) => {
      const covered = [...new Set(entry[field] || [])].map(Number).filter((m) => wanted.has(m));
      return { entry, covered };
    })
    .filter((candidate) => candidate.covered.length)
    .sort((a, b) => b.covered.length - a.covered.length || a.entry.commonName.localeCompare(b.entry.commonName))
    .slice(0, limit)
    .map(
      ({ entry, covered }) =>
        `${entry.commonName} (${entry.botanicalName}) ${verb} ${describeMonths(covered)}.`
    );
}
