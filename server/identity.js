// Who is making this request? Resolved once per request in server.js and
// attached as ctx.user: `{ id, email, isAdmin }`, or null when anonymous.
//
// The site sits behind Cloudflare Access (Google SSO) through a cloudflared
// tunnel. Access signs a JWT into the Cf-Access-Jwt-Assertion header, and that
// signature is the only thing trusted here. The plain
// Cf-Access-Authenticated-User-Email header is ignored: anything on the host
// (feed-poller, a local shell) can reach web:8080 or 127.0.0.1:8080 directly
// and set any header it likes, but cannot sign as Cloudflare.
//
// This module identifies; it does not authorize. Anonymous requests pass
// through with ctx.user = null, and rejecting them is a later bead
// (nl-3s5.15, nl-3s5.4).
//
// Env:
//   CF_ACCESS_TEAM_DOMAIN  e.g. myteam.cloudflareaccess.com (issuer and certs host)
//   CF_ACCESS_AUD          the Access application's AUD tag
//   DEV_USER_EMAIL         dev/test only: every request is this user, no JWT
//                          needed. Ignored whenever either CF var is set.
import { verify as cryptoVerify } from 'node:crypto';
import { createAccessCertCache, normaliseTeamDomain } from '../tools/accessCerts.js';

export const JWT_HEADER = 'cf-access-jwt-assertion';
/** Judgement: tolerated clock drift between us and Cloudflare, in seconds. */
export const CLOCK_SKEW_SECONDS = 60;

/** @typedef {{ id: number, email: string, isAdmin: boolean }} User */

/**
 * @param {string} segment
 * @returns {any}
 */
function decodeJsonSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Verify a Cloudflare Access JWT and return its payload, or null for any
 * failure. RS256 only: `none`, HS256 (the public-key-as-HMAC-secret attack)
 * and every other alg are rejected before any key is looked up.
 *
 * @param {string} token
 * @param {object} options
 * @param {(kid: string) => Promise<import('node:crypto').KeyObject | null>} options.getKey
 * @param {string} options.issuer e.g. https://myteam.cloudflareaccess.com
 * @param {string} options.audience the application AUD tag
 * @param {number} [options.nowSeconds]
 * @param {number} [options.skewSeconds]
 * @returns {Promise<Record<string, any> | null>}
 */
export async function verifyAccessJwt(token, {
  getKey,
  issuer,
  audience,
  nowSeconds = Math.floor(Date.now() / 1000),
  skewSeconds = CLOCK_SKEW_SECONDS,
}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => BASE64URL.test(p))) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = decodeJsonSegment(headerB64);
    payload = decodeJsonSegment(payloadB64);
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return null;
  if (header.alg !== 'RS256') return null;
  if (typeof header.kid !== 'string' || !header.kid) return null;

  const key = await getKey(header.kid);
  if (!key || key.asymmetricKeyType !== 'rsa') return null;

  const signature = Buffer.from(signatureB64, 'base64url');
  let valid = false;
  try {
    valid = cryptoVerify('sha256', Buffer.from(`${headerB64}.${payloadB64}`), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return null;

  if (payload.iss !== issuer) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience || !aud.includes(audience)) return null;
  if (typeof payload.exp !== 'number' || nowSeconds >= payload.exp + skewSeconds) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || nowSeconds < payload.nbf - skewSeconds)) return null;
  if (payload.iat !== undefined && (typeof payload.iat !== 'number' || payload.iat > nowSeconds + skewSeconds)) return null;
  return payload;
}

/**
 * Find or create the users row for a verified email. Access policy membership
 * is the invite list, so first sight creates the row; is_admin is never
 * written here (OWNER_EMAIL seeding in appDb.js is the only path to admin).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} rawEmail
 * @returns {User | null}
 */
export function upsertUser(db, rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return null;
  const select = db.prepare('SELECT id, email, is_admin FROM users WHERE email = ?');
  // Read first: this runs on every request, static files included, and a
  // known user (the usual case) should cost no write.
  let row = /** @type {any} */ (select.get(email));
  if (!row) {
    db.prepare(
      'INSERT INTO users (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING'
    ).run(email, new Date().toISOString());
    row = select.get(email);
  }
  return row ? { id: Number(row.id), email: row.email, isAdmin: Boolean(row.is_admin) } : null;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
function readJwtHeader(req) {
  const value = req.headers[JWT_HEADER];
  const token = Array.isArray(value) ? value[0] : value;
  return token ? token.trim() : null;
}

/**
 * Build the per-request identity resolver. Call once at startup (that is
 * when the configuration warnings are logged), then `await identify(req, db)`
 * per request. The returned function never throws: any failure logs and
 * yields null (anonymous).
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now] milliseconds
 * @param {{ warn: (...a: any[]) => void, error: (...a: any[]) => void }} [options.logger]
 * @param {ReturnType<typeof createAccessCertCache>} [options.certCache] override, for tests
 * @returns {(req: import('node:http').IncomingMessage, db: import('node:sqlite').DatabaseSync) => Promise<User | null>}
 */
export function createIdentity({
  env = process.env,
  fetchImpl,
  now = Date.now,
  logger = console,
  certCache,
} = {}) {
  const teamDomain = normaliseTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const audience = String(env.CF_ACCESS_AUD || '').trim();
  const accessConfigured = Boolean(teamDomain && audience);
  let devEmail = String(env.DEV_USER_EMAIL || '').trim().toLowerCase();

  if (devEmail && (teamDomain || audience)) {
    logger.error(
      '[identity] DEV_USER_EMAIL is set alongside CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD. ' +
        'That looks like production, so the dev identity is IGNORED.'
    );
    devEmail = '';
  }
  if (!accessConfigured) {
    if (teamDomain || audience) {
      logger.warn('[identity] only one of CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD is set; both are needed.');
    }
    logger.warn(
      '[identity] Cloudflare Access is not configured (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD): ' +
        'no JWT can be verified and every request is anonymous' +
        (devEmail ? ' except for the dev identity below.' : '.')
    );
  }
  if (devEmail) {
    logger.warn(
      `[identity] *** DEV IDENTITY ON: every request is ${devEmail} (DEV_USER_EMAIL). ` +
        'Never set this in production. ***'
    );
  }

  const cache = accessConfigured
    ? certCache || createAccessCertCache({ teamDomain, fetchImpl, now, logger })
    : null;
  const issuer = `https://${teamDomain}`;

  return async function identify(req, db) {
    try {
      if (cache) {
        const token = readJwtHeader(req);
        if (token) {
          const payload = await verifyAccessJwt(token, {
            getKey: (kid) => cache.getKey(kid),
            issuer,
            audience,
            nowSeconds: Math.floor(now() / 1000),
          });
          // A verified token with no email (a Cloudflare service token) is
          // not a person, so it stays anonymous.
          if (payload && typeof payload.email === 'string' && payload.email.trim()) {
            return upsertUser(db, payload.email);
          }
        }
        return null;
      }
      if (devEmail) return upsertUser(db, devEmail);
      return null;
    } catch (error) {
      logger.error(`[identity] could not resolve the request's user: ${error && /** @type {Error} */ (error).message}`);
      return null;
    }
  };
}
