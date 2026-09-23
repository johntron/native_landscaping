import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';
import { daysUntil, formatSaleDates, localIsoDate, splitSales } from '../src/sourcing/saleSchedule.js';

const row = (over) => ({
  organizer: 'Org',
  event: 'Sale',
  kind: 'sale',
  start_date: '2026-10-17',
  end_date: '2026-10-17',
  ...over,
});

test('a sale is upcoming through its last day and held the day after', () => {
  const sale = row({ start_date: '2026-10-02', end_date: '2026-10-03' });
  assert.equal(splitSales([sale], '2026-10-03').upcoming.length, 1);
  assert.equal(splitSales([sale], '2026-10-04').held.length, 1);
});

test('a one-day sale with a blank end date ends on its start date', () => {
  const sale = row({ end_date: '' });
  assert.equal(splitSales([sale], '2026-10-17').upcoming.length, 1);
  assert.equal(splitSales([sale], '2026-10-18').held.length, 1);
});

test('an open-ended online window stays upcoming', () => {
  const online = row({ kind: 'online', start_date: '2026-10-07', end_date: '' });
  assert.equal(splitSales([online], '2026-12-01').upcoming.length, 1);
});

test('upcoming sorts soonest first, held most recent first, undated rows dropped', () => {
  const { upcoming, held } = splitSales(
    [
      row({ start_date: '2026-11-14', end_date: '2026-11-14' }),
      row({ start_date: '2026-10-17', end_date: '2026-10-17' }),
      row({ start_date: '2026-04-18', end_date: '2026-04-18' }),
      row({ start_date: '2026-05-02', end_date: '2026-05-02' }),
      row({ start_date: 'TBA', end_date: '' }),
    ],
    '2026-09-23',
  );
  assert.deepEqual(upcoming.map((r) => r.start_date), ['2026-10-17', '2026-11-14']);
  assert.deepEqual(held.map((r) => r.start_date), ['2026-05-02', '2026-04-18']);
});

test('formatSaleDates covers one day, a range, a month boundary, and an open window', () => {
  assert.equal(formatSaleDates(row({})), 'Sat, Oct 17');
  assert.equal(formatSaleDates(row({ start_date: '2026-10-02', end_date: '2026-10-03' })), 'Oct 2–3');
  assert.equal(formatSaleDates(row({ start_date: '2026-09-30', end_date: '2026-10-02' })), 'Sep 30–Oct 2');
  assert.equal(formatSaleDates(row({ kind: 'online', start_date: '2026-10-07', end_date: '' })), 'From Wed, Oct 7');
});

test('daysUntil counts calendar days', () => {
  assert.equal(daysUntil(row({}), '2026-09-23'), 24);
  assert.equal(daysUntil(row({}), '2026-10-17'), 0);
});

test('localIsoDate uses the local calendar, not UTC', () => {
  assert.equal(localIsoDate(new Date(2026, 8, 23, 23, 30)), '2026-09-23');
});

test('sourcing/plant-sales.csv: every row has a valid kind, access, and dates', () => {
  const rows = parseCsv(readFileSync(fileURLToPath(new URL('../sourcing/plant-sales.csv', import.meta.url)), 'utf8'));
  for (const [i, r] of rows.entries()) {
    const where = `line ${i + 2}`;
    assert.match(r.start_date, /^\d{4}-\d{2}-\d{2}$/, where);
    assert.ok(!r.end_date || r.end_date >= r.start_date, `${where}: ends before it starts`);
    assert.ok(['sale', 'online', 'event'].includes(r.kind), `${where}: kind ${r.kind}`);
    assert.ok(['public', 'members'].includes(r.access), `${where}: access ${r.access}`);
    assert.ok(['native', 'mixed', ''].includes(r.offers), `${where}: offers ${r.offers}`);
  }
});
