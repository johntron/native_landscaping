import { STATUSES } from '../ecology.js';
import { describeMonths } from '../months.js';
import { countSpeciesPerMonth, splitByCatalogCover, suggestCover } from './bloomSuccession.js';

/**
 * Rule 7 — berry and seed food carrying birds through fall and winter.
 *
 * Summer fruit is easy and largely redundant; the months that decide whether a
 * yard feeds anything are September through February, when little else is left.
 * So the whole year is reported but only that window sets the status.
 *
 * Wrap-around comes free from plantParser: `fruit_season_months: 10-2` already
 * yields {10,11,12,1,2}, so October fruit that holds into February counts as
 * winter food without this rule re-parsing anything.
 */
const CRITICAL_MONTHS = [9, 10, 11, 12, 1, 2];

/** A heavy crop feeds more birds for longer than a sparse one. */
const LOAD_WEIGHT = { heavy: 3, moderate: 2, sparse: 1, none: 0 };

export default {
  id: 'bird-food',
  title: 'Fall and winter bird food',

  evaluate(ctx) {
    if (!ctx.placedSpecies.length) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: 'Nothing is planted yet, so there is no fruit season to check.',
      };
    }

    const fruiting = ctx.placedSpecies.filter((entry) => hasFruit(entry));
    const perMonth = countSpeciesPerMonth(fruiting, 'fruitMonths');
    const { weights: loadPerMonth, undeclaredLoad } = weightPerMonth(fruiting);
    const allBare = CRITICAL_MONTHS.filter((month) => !perMonth.get(month));
    // Same split the bloom rule uses, and the reason the two rules disagree
    // about winter without either one hardcoding a season: nothing in the
    // catalog blooms in December, so bloom lets it go, while yaupon and
    // beautyberry fruit straight through it, so an empty December is a real gap.
    const { closable: bare, unavailable } = splitByCatalogCover(ctx, 'fruitMonths', allBare);
    const thin = CRITICAL_MONTHS.filter(
      (month) => perMonth.get(month) && loadPerMonth.get(month) < 2
    );

    const findings = [];
    if (!fruiting.length) {
      findings.push('No planted species carries fruit or seed a bird eats.');
    } else {
      findings.push(
        `${fruiting.length} planted species fruit${fruiting.length === 1 ? 's' : ''}, covering ${describeMonths(
          [...perMonth.keys()]
        )}.`
      );
    }
    if (bare.length) {
      findings.push(
        `No fruit at all in ${describeMonths(bare)} — the catalog carries species that fruit then, so this is a gap worth closing.`
      );
    }
    if (unavailable.length) {
      findings.push(
        `Nothing in the catalog fruits in ${describeMonths(unavailable)}, so those months are not counted against the design.`
      );
    }
    if (thin.length) {
      findings.push(
        `${describeMonths(thin)} carries only a sparse crop — enough to see, not enough to feed on.`
      );
    }
    if (undeclaredLoad) {
      findings.push(
        `${undeclaredLoad} fruiting species declare${undeclaredLoad === 1 ? 's' : ''} no crop size, so ${
          undeclaredLoad === 1 ? 'it is' : 'they are'
        } excluded from the "thin" assessment rather than assumed sparse.`
      );
    }

    const status = bare.length >= CRITICAL_MONTHS.length
      ? STATUSES.GAP
      : bare.length
        ? bare.length >= 3
          ? STATUSES.GAP
          : STATUSES.PARTIAL
        : thin.length
          ? STATUSES.PARTIAL
          : STATUSES.OK;

    const summary = !fruiting.length
      ? 'Nothing planted here feeds a bird in winter.'
      : bare.length
        ? `Fruit runs out for ${describeMonths(bare)}, the months birds most need it.`
        : thin.length
          ? 'Fruit covers every fall and winter month, but thinly in places.'
          : 'Fruit or seed is available through every fall and winter month.';

    return {
      status,
      summary,
      findings,
      suggestions: suggestCover(ctx, 'fruitMonths', bare.length ? bare : thin, 'fruits'),
    };
  },
};

function hasFruit(entry) {
  return (entry?.fruitMonths || []).length > 0 && entry.fruitLoad !== 'none';
}

/**
 * Best crop available in each month, so one heavy fruiter reads as more than
 * one sparse one. A species with no declared fruit_load is excluded from the
 * weight computation rather than defaulted to 'sparse' (nl-c58) — it still
 * counts toward month coverage via countSpeciesPerMonth, just not toward
 * "thin".
 */
function weightPerMonth(entries) {
  const weights = new Map();
  let undeclaredLoad = 0;
  entries.forEach((entry) => {
    const weight = LOAD_WEIGHT[entry.fruitLoad];
    if (weight === undefined) {
      undeclaredLoad += 1;
      return;
    }
    new Set(entry.fruitMonths || []).forEach((month) => {
      const m = Number(month);
      weights.set(m, Math.max(weights.get(m) || 0, weight));
    });
  });
  return { weights, undeclaredLoad };
}
