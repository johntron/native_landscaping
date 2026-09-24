// Fetches and caches the Cloudflare Access signing keys (a JWKS) that
// server/identity.js verifies Cf-Access-Jwt-Assertion tokens against.
//
// This is a third-party call, so it lives in tools/ like every other one; the
// server imports it and calls it at request time. Keys are cached in memory,
// refetched when the TTL lapses or a token names a `kid` we have not seen
// (Cloudflare rotates its keys), and every fetch attempt, successful or not,
// is rate-limited: a forged kid, or Cloudflare being down, must not turn each
// incoming request into an outbound fetch.
//
// Fail closed: with no usable keys (never fetched, or the cache expired and
// the refresh failed) getKey returns null, and the caller treats the request
// as anonymous.
import { createPublicKey } from 'node:crypto';

/** Judgement: Cloudflare rotates Access keys every few weeks; an hour is plenty fresh. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Judgement: at most one fetch attempt per this interval, whatever triggered it. */
export const DEFAULT_MIN_REFETCH_MS = 30 * 1000;
/** Judgement: how long a request may wait on Cloudflare before we give up. */
export const DEFAULT_FETCH_TIMEOUT_MS = 5000;

/**
 * Normalise a team domain as the owner might paste it ("myteam.cloudflareaccess.com",
 * "https://myteam.cloudflareaccess.com/") to the bare host.
 * @param {string | undefined} value
 * @returns {string}
 */
export function normaliseTeamDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** @param {string} teamDomain bare host, see normaliseTeamDomain */
export function certsUrl(teamDomain) {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

/**
 * Turn a JWKS document into a Map of kid -> RSA public KeyObject. Keys that
 * are not RSA, lack a kid, or fail to import are skipped.
 * @param {unknown} jwks
 * @returns {Map<string, import('node:crypto').KeyObject>}
 */
export function parseJwks(jwks) {
  const keys = new Map();
  const list = jwks && typeof jwks === 'object' && Array.isArray(/** @type {any} */ (jwks).keys)
    ? /** @type {any[]} */ (/** @type {any} */ (jwks).keys)
    : [];
  for (const jwk of list) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
    if (jwk.use && jwk.use !== 'sig') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // A malformed key is skipped, not fatal: the others may still be good.
    }
  }
  return keys;
}

/**
 * @typedef {object} AccessCertCacheOptions
 * @property {string} teamDomain e.g. "myteam.cloudflareaccess.com"
 * @property {typeof fetch} [fetchImpl] injectable so tests never touch the network
 * @property {number} [ttlMs]
 * @property {number} [minRefetchMs]
 * @property {number} [fetchTimeoutMs]
 * @property {() => number} [now] milliseconds
 * @property {{ warn: (...args: any[]) => void }} [logger]
 */

/**
 * Create an in-memory cache of the team's Access signing keys.
 * @param {AccessCertCacheOptions} options
 */
export function createAccessCertCache({
  teamDomain,
  fetchImpl = globalThis.fetch,
  ttlMs = DEFAULT_TTL_MS,
  minRefetchMs = DEFAULT_MIN_REFETCH_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  now = Date.now,
  logger = console,
}) {
  const domain = normaliseTeamDomain(teamDomain);
  if (!domain) throw new Error('createAccessCertCache: teamDomain is required');
  const url = certsUrl(domain);

  /** @type {Map<string, import('node:crypto').KeyObject>} */
  let keys = new Map();
  let fetchedAt = -Infinity; // last successful fetch
  let attemptedAt = -Infinity; // last attempt, successful or not
  /** @type {Promise<void> | null} */
  let inFlight = null;

  async function refresh() {
    attemptedAt = now();
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseJwks(await response.json());
      if (parsed.size === 0) throw new Error('no usable RSA keys in response');
      keys = parsed;
      fetchedAt = now();
    } catch (error) {
      logger.warn(`[identity] could not fetch Cloudflare Access certs from ${url}: ${error && /** @type {Error} */ (error).message}`);
    }
  }

  /** Start a fetch unless one is running or one was attempted too recently. */
  function maybeRefresh() {
    if (inFlight) return inFlight;
    if (now() - attemptedAt < minRefetchMs) return null;
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    url,
    /**
     * Resolve the public key for a token's kid, or null when there is none
     * we can vouch for.
     * @param {string} kid
     * @returns {Promise<import('node:crypto').KeyObject | null>}
     */
    async getKey(kid) {
      const expired = now() - fetchedAt >= ttlMs;
      if (expired || !keys.has(kid)) {
        const pending = maybeRefresh();
        if (pending) await pending;
      }
      // Fail closed: an expired cache whose refresh failed yields nothing.
      if (now() - fetchedAt >= ttlMs) return null;
      return keys.get(kid) || null;
    },
  };
}
