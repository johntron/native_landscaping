import test from 'node:test';
import assert from 'node:assert/strict';
import { persistProjectConfig } from '../src/data/persistence.js';
import { normalizeProjectConfig } from '../src/data/projectConfig.js';

function makeConfig() {
  return normalizeProjectConfig(
    {
      name: 'Backyard',
      views: [
        {
          id: 'plan',
          type: 'plan',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          background: 'img/top.webp',
        },
      ],
    },
    'backyard'
  );
}

test('persistProjectConfig posts the serialized config to the project endpoint', async () => {
  const calls = [];
  const status = [];
  const result = await persistProjectConfig(makeConfig(), (msg, state) => status.push({ msg, state }), {
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ config: { id: 'backyard' } }) };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/project?project=backyard');
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  // Serialized, not normalized: the default label and zero origin stay out of the file.
  assert.equal('label' in body.views[0], false);
  assert.equal('originFt' in body.views[0], false);
  assert.deepEqual(body.views[0].extentFt, { width: 40, height: 30 });
  assert.deepEqual(status, [{ msg: 'Views saved', state: 'success' }]);
  assert.deepEqual(result, { config: { id: 'backyard' } });
});

test('a rejected save surfaces the server message rather than a bare status code', async () => {
  const status = [];
  const result = await persistProjectConfig(makeConfig(), (msg, state) => status.push({ msg, state }), {
    fetchFn: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Project "backyard" view 1 is non-uniformly scaled' }),
    }),
  });
  assert.equal(result, null);
  assert.equal(status[0].state, 'error');
  assert.match(status[0].msg, /non-uniformly scaled/);
});

test('an unreachable server is reported rather than thrown', async () => {
  const status = [];
  const result = await persistProjectConfig(makeConfig(), (msg, state) => status.push({ msg, state }), {
    fetchFn: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal(result, null);
  assert.equal(status[0].state, 'error');
});

test('a body without views[] is not treated as a legacy config', async () => {
  // The legacy {plan, elevations[]} reader is for files on disk. If a POST body
  // reached it, {} would migrate into one blank default plan view, pass every
  // validation, and overwrite the project — with no config history to recover
  // from. The server rejects it; this pins the contract the client relies on.
  const bodies = [];
  await persistProjectConfig(makeConfig(), null, {
    fetchFn: async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.ok(Array.isArray(bodies[0].views) && bodies[0].views.length > 0);
});
