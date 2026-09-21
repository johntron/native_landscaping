import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openObservationEventsDb, upsertEvents } from '../tools/observationEventsDb.js';
import { openFeedStateDb, setFeedState } from '../tools/feedState/feedStateDb.js';
import { queryFeed } from '../tools/feedState/feed.js';

function tmpDbs() {
  const dir = mkdtempSync(join(tmpdir(), 'feed-test-'));
  const eventsDb = openObservationEventsDb(join(dir, 'events.db'));
  const feedStateDb = openFeedStateDb(join(dir, 'feed-state.db'));
  return { eventsDb, feedStateDb, dir };
}

function seedEvents(eventsDb) {
  upsertEvents(eventsDb, [
    { observation_id: 1, area_id: 'area-1', taxon_name: 'Asclepias tuberosa', observed_on: '2026-01-01', ingested_at: 't1' },
    { observation_id: 2, area_id: 'area-1', taxon_name: 'Danaus plexippus', observed_on: '2026-01-02', ingested_at: 't1' },
    { observation_id: 3, area_id: 'area-1', taxon_name: 'Lupinus texensis', observed_on: '2026-01-03', ingested_at: 't1' },
    { observation_id: 4, area_id: 'area-2', taxon_name: 'Bouteloua curtipendula', observed_on: '2026-01-01', ingested_at: 't1' },
  ]);
}

test('queryFeed joins events with default unread/not-dismissed state', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    seedEvents(eventsDb);
    const result = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1' });
    assert.equal(result.total, 3);
    assert.equal(result.items.length, 3);
    assert.ok(result.items.every((item) => item.read === false && item.dismissed === false));
    // listEvents orders DESC by observed_on — newest first.
    assert.deepEqual(result.items.map((i) => i.observation_id), [3, 2, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed reflects read/dismissed state set via setFeedState', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    seedEvents(eventsDb);
    setFeedState(feedStateDb, 2, 'area-1', { read: true });
    const result = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1' });
    const item2 = result.items.find((i) => i.observation_id === 2);
    assert.equal(item2.read, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed excludes dismissed items by default, includes with includeDismissed', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    seedEvents(eventsDb);
    setFeedState(feedStateDb, 1, 'area-1', { dismissed: true });

    const withoutDismissed = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1' });
    assert.equal(withoutDismissed.total, 2);
    assert.ok(!withoutDismissed.items.some((i) => i.observation_id === 1));

    const withDismissed = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1', includeDismissed: true });
    assert.equal(withDismissed.total, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed unreadOnly drops read items', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    seedEvents(eventsDb);
    setFeedState(feedStateDb, 2, 'area-1', { read: true });
    const result = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1', unreadOnly: true });
    assert.equal(result.total, 2);
    assert.ok(!result.items.some((i) => i.observation_id === 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed paginates and scopes strictly to one area', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    seedEvents(eventsDb);
    const page1 = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1', pageSize: 2, page: 1 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.total, 3);
    const page2 = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1', pageSize: 2, page: 2 });
    assert.equal(page2.items.length, 1);

    const area2 = queryFeed(eventsDb, feedStateDb, { areaId: 'area-2' });
    assert.equal(area2.total, 1);
    assert.equal(area2.items[0].observation_id, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed requires areaId', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    assert.throws(() => queryFeed(eventsDb, feedStateDb, {}), /"areaId"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
