import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openObservationEventsDb, upsertEvents } from '../tools/observationEventsDb.js';
import { openFeedStateDb, setFeedState } from '../tools/feedState/feedStateDb.js';
import { queryFeed } from '../tools/feedState/feed.js';
import { openEcosystemDb, replaceTaxonRows } from '../tools/ecosystemIndexDb.js';

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

// lane='yard-relevance' against the real, checked-in ecology tables (nl-1qy.2)
// — Betula is a real ecoregion-9 keystone genus absent from plants.csv (see
// tools/feedState/yardRelevanceTables.js for how the tables load).
test('queryFeed lane=yard-relevance narrows to classified events and attaches relevance', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    upsertEvents(eventsDb, [
      { observation_id: 10, area_id: 'area-yr', taxon_name: 'Betula nigra', iconic_taxon: 'Plantae', observed_on: '2026-01-01', ingested_at: 't1' },
      { observation_id: 11, area_id: 'area-yr', taxon_name: 'Agelaius phoeniceus', iconic_taxon: 'Aves', observed_on: '2026-01-02', ingested_at: 't1' },
      { observation_id: 12, area_id: 'area-yr', taxon_name: 'Bouteloua curtipendula', iconic_taxon: 'Plantae', observed_on: '2026-01-03', ingested_at: 't1' },
    ]);
    const result = queryFeed(eventsDb, feedStateDb, { areaId: 'area-yr', lane: 'yard-relevance', ecoregion: '9' });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((i) => i.observation_id).sort(), [10, 11]);
    const plant = result.items.find((i) => i.observation_id === 10);
    assert.equal(plant.relevance.kind, 'missing-genus');
    const animal = result.items.find((i) => i.observation_id === 11);
    assert.equal(animal.relevance.kind, 'associated-fauna');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed lane=yard-relevance returns a warning when the area has no ecoregion', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    seedEvents(eventsDb);
    const result = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1', lane: 'yard-relevance' });
    assert.equal(result.total, 0);
    assert.match(result.warning, /ecoregion/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// lane='invasive-monitor' against the real, checked-in ecology/invasive-watchlist.csv
// (nl-1qy.3) — Pyrus calleryana (Callery pear) is a real watchlist entry; Ulmus
// crassifolia (Cedar Elm, a North Texas native) is not.
test('queryFeed lane=invasive-monitor narrows to watchlist matches and flags first-seen', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    upsertEvents(eventsDb, [
      { observation_id: 20, area_id: 'area-inv', taxon_id: 501, taxon_name: 'Pyrus calleryana', observed_on: '2026-01-01', ingested_at: 't1' },
      { observation_id: 21, area_id: 'area-inv', taxon_id: 501, taxon_name: 'Pyrus calleryana', observed_on: '2026-02-01', ingested_at: 't1' },
      { observation_id: 22, area_id: 'area-inv', taxon_id: 900, taxon_name: 'Ulmus crassifolia', observed_on: '2026-01-15', ingested_at: 't1' },
    ]);
    const result = queryFeed(eventsDb, feedStateDb, { areaId: 'area-inv', lane: 'invasive-monitor' });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((i) => i.observation_id).sort(), [20, 21]);
    const first = result.items.find((i) => i.observation_id === 20);
    const later = result.items.find((i) => i.observation_id === 21);
    assert.equal(first.relevance.kind, 'invasive-watchlist');
    assert.equal(first.relevance.firstSeenHere, true);
    assert.equal(later.relevance.firstSeenHere, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed lane=rarity narrows to events with a known local count and attaches it', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    const ecosystemDbPath = join(dir, 'ecosystem.db');
    const ecosystemDb = openEcosystemDb(ecosystemDbPath);
    replaceTaxonRows(ecosystemDb, 'Dallas, TX', 'Plantae', [
      { taxon_name: 'Asclepias tuberosa', genus: 'Asclepias', radius_mi: 10, observation_count: 3, fetched_on: '2026-01-01', source: 'test' },
    ]);

    upsertEvents(eventsDb, [
      { observation_id: 30, area_id: 'area-rare', taxon_name: 'Asclepias tuberosa', observed_on: '2026-01-01', ingested_at: 't1' },
      { observation_id: 31, area_id: 'area-rare', taxon_name: 'Lupinus texensis', observed_on: '2026-01-02', ingested_at: 't1' },
    ]);
    const result = queryFeed(eventsDb, feedStateDb, {
      areaId: 'area-rare',
      lane: 'rarity',
      place: 'Dallas, TX',
      ecosystemDbPath,
    });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].observation_id, 30);
    assert.equal(result.items[0].relevance.kind, 'local-scarcity');
    assert.equal(result.items[0].relevance.observationCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed lane=rarity honors rarityThreshold', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    const ecosystemDbPath = join(dir, 'ecosystem.db');
    const ecosystemDb = openEcosystemDb(ecosystemDbPath);
    replaceTaxonRows(ecosystemDb, 'Dallas, TX', 'Plantae', [
      { taxon_name: 'Asclepias tuberosa', genus: 'Asclepias', radius_mi: 10, observation_count: 50, fetched_on: '2026-01-01', source: 'test' },
    ]);
    upsertEvents(eventsDb, [
      { observation_id: 40, area_id: 'area-rare2', taxon_name: 'Asclepias tuberosa', observed_on: '2026-01-01', ingested_at: 't1' },
    ]);
    const result = queryFeed(eventsDb, feedStateDb, {
      areaId: 'area-rare2',
      lane: 'rarity',
      place: 'Dallas, TX',
      ecosystemDbPath,
      rarityThreshold: 10,
    });
    assert.equal(result.total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed lane=rarity returns a warning when the area has no place', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    seedEvents(eventsDb);
    const result = queryFeed(eventsDb, feedStateDb, { areaId: 'area-1', lane: 'rarity' });
    assert.equal(result.total, 0);
    assert.match(result.warning, /place/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryFeed lane=rarity returns a warning when the place has no local index', () => {
  const { eventsDb, feedStateDb, dir } = tmpDbs();
  try {
    const ecosystemDbPath = join(dir, 'ecosystem-empty.db');
    openEcosystemDb(ecosystemDbPath); // create empty file, no rows
    seedEvents(eventsDb);
    const result = queryFeed(eventsDb, feedStateDb, {
      areaId: 'area-1',
      lane: 'rarity',
      place: 'Nowhere, TX',
      ecosystemDbPath,
    });
    assert.equal(result.total, 0);
    assert.match(result.warning, /No local species index/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
