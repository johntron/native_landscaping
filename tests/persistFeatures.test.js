import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectFeatures, persistFeatures } from '../src/data/persistence.js';
import { normalizeFeatures } from '../src/data/featureConfig.js';

const RAW_HOUSE = {
  id: 'house',
  type: 'box',
  footprintFt: [
    { x: 8, y: 12 },
    { x: 24, y: 12 },
    { x: 24, y: 20 },
    { x: 8, y: 20 },
  ],
  heightFt: 10,
};

function features() {
  return normalizeFeatures({ features: [RAW_HOUSE] }, 'backyard').features;
}

test('persistFeatures posts the serialized model to the features endpoint', async () => {
  const calls = [];
  const status = [];
  const result = await persistFeatures(features(), (msg, state) => status.push({ msg, state }), {
    projectId: 'backyard',
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ features: [RAW_HOUSE] }) };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/features?project=backyard');
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  // Serialized, not normalized: the supplied style and zero base stay out of the file.
  assert.deepEqual(body.features[0], RAW_HOUSE);
  assert.equal('style' in body.features[0], false);
  assert.deepEqual(status, [{ msg: 'Features saved', state: 'success' }]);
  assert.deepEqual(result, { features: [RAW_HOUSE] });
});

test('persistFeatures surfaces what the server refused, not a bare status code', async () => {
  const status = [];
  const result = await persistFeatures(features(), (msg, state) => status.push({ msg, state }), {
    projectId: 'backyard',
    fetchFn: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Missing features[]' }),
    }),
  });
  assert.equal(result, null);
  assert.deepEqual(status, [{ msg: 'Missing features[]', state: 'error' }]);
});

test('persistFeatures refuses to send anything that is not a list', async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };
  assert.equal(await persistFeatures(null, undefined, { fetchFn }), null);
  assert.equal(await persistFeatures({ features: [] }, undefined, { fetchFn }), null);
  assert.equal(called, false);

  // An empty yard is a legitimate save, though — it is how the last feature goes.
  const calls = [];
  await persistFeatures([], undefined, {
    projectId: 'backyard',
    fetchFn: async (url, opts) => {
      calls.push(opts);
      return { ok: true, json: async () => ({ features: [] }) };
    },
  });
  assert.deepEqual(JSON.parse(calls[0].body), { features: [] });
});

test('loadProjectFeatures normalizes what the endpoint returns', async () => {
  const calls = [];
  const loaded = await loadProjectFeatures(undefined, {
    projectId: 'backyard',
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ features: [RAW_HOUSE] }) };
    },
  });
  assert.equal(calls[0].url, '/api/features?project=backyard');
  assert.equal(calls[0].opts.cache, 'no-store');
  // A response is trusted no more than a file: the drawing reads style and
  // heightFt off every feature, so the defaults have to be filled in here.
  assert.equal(loaded.features[0].style.strokeWidthFt, 0.15);
  assert.equal(loaded.features[0].baseFt, 0);
});

test('loadProjectFeatures degrades to an empty yard rather than failing the boot', async () => {
  const status = [];
  const failed = await loadProjectFeatures((msg, state) => status.push({ msg, state }), {
    projectId: 'backyard',
    fetchFn: async () => ({ ok: false, status: 500, json: async () => null }),
  });
  assert.deepEqual(failed, { features: [] });
  assert.equal(status[0].state, 'error');

  // A malformed body is a load failure too, not something to render.
  const malformed = await loadProjectFeatures(undefined, {
    projectId: 'backyard',
    fetchFn: async () => ({ ok: true, json: async () => ({ features: [{ id: 'no-type' }] }) }),
  });
  assert.deepEqual(malformed, { features: [] });

  // Opened as plain files with no fetch at all, there is nothing to load and
  // nothing to complain about — the yard simply has no features.
  const realFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    const quiet = [];
    assert.deepEqual(await loadProjectFeatures((msg) => quiet.push(msg), { projectId: 'x' }), {
      features: [],
    });
    assert.deepEqual(quiet, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
