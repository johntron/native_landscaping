// Covers the request helpers added for nl-3s5.15: json(), requireUser,
// loadOwnedProject, and the rate limiter. These are not wired into any route
// yet (later beads do that); this only pins down the helpers' own contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  json,
  requireUser,
  loadOwnedProject,
  createRateLimiter,
  enforceRateLimit,
  rateLimitKeyFor,
} from '../server/http.js';

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

test('json() writes the status, content type, and JSON body', () => {
  const res = makeRes();
  json(res, 201, { ok: true });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('requireUser returns the user when ctx.user is set, writes nothing', () => {
  const res = makeRes();
  const user = { id: 1, email: 'a@example.com', isAdmin: false };
  const result = requireUser({ user }, res);
  assert.equal(result, user);
  assert.equal(res.ended, false);
});

test('requireUser answers 401 and returns null when ctx.user is null', () => {
  const res = makeRes();
  const result = requireUser({ user: null }, res);
  assert.equal(result, null);
  assert.equal(res.statusCode, 401);
  assert.ok(JSON.parse(res.body).error);
});

test('loadOwnedProject returns the project for its owner', () => {
  const res = makeRes();
  const user = { id: 7, email: 'owner@example.com', isAdmin: false };
  const record = { slug: 'my-yard', ownerId: 7 };
  const findProject = () => record;
  const result = loadOwnedProject({ user }, res, 'my-yard', { findProject });
  assert.equal(result, record);
  assert.equal(res.ended, false);
});

test('loadOwnedProject answers 404 for a project that does not exist', () => {
  const res = makeRes();
  const user = { id: 7, email: 'owner@example.com', isAdmin: false };
  const findProject = () => null;
  const result = loadOwnedProject({ user }, res, 'ghost-yard', { findProject });
  assert.equal(result, null);
  assert.equal(res.statusCode, 404);
});

test('loadOwnedProject answers 404, not 403, for someone else\'s project', () => {
  const res = makeRes();
  const user = { id: 7, email: 'not-the-owner@example.com', isAdmin: false };
  const record = { slug: 'their-yard', ownerId: 99 };
  const findProject = () => record;
  const result = loadOwnedProject({ user }, res, 'their-yard', { findProject });
  assert.equal(result, null);
  assert.equal(res.statusCode, 404);
});

test('loadOwnedProject gives the identical 404 body for missing vs. unowned', () => {
  const missingRes = makeRes();
  const unownedRes = makeRes();
  const user = { id: 7, email: 'u@example.com', isAdmin: false };
  loadOwnedProject({ user }, missingRes, 'ghost-yard', { findProject: () => null });
  loadOwnedProject({ user }, unownedRes, 'their-yard', {
    findProject: () => ({ slug: 'their-yard', ownerId: 99 }),
  });
  assert.equal(missingRes.statusCode, unownedRes.statusCode);
  assert.equal(missingRes.body, unownedRes.body);
});

test('loadOwnedProject admin does not bypass ownership', () => {
  const res = makeRes();
  const admin = { id: 1, email: 'admin@example.com', isAdmin: true };
  const record = { slug: 'their-yard', ownerId: 99 };
  const result = loadOwnedProject({ user: admin }, res, 'their-yard', { findProject: () => record });
  assert.equal(result, null);
  assert.equal(res.statusCode, 404);
});

test('loadOwnedProject answers 401 when anonymous, before touching findProject', () => {
  const res = makeRes();
  let called = false;
  const findProject = () => {
    called = true;
    return null;
  };
  const result = loadOwnedProject({ user: null }, res, 'my-yard', { findProject });
  assert.equal(result, null);
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test('loadOwnedProject answers 404 for an invalid slug without calling findProject', () => {
  const res = makeRes();
  const user = { id: 7, email: 'u@example.com', isAdmin: false };
  let called = false;
  const findProject = () => {
    called = true;
    return null;
  };
  const result = loadOwnedProject({ user }, res, '../etc/passwd', { findProject });
  assert.equal(result, null);
  assert.equal(res.statusCode, 404);
  assert.equal(called, false);
});

test('rate limiter allows requests up to capacity, then 429s with Retry-After', () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => nowMs });

  const first = limiter.take('user:1');
  const second = limiter.take('user:1');
  const third = limiter.take('user:1');
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, true);

  const fourth = limiter.take('user:1');
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterSeconds > 0);

  const res = makeRes();
  const allowed = enforceRateLimit(limiter, 'user:1', res);
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) > 0);
  assert.ok(JSON.parse(res.body).error);
});

test('rate limiter refills over time', () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => nowMs });

  assert.equal(limiter.take('k').allowed, true);
  assert.equal(limiter.take('k').allowed, true);
  assert.equal(limiter.take('k').allowed, false);

  nowMs += 1000; // one second passes: one token refills
  const result = limiter.take('k');
  assert.equal(result.allowed, true);

  const next = limiter.take('k');
  assert.equal(next.allowed, false);
});

test('rate limiter buckets are isolated per key', () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => nowMs });

  assert.equal(limiter.take('user:1').allowed, true);
  assert.equal(limiter.take('user:1').allowed, false);
  // A different key has its own bucket, unaffected by user:1's exhaustion.
  assert.equal(limiter.take('user:2').allowed, true);
});

test('rate limiter prunes idle buckets', () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 1, now: () => nowMs, idleMs: 1000 });

  limiter.take('stale');
  assert.equal(limiter.size(), 1);

  nowMs += 500;
  limiter.take('fresh');
  assert.equal(limiter.size(), 2);

  nowMs += 600; // stale's last activity is now 1100ms ago (> idleMs); fresh's is 600ms ago
  limiter.prune();
  assert.equal(limiter.size(), 1);
});

test('rateLimitKeyFor uses the user id when signed in, else the remote address', () => {
  const req = { socket: { remoteAddress: '203.0.113.5' } };
  assert.equal(rateLimitKeyFor({ user: { id: 42 } }, req), 'user:42');
  assert.equal(rateLimitKeyFor({ user: null }, req), 'ip:203.0.113.5');
});

test('rateLimitKeyFor falls back when remote address is unavailable', () => {
  assert.equal(rateLimitKeyFor({ user: null }, { socket: {} }), 'ip:unknown');
});
