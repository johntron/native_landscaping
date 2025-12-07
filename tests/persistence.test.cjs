const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

async function runPersistenceTest() {
const modulePath = pathToFileURL(path.join(__dirname, '../src/data/persistence.js')).href;
  const { loadLayoutHistory, persistLayout, updateHistoryCursor } = await import(modulePath);

  const loadCalls = [];
  const historyStatusMessages = [];
  const historyData = await loadLayoutHistory(
    (msg, state) => historyStatusMessages.push({ msg, state }),
    {
      fetchFn: async (url, opts) => {
        loadCalls.push({ url, opts });
        return {
          ok: true,
          json: async () => ({ entries: [{ id: 'seed', timestamp: '2024-01-01T00:00:00Z', description: 'seed', plants: [] }], cursor: 0 }),
        };
      },
    }
  );
  assert.strictEqual(loadCalls.length, 1);
  assert.strictEqual(Array.isArray(historyData.entries) ? historyData.entries.length : 0, 1);
  assert.strictEqual(historyStatusMessages[0].state, 'success');

  const persistCalls = [];
  let persistStatusMessage = '';
  await persistLayout(
    [{ id: 'plant-1', x: 1, y: 2 }],
    'manual update',
    (msg, state) => {
      persistStatusMessage = msg;
      historyStatusMessages.push({ msg, state });
    },
    {
      fetchFn: async (url, opts) => {
        persistCalls.push({ url, opts });
        return {
          ok: true,
          json: async () => ({ entry: { id: 'persisted-entry' }, cursor: 3 }),
        };
      },
    }
  );
  assert.strictEqual(persistCalls.length, 1);
  const body = JSON.parse(persistCalls[0].opts.body);
  assert.strictEqual(body.description, 'manual update');
  assert.strictEqual(body.plants.length, 1);
  assert.ok(persistStatusMessage.startsWith('Last saved at'));

  const cursorCalls = [];
  await updateHistoryCursor(
    5,
    (msg, state) => {
      historyStatusMessages.push({ msg, state });
    },
    {
      fetchFn: async (url, opts) => {
        cursorCalls.push({ url, opts });
        return {
          ok: true,
          json: async () => ({ entry: { id: 'seed' }, cursor: 5 }),
        };
      },
    }
  );
  assert.strictEqual(cursorCalls.length, 1);
}

module.exports = {
  runPersistenceTest,
};

if (require.main === module) {
  runPersistenceTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
