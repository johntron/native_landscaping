import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayoutCsv } from '../src/data/layoutExporter.js';

test('exports plant positions by species id with consistent precision and escaping', () => {
  const csv = buildLayoutCsv([
    { id: 'plant-1', speciesId: 'some-plant', botanicalName: 'Some plant', x: 1.23456, y: 5 },
    { id: 'comma,plant', speciesId: 'quoted "id"', botanicalName: 'Quoted "Name"', x: 0, y: 0 },
  ]);

  const lines = csv.split('\n');
  assert.equal(lines[0], 'id,species_id,x_ft,y_ft');
  assert.equal(lines[1], 'plant-1,some-plant,1.235,5.000');
  assert.equal(lines[2], '"comma,plant","quoted ""id""",0.000,0.000');
});

test('refuses to write a plant with no species id rather than a row nothing can read back', () => {
  assert.throws(
    () => buildLayoutCsv([{ id: 'old', botanicalName: 'Ilex vomitoria', x: 0, y: 0 }]),
    /no speciesId.*migrate-species-ids/
  );
});
