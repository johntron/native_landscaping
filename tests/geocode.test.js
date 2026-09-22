import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProbeCache } from '../tools/usda-plants/probeCache.js';
import { geocodeAddress } from '../tools/geocode.mjs';

function tmpCache() {
  const dir = mkdtempSync(join(tmpdir(), 'geocode-test-'));
  const probeCache = openProbeCache(join(dir, 'probe-cache.db'));
  return { probeCache, dir };
}

function withMockFetch(response, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test('geocodeAddress returns lat/lng plus address details from the first Nominatim result', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    const nominatimResult = [
      {
        lat: '32.7767',
        lon: '-96.7970',
        display_name: 'Dallas, Dallas County, Texas, USA',
        address: { city: 'Dallas', state: 'Texas', country: 'USA' },
      },
    ];
    await withMockFetch(
      { ok: true, status: 200, json: async () => nominatimResult },
      async () => {
        const result = await geocodeAddress('Dallas, TX', { probeCache });
        assert.equal(result.lat, 32.7767);
        assert.equal(result.lng, -96.797);
        assert.equal(result.city, 'Dallas');
        assert.equal(result.state, 'Texas');
        assert.equal(result.country, 'USA');
        assert.equal(result.displayName, 'Dallas, Dallas County, Texas, USA');
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('geocodeAddress throws when Nominatim finds nothing', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    await withMockFetch({ ok: true, status: 200, json: async () => [] }, async () => {
      await assert.rejects(() => geocodeAddress('nowhere at all', { probeCache }), /found nothing/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('geocodeAddress rejects an empty query without making a request', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => [] };
    };
    try {
      await assert.rejects(() => geocodeAddress('   ', { probeCache }), /non-empty query/);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('geocodeAddress caches by query text — a repeated lookup does not hit the network again', async () => {
  const { probeCache, dir } = tmpCache();
  try {
    let networkCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      networkCalls += 1;
      return { ok: true, status: 200, json: async () => [{ lat: '1', lon: '2', display_name: 'x', address: {} }] };
    };
    try {
      await geocodeAddress('Some Address', { probeCache });
      await geocodeAddress('Some Address', { probeCache });
      assert.equal(networkCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
