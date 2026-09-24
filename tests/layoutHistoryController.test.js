import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLayoutHistoryController } from '../src/history/layoutHistoryController.js';
import { createPlantFromSpecies, parseSpeciesCsv } from '../src/data/plantParser.js';
import { toPlacement } from '../src/data/placements.js';

const PLANTS_CSV = readFileSync(new URL('../plants.csv', import.meta.url), 'utf8');

/** A controller wired to a fake fetch that records every request. */
function setup(speciesCsv = PLANTS_CSV) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const reply = url.startsWith('/api/layout') ? { entry: { id: 'server-entry' }, cursor: 99 } : { cursor: body?.cursor };
    return { ok: true, json: async () => reply };
  };
  const appState = { species: parseSpeciesCsv(speciesCsv), speciesSynonyms: new Map(), project: { id: 'p' }, plants: [] };
  const fakeButton = () => ({
    disabled: false,
    handler: null,
    addEventListener(type, fn) { this.handler = fn; },
    click() { this.handler(); },
  });
  const undoButton = fakeButton();
  const redoButton = fakeButton();
  const controller = createLayoutHistoryController({
    appState,
    undoButton,
    redoButton,
    historyStatus: null,
    render() {},
    refreshSpeciesTable() {},
  });
  return { controller, appState, calls, undoButton, redoButton };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function plantsAt(xs, speciesCsv = PLANTS_CSV) {
  const holly = parseSpeciesCsv(speciesCsv).find((entry) => entry.speciesId === 'yaupon-holly');
  return xs.map((x, i) => createPlantFromSpecies(holly, { id: `h${i}`, x, y: 1 }));
}

test('the yard is the entry at the cursor: no request, plants built from the catalog', async () => {
  const { controller, calls } = setup();
  const layout = plantsAt([2]);
  const entries = [
    { id: 'e0', description: 'a', plants: plantsAt([1]).map(toPlacement) },
    { id: 'e1', description: 'b', plants: layout.map(toPlacement) },
  ];
  const plants = controller.start({ entries, cursor: 1 });
  await flush();
  assert.deepStrictEqual(plants, layout);
  assert.deepStrictEqual(calls, []);
});

test('the stored cursor is honoured even when it is not the last entry', async () => {
  // Since nl-3s5.3 there is no layout file to move it: the server's cursor is the yard.
  const { controller, calls, redoButton } = setup();
  const entries = [
    { id: 'e0', description: 'a', plants: plantsAt([1]).map(toPlacement) },
    { id: 'e1', description: 'b', plants: plantsAt([2]).map(toPlacement) },
  ];
  const plants = controller.start({ entries, cursor: 0 });
  await flush();
  assert.equal(plants[0].x, 1);
  assert.equal(redoButton.disabled, false, 'redo still reaches the later entry');
  assert.deepStrictEqual(calls, []);
});

test('undo after a catalog change shows the catalog as it is now', async () => {
  // Yaupon holly's width, changed in the catalog after the entries were recorded.
  const hollyRow = PLANTS_CSV.split('\n').find((line) => line.startsWith('yaupon-holly,'));
  assert.ok(hollyRow.includes(',10,18,umbel/head,'), 'fixture: holly is 10 ft wide, 18 ft tall');
  const changedCsv = PLANTS_CSV.replace(hollyRow, hollyRow.replace(',10,18,umbel/head,', ',42,18,umbel/head,'));
  assert.equal(parseSpeciesCsv(changedCsv).find((e) => e.speciesId === 'yaupon-holly').width, 42);

  const { controller, appState, calls, undoButton, redoButton } = setup(changedCsv);
  // Recorded under the old catalog: full legacy objects in entry 0, placements in entry 1.
  const entries = [
    { id: 'e0', description: 'a', plants: plantsAt([1]) },
    { id: 'e1', description: 'b', plants: plantsAt([2]).map(toPlacement) },
  ];
  assert.notEqual(entries[0].plants[0].width, 42);
  appState.plants = controller.start({ entries, cursor: 1 });
  assert.equal(appState.plants[0].width, 42);

  // Undo back to the legacy full-object entry: its stored width is ignored.
  undoButton.click();
  await flush();
  assert.equal(appState.plants[0].x, 1);
  assert.equal(appState.plants[0].width, 42);
  assert.deepStrictEqual(calls.at(-1).body, { cursor: 0 });
  redoButton.click();
  await flush();
  assert.equal(appState.plants[0].x, 2);
  assert.equal(appState.plants[0].width, 42);

  appState.plants = [{ ...appState.plants[0], x: 3 }];
  controller.commit('moved');
  await flush();
  assert.deepStrictEqual(calls.at(-1).body.plants, [{ id: 'h0', speciesId: 'yaupon-holly', x: 3, y: 1 }], 'the POST carries placements only');
  assert.deepStrictEqual(calls.at(-1).body.previousPlants, [{ id: 'h0', speciesId: 'yaupon-holly', x: 2, y: 1 }]);
});

test('a yard with no history yet shows nothing, and its first save seeds the server from empty', async () => {
  const { controller, appState, calls } = setup();
  const plants = controller.start({ entries: [], cursor: -1 });
  await flush();
  assert.deepStrictEqual(plants, []);
  assert.deepStrictEqual(calls, []);

  appState.plants = plantsAt([3]);
  controller.commit('added');
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/layout?project=p');
  // An empty previousPlants is sent, not dropped: the server records it as the
  // 'Initial layout' entry so both stacks keep one index (server/db/projectStore.js).
  assert.deepStrictEqual(calls[0].body.previousPlants, []);
});
