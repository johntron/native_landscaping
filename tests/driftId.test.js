import test from 'node:test';
import assert from 'node:assert/strict';
import { driftMemberCountLabel, humanizeDriftId, isValidDriftId, slugifyDriftLabel } from '../src/data/driftId.js';

test('humanizeDriftId turns hyphens to spaces and capitalises the first letter only (nl-o47.6.2)', () => {
  assert.equal(humanizeDriftId('winecup'), 'Winecup');
  assert.equal(humanizeDriftId('winecup-2'), 'Winecup 2');
  assert.equal(humanizeDriftId('front-edge'), 'Front edge');
  assert.equal(humanizeDriftId(''), '');
  assert.equal(humanizeDriftId(null), '');
});

test('humanizeDriftId(slugifyDriftLabel(x)) round-trips a normal label\'s wording', () => {
  assert.equal(humanizeDriftId(slugifyDriftLabel('Front Edge')), 'Front edge');
});

test('isValidDriftId is unaffected (sanity: this file does not touch it)', () => {
  assert.equal(isValidDriftId('winecup-2'), true);
});

test('driftMemberCountLabel humanizes the id and pluralizes the count (nl-o47.6.7)', () => {
  assert.equal(driftMemberCountLabel('winecup', 12), 'Winecup · 12 plants');
  assert.equal(driftMemberCountLabel('winecup', 1), 'Winecup · 1 plant');
  assert.equal(driftMemberCountLabel('front-edge', 0), 'Front edge · 0 plants');
});

test('driftMemberCountLabel returns empty for an unhumanizable id', () => {
  assert.equal(driftMemberCountLabel('', 5), '');
  assert.equal(driftMemberCountLabel(null, 5), '');
});
