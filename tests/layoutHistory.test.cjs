const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

async function runLayoutHistoryTest() {
  const modulePath = pathToFileURL(path.join(__dirname, '../src/history/layoutHistory.js')).href;
  const { createLayoutHistory } = await import(modulePath);

  const startPlants = [{ id: 'plant-a', x: 0, y: 0 }];
  const history = createLayoutHistory(startPlants);
  assert.strictEqual(history.canUndo(), false);
  const movedPlants = [{ id: 'plant-a', x: 2, y: 3 }];
  history.record(movedPlants, { description: 'moved' });
  assert.strictEqual(history.canUndo(), true);
  const beforeUndo = history.undo();
  assert.deepStrictEqual(beforeUndo, startPlants);
  assert.strictEqual(history.canRedo(), true);
  const afterRedo = history.redo();
  assert.deepStrictEqual(afterRedo, movedPlants);

  const seedEntry = {
    id: 'seed-1',
    description: 'Initial seed',
    timestamp: '2024-01-01T00:00:00Z',
    plants: [{ id: 'seed-plant', x: 1, y: 1 }],
  };
  const seededHistory = createLayoutHistory([{ id: 'fallback', x: 4, y: 4 }], {
    seedEntries: [seedEntry],
  });
  assert.strictEqual(seededHistory.canUndo(), false);
  assert.deepStrictEqual(seededHistory.getCurrentPlants(), seedEntry.plants);

  // nl-3s5.19: an entry holds placements only. Recording full plant objects
  // keeps id, speciesId, x, y and any optional per-plant field, nothing else,
  // and a legacy full-object seed is reduced the same way.
  const fullPlant = {
    id: 'p1', speciesId: 'sp', commonName: 'Stale', botanicalName: 'Stalus', width: 3,
    growingMonths: [3, 4], foliageColors: { spring: '#000' }, layer: 2, x: 1, y: 2, status: 'planned',
  };
  const placementHistory = createLayoutHistory([], { seedEntries: [{ id: 's', plants: [fullPlant] }] });
  assert.deepStrictEqual(placementHistory.getCurrentPlants(), [{ id: 'p1', speciesId: 'sp', x: 1, y: 2, status: 'planned' }]);
  placementHistory.record([{ ...fullPlant, x: 5 }], { description: 'moved' });
  assert.deepStrictEqual(placementHistory.getCurrentPlants(), [{ id: 'p1', speciesId: 'sp', x: 5, y: 2, status: 'planned' }]);
  assert.deepStrictEqual(placementHistory.undo(), [{ id: 'p1', speciesId: 'sp', x: 1, y: 2, status: 'planned' }]);
  // The server's copy of the entry is adopted, its plants reduced too.
  placementHistory.redo();
  placementHistory.annotateCurrentEntry({ id: 'server-id', plants: [fullPlant] });
  assert.strictEqual(placementHistory.getCurrentEntry().id, 'server-id');
  assert.deepStrictEqual(placementHistory.getCurrentEntry().plants, [{ id: 'p1', speciesId: 'sp', x: 1, y: 2, status: 'planned' }]);
  assert.strictEqual(placementHistory.getEntries()[1].description, 'moved');
}

module.exports = {
  runLayoutHistoryTest,
};

if (require.main === module) {
  runLayoutHistoryTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
