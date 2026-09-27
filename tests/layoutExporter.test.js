import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayoutCsv } from '../src/data/layoutExporter.js';

test('exports plant positions by species id with consistent precision and escaping', () => {
  const csv = buildLayoutCsv([
    { id: 'plant-1', speciesId: 'some-plant', botanicalName: 'Some plant', x: 1.23456, y: 5 },
    { id: 'comma,plant', speciesId: 'quoted "id"', botanicalName: 'Quoted "Name"', x: 0, y: 0 },
  ]);

  const lines = csv.split('\n');
  assert.equal(lines[0], 'id,species_id,x_ft,y_ft,status,planted_on,source,source_nursery,source_sale_organizer,source_sale_event,source_sale_date,local_ecotype,drift_id');
  assert.equal(lines[1], 'plant-1,some-plant,1.235,5.000,planned,,,,,,,,');
  assert.equal(lines[2], '"comma,plant","quoted ""id""",0.000,0.000,planned,,,,,,,,');
});

test('writes each plant\'s lifecycle, and the sourcing/ row a source was linked to (nl-3s5.22)', () => {
  const csv = buildLayoutCsv([
    { id: 'a', speciesId: 's', x: 0, y: 0, status: 'planted', plantedOn: '2026-04-18', source: { name: 'Big Box #123, aisle 7' } },
    { id: 'b', speciesId: 's', x: 0, y: 0, status: 'planted', source: { name: 'Native Gardeners', ref: { table: 'nurseries', name: 'Native Gardeners' } }, localEcotype: true },
    {
      id: 'c', speciesId: 's', x: 0, y: 0,
      source: { name: 'NPSOT sale', ref: { table: 'plant-sales', organizer: 'NPSOT North Central Chapter', event: 'Fall Native Plant Sale', startDate: '2026-10-17' } },
    },
    // an invalid status or date is not written as if it were one
    { id: 'd', speciesId: 's', x: 0, y: 0, status: 'removed', plantedOn: 'yesterday' },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[1], 'a,s,0.000,0.000,planted,2026-04-18,"Big Box #123, aisle 7",,,,,,');
  assert.equal(lines[2], 'b,s,0.000,0.000,planted,,Native Gardeners,Native Gardeners,,,,yes,');
  assert.equal(lines[3], 'c,s,0.000,0.000,planned,,NPSOT sale,,NPSOT North Central Chapter,Fall Native Plant Sale,2026-10-17,,');
  assert.equal(lines[4], 'd,s,0.000,0.000,planned,,,,,,,,');
});

test('writes a plant\'s driftId, and drops one that is not a slug src/state/plantIds.js would mint (nl-o47.6.1)', () => {
  const csv = buildLayoutCsv([
    { id: 'a', speciesId: 's', x: 0, y: 0, driftId: 'winecup-strip' },
    { id: 'b', speciesId: 's', x: 0, y: 0, driftId: '' },
    { id: 'c', speciesId: 's', x: 0, y: 0 },
    // malformed values (not a string, uppercase, a space, too long) are written blank, not verbatim
    { id: 'd', speciesId: 's', x: 0, y: 0, driftId: 'Winecup Strip' },
    { id: 'e', speciesId: 's', x: 0, y: 0, driftId: 'x'.repeat(100) },
    { id: 'f', speciesId: 's', x: 0, y: 0, driftId: 42 },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[1], 'a,s,0.000,0.000,planned,,,,,,,,winecup-strip');
  assert.equal(lines[2], 'b,s,0.000,0.000,planned,,,,,,,,');
  assert.equal(lines[3], 'c,s,0.000,0.000,planned,,,,,,,,');
  assert.equal(lines[4], 'd,s,0.000,0.000,planned,,,,,,,,');
  assert.equal(lines[5], 'e,s,0.000,0.000,planned,,,,,,,,');
  assert.equal(lines[6], 'f,s,0.000,0.000,planned,,,,,,,,');
});

test('refuses to write a plant with no species id rather than a row nothing can read back', () => {
  assert.throws(
    () => buildLayoutCsv([{ id: 'old', botanicalName: 'Ilex vomitoria', x: 0, y: 0 }]),
    /no speciesId.*migrate-species-ids/
  );
});
