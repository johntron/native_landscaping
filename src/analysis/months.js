/** Month helpers shared by the ecology rules. Months are 1-12, as plantParser emits them. */

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const MONTH_ABBR = MONTH_NAMES.map((name) => name.slice(0, 3));

/** @param {number} month 1-12 */
export function monthName(month) {
  return MONTH_ABBR[(Number(month) - 1 + 12) % 12] || String(month);
}

/**
 * Name a run of months as a reader would say it — "Dec-Feb", not "Dec, Jan, Feb" —
 * wrapping across the year end, which is how the catalog already writes seasons.
 * @param {Iterable<number>} months
 */
export function describeMonths(months) {
  const set = new Set([...months].map(Number).filter((m) => m >= 1 && m <= 12));
  if (!set.size) return 'no months';
  if (set.size === 12) return 'all year';

  const runs = [];
  // Start at a month whose predecessor is absent, so a run spanning December
  // into January is reported as one run rather than two.
  const start = [...Array(12).keys()]
    .map((i) => i + 1)
    .find((m) => set.has(m) && !set.has(((m - 2 + 12) % 12) + 1));
  for (let i = 0, month = start; i < 12; i += 1) {
    if (set.has(month)) {
      const last = runs[runs.length - 1];
      if (last && last.end === ((month - 2 + 12) % 12) + 1) last.end = month;
      else runs.push({ start: month, end: month });
    }
    month = (month % 12) + 1;
  }

  return runs
    .map((run) => (run.start === run.end ? monthName(run.start) : `${monthName(run.start)}-${monthName(run.end)}`))
    .join(', ');
}
