import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEcoregionInput, KNOWN_ECOREGIONS } from '../src/data/ecoregionInput.js';

test('a blank entry clears the field with no comment', () => {
  assert.deepEqual(resolveEcoregionInput('  '), { value: null, note: null });
});

test('a known Level I code is saved as typed, with no comment', () => {
  assert.deepEqual(resolveEcoregionInput('9'), { value: '9', note: null });
});

test('a Level III Blackland Prairie code is translated to its Level I parent', () => {
  const result = resolveEcoregionInput('32');
  assert.equal(result.value, '9');
  assert.match(result.note, /32.*Level I/s);
});

test('a Level IV Blackland Prairie code is translated, case-insensitively', () => {
  assert.equal(resolveEcoregionInput('32a').value, '9');
  assert.equal(resolveEcoregionInput('32A').value, '9');
  assert.equal(resolveEcoregionInput(' 32b ').value, '9');
});

test('a ZIP code is saved as typed, with a comment pointing at EPA\'s map', () => {
  const result = resolveEcoregionInput('75204');
  assert.equal(result.value, '75204');
  assert.match(result.note, /ZIP code/);
  assert.match(result.note, /epa\.gov/);
});

test('an unrecognized code is saved as typed, with a not-declared warning', () => {
  const result = resolveEcoregionInput('41');
  assert.equal(result.value, '41');
  assert.match(result.note, /not declared/);
  assert.ok(result.note.includes(Object.keys(KNOWN_ECOREGIONS)[0]));
});
