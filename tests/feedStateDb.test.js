import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFeedStateDb, getFeedState, listFeedStates, setFeedState } from '../tools/feedState/feedStateDb.js';

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'feed-state-test-'));
  const db = openFeedStateDb(join(dir, 'feed-state.db'));
  return { db, dir };
}

test('openFeedStateDb sets busy_timeout so a concurrent writer waits instead of failing immediately (nl-3s5.14)', () => {
  const { db, dir } = tmpDb();
  try {
    const { timeout } = db.prepare('PRAGMA busy_timeout').get();
    assert.equal(timeout, 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getFeedState defaults to unread/not-dismissed for a never-touched observation', () => {
  const { db, dir } = tmpDb();
  try {
    assert.deepEqual(getFeedState(db, 42, 'area-1'), { read: false, dismissed: false, updatedAt: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setFeedState marks read and round-trips through getFeedState', () => {
  const { db, dir } = tmpDb();
  try {
    const result = setFeedState(db, 42, 'area-1', { read: true });
    assert.equal(result.read, true);
    assert.equal(result.dismissed, false);
    assert.equal(typeof result.updatedAt, 'string');

    const fetched = getFeedState(db, 42, 'area-1');
    assert.equal(fetched.read, true);
    assert.equal(fetched.dismissed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setFeedState applies only the flags present in the patch (PATCH semantics)', () => {
  const { db, dir } = tmpDb();
  try {
    setFeedState(db, 1, 'area-1', { read: true });
    const afterDismiss = setFeedState(db, 1, 'area-1', { dismissed: true });
    // read stays true even though this call only touched dismissed.
    assert.equal(afterDismiss.read, true);
    assert.equal(afterDismiss.dismissed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setFeedState scopes state per area, not globally by observation id', () => {
  const { db, dir } = tmpDb();
  try {
    setFeedState(db, 7, 'area-1', { read: true });
    assert.equal(getFeedState(db, 7, 'area-1').read, true);
    assert.equal(getFeedState(db, 7, 'area-2').read, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setFeedState rejects a missing/invalid areaId or observationId', () => {
  const { db, dir } = tmpDb();
  try {
    assert.throws(() => setFeedState(db, 1, '', { read: true }), /"areaId"/);
    assert.throws(() => setFeedState(db, 'nope', 'area-1', { read: true }), /"observationId"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listFeedStates returns a Map keyed by observation_id, scoped to one area', () => {
  const { db, dir } = tmpDb();
  try {
    setFeedState(db, 1, 'area-1', { read: true });
    setFeedState(db, 2, 'area-1', { dismissed: true });
    setFeedState(db, 1, 'area-2', { read: true });

    const states = listFeedStates(db, 'area-1');
    assert.equal(states.size, 2);
    assert.equal(states.get(1).read, true);
    assert.equal(states.get(2).dismissed, true);
    assert.equal(states.has(3), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
