import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BACKGROUND_EDGE_PX,
  compressBackgroundImage,
  fitWithin,
  uploadViewBackground,
} from '../src/data/backgroundUpload.js';

/** A stand-in for the canvas pipeline: records what it was asked to encode. */
function makeEncoder({ sizes, type = 'image/webp' }) {
  const calls = [];
  const encode = async (source, width, height, contentType, quality) => {
    calls.push({ width, height, contentType, quality });
    const size = sizes[Math.min(calls.length - 1, sizes.length - 1)];
    return { size, type: contentType === 'image/webp' ? type : contentType };
  };
  return { calls, encode };
}

const decodeTo = (width, height) => async () => ({ width, height, close() {} });

test('fits an oversized image inside the edge limit, keeping its aspect', () => {
  assert.deepEqual(fitWithin(4000, 3000, 2400), { width: 2400, height: 1800 });
  assert.deepEqual(fitWithin(3000, 4000, 2400), { width: 1800, height: 2400 });
});

test('leaves an image already inside the limit alone rather than upscaling', () => {
  assert.deepEqual(fitWithin(1200, 900, 2400), { width: 1200, height: 900 });
});

test('never produces a zero dimension', () => {
  assert.deepEqual(fitWithin(4000, 1, 2400), { width: 2400, height: 1 });
  assert.deepEqual(fitWithin(0, 0, 2400), { width: 1, height: 1 });
});

test('downscales a phone photo to the background edge limit', async () => {
  const { calls, encode } = makeEncoder({ sizes: [400 * 1024] });
  const result = await compressBackgroundImage(
    { type: 'image/jpeg', size: 5 * 1024 * 1024 },
    { decode: decodeTo(4032, 3024), encode }
  );
  assert.equal(result.width, MAX_BACKGROUND_EDGE_PX);
  assert.equal(result.height, 1800);
  assert.equal(calls.length, 1, 'a blob already under target needs no second pass');
  assert.equal(result.contentType, 'image/webp');
});

test('steps down the quality ladder until the blob fits the target', async () => {
  const { calls, encode } = makeEncoder({ sizes: [3_000_000, 1_500_000, 700_000, 100] });
  const result = await compressBackgroundImage(
    { type: 'image/jpeg', size: 9_000_000 },
    { decode: decodeTo(4032, 3024), encode }
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.quality),
    [0.86, 0.78, 0.7]
  );
  assert.equal(result.quality, 0.7);
  assert.equal(result.blob.size, 700_000);
  // Resizing happens once; only the quality changes down the ladder.
  assert.ok(calls.every((call) => call.width === MAX_BACKGROUND_EDGE_PX));
});

test('stops at the bottom of the ladder rather than looping forever', async () => {
  const { calls, encode } = makeEncoder({ sizes: [9_000_000] });
  const result = await compressBackgroundImage(
    { type: 'image/jpeg' },
    { decode: decodeTo(3000, 2000), encode }
  );
  assert.equal(calls.length, 5);
  assert.equal(result.quality, 0.55);
});

test('falls back to JPEG when toBlob quietly hands back a PNG', async () => {
  // toBlob does not throw for an unsupported type — it returns PNG instead, so
  // the first encode is a probe and the format is whatever came back.
  const { calls, encode } = makeEncoder({ sizes: [500_000], type: 'image/png' });
  const result = await compressBackgroundImage(
    { type: 'image/jpeg' },
    { decode: decodeTo(1000, 800), encode }
  );
  assert.equal(result.contentType, 'image/jpeg');
  assert.deepEqual(
    calls.map((call) => call.contentType),
    ['image/webp', 'image/jpeg']
  );
});

test('refuses a file that is not a raster image', async () => {
  await assert.rejects(
    () => compressBackgroundImage({ type: 'application/pdf' }, { decode: decodeTo(10, 10) }),
    /not an image/
  );
  await assert.rejects(
    () => compressBackgroundImage({ type: 'image/svg+xml' }, { decode: decodeTo(10, 10) }),
    /SVG cannot be used/
  );
  await assert.rejects(() => compressBackgroundImage(null), /Choose an image file/);
});

test('refuses a source file too large to be worth decoding', async () => {
  await assert.rejects(
    () =>
      compressBackgroundImage(
        { type: 'image/jpeg', size: 41 * 1024 * 1024 },
        { decode: decodeTo(10, 10) }
      ),
    /larger than 40 MB/
  );
});

test('posts the bytes as the raw body, with no filename anywhere', async () => {
  const calls = [];
  const blob = { size: 1234, type: 'image/webp' };
  const background = await uploadViewBackground({
    projectId: 'backyard',
    viewId: 'south',
    blob,
    contentType: 'image/webp',
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ background: 'img/south-abc123.webp' }) };
    },
  });

  assert.equal(background, 'img/south-abc123.webp');
  assert.equal(calls[0].url, '/api/view-background?project=backyard&view=south');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Content-Type'], 'image/webp');
  assert.equal(calls[0].opts.body, blob);
});

test('surfaces the server’s own explanation when an upload is rejected', async () => {
  await assert.rejects(
    () =>
      uploadViewBackground({
        projectId: 'backyard',
        viewId: 'south',
        blob: { size: 1 },
        contentType: 'image/webp',
        fetchFn: async () => ({
          ok: false,
          status: 415,
          json: async () => ({ error: 'Background must be a WebP, JPEG, or PNG image' }),
        }),
      }),
    /must be a WebP, JPEG, or PNG image/
  );
});

test('rejects an upload with no view to attach it to', async () => {
  await assert.rejects(
    () => uploadViewBackground({ projectId: 'backyard', viewId: '', blob: {}, fetchFn: async () => ({}) }),
    /Missing view id/
  );
});
