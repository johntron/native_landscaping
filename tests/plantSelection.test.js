import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlantSelection } from '../src/ui/plantSelection.js';

function makeAppState(plants = []) {
  return { plants, selectedPlantIds: new Set() };
}

test('selectPlants replaces the selection and triggers render + onSelectionChange', () => {
  const appState = makeAppState([{ id: 'a' }, { id: 'b' }]);
  let renders = 0;
  let lastChange = null;
  const selection = createPlantSelection({
    appState,
    render: () => { renders += 1; },
    onSelectionChange: (s) => { lastChange = new Set(s); },
  });

  selection.selectPlants(['a']);
  assert.deepEqual([...selection.getSelection()], ['a']);
  assert.equal(renders, 1);
  assert.deepEqual([...lastChange], ['a']);

  selection.selectPlants('b'); // a single id, not just an array
  assert.deepEqual([...selection.getSelection()], ['b']);
  assert.equal(renders, 2);
});

test('selectPlants with the same selection is a no-op (no render, no callback)', () => {
  const appState = makeAppState([{ id: 'a' }]);
  let renders = 0;
  const selection = createPlantSelection({ appState, render: () => { renders += 1; } });
  selection.selectPlants(['a']);
  assert.equal(renders, 1);
  selection.selectPlants(['a']);
  assert.equal(renders, 1); // unchanged
});

test('clearSelection empties the set and is a no-op when already empty', () => {
  const appState = makeAppState([{ id: 'a' }]);
  let renders = 0;
  const selection = createPlantSelection({ appState, render: () => { renders += 1; } });
  selection.clearSelection();
  assert.equal(renders, 0); // already empty
  selection.selectPlants(['a']);
  selection.clearSelection();
  assert.equal(selection.getSelection().size, 0);
  assert.equal(renders, 2);
});

test('pruneSelection drops ids that no longer name a plant', () => {
  const appState = makeAppState([{ id: 'a' }, { id: 'b' }]);
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectPlants(['a', 'b']);
  appState.plants = [{ id: 'b' }]; // 'a' removed elsewhere (e.g. undo/redo/remove)
  selection.pruneSelection();
  assert.deepEqual([...selection.getSelection()], ['b']);
});

test('pruneSelection with nothing to drop does not re-render', () => {
  const appState = makeAppState([{ id: 'a' }]);
  let renders = 0;
  const selection = createPlantSelection({ appState, render: () => { renders += 1; } });
  selection.selectPlants(['a']);
  renders = 0;
  selection.pruneSelection();
  assert.equal(renders, 0);
});
