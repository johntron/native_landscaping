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

    const findings = [];
    if (bare.length) findings.push(`Nothing blooms in ${describeMonths(bare)}, inside the growing season.`);
    if (thin.length) {
      findings.push(
        `Only one species blooms in ${describeMonths(thin)} — lose it and the month goes bare.`
      );
    }
    const dormant = [...Array(12).keys()].map((i) => i + 1).filter((m) => !window.has(m));
    if (dormant.length) {
      findings.push(
        `${describeMonths(dormant)} sits outside every planted species' growing season, so it is not counted as a gap.`
      );
    }

    const status = bare.length ? STATUSES.GAP : thin.length ? STATUSES.PARTIAL : STATUSES.OK;
    const summary = bare.length
      ? `${bare.length} month${bare.length === 1 ? ' of the growing season has' : 's of the growing season have'} no bloom at all (${describeMonths(bare)}).`
      : thin.length
        ? `Bloom covers the season, but ${describeMonths(thin)} rests on a single species.`
        : `Something blooms every month of the growing season (${describeMonths(window)}).`;

    return {
      status,
      summary,
      findings,
      suggestions: suggestCover(ctx, 'floweringMonths', [...bare, ...thin], 'blooms'),
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
