import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openObservationEventsDb,
  upsertEvents,
  getAreaCursor,
  setAreaCursor,
  listEvents,
  countEvents,
} from '../tools/observationEventsDb.js';
import {
  mapObservationEntry,
  fetchAreaObservations,
  fetchCurrentMaxObservationId,
} from '../tools/fetch-observation-events.mjs';

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'observation-events-test-'));
  const db = openObservationEventsDb(join(dir, 'events.db'));
  return { db, dir };
}

test('upsertEvents writes rows, scoped per area', () => {
  const { db, dir } = tmpDb();
  try {
    upsertEvents(db, [
      { observation_id: 10, area_id: 'area-1', taxon_name: 'Asclepias tuberosa', observed_on: '2026-01-01', ingested_at: 't1' },
      { observation_id: 30, area_id: 'area-1', taxon_name: 'Danaus plexippus', observed_on: '2026-01-03', ingested_at: 't1' },
      { observation_id: 5, area_id: 'area-2', taxon_name: 'Lupinus texensis', observed_on: '2026-01-02', ingested_at: 't1' },
    ]);

    assert.equal(countEvents(db, 'area-1'), 2);
    assert.equal(countEvents(db, 'area-2'), 1);
    assert.equal(countEvents(db, 'area-unknown'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertEvents round-trips conservation_status and taxon_geoprivacy (nl-1qy.4.2/.4.3)', () => {
  const { db, dir } = tmpDb();
  try {
    upsertEvents(db, [
      {
        observation_id: 10,
        area_id: 'area-1',
        taxon_name: 'Haliaeetus leucocephalus',
        observed_on: '2026-01-01',
        ingested_at: 't1',
        conservation_status: 'G4',
        conservation_status_name: 'Apparently Secure',
        taxon_geoprivacy: 'obscured',
      },
    ]);
    const [row] = listEvents(db, { areaId: 'area-1' });
    assert.equal(row.conservation_status, 'G4');
    assert.equal(row.conservation_status_name, 'Apparently Secure');
    assert.equal(row.taxon_geoprivacy, 'obscured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening an existing db file that predates the conservation_status/taxon_geoprivacy columns migrates it in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'observation-events-migrate-test-'));
  try {
    const path = join(dir, 'events.db');
    // Simulate a pre-nl-1qy.4.2/.4.3 db: the table exists but lacks the new columns.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE observation_events (
        observation_id INTEGER NOT NULL,
        area_id TEXT NOT NULL,
        taxon_id INTEGER,
        taxon_name TEXT,
        common_name TEXT,
        iconic_taxon TEXT,
        observed_on TEXT,
        lat REAL,
        lng REAL,
        quality_grade TEXT,
        establishment_means TEXT,
        photo_url TEXT,
        photo_attribution TEXT,
        url TEXT,
        ingested_at TEXT NOT NULL,
        PRIMARY KEY (observation_id, area_id)
      )
    `);
    legacy.close();

    const db = openObservationEventsDb(path);
    upsertEvents(db, [
      { observation_id: 1, area_id: 'area-1', taxon_name: 'X', observed_on: '2026-01-01', ingested_at: 't1', conservation_status: 'G2' },
    ]);
    const [row] = listEvents(db, { areaId: 'area-1' });
    assert.equal(row.conservation_status, 'G2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('area_cursor persists the fetch cursor per area, independent of whether any rows were written', () => {
  const { db, dir } = tmpDb();
  try {
    assert.equal(getAreaCursor(db, 'area-1'), null);

    // A poll that found nothing new still has to move the cursor forward —
    // this is the case that broke a MAX(observation_id)-derived cursor.
    setAreaCursor(db, 'area-1', 1000, '2026-01-01T00:00:00Z');
    assert.equal(getAreaCursor(db, 'area-1'), 1000);
    assert.equal(getAreaCursor(db, 'area-2'), null);

    setAreaCursor(db, 'area-1', 1500, '2026-01-02T00:00:00Z');
    assert.equal(getAreaCursor(db, 'area-1'), 1500, 'a later poll updates the cursor rather than adding a second row');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertEvents is idempotent per (observation_id, area_id) — a re-fetch replaces rather than duplicates', () => {
  const { db, dir } = tmpDb();
  try {
    upsertEvents(db, [
      { observation_id: 10, area_id: 'area-1', quality_grade: 'needs_id', observed_on: '2026-01-01', ingested_at: 't1' },
    ]);
    assert.equal(countEvents(db, 'area-1'), 1);

    // Same observation, re-fetched later after it got upgraded to research grade.
    upsertEvents(db, [
      { observation_id: 10, area_id: 'area-1', quality_grade: 'research', observed_on: '2026-01-01', ingested_at: 't2' },
    ]);
    assert.equal(countEvents(db, 'area-1'), 1, 're-fetching the same (observation_id, area_id) must not add a second row');
    const [row] = listEvents(db, { areaId: 'area-1' });
    assert.equal(row.quality_grade, 'research');
    assert.equal(row.ingested_at, 't2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same observation can be logged under two overlapping areas without colliding', () => {
  const { db, dir } = tmpDb();
  try {
    upsertEvents(db, [
      { observation_id: 99, area_id: 'area-a', taxon_name: 'Quercus virginiana', observed_on: '2026-02-01', ingested_at: 't1' },
      { observation_id: 99, area_id: 'area-b', taxon_name: 'Quercus virginiana', observed_on: '2026-02-01', ingested_at: 't1' },
    ]);
    assert.equal(countEvents(db, 'area-a'), 1);
    assert.equal(countEvents(db, 'area-b'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listEvents filters by area, taxon, and a since-observed-on floor', () => {
  const { db, dir } = tmpDb();
  try {
    upsertEvents(db, [
      { observation_id: 1, area_id: 'area-1', taxon_id: 111, observed_on: '2026-01-01', ingested_at: 't1' },
      { observation_id: 2, area_id: 'area-1', taxon_id: 222, observed_on: '2026-01-10', ingested_at: 't1' },
      { observation_id: 3, area_id: 'area-1', taxon_id: 111, observed_on: '2026-01-15', ingested_at: 't1' },
    ]);

    const byTaxon = listEvents(db, { areaId: 'area-1', taxonId: 111 });
    assert.deepEqual(byTaxon.map((r) => r.observation_id).sort(), [1, 3]);

    const sinceMidJan = listEvents(db, { areaId: 'area-1', sinceObservedOn: '2026-01-10' });
    assert.deepEqual(sinceMidJan.map((r) => r.observation_id).sort(), [2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mapObservationEntry pulls the fields the table needs out of a raw /v1/observations result', () => {
  const row = mapObservationEntry({
    id: 12345,
    observed_on: '2026-03-01',
    quality_grade: 'research',
    uri: 'https://www.inaturalist.org/observations/12345',
    geojson: { coordinates: [-96.8, 32.9] }, // [lng, lat]
    taxon: {
      id: 555,
      name: 'Asclepias tuberosa',
      preferred_common_name: 'Butterfly Weed',
      iconic_taxon_name: 'Plantae',
      default_photo: { license_code: 'cc-by-nc', square_url: 'https://example.com/p.jpg', attribution: '(c) someone' },
    },
  });

  assert.equal(row.observation_id, 12345);
  assert.equal(row.taxon_id, 555);
  assert.equal(row.taxon_name, 'Asclepias tuberosa');
  assert.equal(row.common_name, 'Butterfly Weed');
  assert.equal(row.iconic_taxon, 'Plantae');
  assert.equal(row.observed_on, '2026-03-01');
  assert.equal(row.lat, 32.9);
  assert.equal(row.lng, -96.8);
  assert.equal(row.quality_grade, 'research');
  assert.equal(row.photo_url, 'https://example.com/p.jpg');
  assert.equal(row.photo_attribution, '(c) someone');
  assert.equal(row.url, 'https://www.inaturalist.org/observations/12345');
});

test('mapObservationEntry leaves photo fields blank when there is no open license', () => {
  const row = mapObservationEntry({
    id: 1,
    taxon: { id: 2, name: 'X', default_photo: { license_code: null, square_url: 'https://example.com/p.jpg' } },
  });
  assert.equal(row.photo_url, '');
  assert.equal(row.photo_attribution, '');
});

test('mapObservationEntry falls back to constructing the observation URL when uri is absent', () => {
  const row = mapObservationEntry({ id: 42, taxon: {} });
  assert.equal(row.url, 'https://www.inaturalist.org/observations/42');
});

test('fetchAreaObservations pages with id_above, ascending, actually walking multiple pages until a short page ends it', async () => {
  const area = { id: 'area-1', name: 'Area 1', lat: 32.9, lng: -96.8, radius_mi: 1 };
  const calls = [];
  // A full page of 2 (perPage: 2 below), then a short final page of 1 — this
  // is the case that must drive a SECOND request with id_above advanced past
  // the first page's last id, which is the entire point of id_above paging.
  const pages = [
    [{ id: 101 }, { id: 102 }],
    [{ id: 103 }],
  ];
  let call = 0;
  const fetchJson = async (endpoint, url) => {
    calls.push({ endpoint, idAbove: url.searchParams.get('id_above'), orderBy: url.searchParams.get('order_by'), order: url.searchParams.get('order') });
    const results = pages[call] || [];
    call += 1;
    return { results };
  };

  const { entries, nextCursor } = await fetchAreaObservations({ area, idAbove: 0, fetchJson, maxPages: 5, perPage: 2 });

  assert.equal(calls.length, 2, 'a full page must trigger a second request');
  assert.equal(calls[0].idAbove, '0');
  assert.equal(calls[1].idAbove, '102', 'the second request must resume from the first page\'s last id');
  assert.equal(calls[0].orderBy, 'id');
  assert.equal(calls[0].order, 'asc');
  assert.deepEqual(entries.map((e) => e.observation_id), [101, 102, 103]);
  assert.equal(nextCursor, 103);
});

test('fetchAreaObservations resumes from a nonzero id_above (the incremental-fetch case)', async () => {
  const area = { id: 'area-1', name: 'Area 1', lat: 0, lng: 0, radius_mi: 1 };
  const fetchJson = async (endpoint, url) => ({
    results: url.searchParams.get('id_above') === '500' ? [{ id: 501 }] : [],
  });
  const { entries, nextCursor } = await fetchAreaObservations({ area, idAbove: 500, fetchJson, maxPages: 5, perPage: 200 });
  assert.deepEqual(entries.map((e) => e.observation_id), [501]);
  assert.equal(nextCursor, 501);
});

test('fetchAreaObservations keeps the prior cursor when a page finds nothing new', async () => {
  const area = { id: 'area-1', name: 'Area 1', lat: 0, lng: 0, radius_mi: 1 };
  const fetchJson = async () => ({ results: [] });
  const { entries, nextCursor } = await fetchAreaObservations({ area, idAbove: 777, fetchJson, maxPages: 5, perPage: 200 });
  assert.deepEqual(entries, []);
  assert.equal(nextCursor, 777, 'nextCursor must still be returned so the caller can persist it even on an empty poll');
});

test('fetchAreaObservations with includeProtected drops the taxon_geoprivacy=open filter and keeps only obscured/private rows (nl-1qy.4.3)', async () => {
  const area = { id: 'area-1', name: 'Area 1', lat: 0, lng: 0, radius_mi: 1 };
  let requestUrl;
  const fetchJson = async (endpoint, url) => {
    requestUrl = url;
    return {
      results: [
        { id: 1, taxon_geoprivacy: 'open' },
        { id: 2, taxon_geoprivacy: 'obscured' },
        { id: 3, taxon_geoprivacy: 'private' },
        { id: 4 }, // no taxon_geoprivacy at all — must not be treated as protected
      ],
    };
  };
  const { entries } = await fetchAreaObservations({ area, idAbove: 0, fetchJson, maxPages: 1, perPage: 200, includeProtected: true });
  assert.equal(requestUrl.searchParams.has('taxon_geoprivacy'), false, 'the protected pass must not filter to taxon_geoprivacy=open');
  assert.deepEqual(entries.map((e) => e.observation_id), [2, 3]);
});

test('fetchAreaObservations without includeProtected keeps the taxon_geoprivacy=open filter and returns everything the API sends back', async () => {
  const area = { id: 'area-1', name: 'Area 1', lat: 0, lng: 0, radius_mi: 1 };
  let requestUrl;
  const fetchJson = async (endpoint, url) => {
    requestUrl = url;
    return { results: [{ id: 1, taxon_geoprivacy: 'open' }] };
  };
  const { entries } = await fetchAreaObservations({ area, idAbove: 0, fetchJson, maxPages: 1, perPage: 200 });
  assert.equal(requestUrl.searchParams.get('taxon_geoprivacy'), 'open');
  assert.deepEqual(entries.map((e) => e.observation_id), [1]);
});

test('fetchCurrentMaxObservationId issues one descending, per_page=1 request for the seed value', async () => {
  const area = { id: 'area-1', name: 'Area 1', lat: 32.9, lng: -96.8, radius_mi: 1 };
  const calls = [];
  const fetchJson = async (endpoint, url) => {
    calls.push({
      order: url.searchParams.get('order'),
      orderBy: url.searchParams.get('order_by'),
      perPage: url.searchParams.get('per_page'),
    });
    return { results: [{ id: 999999 }] };
  };
  const maxId = await fetchCurrentMaxObservationId({ area, fetchJson });
  assert.equal(maxId, 999999);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].order, 'desc');
  assert.equal(calls[0].orderBy, 'id');
  assert.equal(calls[0].perPage, '1');
});

test('fetchCurrentMaxObservationId returns null for an area with no matching observations', async () => {
  const area = { id: 'area-1', name: 'Area 1', lat: 0, lng: 0, radius_mi: 1 };
  const fetchJson = async () => ({ results: [] });
  assert.equal(await fetchCurrentMaxObservationId({ area, fetchJson }), null);
});
