// Covers rejectCrossSite (nl-3s5.16): the central CSRF guard called once in
// server.js before the ROUTES loop, for every state-changing request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectCrossSite } from '../server/http.js';

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
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

function makeReq({ method, contentType, origin, host = 'rewilder.example', secFetchSite } = {}) {
  const headers = { host };
  if (contentType !== undefined) headers['content-type'] = contentType;
  if (origin !== undefined) headers.origin = origin;
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite;
  return { method, headers };
}

test('a same-origin JSON POST passes', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'application/json',
    origin: 'https://rewilder.example',
    host: 'rewilder.example',
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, false);
  assert.equal(res.ended, false);
});

test('a JSON POST with a charset parameter still passes', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'application/json; charset=utf-8',
    origin: 'https://rewilder.example',
    host: 'rewilder.example',
  });
  const res = makeRes();
  assert.equal(rejectCrossSite(req, res, '/api/saved-areas'), false);
});

test('text/plain gets 415', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'text/plain',
    origin: 'https://rewilder.example',
    host: 'rewilder.example',
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, true);
  assert.equal(res.statusCode, 415);
  assert.ok(JSON.parse(res.body).error);
});

test('a form-urlencoded POST gets 415', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    origin: 'https://rewilder.example',
    host: 'rewilder.example',
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, true);
  assert.equal(res.statusCode, 415);
});

test('a foreign Origin gets 403', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'application/json',
    origin: 'https://evil.example',
    host: 'rewilder.example',
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, true);
  assert.equal(res.statusCode, 403);
  assert.ok(JSON.parse(res.body).error);
});

test('a missing Origin with valid JSON Content-Type is let through (curl, Playwright request)', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'application/json',
    host: 'rewilder.example',
    // no origin
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, false);
  assert.equal(res.ended, false);
});

test('a missing Origin but a cross-site Sec-Fetch-Site still gets 403', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'application/json',
    host: 'rewilder.example',
    secFetchSite: 'cross-site',
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, true);
  assert.equal(res.statusCode, 403);
});

test('a missing Origin with Sec-Fetch-Site: same-origin passes', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'application/json',
    host: 'rewilder.example',
    secFetchSite: 'same-origin',
  });
  const res = makeRes();
  assert.equal(rejectCrossSite(req, res, '/api/saved-areas'), false);
});

test('GET is untouched, whatever its Content-Type or Origin', () => {
  const req = makeReq({
    method: 'GET',
    contentType: 'text/plain',
    origin: 'https://evil.example',
    host: 'rewilder.example',
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, false);
  assert.equal(res.ended, false);
});

test('PUT and DELETE are covered the same as POST', () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const good = makeReq({
      method,
      contentType: 'application/json',
      origin: 'https://rewilder.example',
      host: 'rewilder.example',
    });
    assert.equal(rejectCrossSite(good, makeRes(), '/api/saved-areas'), false, method);

    const bad = makeReq({
      method,
      contentType: 'text/plain',
      origin: 'https://rewilder.example',
      host: 'rewilder.example',
    });
    const res = makeRes();
    assert.equal(rejectCrossSite(bad, res, '/api/saved-areas'), true, method);
    assert.equal(res.statusCode, 415);
  }
});

test('the upload route accepts its image content types', () => {
  for (const contentType of ['image/webp', 'image/jpeg', 'image/png']) {
    const req = makeReq({
      method: 'POST',
      contentType,
      origin: 'https://rewilder.example',
      host: 'rewilder.example',
    });
    const res = makeRes();
    assert.equal(rejectCrossSite(req, res, '/api/view-background'), false, contentType);
  }
});

test('the upload route rejects JSON and other non-image content types', () => {
  for (const contentType of ['application/json', 'text/plain', 'image/gif']) {
    const req = makeReq({
      method: 'POST',
      contentType,
      origin: 'https://rewilder.example',
      host: 'rewilder.example',
    });
    const res = makeRes();
    const answered = rejectCrossSite(req, res, '/api/view-background');
    assert.equal(answered, true, contentType);
    assert.equal(res.statusCode, 415);
  }
});

test('a JSON POST to a non-upload path is rejected even if it looks like an image type', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'image/webp',
    origin: 'https://rewilder.example',
    host: 'rewilder.example',
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, true);
  assert.equal(res.statusCode, 415);
});

test('a missing Content-Type is rejected (415), regardless of Origin', () => {
  const req = makeReq({
    method: 'POST',
    origin: 'https://rewilder.example',
    host: 'rewilder.example',
    // no content-type
  });
  const res = makeRes();
  const answered = rejectCrossSite(req, res, '/api/saved-areas');
  assert.equal(answered, true);
  assert.equal(res.statusCode, 415);
});

test('Origin host comparison ignores scheme and matches port-bearing Host headers', () => {
  const req = makeReq({
    method: 'POST',
    contentType: 'application/json',
    origin: 'http://127.0.0.1:8000',
    host: '127.0.0.1:8000',
  });
  const res = makeRes();
  assert.equal(rejectCrossSite(req, res, '/api/saved-areas'), false);
});
