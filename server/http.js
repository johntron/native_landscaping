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
// Since nl-3s5.24 the project routes use loadReadableProject (the caller's own
// yard, or the shared example read-only) and loadWritableProject (the caller's
// own yard; 403 for the example) instead; loadOwnedProject remains the
// owner-only primitive.
//
// This mirrors the existing route convention (return true once the request
// has been answered, so server.js's ROUTES loop stops trying handlers) and
// keeps every route's error handling to two lines, instead of each of ten
// routes writing its own try/catch and status codes.
import { isValidProjectId } from '../src/data/projectConfig.js';
import { imageTypeForContentType } from '../src/data/backgroundStore.js';

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
 * Require ctx.user to be an admin (users.is_admin, from server/identity.js).
 * On success returns the user. On failure — anonymous or a signed-in
 * non-admin — writes a 404 JSON response and returns null; the caller should
 * stop handling the request (`return true` from a route).
 *
 * 404, not 403 (nl-3s5.7): these are maintainer-only routes (the plant-data
 * claim store) whose existence a non-admin caller must not be able to infer,
 * the same reasoning loadOwnedProject above already uses for project 404s.
 *
 * @param {{ user: import('../server/identity.js').User | null }} ctx
 * @param {import('node:http').ServerResponse} res
 * @returns {import('../server/identity.js').User | null}
 */
export function requireAdmin(ctx, res) {
  if (ctx.user && ctx.user.isAdmin) return ctx.user;
  json(res, 404, { error: 'Not found' });
  return null;
}

/**
 * Require the caller to be signed in AND to own the project named by `slug`.
 *
 * The lookup is injected as `findProject(ctx, slug) -> { slug, ownerId, ... } | null`
 * so this module stays free of any store. The project routes pass
 * server/db/projectStore.js's findCallerProject, which looks the slug up among
 * ctx.user's own yards in app.db (nl-3s5.3): slugs are unique per owner, so
 * someone else's yard is simply not found.
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
 * Resolve ?project=<slug> for a READ: the caller's own yard, or else the one
 * shared example yard (nl-3s5.24), or the same 401/404 loadOwnedProject gives.
 *
 * The example is an explicit allowlist of one, supplied as `findExample(ctx,
 * slug) -> record | null` (server/db/projectStore.js findExampleFor, which
 * answers only for the example's slug). It is not a visibility value and not
 * an admin bypass: every other yard that is not the caller's stays the
 * identical 404. The caller's own yard is tried first, so a yard a user made
 * with the example's slug before the slug was reserved stays theirs.
 *
 * @param {{ user: import('../server/identity.js').User | null }} ctx
 * @param {import('node:http').ServerResponse} res
 * @param {string} slug
 * @param {{ findProject: (ctx: object, slug: string) => ({ id: number, slug: string, ownerId: number } | null),
 *   findExample: (ctx: object, slug: string) => ({ id: number, slug: string, ownerId: number } | null) }} deps
 * @returns {{ id: number, slug: string, ownerId: number } | null}
 */
export function loadReadableProject(ctx, res, slug, { findProject, findExample }) {
  const user = requireUser(ctx, res);
  if (!user) return null;
  if (isValidProjectId(slug)) {
    const own = findProject(ctx, slug);
    if (own && own.ownerId === user.id) return own;
    const example = findExample(ctx, slug);
    if (example) return example;
  }
  json(res, 404, { error: 'Project not found' });
  return null;
}

/** The body every write to the example yard gets. */
export const EXAMPLE_READ_ONLY_ERROR = 'The example yard is read-only. Copy it to your yards to change it.';

/**
 * Resolve ?project=<slug> for a WRITE: exactly loadReadableProject, then 403
 * when the yard it resolved to is the shared example, whoever the caller is
 * (even a session as the example's system owner). Compared by row id, so a
 * user's own yard that shares the example's slug stays writable and a copy
 * of the example is an ordinary yard.
 *
 * 403, not 404: the example's existence is not a secret (every signed-in
 * user sees it in the picker), and "read-only" is the answer that tells the
 * client what to do next. Any other yard not the caller's is still the 404.
 *
 * @param {{ user: import('../server/identity.js').User | null }} ctx
 * @param {import('node:http').ServerResponse} res
 * @param {string} slug
 * @param {Parameters<typeof loadReadableProject>[3]} deps
 */
export function loadWritableProject(ctx, res, slug, deps) {
  const project = loadReadableProject(ctx, res, slug, deps);
  if (!project) return null;
  const example = deps.findExample(ctx, slug);
  if (example && example.id === project.id) {
    json(res, 403, { error: EXAMPLE_READ_ONLY_ERROR });
    return null;
  }
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

// --- Cross-site request guard (nl-3s5.16) ---------------------------------
//
// collectPayload() above parses any body as JSON regardless of what
// Content-Type says, so a cross-site <form> or a fetch(..., {mode:
// 'no-cors'}) POST — neither of which triggers a CORS preflight, and both of
// which a browser will happily send with Content-Type: text/plain or
// application/x-www-form-urlencoded while attaching the victim's session
// cookie — used to reach every state-changing route. rejectCrossSite() closes
// that gap once, centrally (called from server.js before the ROUTES loop),
// instead of every route module repeating the check.

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// POST /api/view-background (server/routes/project.js) is the one
// state-changing route that isn't a JSON envelope: src/data/backgroundUpload.js
// POSTs the compressed image bytes as the raw body with Content-Type set to
// the image's own MIME type, no JSON wrapper. That route already checks the
// declared type against the sniffed bytes (imageTypeForContentType, from
// src/data/backgroundStore.js); this guard reuses the same allowlist rather
// than keeping a second copy that could drift from it.
const UPLOAD_PATHNAME = '/api/view-background';

/**
 * Media type only, parameters (charset, boundary, ...) and case dropped.
 * @param {string | string[] | undefined} header
 * @returns {string | null}
 */
function mediaType(header) {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const type = value.split(';')[0].trim().toLowerCase();
  return type || null;
}

/**
 * @param {string} origin
 * @returns {string | null} the origin's host[:port], lowercased
 */
function hostFromOrigin(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

// ALLOWED_ORIGINS: an optional comma-separated allowlist of hosts (or full
// origin URLs) this server accepts Origin requests from. Read once at
// module load, like CF_ACCESS_TEAM_DOMAIN in server/identity.js. Unset by
// default: the request's own Host header (below) is what cloudflared
// forwards unmodified from the tunnel edge (see docker-compose.yml's tunnel
// comments), so it already carries the public hostname without any extra
// configuration. This var exists for a deployment where that stops being
// true — a proxy in front that rewrites Host, or one server answering more
// than one hostname — not because Host is expected to lie in this repo's
// setup; the orchestrator should confirm live that a production request's
// Host header does carry the tunnel's public hostname unchanged, since that
// is the one thing here not exercised by a unit test.
const ALLOWED_ORIGIN_HOSTS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => (entry.includes('://') ? hostFromOrigin(entry) : entry.toLowerCase()))
  .filter(Boolean);

/**
 * The CSRF guard for every state-changing request. Two checks, either of
 * which can answer the request and return true:
 *
 * 1. Content-Type must be `application/json` (parameters ignored), or, for
 *    the upload route, one of its three image types. This alone defeats a
 *    plain HTML `<form>` or a `no-cors` fetch: browsers restrict such
 *    "simple" cross-site submissions to a fixed list of content types that
 *    does not include `application/json`, so a forged cross-site POST
 *    either never leaves the browser with that header or never arrives
 *    without a preflight this server doesn't answer with CORS headers.
 *
 * 2. When the browser sent an Origin header, its host must match this
 *    site's own (ALLOWED_ORIGINS if set, else the request's Host header).
 *    Modern Chrome/Firefox/Safari attach Origin to every fetch/XHR that
 *    isn't a simple cross-origin GET — including a same-origin POST from
 *    this app's own pages — so a forged cross-site POST driven by a browser
 *    always has Origin too, naming the attacker's page, not ours.
 *
 *    A request with NO Origin header is let through by this check (not
 *    rejected): that is what a request never driven by a browser looks
 *    like — curl in tools/ scripts, Playwright's `request` fixture in
 *    tests-e2e/ (it does not set Origin on same-origin calls) — and none of
 *    those can be driven by a hostile page holding a victim's session
 *    cookie, which is what this guard defends against. Content-Type (check
 *    1) is what still protects that path: a script can set an arbitrary
 *    Content-Type on its own request, but it cannot make a browser attach
 *    `application/json` to a plain cross-site form or `no-cors` fetch.
 *    `Sec-Fetch-Site`, sent by all three target browsers, is used as a
 *    second signal where present even with no Origin: a value other than
 *    `same-origin` or `none` still fails the request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @returns {boolean} true once a response has been written (415 or 403);
 *   the caller should stop handling the request.
 */
export function rejectCrossSite(req, res, pathname) {
  if (!STATE_CHANGING_METHODS.has(req.method)) return false;

  const contentType = mediaType(req.headers['content-type']);
  const contentTypeOk =
    pathname === UPLOAD_PATHNAME
      ? imageTypeForContentType(req.headers['content-type']) !== null
      : contentType === 'application/json';
  if (!contentTypeOk) {
    json(res, 415, { error: 'Unsupported Content-Type' });
    return true;
  }

  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;

  if (origin) {
    const originHost = hostFromOrigin(origin);
    const hostHeader = req.headers.host;
    const requestHost = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader || '').toLowerCase();
    const allowedHosts = ALLOWED_ORIGIN_HOSTS.length ? ALLOWED_ORIGIN_HOSTS : [requestHost];
    if (!originHost || !allowedHosts.includes(originHost)) {
      json(res, 403, { error: 'Cross-site request rejected' });
      return true;
    }
    return false;
  }

  const secFetchSite = req.headers['sec-fetch-site'];
  const site = Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite;
  if (site && site !== 'same-origin' && site !== 'none') {
    json(res, 403, { error: 'Cross-site request rejected' });
    return true;
  }

  return false;
}
