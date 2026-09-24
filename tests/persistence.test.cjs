const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

async function runPersistenceTest() {
  const modulePath = pathToFileURL(path.join(__dirname, '../src/data/persistence.js')).href;
  const { loadLayoutHistory, persistLayout, updateHistoryCursor } = await import(modulePath);
  const layoutExporterPath = pathToFileURL(
    path.join(__dirname, '../src/data/layoutExporter.js')
  ).href;
  const { buildLayoutCsv } = await import(layoutExporterPath);

  const loadCalls = [];
  const historyStatusMessages = [];
  const historyData = await loadLayoutHistory(
    (msg, state) => historyStatusMessages.push({ msg, state }),
    {
      projectId: 'backyard',
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
  assert.strictEqual(loadCalls[0].url, '/api/history?project=backyard');
  assert.strictEqual(Array.isArray(historyData.entries) ? historyData.entries.length : 0, 1);
  assert.strictEqual(historyStatusMessages[0].state, 'success');

  // History comes back as placements whatever shape the server sent (a legacy
  // full-object snapshot here), and the layout CSV no longer filters it: that
  // reconciliation is src/history/reconcileLayout.js, run by the controller.
  const legacyPlant = {
    id: 'match-plant', speciesId: 'match', botanicalName: 'Match', commonName: 'Match',
    width: 3, growingMonths: [3, 4], x: 1, y: 2,
  };
  const laterPlants = [{ id: 'future-plant', speciesId: 'future', x: 3, y: 4 }];
  const mismatchCsv = buildLayoutCsv([{ id: 'mismatch', speciesId: 'mismatch', x: 9, y: 8 }]);
  const loaded = await loadLayoutHistory(null, {
    layoutCsv: mismatchCsv,
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        entries: [
          { id: 'match', timestamp: '2024-01-01T00:00:00Z', description: 'match', plants: [legacyPlant] },
          { id: 'future', timestamp: '2024-01-02T00:00:00Z', description: 'future', plants: laterPlants },
        ],
        cursor: 1,
      }),
    }),
  });
  assert.strictEqual(loaded.entries.length, 2);
  assert.strictEqual(loaded.cursor, 1);
  assert.deepStrictEqual(loaded.entries[0].plants, [{ id: 'match-plant', speciesId: 'match', x: 1, y: 2 }]);
  assert.strictEqual(loaded.entries[0].description, 'match');

  const persistCalls = [];
  let persistStatusMessage = '';
  const persistFetch = async (url, opts) => {
    persistCalls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ entry: { id: 'persisted-entry' }, cursor: 3 }),
    };
  };
  await persistLayout(
    [{ id: 'plant-1', speciesId: 'sp', commonName: 'Stale', width: 3, x: 1, y: 2 }],
    'manual update',
    (msg, state) => {
      persistStatusMessage = msg;
      historyStatusMessages.push({ msg, state });
    },
    {
      fetchFn: persistFetch,
      projectId: 'backyard',
    }
  );
  assert.strictEqual(persistCalls.length, 1);
  assert.strictEqual(persistCalls[0].url, '/api/layout?project=backyard');
  let body = JSON.parse(persistCalls[0].opts.body);
  assert.strictEqual(body.description, 'manual update');
  assert.deepStrictEqual(body.plants, [{ id: 'plant-1', speciesId: 'sp', x: 1, y: 2 }], 'placements only');
  assert.strictEqual(body.previousPlants, undefined);
  assert.ok(persistStatusMessage.startsWith('Last saved at'));

  await persistLayout(
    [{ id: 'plant-2', x: 2, y: 3 }],
    'manual update 2',
    () => {},
    {
      fetchFn: persistFetch,
      previousPlants: [{ id: 'plant-1', x: 1, y: 2 }],
    }
  );
  assert.strictEqual(persistCalls.length, 2);
  body = JSON.parse(persistCalls[1].opts.body);
  assert.strictEqual(body.description, 'manual update 2');
  assert.deepStrictEqual(body.previousPlants, [{ id: 'plant-1', x: 1, y: 2 }]);

  const cursorCalls = [];
  await updateHistoryCursor(
    5,
    (msg, state) => {
      historyStatusMessages.push({ msg, state });
    },
    {
      projectId: 'backyard',
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
  assert.strictEqual(cursorCalls[0].url, '/api/history/cursor?project=backyard');
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
