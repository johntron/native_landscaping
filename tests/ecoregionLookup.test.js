import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProbeCache } from '../tools/usda-plants/probeCache.js';
import { lookupEcoregion } from '../tools/ecoregionLookup.mjs';

function tmpCache() {
  const dir = mkdtempSync(join(tmpdir(), 'ecoregion-test-'));
  const probeCache = openProbeCache(join(dir, 'probe-cache.db'));
  return { probeCache, dir };
}

function featureServerBody(code, name) {
  return { features: code == null ? [] : [{ attributes: { LEVEL1: code, NameL1_En: name } }] };
}

test('lookupEcoregion returns the code/name for a matched point (Dallas -> Great Plains, live-verified 2026-09-22)', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => featureServerBody('9', 'Great Plains') });
    try {
      const result = await lookupEcoregion(32.7767, -96.797, { probeCache });
      assert.deepEqual(result, { code: '9', name: 'Great Plains' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookupEcoregion returns null, not a guess, when the point matches no feature', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => featureServerBody(null) });
    try {
      const result = await lookupEcoregion(0, 0, { probeCache });
      assert.equal(result, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookupEcoregion throws on an HTTP error rather than returning a stale/invented answer', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    try {
      await assert.rejects(() => lookupEcoregion(1, 1, { probeCache }), /HTTP 500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookupEcoregion throws on a FeatureServer error body even when HTTP status is 200', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: 'Invalid URL' } }),
    });
    try {
      await assert.rejects(() => lookupEcoregion(1, 1, { probeCache }), /Invalid URL/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookupEcoregion rejects non-finite coordinates', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    await assert.rejects(() => lookupEcoregion(NaN, 1, { probeCache }), /finite lat\/lng/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookupEcoregion caches by rounded coordinates — a nearby repeat lookup does not hit the network again', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    let networkCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      networkCalls += 1;
      return { ok: true, status: 200, json: async () => featureServerBody('9', 'Great Plains') };
    };
    try {
      await lookupEcoregion(32.77669, -96.79701, { probeCache });
      await lookupEcoregion(32.77671, -96.79699, { probeCache }); // rounds to the same 3-decimal key
      assert.equal(networkCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
