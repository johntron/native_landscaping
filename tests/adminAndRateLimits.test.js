// nl-3s5.7: admin-only claims routes/pages, and rate limits on the routes
// that call a third party (Nominatim, the CEC ecoregion lookup, iNaturalist).
//
// Two concerns, kept in one file because they were added by the same bead:
//  - requireAdmin() (server/http.js) and its wiring into
//    server/routes/claims.js and the isAdminOnlyStaticPath() check server.js
//    runs before the static fallback: a non-admin (including anonymous) must
//    get exactly the 404 an unknown route/file gets, never a 403 that would
//    confirm the thing exists.
//  - the rate limiters module-scoped in server/routes/ecosystem.js
//    (geocode, ecoregion) and server/routes/feed.js (feed/refresh): correct
//    capacity/refill, 429 + Retry-After on exhaustion, and per-key isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireAdmin, createRateLimiter, enforceRateLimit, rateLimitKeyFor } from '../server/http.js';
import { isAdminOnlyStaticPath } from '../server/static.js';
import { handleClaimsRoutes } from '../server/routes/claims.js';
import { openClaimsStore, createSchema } from '../tools/claims/claimsStore.js';
import { handleEcosystemRoutes } from '../server/routes/ecosystem.js';
import { handleFeedRoutes } from '../server/routes/feed.js';
import { openAppDb } from '../server/db/appDb.js';

/** A minimal http.ServerResponse stand-in that records what was sent. */
function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

function tempClaimsDb() {
  const dir = mkdtempSync(join(tmpdir(), 'admin-rate-limits-test-'));
  const db = openClaimsStore(join(dir, 'claims.db'));
  createSchema(db);
  return { db, dir };
}

function stubClaimsRequest(pathnameAndQuery, method, db, user) {
  const url = new URL(`http://localhost${pathnameAndQuery}`);
  const req = { method, headers: { 'content-type': 'application/json' } };
  const res = makeRes();
  const ctx = { url, pathname: url.pathname, publicDir: '/tmp', db: { claims: () => db }, user };
  return { req, res, ctx };
}

const ADMIN = { id: 1, email: 'admin@example.com', isAdmin: true };
const NON_ADMIN = { id: 2, email: 'member@example.com', isAdmin: false };

// --- requireAdmin -----------------------------------------------------------

test('requireAdmin returns the user and writes nothing for an admin', () => {
  const res = makeRes();
  const result = requireAdmin({ user: ADMIN }, res);
  assert.equal(result, ADMIN);
  assert.equal(res.ended, false);
});

test('requireAdmin answers 404 (not 403) for a signed-in non-admin', () => {
  const res = makeRes();
  const result = requireAdmin({ user: NON_ADMIN }, res);
  assert.equal(result, null);
  assert.equal(res.statusCode, 404);
});

test('requireAdmin answers 404 for an anonymous caller', () => {
  const res = makeRes();
  const result = requireAdmin({ user: null }, res);
  assert.equal(result, null);
  assert.equal(res.statusCode, 404);
});

// --- claims API routes -------------------------------------------------------

test('an admin gets 200 from GET /api/claims-coverage', async () => {
  const { db, dir } = tempClaimsDb();
  try {
    const { req, res, ctx } = stubClaimsRequest('/api/claims-coverage', 'GET', db, ADMIN);
    const handled = await handleClaimsRoutes(req, res, ctx);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { rows: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an admin gets 200 from GET /api/claims-conflicts', async () => {
  const { db, dir } = tempClaimsDb();
  try {
    const { req, res, ctx } = stubClaimsRequest('/api/claims-conflicts', 'GET', db, ADMIN);
    const handled = await handleClaimsRoutes(req, res, ctx);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { rows: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, user] of [['a non-admin', NON_ADMIN], ['an anonymous caller', null]]) {
  test(`${label} gets 404 from GET /api/claims-coverage`, async () => {
    const { db, dir } = tempClaimsDb();
    try {
      const { req, res, ctx } = stubClaimsRequest('/api/claims-coverage', 'GET', db, user);
      const handled = await handleClaimsRoutes(req, res, ctx);
      assert.equal(handled, true);
      assert.equal(res.statusCode, 404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${label} gets 404 from GET /api/claims-conflicts`, async () => {
    const { db, dir } = tempClaimsDb();
    try {
      const { req, res, ctx } = stubClaimsRequest('/api/claims-conflicts', 'GET', db, user);
      const handled = await handleClaimsRoutes(req, res, ctx);
      assert.equal(handled, true);
      assert.equal(res.statusCode, 404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${label} gets 404 from POST /api/claims-correct`, async () => {
    const { db, dir } = tempClaimsDb();
    try {
      const { req, res, ctx } = stubClaimsRequest('/api/claims-correct', 'POST', db, user);
      const handled = await handleClaimsRoutes(req, res, ctx);
      assert.equal(handled, true);
      assert.equal(res.statusCode, 404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a path outside the claims API is left unhandled regardless of admin status', async () => {
  const { db, dir } = tempClaimsDb();
  try {
    const { req, res, ctx } = stubClaimsRequest('/api/ecosystem', 'GET', db, NON_ADMIN);
    const handled = await handleClaimsRoutes(req, res, ctx);
    assert.equal(handled, false);
    assert.equal(res.ended, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- admin-only static pages -------------------------------------------------

test('isAdminOnlyStaticPath names claims-coverage.html and claims-conflicts.html', () => {
  assert.equal(isAdminOnlyStaticPath('/claims-coverage.html'), true);
  assert.equal(isAdminOnlyStaticPath('/claims-conflicts.html'), true);
});

test('isAdminOnlyStaticPath leaves every other page alone', () => {
  assert.equal(isAdminOnlyStaticPath('/design.html'), false);
  assert.equal(isAdminOnlyStaticPath('/index.html'), false);
  assert.equal(isAdminOnlyStaticPath('/'), false);
});

// --- rate limiting -----------------------------------------------------------
//
// server.js and the routes only compose createRateLimiter/enforceRateLimit
// (already unit-tested in tests/httpHelpers.test.js) with the specific
// capacity/refill each route module chose. What's worth pinning down here is
// those chosen numbers' observable behaviour, not the generic mechanism.

test('a Nominatim-style 1/s limiter (capacity 1, refill 1/s) allows one call and 429s the very next', () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
  const res1 = makeRes();
  assert.equal(enforceRateLimit(limiter, 'ip:1.2.3.4', res1), true);
  assert.equal(res1.ended, false);

  const res2 = makeRes();
  assert.equal(enforceRateLimit(limiter, 'ip:1.2.3.4', res2), false);
  assert.equal(res2.statusCode, 429);
  assert.ok(res2.headers['Retry-After']);
  assert.ok(JSON.parse(res2.body).retryAfterSeconds >= 1);
});

test('the same limiter allows another call once a full second has elapsed', () => {
  let now = 2_000_000;
  const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
  assert.equal(enforceRateLimit(limiter, 'ip:5.6.7.8', makeRes()), true);
  assert.equal(enforceRateLimit(limiter, 'ip:5.6.7.8', makeRes()), false);

  now += 1000; // one second later
  assert.equal(enforceRateLimit(limiter, 'ip:5.6.7.8', makeRes()), true);
});

test('rate limits are tracked per key: exhausting one user leaves another untouched', () => {
  let now = 3_000_000;
  const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
  const keyA = rateLimitKeyFor({ user: { id: 11 } }, { headers: {} });
  const keyB = rateLimitKeyFor({ user: { id: 22 } }, { headers: {} });
  assert.notEqual(keyA, keyB);

  assert.equal(enforceRateLimit(limiter, keyA, makeRes()), true);
  assert.equal(enforceRateLimit(limiter, keyA, makeRes()), false); // A is exhausted
  assert.equal(enforceRateLimit(limiter, keyB, makeRes()), true); // B is untouched
});

test('an ecoregion-style burst limiter (capacity 10, refill 1/s) allows a burst of 10 then 429s', () => {
  let now = 4_000_000;
  const limiter = createRateLimiter({ capacity: 10, refillPerSecond: 1, now: () => now });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(enforceRateLimit(limiter, 'ip:9.9.9.9', makeRes()), true, `call ${i + 1} of 10 should be allowed`);
  }
  const overflow = makeRes();
  assert.equal(enforceRateLimit(limiter, 'ip:9.9.9.9', overflow), false);
  assert.equal(overflow.statusCode, 429);
});

// --- the real module-scoped limiters, through the real route handlers ------
//
// The tests above pin down the chosen capacity/refill numbers in isolation.
// These exercise the actual singleton limiters server/routes/ecosystem.js and
// server/routes/feed.js create at module scope, through handleEcosystemRoutes
// and handleFeedRoutes themselves — proving the limiter is actually wired in
// front of the route, not just correct on its own. Each test uses a unique
// caller (a distinct Cf-Connecting-IP, or a distinct user id) so it can't be
// starved by another test's calls against the same shared bucket.

function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function stubEcosystemRequest(pathnameAndQuery, method, body, headers) {
  const url = new URL(`http://localhost${pathnameAndQuery}`);
  const req = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    on(event, cb) {
      if (event === 'data' && body) cb(Buffer.from(JSON.stringify(body)));
      if (event === 'end') cb();
    },
  };
  const res = makeRes();
  const ctx = { url, pathname: url.pathname, publicDir: '/tmp', db: {}, user: null };
  return { req, res, ctx };
}

test('POST /api/geocode enforces the 1/s Nominatim limiter: two immediate calls, the second is 429', async () => {
  await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => [] }),
    async () => {
      const headers = { 'cf-connecting-ip': '203.0.113.1' };
      const first = stubEcosystemRequest('/api/geocode', 'POST', { query: 'Dallas, TX' }, headers);
      const second = stubEcosystemRequest('/api/geocode', 'POST', { query: 'Dallas, TX' }, headers);

      const handled1 = await handleEcosystemRoutes(first.req, first.res, first.ctx);
      const handled2 = await handleEcosystemRoutes(second.req, second.res, second.ctx);

      assert.equal(handled1, true);
      assert.notEqual(first.res.statusCode, 429);

      assert.equal(handled2, true);
      assert.equal(second.res.statusCode, 429);
      assert.ok(second.res.headers['Retry-After']);
    }
  );
});

test('GET /api/ecoregion is rate-limited per caller: a fresh IP is unaffected by another IP being exhausted', async () => {
  await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) }),
    async () => {
      const exhausted = { 'cf-connecting-ip': '203.0.113.2' };
      const fresh = { 'cf-connecting-ip': '203.0.113.3' };

      // Burn through the exhausted IP's capacity (10) first.
      for (let i = 0; i < 10; i += 1) {
        const { req, res, ctx } = stubEcosystemRequest('/api/ecoregion?lat=32.7&lng=-96.8', 'GET', null, exhausted);
        // eslint-disable-next-line no-await-in-loop
        const handled = await handleEcosystemRoutes(req, res, ctx);
        assert.equal(handled, true);
      }
      const overflow = stubEcosystemRequest('/api/ecoregion?lat=32.7&lng=-96.8', 'GET', null, exhausted);
      assert.equal(await handleEcosystemRoutes(overflow.req, overflow.res, overflow.ctx), true);
      assert.equal(overflow.res.statusCode, 429);

      const freshCall = stubEcosystemRequest('/api/ecoregion?lat=32.7&lng=-96.8', 'GET', null, fresh);
      assert.equal(await handleEcosystemRoutes(freshCall.req, freshCall.res, freshCall.ctx), true);
      assert.notEqual(freshCall.res.statusCode, 429);
    }
  );
});

test('POST /api/feed/refresh rate-limits before touching iNaturalist: exhausting the limiter answers 429 with no saved area required', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-refresh-rate-limit-test-'));
  try {
    const appDb = openAppDb({ dataDir: dir, ownerEmail: '' });
    const db = { app: appDb, observationEvents: {} };
    const user = { id: 987654, email: 'refresh-test@example.com', isAdmin: false };

    function stubRefreshRequest() {
      const url = new URL('http://localhost/api/feed/refresh');
      const body = { areaId: 'no-such-area' };
      const req = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on(event, cb) {
          if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
          if (event === 'end') cb();
        },
      };
      const res = makeRes();
      const ctx = { url, pathname: url.pathname, db, user };
      return { req, res, ctx };
    }

    // Capacity 5: the first 5 calls reach pollSavedAreas (which 404s on the
    // unknown area, without any network call), the 6th never gets that far.
    for (let i = 0; i < 5; i += 1) {
      const { req, res, ctx } = stubRefreshRequest();
      // eslint-disable-next-line no-await-in-loop
      const handled = await handleFeedRoutes(req, res, ctx);
      assert.equal(handled, true);
      assert.equal(res.statusCode, 404, `call ${i + 1} of 5 should reach the route and 404 on the unknown area`);
    }
    const overflow = stubRefreshRequest();
    assert.equal(await handleFeedRoutes(overflow.req, overflow.res, overflow.ctx), true);
    assert.equal(overflow.res.statusCode, 429);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a feed-refresh-style limiter (capacity 5, refill 1/30s) allows 5 refreshes then 429s', () => {
  let now = 5_000_000;
  const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 1 / 30, now: () => now });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(enforceRateLimit(limiter, 'user:1', makeRes()), true, `refresh ${i + 1} of 5 should be allowed`);
  }
  const overflow = makeRes();
  assert.equal(enforceRateLimit(limiter, 'user:1', overflow), false);
  assert.equal(overflow.statusCode, 429);
  assert.ok(overflow.headers['Retry-After']);
});
