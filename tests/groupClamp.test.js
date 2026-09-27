import test from 'node:test';
import assert from 'node:assert/strict';
import { clampGroupAxisDelta, clampGroupDelta } from '../src/render/groupClamp.js';

test('clampGroupAxisDelta passes a delta through unchanged when the whole group stays in bounds', () => {
  assert.equal(clampGroupAxisDelta([2, 5, 8], 3, { min: 0, max: 20 }), 3);
});

test('clampGroupAxisDelta shrinks a positive delta so the group\'s farthest member stops at the max', () => {
  // Members at 2, 5, 8; bounds 0..10; a +5 move would push 8 to 13.
  assert.equal(clampGroupAxisDelta([2, 5, 8], 5, { min: 0, max: 10 }), 2);
});

test('clampGroupAxisDelta shrinks a negative delta so the group\'s nearest member stops at the min', () => {
  // Members at 2, 5, 8; bounds 0..10; a -5 move would push 2 to -3.
  assert.equal(clampGroupAxisDelta([2, 5, 8], -5, { min: 0, max: 10 }), -2);
});

test('clampGroupAxisDelta on a single-member group reduces to the plain single-value clamp', () => {
  assert.equal(clampGroupAxisDelta([9], 5, { min: 0, max: 10 }), 1);
  assert.equal(clampGroupAxisDelta([9], -20, { min: 0, max: 10 }), -9);
});

test('clampGroupAxisDelta with no members proposes no move', () => {
  assert.equal(clampGroupAxisDelta([], 5, { min: 0, max: 10 }), 0);
});

test('clampGroupAxisDelta keeps the group\'s shape: the same clamp applies to every member', () => {
  const values = [2, 5, 8];
  const delta = clampGroupAxisDelta(values, 5, { min: 0, max: 10 });
  const moved = values.map((v) => v + delta);
  assert.deepEqual(moved, [4, 7, 10]); // spacing (3 apart) preserved, farthest pinned to the bound
});

test('clampGroupDelta clamps each axis independently, so a diagonal move is never bent to one side', () => {
  const positions = [
    { x: 1, y: 1 },
    { x: 9, y: 2 },
  ];
  const bounds = { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } };
  // x would push the group's max (9) to 14; y has plenty of room.
  const clamped = clampGroupDelta(positions, { x: 5, y: 5 }, bounds);
  assert.deepEqual(clamped, { x: 1, y: 5 });
});

test('clampGroupDelta on an already-fitting move returns it unchanged', () => {
  const positions = [{ x: 3, y: 3 }];
  const bounds = { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } };
  assert.deepEqual(clampGroupDelta(positions, { x: 1, y: -1 }, bounds), { x: 1, y: -1 });
});
