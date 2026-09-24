import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAppDb } from '../server/db/appDb.js';
import { createIdentity, upsertUser, verifyAccessJwt } from '../server/identity.js';
import { createAccessCertCache, normaliseTeamDomain, parseJwks } from '../tools/accessCerts.js';

const TEAM = 'testteam.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'aud-tag-0123456789abcdef';
const NOW_MS = Date.UTC(2026, 8, 23, 12, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);

const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** @param {import('node:crypto').KeyObject} publicKey @param {string} kid */
function jwk(publicKey, kid) {
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Sign an RS256 token with the given private key. */
function signToken(payload, { privateKey = keyA.privateKey, kid = 'kid-a', header = {} } = {}) {
  const h = b64({ alg: 'RS256', kid, typ: 'JWT', ...header });
  const p = b64(payload);
  const sig = cryptoSign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function claims(overrides = {}) {
  return {
    iss: ISSUER,
    aud: [AUD],
    email: 'Person@Example.com',
    sub: 'abc',
    iat: NOW_S - 10,
    nbf: NOW_S - 10,
    exp: NOW_S + 3600,
    ...overrides,
  };
}

/** A fetch stub serving a JWKS, counting calls. */
function fakeFetch(keys) {
  const stub = async (url) => {
    stub.calls.push(url);
    if (stub.fail) throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ keys: stub.keys }) };
  };
  stub.calls = [];
  stub.keys = keys;
  stub.fail = false;
  return stub;
}

const quietLogger = () => {
  const log = { warnings: [], errors: [] };
  log.warn = (m) => log.warnings.push(String(m));
  log.error = (m) => log.errors.push(String(m));
  return log;
};

function tempDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'native-landscaping-identity-test-'));
  return openAppDb({ dataDir, ownerEmail: '' });
}

function req(headers = {}) {
  return { headers };
}

function setup({ keys = [jwk(keyA.publicKey, 'kid-a')], env = {} } = {}) {
  const fetchImpl = fakeFetch(keys);
  const logger = quietLogger();
  let clock = NOW_MS;
  const identify = createIdentity({
    env: { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ...env },
    fetchImpl,
    now: () => clock,
    logger,
  });
  const db = tempDb();
  return { identify, db, fetchImpl, logger, advance: (ms) => { clock += ms; } };
}

test('a valid token attaches the user and upserts a lowercased users row', async () => {
  const { identify, db, fetchImpl } = setup();
  const user = await identify(req({ 'cf-access-jwt-assertion': signToken(claims()) }), db);
  assert.equal(user.email, 'person@example.com');
  assert.equal(user.isAdmin, false);
  assert.equal(typeof user.id, 'number');
  assert.deepEqual(fetchImpl.calls, [`${ISSUER}/cdn-cgi/access/certs`]);

  // Second sight reuses the row and the cached certs.
  const again = await identify(req({ 'cf-access-jwt-assertion': signToken(claims()) }), db);
  assert.equal(again.id, user.id);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test('upsert never touches is_admin', async () => {
  const db = tempDb();
  db.prepare("INSERT INTO users (email, is_admin, created_at) VALUES ('boss@example.com', 1, 'x')").run();
  const { identify, fetchImpl } = setup();
  void fetchImpl;
  const user = await identify(req({ 'cf-access-jwt-assertion': signToken(claims({ email: 'BOSS@example.com' })) }), db);
  assert.equal(user.isAdmin, true);
  assert.equal(upsertUser(db, 'boss@example.com').isAdmin, true);
});

test('a bad signature is anonymous', async () => {
  const { identify, db } = setup();
  const forged = signToken(claims(), { privateKey: stranger.privateKey, kid: 'kid-a' });
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': forged }), db), null);

  // A payload swapped under a genuine signature fails too.
  const good = signToken(claims()).split('.');
  const tampered = [good[0], b64(claims({ email: 'evil@example.com' })), good[2]].join('.');
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': tampered }), db), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

test('the wrong audience is anonymous; a string aud is accepted', async () => {
  const { identify, db } = setup();
  const wrong = signToken(claims({ aud: ['some-other-app'] }));
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': wrong }), db), null);
  const asString = signToken(claims({ aud: AUD }));
  assert.equal((await identify(req({ 'cf-access-jwt-assertion': asString }), db)).email, 'person@example.com');
});

test('expired, missing exp, future nbf and future iat are anonymous; small skew is tolerated', async () => {
  const { identify, db } = setup();
  const send = (c) => identify(req({ 'cf-access-jwt-assertion': signToken(c) }), db);
  assert.equal(await send(claims({ exp: NOW_S - 120 })), null);
  assert.equal(await send(claims({ exp: undefined })), null);
  assert.equal(await send(claims({ nbf: NOW_S + 600 })), null);
  assert.equal(await send(claims({ iat: NOW_S + 600 })), null);
  assert.ok(await send(claims({ exp: NOW_S - 30 })), 'within the 60s skew');
});

test('a wrong issuer is anonymous', async () => {
  const { identify, db } = setup();
  const t = signToken(claims({ iss: 'https://otherteam.cloudflareaccess.com' }));
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': t }), db), null);
});

test('alg none and HS256 (public key as HMAC secret) are rejected', async () => {
  const { identify, db } = setup();
  const p = b64(claims());

  const none = `${b64({ alg: 'none', kid: 'kid-a' })}.${p}.`;
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': none }), db), null);
  const noneNoSig = `${b64({ alg: 'none', kid: 'kid-a' })}.${p}`;
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': noneNoSig }), db), null);

  const hsHeader = b64({ alg: 'HS256', kid: 'kid-a' });
  const pem = keyA.publicKey.export({ type: 'spki', format: 'pem' });
  const hsSig = createHmac('sha256', pem).update(`${hsHeader}.${p}`).digest('base64url');
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': `${hsHeader}.${p}.${hsSig}` }), db), null);

  // verifyAccessJwt rejects before asking for a key at all.
  let asked = 0;
  const result = await verifyAccessJwt(`${hsHeader}.${p}.${hsSig}`, {
    getKey: async () => { asked += 1; return keyA.publicKey; },
    issuer: ISSUER,
    audience: AUD,
    nowSeconds: NOW_S,
  });
  assert.equal(result, null);
  assert.equal(asked, 0);
});

test('an unknown kid triggers exactly one refetch, rate-limited against more', async () => {
  const { identify, db, fetchImpl, advance } = setup();
  // Prime the cache with kid-a.
  assert.ok(await identify(req({ 'cf-access-jwt-assertion': signToken(claims()) }), db));
  assert.equal(fetchImpl.calls.length, 1);

  // Cloudflare rotates: kid-b appears. The first token with kid-b refetches.
  fetchImpl.keys = [jwk(keyA.publicKey, 'kid-a'), jwk(keyB.publicKey, 'kid-b')];
  advance(60 * 1000);
  const rotated = signToken(claims(), { privateKey: keyB.privateKey, kid: 'kid-b' });
  assert.ok(await identify(req({ 'cf-access-jwt-assertion': rotated }), db));
  assert.equal(fetchImpl.calls.length, 2);

  // A forged kid refetches once at most per window...
  advance(60 * 1000);
  const forged = signToken(claims(), { privateKey: stranger.privateKey, kid: 'kid-forged' });
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': forged }), db), null);
  assert.equal(fetchImpl.calls.length, 3);
  // ...and a flood of them inside that window adds no fetches.
  for (let i = 0; i < 5; i += 1) {
    const t = signToken(claims(), { privateKey: stranger.privateKey, kid: `kid-forged-${i}` });
    assert.equal(await identify(req({ 'cf-access-jwt-assertion': t }), db), null);
  }
  assert.equal(fetchImpl.calls.length, 3);
});

test('certs unreachable: fail closed, and failed fetches are rate-limited too', async () => {
  const { identify, db, fetchImpl, logger, advance } = setup();
  fetchImpl.fail = true;
  const token = signToken(claims());
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': token }), db), null);
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': token }), db), null);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(logger.warnings.some((w) => w.includes('could not fetch')));

  // Recovery after the rate-limit window.
  fetchImpl.fail = false;
  advance(31 * 1000);
  assert.ok(await identify(req({ 'cf-access-jwt-assertion': token }), db));
  assert.equal(fetchImpl.calls.length, 2);

  // Cache expires and the refresh fails: fail closed rather than serve stale keys.
  fetchImpl.fail = true;
  advance(61 * 60 * 1000);
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': signToken(claims({ exp: NOW_S + 99999 })) }), db), null);
});

test('a forged email header with no JWT stays anonymous and creates no row', async () => {
  const { identify, db, fetchImpl } = setup();
  const user = await identify(req({ 'cf-access-authenticated-user-email': 'owner@example.com' }), db);
  assert.equal(user, null);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

test('a verified token without an email (service token) is anonymous', async () => {
  const { identify, db } = setup();
  const t = signToken(claims({ email: undefined, common_name: 'svc' }));
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': t }), db), null);
});

test('unconfigured: everyone is anonymous, nothing is fetched, one warning at startup', async () => {
  const fetchImpl = fakeFetch([]);
  const logger = quietLogger();
  const identify = createIdentity({ env: {}, fetchImpl, logger });
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /not configured/);
  const db = tempDb();
  assert.equal(await identify(req({ 'cf-access-jwt-assertion': signToken(claims()) }), db), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('dev identity: DEV_USER_EMAIL makes every request that user, loudly', async () => {
  const logger = quietLogger();
  const identify = createIdentity({ env: { DEV_USER_EMAIL: 'Dev@Example.com' }, fetchImpl: fakeFetch([]), logger });
  assert.ok(logger.warnings.some((w) => w.includes('DEV IDENTITY ON') && w.includes('dev@example.com')));
  const db = tempDb();
  const user = await identify(req(), db);
  assert.equal(user.email, 'dev@example.com');
  assert.equal(user.isAdmin, false);
  assert.equal((await identify(req(), db)).id, user.id);
});

test('dev identity is ignored when Cloudflare Access is configured', async () => {
  const { identify, db, logger } = setup({ env: { DEV_USER_EMAIL: 'dev@example.com' } });
  assert.ok(logger.errors.some((e) => e.includes('IGNORED')));
  assert.equal(await identify(req(), db), null);
});

test('the resolver never throws, even if the database does', async () => {
  const logger = quietLogger();
  const identify = createIdentity({ env: { DEV_USER_EMAIL: 'dev@example.com' }, logger });
  const brokenDb = { prepare() { throw new Error('disk on fire'); } };
  assert.equal(await identify(req(), /** @type {any} */ (brokenDb)), null);
  assert.ok(logger.errors.some((e) => e.includes('disk on fire')));
});

test('helpers: team domain normalisation and JWKS parsing', () => {
  assert.equal(normaliseTeamDomain(' https://MyTeam.cloudflareaccess.com/ '), 'myteam.cloudflareaccess.com');
  const keys = parseJwks({ keys: [jwk(keyA.publicKey, 'a'), { kty: 'EC', kid: 'ec' }, { kty: 'RSA' }] });
  assert.deepEqual([...keys.keys()], ['a']);
  assert.throws(() => createAccessCertCache({ teamDomain: '' }));
});
