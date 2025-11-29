import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/data/csvLoader.js';

test('parseCsv handles quoted commas and trims cells', () => {
  const csv = 'name,description\n"plant, one"," bright"\nsecond,plain';
  const rows = parseCsv(csv);

  assert.equal(rows.length, 2);
  assert.deepStrictEqual(rows[0], { name: 'plant, one', description: 'bright' });
  assert.deepStrictEqual(rows[1], { name: 'second', description: 'plain' });
});
