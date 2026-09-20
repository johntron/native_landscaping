import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openSavedAreasDb,
  createSavedArea,
  getSavedArea,
  listSavedAreas,
  updateSavedArea,
  deleteSavedArea,
  validateSavedAreaInput,
} from '../tools/savedAreas/savedAreasDb.js';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'saved-areas-test-'));
  return join(dir, 'saved-areas.db');
}

function openTempDb() {
  return openSavedAreasDb(tempDbPath());
}

test('createSavedArea inserts a row with a generated id and timestamps, and round-trips filters', () => {
  const db = openTempDb();
  const area = createSavedArea(db, {
    name: 'Backyard',
    lat: 32.78,
    lng: -96.8,
    radiusMi: 5,
    filters: { taxonScope: 'plantae', invasiveOnly: true, rarityThreshold: 10, yardRelevantGenera: ['Quercus'] },
  });

  assert.equal(typeof area.id, 'string');
  assert.ok(area.id.length > 0);
  assert.equal(area.name, 'Backyard');
  assert.equal(area.lat, 32.78);
  assert.equal(area.lng, -96.8);
  assert.equal(area.radiusMi, 5);
  assert.deepEqual(area.filters, {
    taxonScope: 'plantae',
    invasiveOnly: true,
    rarityThreshold: 10,
    yardRelevantGenera: ['Quercus'],
  });
  assert.equal(typeof area.createdAt, 'string');
  assert.equal(area.createdAt, area.updatedAt);
});

test('createSavedArea defaults filters to {} when omitted', () => {
  const db = openTempDb();
  const area = createSavedArea(db, { name: 'No filters', lat: 0, lng: 0, radiusMi: 1 });
  assert.deepEqual(area.filters, {});
});

test('getSavedArea returns null for an unknown id', () => {
  const db = openTempDb();
  assert.equal(getSavedArea(db, 'does-not-exist'), null);
});

test('listSavedAreas returns every row, ordered by name', () => {
  const db = openTempDb();
  createSavedArea(db, { name: 'Zeta', lat: 1, lng: 1, radiusMi: 1 });
  createSavedArea(db, { name: 'Alpha', lat: 2, lng: 2, radiusMi: 2 });
  const names = listSavedAreas(db).map((a) => a.name);
  assert.deepEqual(names, ['Alpha', 'Zeta']);
});

test('updateSavedArea applies only the fields present in the patch (PATCH semantics)', () => {
  const db = openTempDb();
  const created = createSavedArea(db, {
    name: 'Original',
    lat: 10,
    lng: 20,
    radiusMi: 3,
    filters: { invasiveOnly: false },
  });

  const updated = updateSavedArea(db, created.id, { name: 'Renamed' });
  assert.equal(updated.name, 'Renamed');
  // Untouched fields survive the partial update.
  assert.equal(updated.lat, 10);
  assert.equal(updated.lng, 20);
  assert.equal(updated.radiusMi, 3);
  assert.deepEqual(updated.filters, { invasiveOnly: false });
  // updatedAt is reissued on every write; it's timer-resolution dependent
  // whether it differs from createdAt in a fast test run, so just check it
  // moved forward-or-equal rather than asserting strict inequality.
  assert.ok(updated.updatedAt >= created.updatedAt);
  assert.equal(updated.createdAt, created.createdAt);

  const filtersOnly = updateSavedArea(db, created.id, { filters: { invasiveOnly: true } });
  assert.equal(filtersOnly.name, 'Renamed');
  assert.deepEqual(filtersOnly.filters, { invasiveOnly: true });
});

test('updateSavedArea throws for an unknown id', () => {
  const db = openTempDb();
  assert.throws(() => updateSavedArea(db, 'nope', { name: 'x' }), /No saved area with id/);
});

test('deleteSavedArea removes the row and reports whether one existed', () => {
  const db = openTempDb();
  const area = createSavedArea(db, { name: 'Temp', lat: 0, lng: 0, radiusMi: 1 });
  assert.equal(deleteSavedArea(db, area.id), true);
  assert.equal(getSavedArea(db, area.id), null);
  assert.equal(deleteSavedArea(db, area.id), false);
});

test('validateSavedAreaInput requires a non-empty name', () => {
  assert.throws(
    () => validateSavedAreaInput({ name: '  ', lat: 0, lng: 0, radiusMi: 1 }),
    /non-empty "name"/
  );
  assert.throws(
    () => validateSavedAreaInput({ lat: 0, lng: 0, radiusMi: 1 }),
    /non-empty "name"/
  );
});

test('validateSavedAreaInput rejects lat/lng out of range and non-finite values', () => {
  const base = { name: 'x', lat: 0, lng: 0, radiusMi: 1 };
  assert.throws(() => validateSavedAreaInput({ ...base, lat: 91 }), /"lat"/);
  assert.throws(() => validateSavedAreaInput({ ...base, lat: -91 }), /"lat"/);
  assert.throws(() => validateSavedAreaInput({ ...base, lng: 181 }), /"lng"/);
  assert.throws(() => validateSavedAreaInput({ ...base, lng: -181 }), /"lng"/);
  assert.throws(() => validateSavedAreaInput({ ...base, lat: 'nope' }), /"lat"/);
  assert.doesNotThrow(() => validateSavedAreaInput({ ...base, lat: 90, lng: 180 }));
  assert.doesNotThrow(() => validateSavedAreaInput({ ...base, lat: -90, lng: -180 }));
});

test('validateSavedAreaInput requires radiusMi to be a positive number', () => {
  const base = { name: 'x', lat: 0, lng: 0 };
  assert.throws(() => validateSavedAreaInput({ ...base, radiusMi: 0 }), /"radiusMi"/);
  assert.throws(() => validateSavedAreaInput({ ...base, radiusMi: -5 }), /"radiusMi"/);
  assert.throws(() => validateSavedAreaInput({ ...base, radiusMi: 'far' }), /"radiusMi"/);
});

test('validateSavedAreaInput rejects a non-object filters value', () => {
  const base = { name: 'x', lat: 0, lng: 0, radiusMi: 1 };
  assert.throws(() => validateSavedAreaInput({ ...base, filters: 'nope' }), /"filters"/);
  assert.throws(() => validateSavedAreaInput({ ...base, filters: ['a'] }), /"filters"/);
});

test('validateSavedAreaInput with partial:true only requires fields present on the patch', () => {
  assert.deepEqual(validateSavedAreaInput({ name: 'Only name' }, { partial: true }), {
    name: 'Only name',
  });
  // No fields at all is a valid (no-op) partial patch.
  assert.deepEqual(validateSavedAreaInput({}, { partial: true }), {});
  // But a field that IS present is still validated.
  assert.throws(() => validateSavedAreaInput({ lat: 999 }, { partial: true }), /"lat"/);
});

test('createSavedArea surfaces validation errors rather than inserting a bad row', () => {
  const db = openTempDb();
  assert.throws(() => createSavedArea(db, { name: '', lat: 0, lng: 0, radiusMi: 1 }), /non-empty "name"/);
  assert.deepEqual(listSavedAreas(db), []);
});
