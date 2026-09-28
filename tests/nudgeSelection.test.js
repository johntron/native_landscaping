import test from 'node:test';
import assert from 'node:assert/strict';
import { NUDGE_STEP_FT, nudgeSelection } from '../src/state/nudgeSelection.js';

function state(plants) {
  return { plants };
}

test('nudgeSelection moves the selected plant north by the step (y increases north)', () => {
  const s = state([{ id: 'a', x: 5, y: 5 }]);
  const moved = nudgeSelection(s, new Set(['a']), 'N', null);
  assert.equal(moved, true);
  assert.equal(s.plants[0].x, 5);
  assert.equal(s.plants[0].y, 5 + NUDGE_STEP_FT);
});

test('nudgeSelection moves south, east, and west by the step on the right axis', () => {
  const fresh = () => state([{ id: 'a', x: 5, y: 5 }]);
  let s = fresh();
  nudgeSelection(s, new Set(['a']), 'S', null);
  assert.equal(s.plants[0].y, 5 - NUDGE_STEP_FT);
  assert.equal(s.plants[0].x, 5);

  s = fresh();
  nudgeSelection(s, new Set(['a']), 'E', null);
  assert.equal(s.plants[0].x, 5 + NUDGE_STEP_FT);
  assert.equal(s.plants[0].y, 5);

  s = fresh();
  nudgeSelection(s, new Set(['a']), 'W', null);
  assert.equal(s.plants[0].x, 5 - NUDGE_STEP_FT);
  assert.equal(s.plants[0].y, 5);
});

test('nudgeSelection moves every selected plant by the same delta (group, keeps shape)', () => {
  const s = state([
    { id: 'a', x: 1, y: 1 },
    { id: 'b', x: 9, y: 4 },
    { id: 'c', x: 3, y: 3 }, // not selected
  ]);
  nudgeSelection(s, new Set(['a', 'b']), 'E', null);
  assert.equal(s.plants[0].x, 1 + NUDGE_STEP_FT);
  assert.equal(s.plants[1].x, 9 + NUDGE_STEP_FT);
  assert.equal(s.plants[2].x, 3); // untouched
});

test('nudgeSelection clamps to the yard as a group, and reports no move when pinned', () => {
  const s = state([{ id: 'a', x: 9.9, y: 5 }]);
  const bounds = { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } };
  const moved = nudgeSelection(s, new Set(['a']), 'E', bounds);
  assert.equal(moved, true);
  assert.equal(s.plants[0].x, 10); // clamped to the edge, not a full step past it

  const secondMove = nudgeSelection(s, new Set(['a']), 'E', bounds);
  assert.equal(secondMove, false); // already pinned; nothing to commit
});

test('nudgeSelection is a no-op with an empty selection or an unknown direction', () => {
  const s = state([{ id: 'a', x: 5, y: 5 }]);
  assert.equal(nudgeSelection(s, new Set(), 'N', null), false);
  assert.equal(nudgeSelection(s, new Set(['a']), 'UP', null), false);
  assert.equal(s.plants[0].x, 5);
  assert.equal(s.plants[0].y, 5);
});

test('nudgeSelection ignores an id in the selection that names no plant', () => {
  const s = state([{ id: 'a', x: 5, y: 5 }]);
  const moved = nudgeSelection(s, new Set(['a', 'ghost']), 'N', null);
  assert.equal(moved, true);
  assert.equal(s.plants[0].y, 5 + NUDGE_STEP_FT);
});
