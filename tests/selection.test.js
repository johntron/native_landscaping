import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneSelectionIds, selectionsEqual, toSelectionSet } from '../src/state/selection.js';

test('pruneSelectionIds keeps only ids that still name a plant', () => {
  const plants = [{ id: 'a' }, { id: 'b' }];
  const pruned = pruneSelectionIds(new Set(['a', 'c']), plants);
  assert.deepEqual([...pruned], ['a']);
});

test('pruneSelectionIds normalizes ids to strings on both sides', () => {
  const plants = [{ id: 7 }];
  const pruned = pruneSelectionIds(new Set(['7']), plants);
  assert.deepEqual([...pruned], ['7']);
});

test('pruneSelectionIds returns a new Set, never the instance handed in', () => {
  const selection = new Set(['a']);
  const pruned = pruneSelectionIds(selection, [{ id: 'a' }]);
  assert.notEqual(pruned, selection);
  assert.deepEqual([...pruned], ['a']);
});

test('pruneSelectionIds on an empty plant list drops everything', () => {
  assert.equal(pruneSelectionIds(new Set(['a', 'b']), []).size, 0);
});

test('selectionsEqual is true for the same ids regardless of Set insertion order', () => {
  assert.ok(selectionsEqual(new Set(['a', 'b']), new Set(['b', 'a'])));
});

test('selectionsEqual is false when sizes differ', () => {
  assert.ok(!selectionsEqual(new Set(['a']), new Set(['a', 'b'])));
});

test('selectionsEqual is false when sizes match but membership differs', () => {
  assert.ok(!selectionsEqual(new Set(['a']), new Set(['b'])));
});

test('toSelectionSet accepts a single id or a list, and drops blanks', () => {
  assert.deepEqual([...toSelectionSet('a')], ['a']);
  assert.deepEqual([...toSelectionSet(['a', '', null, undefined, 'b'])], ['a', 'b']);
  assert.deepEqual([...toSelectionSet(5)], ['5']);
});
