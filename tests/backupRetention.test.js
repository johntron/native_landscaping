import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planRetention,
  snapshotName,
  parseSnapshotName,
  isoWeekKey,
} from '../tools/backup/retention.js';

/** One complete snapshot per day at 03:30Z, starting `start`, for `days` days. */
function nightly(start, days, { hour = '033000' } = {}) {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < days; i += 1) {
    out.push({ name: `${d.toISOString().slice(0, 10)}T${hour}Z`, complete: true });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

test('snapshot names round-trip and sort like time', () => {
  const at = new Date('2026-09-24T03:30:12.345Z');
  assert.equal(snapshotName(at), '2026-09-24T033012Z');
  assert.equal(parseSnapshotName('2026-09-24T033012Z').toISOString(), '2026-09-24T03:30:12.000Z');
  assert.equal(parseSnapshotName('2026-02-31T000000Z'), null, 'impossible dates are not ours');
  assert.equal(parseSnapshotName('2026-09-24'), null);
  assert.equal(parseSnapshotName('notes'), null);
});

test('ISO weeks follow the Thursday rule across the year boundary', () => {
  assert.equal(isoWeekKey(new Date('2026-12-31T12:00:00Z')), '2026-W53'); // Thursday
  assert.equal(isoWeekKey(new Date('2027-01-03T12:00:00Z')), '2026-W53'); // Sunday of that week
  assert.equal(isoWeekKey(new Date('2027-01-04T12:00:00Z')), '2027-W01'); // Monday
  assert.equal(isoWeekKey(new Date('2025-12-29T12:00:00Z')), '2026-W01'); // Monday of 2026-W01
  assert.equal(isoWeekKey(new Date('2026-09-24T12:00:00Z')), '2026-W39');
});

test('fewer snapshots than the policy keeps: nothing is pruned', () => {
  const plan = planRetention(nightly('2026-09-01', 5));
  assert.equal(plan.keep.length, 5);
  assert.deepEqual(plan.prune, []);
});

test('120 nightly runs keep 14 dailies plus the newest of 8 ISO weeks', () => {
  const snaps = nightly('2026-06-01', 120); // through 2026-09-28
  const plan = planRetention(snaps);
  const days = plan.keep.map((n) => n.slice(0, 10));
  // The 14 most recent days are all kept.
  const last14 = snaps.slice(-14).map((s) => s.name).reverse();
  for (const n of last14) assert.ok(plan.keep.includes(n), n);
  // Weekly: newest per ISO week for 8 weeks. The 14 dailies already span
  // weeks W38 (part), W39, W40 (2026-09-28 is a Monday); the older weeks are
  // represented by their Sunday.
  const weeks = new Set(plan.keep.map((n) => isoWeekKey(parseSnapshotName(n))));
  assert.equal(weeks.size, 8);
  const olderThanDailies = plan.keep.filter((n) => !last14.includes(n));
  for (const n of olderThanDailies) {
    assert.equal(parseSnapshotName(n).getUTCDay(), 0, `${n} is the Sunday (newest) of its week`);
  }
  assert.equal(plan.keep.length + plan.prune.length, 120);
  assert.equal(new Set(days).size, plan.keep.length, 'one snapshot per kept day');
  assert.ok(plan.keep.length <= 14 + 8);
  assert.deepEqual(plan.keep, [...plan.keep].sort().reverse(), 'newest first');
});

test('several runs on one day: only the newest counts toward that day', () => {
  const snaps = [
    ...nightly('2026-09-10', 20),
    { name: '2026-09-29T010000Z', complete: true },
    { name: '2026-09-29T120000Z', complete: true },
    { name: '2026-09-29T230000Z', complete: true },
  ];
  const plan = planRetention(snaps, { daily: 3, weekly: 0 });
  // nightly() also made 2026-09-29T033000Z: four runs that day, one kept.
  assert.deepEqual(plan.keep, ['2026-09-29T230000Z', '2026-09-28T033000Z', '2026-09-27T033000Z']);
  assert.ok(plan.prune.includes('2026-09-29T120000Z'));
  assert.ok(plan.prune.includes('2026-09-29T033000Z'));
  assert.ok(plan.prune.includes('2026-09-29T010000Z'));
});

test('a gap in the dates does not shorten the history', () => {
  // Host off for two weeks in the middle.
  const snaps = [...nightly('2026-08-01', 10), ...nightly('2026-08-25', 5)];
  const plan = planRetention(snaps, { daily: 14, weekly: 0 });
  assert.equal(plan.keep.length, 14, '14 days that have a snapshot, not 14 calendar days');
  assert.deepEqual(plan.prune, ['2026-08-01T033000Z']);
});

test('weekly buckets cross the Dec 31 / Jan 1 boundary by ISO week', () => {
  // Mon 2026-12-28 .. Sun 2027-01-10: ISO weeks 2026-W53 and 2027-W01.
  const snaps = nightly('2026-12-28', 14);
  const plan = planRetention(snaps, { daily: 1, weekly: 3 });
  assert.deepEqual(plan.keep, ['2027-01-10T033000Z', '2027-01-03T033000Z']);
  assert.equal(isoWeekKey(parseSnapshotName('2027-01-03T033000Z')), '2026-W53');
});

test('only complete snapshots count; stale incomplete ones are pruned, a newer one is left alone', () => {
  const snaps = [
    ...nightly('2026-09-01', 3),
    { name: '2026-09-02T120000Z', complete: false }, // failed run, superseded
    { name: '2026-09-04T033000Z', complete: false }, // newer than any complete: maybe uploading
  ];
  const plan = planRetention(snaps, { daily: 2, weekly: 0 });
  assert.deepEqual(plan.keep, ['2026-09-04T033000Z', '2026-09-03T033000Z', '2026-09-02T033000Z']);
  assert.deepEqual(plan.prune, ['2026-09-02T120000Z', '2026-09-01T033000Z']);
});

test('an incomplete snapshot does not take a daily slot', () => {
  // A failed run late on 09-02 is not "the newest of 09-02": the complete
  // 03:30 run of that day keeps the slot, and the failed one is pruned.
  const snaps = [...nightly('2026-09-01', 3), { name: '2026-09-02T230000Z', complete: false }];
  const plan = planRetention(snaps, { daily: 3, weekly: 0 });
  assert.deepEqual(plan.prune, ['2026-09-02T230000Z']);
  assert.deepEqual(plan.keep, ['2026-09-03T033000Z', '2026-09-02T033000Z', '2026-09-01T033000Z']);
});

test('names that are not ours are never pruned', () => {
  const snaps = [...nightly('2026-09-01', 5), { name: 'archive', complete: false }, { name: 'README', complete: true }];
  const plan = planRetention(snaps, { daily: 1, weekly: 0 });
  assert.deepEqual(plan.ignored, ['archive', 'README']);
  assert.ok(!plan.prune.includes('archive'));
  assert.ok(!plan.prune.includes('README'));
});

test('the protected snapshot survives whatever the policy says', () => {
  const snaps = nightly('2026-09-01', 5);
  const plan = planRetention(snaps, { daily: 1, weekly: 0, protect: '2026-09-02T033000Z' });
  assert.ok(plan.keep.includes('2026-09-02T033000Z'));
  assert.ok(plan.keep.includes('2026-09-05T033000Z'));
  assert.equal(plan.prune.length, 3);
});

test('rejects a policy that would keep nothing', () => {
  assert.throws(() => planRetention([], { daily: 0 }), /daily/);
  assert.throws(() => planRetention([], { weekly: -1 }), /weekly/);
});
