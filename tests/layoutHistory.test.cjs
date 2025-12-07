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
