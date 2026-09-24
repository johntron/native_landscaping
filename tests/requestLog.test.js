import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRequestLog,
  shouldLogRequest,
  resolveRequestLogMode,
} from '../server/requestLog.js';

test('formatRequestLog produces one compact line', () => {
  const line = formatRequestLog({
    method: 'POST',
    pathname: '/api/layout',
    status: 200,
    userId: 1,
    durationMs: 12.4,
  });
  assert.equal(line, 'POST /api/layout 200 u1 12ms');
});

test('formatRequestLog shows anonymous callers as -', () => {
  const line = formatRequestLog({
    method: 'GET',
    pathname: '/api/ecoregion',
    status: 200,
    userId: null,
    durationMs: 3,
  });
  assert.equal(line, 'GET /api/ecoregion 200 - 3ms');
});

test('formatRequestLog strips the query string, even if one reaches it', () => {
  // server.js is expected to pass url.pathname (already query-free), but the
  // formatter strips defensively too: a query can carry precise coordinates
  // (e.g. GET /api/ecoregion?lat=..&lng=..) and this repo keeps coordinates
  // out of logs.
  const line = formatRequestLog({
    method: 'GET',
    pathname: '/api/ecoregion?lat=32.78&lng=-96.80',
    status: 200,
    userId: null,
    durationMs: 3,
  });
  assert.equal(line, 'GET /api/ecoregion 200 - 3ms');
  assert.equal(line.includes('lat='), false);
  assert.equal(line.includes('32.78'), false);
});

test('resolveRequestLogMode defaults to api', () => {
  assert.equal(resolveRequestLogMode(undefined), 'api');
  assert.equal(resolveRequestLogMode(''), 'api');
  assert.equal(resolveRequestLogMode('bogus'), 'api');
});

test('resolveRequestLogMode accepts all/api/off', () => {
  assert.equal(resolveRequestLogMode('all'), 'all');
  assert.equal(resolveRequestLogMode('api'), 'api');
  assert.equal(resolveRequestLogMode('off'), 'off');
});

test('shouldLogRequest: off mode never logs', () => {
  assert.equal(shouldLogRequest('off', '/api/layout', 200), false);
  assert.equal(shouldLogRequest('off', '/index.html', 500), false);
});

test('shouldLogRequest: all mode logs everything', () => {
  assert.equal(shouldLogRequest('all', '/index.html', 200), true);
  assert.equal(shouldLogRequest('all', '/api/layout', 200), true);
});

test('shouldLogRequest: api mode logs /api/* regardless of status', () => {
  assert.equal(shouldLogRequest('api', '/api/layout', 200), true);
  assert.equal(shouldLogRequest('api', '/api/layout', 404), true);
});

test('shouldLogRequest: api mode skips static 2xx/3xx but logs static errors', () => {
  assert.equal(shouldLogRequest('api', '/design.html', 200), false);
  assert.equal(shouldLogRequest('api', '/styles.css', 304), false);
  assert.equal(shouldLogRequest('api', '/missing.html', 404), true);
});
