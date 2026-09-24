// Request-body readers, plus the auth/ownership/rate-limit helpers shared by
// every route module.
//
// Error contract (nl-3s5.15): requireUser and loadOwnedProject each either
// return the value the caller asked for, or write the whole HTTP response
// themselves (401 or 404, JSON body) and return null. A route composes them
// like:
//
//   const user = requireUser(ctx, res);
//   if (!user) return true; // response already sent
//
//   const project = loadOwnedProject(ctx, res, slug, { findProject });
//   if (!project) return true;
//
// This mirrors the existing route convention (return true once the request
// has been answered, so server.js's ROUTES loop stops trying handlers) and
// keeps every route's error handling to two lines, instead of each of ten
// routes writing its own try/catch and status codes.
import { isValidProjectId } from '../src/data/projectConfig.js';

/**
 * Send a JSON response. The one place every route's response body goes
 * through, so the Content-Type header and JSON.stringify call aren't
 * repeated per route.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body serialised as the JSON response body
 */
export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Require ctx.user to be set (server.js resolves it from the Cloudflare
 * Access JWT before any route runs; see server/identity.js). On success
 * returns the user. On failure writes a 401 JSON response and returns null;
 * the caller should stop handling the request (`return true` from a route).
 *
 * @param {{ user: import('../server/identity.js').User | null }} ctx
 * @param {import('node:http').ServerResponse} res
 * @returns {import('../server/identity.js').User | null}
 */
export function requireUser(ctx, res) {
  if (ctx.user) return ctx.user;
  json(res, 401, { error: 'Authentication required' });
  return null;
}

/**
 * Require the caller to be signed in AND to own the project named by `slug`.
 *
 * Ownership doesn't exist on disk yet (yards still live under projects/<slug>/;
 * nl-3s5.3 moves them into app.db with an owner column). So the lookup is
 * injected as `findProject(ctx, slug) -> { slug, ownerId, ... } | null`,
 * rather than this module reaching into a store that doesn't exist yet.
 *
 * A missing project, someone else's project, and a malformed slug all answer
 * with the identical 404 body below: the caller (anonymous or not the owner)
 * must not be able to tell a real slug they don't own from one that was never
 * created. Admins do NOT bypass this — the owner decided "one owner per yard
 * for now" — so if that ever changes it needs its own bead and its own
 * comment here explaining why.
 *
 * On success returns the project record `findProject` produced. On failure
 * writes the response (401 if anonymous, 404 otherwise) and returns null;
 * the caller should stop handling the request.
 *
 * @param {{ user: import('../server/identity.js').User | null }} ctx
 * @param {import('node:http').ServerResponse} res
 * @param {string} slug
 * @param {{ findProject: (ctx: object, slug: string) => ({ slug: string, ownerId: number } | null) }} deps
 * @returns {{ slug: string, ownerId: number } | null}
 */
export function loadOwnedProject(ctx, res, slug, { findProject }) {
  const user = requireUser(ctx, res);
  if (!user) return null;

  const notFound = () => {
    json(res, 404, { error: 'Project not found' });
    return null;
  };

  if (!isValidProjectId(slug)) return notFound();

  const project = findProject(ctx, slug);
  if (!project || project.ownerId !== user.id) return notFound();

  return project;
}

/**
 * An in-memory token-bucket rate limiter, keyed per caller (a user id, or a
 * remote address for anonymous requests — see `rateLimitKeyFor`).
 *
 * The bucket refills continuously (fractional tokens accrue between calls)
 * rather than on a fixed tick, so a burst right after refill isn't
 * double-counted against a burst right before it.
 *
 * `capacity` and `refillPerSecond` are judgement calls, not measured limits;
 * callers should say in a comment why they picked their numbers, the way
 * this module can't for a limiter it doesn't own the call site of.
 *
 * @param {object} [options]
 * @param {number} [options.capacity] judgement call: max tokens (and max
 *   burst) per key. Default 20.
 * @param {number} [options.refillPerSecond] judgement call: tokens/second
 *   added back. Default 1 (a token every 10s at capacity 20 reaches full).
 * @param {() => number} [options.now] injectable clock, in ms. Defaults to
 *   Date.now so callers don't need to fake time in production.
 * @param {number} [options.idleMs] a bucket untouched for this long is
 *   eligible for `prune()`. Default 30 minutes: long enough that a slow
 *   but active user never gets pruned mid-session, short enough that an
 *   abandoned key doesn't sit in memory forever.
 */
export function createRateLimiter({
  capacity = 20,
  refillPerSecond = 1,
  now = Date.now,
  idleMs = 30 * 60 * 1000,
} = {}) {
  /** @type {Map<string, { tokens: number, lastRefillMs: number }>} */
  const buckets = new Map();

  function refill(bucket, nowMs) {
    const elapsedSeconds = Math.max(0, nowMs - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.lastRefillMs = nowMs;
  }

  return {
    /**
     * Try to spend `cost` tokens (default 1) from `key`'s bucket.
     * @param {string} key
     * @param {number} [cost]
     * @returns {{ allowed: boolean, retryAfterSeconds: number }} retryAfterSeconds
     *   is 0 when allowed, otherwise how long until enough tokens accrue.
     */
    take(key, cost = 1) {
      const nowMs = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: capacity, lastRefillMs: nowMs };
        buckets.set(key, bucket);
      }
      refill(bucket, nowMs);

      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const deficit = cost - bucket.tokens;
      const retryAfterSeconds = Math.ceil(deficit / refillPerSecond);
      return { allowed: false, retryAfterSeconds };
    },

    /**
     * Drop buckets whose last activity is older than `idleMs`, so a limiter
     * that runs for the life of the process doesn't grow one entry per
     * visitor forever. Call this on a timer (or per-request, sampled) from
     * the route that owns the limiter — this module doesn't schedule one
     * itself, to stay testable without a live timer.
     */
    prune() {
      const nowMs = now();
      for (const [key, bucket] of buckets) {
        if (nowMs - bucket.lastRefillMs > idleMs) buckets.delete(key);
      }
    },

    /** Test/introspection only: how many keys currently have a bucket. */
    size() {
      return buckets.size;
    },
  };
}

/**
 * Apply a rate limiter to a request: on exhaustion, writes a 429 JSON
 * response with Retry-After and returns false. On success, returns true and
 * writes nothing, leaving the route free to keep handling the request.
 *
 * @param {ReturnType<typeof createRateLimiter>} limiter
 * @param {string} key
 * @param {import('node:http').ServerResponse} res
 * @param {number} [cost]
 * @returns {boolean}
 */
export function enforceRateLimit(limiter, key, res, cost = 1) {
  const { allowed, retryAfterSeconds } = limiter.take(key, cost);
  if (!allowed) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    json(res, 429, { error: 'Too many requests', retryAfterSeconds });
    return false;
  }
  return true;
}

/**
 * The key a rate limiter should bucket a request under: the signed-in
 * user's id when there is one, otherwise the remote address, so anonymous
 * traffic is still throttled per client rather than pooled into one bucket.
 *
 * Behind the tunnel every request arrives from the cloudflared container, so
 * the socket address alone would pool all anonymous visitors into one bucket.
 * Cloudflare's Cf-Connecting-IP carries the visitor's address; it is
 * forgeable only by something already on this host, which is acceptable for
 * a rate-limit key (never use it for authorization).
 *
 * @param {{ user: import('../server/identity.js').User | null }} ctx
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function rateLimitKeyFor(ctx, req) {
  if (ctx.user) return `user:${ctx.user.id}`;
  const forwarded = req.headers?.['cf-connecting-ip'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.socket?.remoteAddress;
  return `ip:${ip || 'unknown'}`;
}

export async function collectPayload(req, options = {}) {
  const { requirePlants = true } = options;
  const body = await collectRequestBody(req);
  if (!body) {
    throw new Error('Request body is empty');
  }
  const parsed = JSON.parse(body);
  if (requirePlants && !Array.isArray(parsed.plants)) {
    throw new Error('Missing plant list');
  }
  return parsed;
}

/**
 * Read a request body as bytes, refusing one that grows past `limit`.
 *
 * The cap is checked as chunks arrive, not at the end: a check in the 'end'
 * handler has already buffered whatever was sent. Content-Length is not
 * consulted at all — it is a claim, and the accumulated length is a fact.
 */
export function collectBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        // Pause rather than destroy: the socket has to stay alive long enough
        // to carry the 413 back, or the client sees a dropped connection and
        // has no idea why. server.js destroys it once the response is out.
        req.pause();
        const err = new Error(`Image is larger than ${Math.round(limit / 1024 / 1024)} MB`);
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
