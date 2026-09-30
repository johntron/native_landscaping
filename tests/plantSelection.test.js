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

// --- drift context (nl-o47.6.2, nl-o47.6.12) --------------------------------------

function makeDriftAppState() {
  return makeAppState([
    { id: 'wc-1', driftId: 'winecup' },
    { id: 'wc-2', driftId: 'winecup' },
    { id: 'wc-3', driftId: 'winecup' },
    { id: 'hh-1' },
  ]);
}

test('selectPlants with a drift\'s exact full membership enters whole-drift mode', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectPlants(['wc-1', 'wc-2', 'wc-3']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: 'winecup', driftDrilledIn: false });
});

test('selectPlants with one drift member drills in immediately — even COLD, with no prior context (nl-o47.6.12\'s named behaviour change)', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectPlants(['wc-2']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: 'winecup', driftDrilledIn: true });
  assert.deepEqual([...selection.getSelection()], ['wc-2']);
});

test('selectPlants with one drift member of the ALREADY-active drift stays drilled into it', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectPlants(['wc-1', 'wc-2', 'wc-3']);
  selection.selectPlants(['wc-2']); // Details/Clone/the detail sheet all do this
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: 'winecup', driftDrilledIn: true });
  assert.deepEqual([...selection.getSelection()], ['wc-2']);
});

test('selectPlants with a plain plant, or a subset of a drift, carries no drift context', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectPlants(['hh-1']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: '', driftDrilledIn: false });
  selection.selectPlants(['wc-1', 'wc-2']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: '', driftDrilledIn: false });
});

test('selectDrift selects every current member, whole mode', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectDrift('winecup');
  assert.deepEqual([...selection.getSelection()].sort(), ['wc-1', 'wc-2', 'wc-3']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: 'winecup', driftDrilledIn: false });
});

test('clearSelection drops the drift context too', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectDrift('winecup');
  selection.clearSelection();
  assert.equal(selection.getSelection().size, 0);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: '', driftDrilledIn: false });
});

test('pruneSelection resyncs whole-drift ids to the CURRENT membership, not a stale snapshot', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectDrift('winecup'); // ids: wc-1, wc-2, wc-3
  // "+" (src/state/driftEdits.js addDriftMember) added a member elsewhere,
  // without going through this selection.
  appState.plants = [...appState.plants, { id: 'wc-4', driftId: 'winecup' }];
  selection.pruneSelection();
  assert.deepEqual([...selection.getSelection()].sort(), ['wc-1', 'wc-2', 'wc-3', 'wc-4']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: 'winecup', driftDrilledIn: false });
});

test('pruneSelection re-renders when a whole drift\'s membership changed elsewhere, and skips it when nothing did', () => {
  const appState = makeDriftAppState();
  let renders = 0;
  const selection = createPlantSelection({ appState, render: () => { renders += 1; } });
  selection.selectDrift('winecup');
  renders = 0;
  selection.pruneSelection();
  assert.equal(renders, 0, 'membership unchanged: no render');
  appState.plants = [...appState.plants, { id: 'wc-4', driftId: 'winecup' }];
  selection.pruneSelection();
  assert.equal(renders, 1, 'membership grew: one render');
});

test('pruneSelection drops drift context once a drilled-into plant is removed', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectPlants(['wc-2']); // drills in (cold, nl-o47.6.12)
  appState.plants = appState.plants.filter((p) => p.id !== 'wc-2');
  selection.pruneSelection();
  assert.equal(selection.getSelection().size, 0);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: '', driftDrilledIn: false });
});

test('pruneSelection: a whole drift that dissolves (2 -> 1) falls back to the surviving plant, still selected', () => {
  const appState = makeAppState([
    { id: 'a', driftId: 'strip' },
    { id: 'b', driftId: 'strip' },
  ]);
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectDrift('strip');
  // removeDriftMember (src/state/driftEdits.js) drops 'a', and normalizeDrifts
  // (nl-o47.6.12) drops the driftId label from the lone survivor 'b'.
  appState.plants = [{ id: 'b' }];
  selection.pruneSelection();
  assert.deepEqual([...selection.getSelection()], ['b']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: '', driftDrilledIn: false });
});

test('pruneSelection: undoing a 1 -> 2 conversion falls back to the original plant, still selected', () => {
  const appState = makeAppState([
    { id: 'solo', driftId: 'strip' },
    { id: 'new', driftId: 'strip' },
  ]);
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectDrift('strip'); // whole-drift mode, both members
  // Undo removes the new member entirely, reverting to the lone original plant.
  appState.plants = [{ id: 'solo' }];
  selection.pruneSelection();
  assert.deepEqual([...selection.getSelection()], ['solo']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: '', driftDrilledIn: false });
});

test('renaming a drift and re-selecting its (unchanged) plant ids picks up the new driftId', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectDrift('winecup');
  // A drift's own id can still change under the hood (driftEdits.js internals);
  // this only checks selectPlants re-infers context from current plants.
  appState.plants = appState.plants.map((p) => (p.driftId === 'winecup' ? { ...p, driftId: 'front-edge' } : p));
  selection.selectPlants(['wc-1', 'wc-2', 'wc-3']); // same ids, new driftId
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: 'front-edge', driftDrilledIn: false });
});

// --- raw snapshot/restore (nl-o47.6.12, src/export/exportActions.js) --------------

test('getRawSelection/setRawSelection round-trip a whole-drift selection with no render/onSelectionChange', () => {
  const appState = makeDriftAppState();
  let renders = 0;
  const selection = createPlantSelection({ appState, render: () => { renders += 1; } });
  selection.selectDrift('winecup');
  renders = 0;
  const snapshot = selection.getRawSelection();
  assert.deepEqual(snapshot, { driftId: 'winecup', ids: null });

  selection.setRawSelection({ driftId: '', ids: new Set() });
  assert.equal(renders, 0, 'setRawSelection never renders on its own');
  assert.equal(selection.getSelection().size, 0);

  selection.setRawSelection(snapshot);
  assert.equal(renders, 0);
  assert.deepEqual([...selection.getSelection()].sort(), ['wc-1', 'wc-2', 'wc-3']);
  assert.deepEqual(selection.getDriftContext(), { selectedDriftId: 'winecup', driftDrilledIn: false });
});

test('getRawSelection/setRawSelection round-trip a plain-ids selection', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectPlants(['hh-1']);
  const snapshot = selection.getRawSelection();
  assert.deepEqual(snapshot, { driftId: '', ids: new Set(['hh-1']) });

  selection.setRawSelection({ driftId: '', ids: new Set() });
  selection.setRawSelection(snapshot);
  assert.deepEqual([...selection.getSelection()], ['hh-1']);
});

test('getRawSelection copies rather than aliases: mutating the snapshot does not touch the live selection', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  selection.selectPlants(['hh-1']);
  const snapshot = selection.getRawSelection();
  snapshot.ids.add('should-not-leak');
  assert.deepEqual([...selection.getSelection()], ['hh-1']);
});

test('setRawSelection copies rather than aliases: mutating the caller\'s Set afterward does not touch the live selection', () => {
  const appState = makeDriftAppState();
  const selection = createPlantSelection({ appState, render: () => {} });
  const ids = new Set(['hh-1']);
  selection.setRawSelection({ driftId: '', ids });
  ids.add('should-not-leak');
  assert.deepEqual([...selection.getSelection()], ['hh-1']);
});
