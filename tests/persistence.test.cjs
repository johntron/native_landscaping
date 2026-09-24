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

  const earlierPlants = [{ id: 'match-plant', speciesId: 'match', botanicalName: 'Match', x: 1, y: 2 }];
  const laterPlants = [{ id: 'future-plant', speciesId: 'future', botanicalName: 'Future', x: 3, y: 4 }];
  const matchCsv = buildLayoutCsv(laterPlants);
  const historyMatch = await loadLayoutHistory(null, {
    layoutCsv: matchCsv,
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        entries: [
          { id: 'match', timestamp: '2024-01-01T00:00:00Z', description: 'match', plants: earlierPlants },
          { id: 'future', timestamp: '2024-01-02T00:00:00Z', description: 'future', plants: laterPlants },
        ],
        cursor: 1,
      }),
    }),
  });
  assert.strictEqual(Array.isArray(historyMatch.entries) ? historyMatch.entries.length : 0, 2);
  assert.strictEqual(historyMatch.cursor, 1);

  const mismatchCsv = buildLayoutCsv([{ id: 'mismatch', speciesId: 'mismatch', botanicalName: 'Mismatch', x: 9, y: 8 }]);
  const mismatchStatus = [];
  const mismatchResult = await loadLayoutHistory(
    (msg, state) => mismatchStatus.push({ msg, state }),
    {
      layoutCsv: mismatchCsv,
      fetchFn: async () => ({
        ok: true,
    json: async () => ({
      entries: [
        { id: 'seed', timestamp: '2024-01-01T00:00:00Z', description: 'seed', plants: earlierPlants },
      ],
      cursor: 0,
    }),
      }),
    }
  );
  assert.strictEqual(mismatchResult.entries.length, 0);
  assert.strictEqual(mismatchResult.cursor, -1);
  assert.ok(mismatchStatus.some((entry) => entry.msg && entry.msg.includes('diverged')));

  // Removing the last plant is a legitimate layout (nl-a7g), and buildLayoutCsv
  // always writes the header row, so an emptied layout's CSV is never a blank
  // string — the match against history's own last-entry-emptied state must
  // still succeed, not report a false divergence and discard the stack.
  const emptyCsv = buildLayoutCsv([]);
  const emptyStatus = [];
  const emptyResult = await loadLayoutHistory(
    (msg, state) => emptyStatus.push({ msg, state }),
    {
      layoutCsv: emptyCsv,
      fetchFn: async () => ({
        ok: true,
        json: async () => ({
          entries: [
            { id: 'seed', timestamp: '2024-01-01T00:00:00Z', description: 'seed', plants: earlierPlants },
            { id: 'removed', timestamp: '2024-01-02T00:00:00Z', description: 'removed last plant', plants: [] },
          ],
          cursor: 1,
        }),
      }),
    }
  );
  assert.strictEqual(emptyResult.entries.length, 2);
  assert.strictEqual(emptyResult.cursor, 1);
  assert.ok(!emptyStatus.some((entry) => entry.msg && entry.msg.includes('diverged')));

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
    [{ id: 'plant-1', x: 1, y: 2 }],
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
  assert.strictEqual(body.plants.length, 1);
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
