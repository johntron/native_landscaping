import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayoutCsv } from '../src/data/layoutExporter.js';

test('exports plant positions with consistent precision and escaping', () => {
  const csv = buildLayoutCsv([
    { id: 'plant-1', botanicalName: 'Some plant', x: 1.23456, y: 5 },
    { id: 'comma,plant', botanicalName: 'Quoted "Name"', x: 0, y: 0 },
  ]);

  const lines = csv.split('\n');
  assert.equal(lines[0], 'id,botanical_name,x_ft,y_ft');
  assert.equal(lines[1], 'plant-1,Some plant,1.235,5.000');
  assert.equal(lines[2], '"comma,plant","Quoted ""Name""",0.000,0.000');
});
