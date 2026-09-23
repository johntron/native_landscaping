/**
 * Which plant sales are still ahead and which have been held, from the rows of
 * sourcing/plant-sales.csv. Pure: no DOM, no fetch, and no clock — the caller
 * hands in today's date, so a test can pin it.
 *
 * Dates are compared as YYYY-MM-DD strings in the viewer's local calendar. A
 * sale is upcoming through its last day, so a sale running today still shows
 * as upcoming at 7 PM, when a UTC date would already say tomorrow.
 */

/**
 * @typedef {Object} SaleRow
 * @property {string} organizer
 * @property {string} event
 * @property {string} kind        'sale' | 'online' | 'event'
 * @property {string} start_date  YYYY-MM-DD
 * @property {string} end_date    YYYY-MM-DD; blank for an open-ended window (online orders)
 * @property {string} hours
 * @property {string} access      'public' | 'members'
 * @property {string} venue
 * @property {string} city
 * @property {string} offers      'native' | 'mixed' | '' when the organizer does not say
 * @property {string} url
 * @property {string} notes
 * @property {string} checked_on
 * @property {string} source
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today's date in the viewer's own calendar, as YYYY-MM-DD.
 * @param {Date} [now]
 */
export function localIsoDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The last day a row is still worth showing as ahead. An open-ended window
 * (online orders "until inventory is gone") has no known end, so it stays
 * upcoming; its start date is what the reader needs.
 * @param {SaleRow} row
 * @returns {string|null} YYYY-MM-DD, or null when open-ended
 */
function lastDay(row) {
  if (ISO_DATE.test(row.end_date)) return row.end_date;
  if (row.kind === 'online') return null;
  return row.start_date;
}

/**
 * Split sale rows into upcoming (soonest first) and held (most recent first).
 * Rows without a valid start date are dropped rather than guessed at.
 * @param {SaleRow[]} rows
 * @param {string} today YYYY-MM-DD
 * @returns {{ upcoming: SaleRow[], held: SaleRow[] }}
 */
export function splitSales(rows, today) {
  const dated = rows.filter((row) => ISO_DATE.test(row.start_date));
  const upcoming = [];
  const held = [];
  for (const row of dated) {
    const end = lastDay(row);
    (end === null || end >= today ? upcoming : held).push(row);
  }
  upcoming.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.organizer.localeCompare(b.organizer));
  held.sort((a, b) => b.start_date.localeCompare(a.start_date) || a.organizer.localeCompare(b.organizer));
  return { upcoming, held };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  // Noon UTC keeps the weekday stable whatever the viewer's time zone.
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
  return { y, m, d, weekday, month: MONTHS[m - 1] };
}

/**
 * "Sat, Oct 17", "Oct 2–3", "Oct 17–25", "Sep 30–Oct 2", or "From Wed, Oct 7"
 * for an open-ended window. The year is left off; every row is dated.
 * @param {SaleRow} row
 */
export function formatSaleDates(row) {
  const start = parts(row.start_date);
  if (!ISO_DATE.test(row.end_date)) {
    return `From ${start.weekday}, ${start.month} ${start.d}`;
  }
  if (row.end_date === row.start_date) return `${start.weekday}, ${start.month} ${start.d}`;
  const end = parts(row.end_date);
  if (end.m === start.m) return `${start.month} ${start.d}–${end.d}`;
  return `${start.month} ${start.d}–${end.month} ${end.d}`;
}

/**
 * Whole days from today to the row's start; negative once it has begun.
 * @param {SaleRow} row
 * @param {string} today YYYY-MM-DD
 */
export function daysUntil(row, today) {
  const toUtc = (iso) => {
    const { y, m, d } = parts(iso);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(row.start_date) - toUtc(today)) / 86_400_000);
}
