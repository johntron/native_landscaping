// What the page and the drawer say while a yard's nearby index has no rows to
// show (nl-3s5.6): "no location set" and "building…" are states, not errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeIndexWait } from '../src/ecosystem/plantMatches.view.js';

const yard = { name: 'Backyard' };
const row = { taxon_name: 'Asclepias tuberosa' };

test('no location, queued and building each get their own sentence, and never a manual command', () => {
  assert.match(describeIndexWait({ state: 'no-location' }, [], yard), /has no location set/);
  for (const state of ['queued', 'building']) {
    const text = describeIndexWait({ state }, [], yard);
    assert.match(text, /^Building the index/);
    assert.doesNotMatch(text, /npm run|docker|tools\//);
  }
});

test('a ready index says nothing, even when it found nothing; a failed one only while it has no rows', () => {
  assert.equal(describeIndexWait({ state: 'ready' }, [], yard), null);
  assert.equal(describeIndexWait({ state: 'ready' }, [row], yard), null);
  assert.match(describeIndexWait({ state: 'failed' }, [], yard), /retried automatically/);
  assert.equal(describeIndexWait({ state: 'failed' }, [row], yard), null);
});
