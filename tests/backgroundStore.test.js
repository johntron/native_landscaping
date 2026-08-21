import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  imageTypeForContentType,
  parseContentType,
  resolveBackgroundTarget,
  sniffImageType,
  supersededBackgrounds,
} from '../src/data/backgroundStore.js';

const PROJECT_DIR = '/srv/yard/projects/backyard';
const HASH = 'a1b2c3d4e5f6';

function webpBytes() {
  const buffer = Buffer.alloc(32);
  buffer.write('RIFF', 0, 'latin1');
  buffer.write('WEBP', 8, 'latin1');
  return buffer;
}

function jpegBytes() {
  const buffer = Buffer.alloc(32);
  buffer.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return buffer;
}

function pngBytes() {
  const buffer = Buffer.alloc(32);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return buffer;
}

test('parses a content type down to its bare media type', () => {
  assert.equal(parseContentType('image/WEBP; charset=binary'), 'image/webp');
  assert.equal(parseContentType(undefined), '');
});

test('allows only the three raster formats, never SVG', () => {
  assert.equal(imageTypeForContentType('image/webp').ext, '.webp');
  assert.equal(imageTypeForContentType('image/jpeg').ext, '.jpg');
  assert.equal(imageTypeForContentType('image/png').ext, '.png');
  // Served back as image/svg+xml, which executes script — must never be stored.
  assert.equal(imageTypeForContentType('image/svg+xml'), null);
  assert.equal(imageTypeForContentType('text/html'), null);
  assert.equal(imageTypeForContentType('application/octet-stream'), null);
});

test('identifies an image from its leading bytes', () => {
  assert.equal(sniffImageType(webpBytes()).contentType, 'image/webp');
  assert.equal(sniffImageType(jpegBytes()).contentType, 'image/jpeg');
  assert.equal(sniffImageType(pngBytes()).contentType, 'image/png');
});

test('refuses bytes that are not one of the allowed images', () => {
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffImageType(Buffer.from('<!doctype html><script>alert(1)</script>')), null);
  // A RIFF container that is not WebP — a WAV, say — must not pass as one.
  const riffWave = Buffer.alloc(32);
  riffWave.write('RIFF', 0, 'latin1');
  riffWave.write('WAVE', 8, 'latin1');
  assert.equal(sniffImageType(riffWave), null);
  assert.equal(sniffImageType(Buffer.alloc(4)), null);
  assert.equal(sniffImageType(null), null);
});

test('names the file from the view id, the content hash, and the sniffed type', () => {
  const target = resolveBackgroundTarget({
    projectDir: PROJECT_DIR,
    viewId: 'south',
    contentHash: HASH,
    ext: '.webp',
  });
  assert.equal(target.relativePath, `img/south-${HASH}.webp`);
  assert.equal(target.file, path.join(PROJECT_DIR, 'img', `south-${HASH}.webp`));
  assert.equal(target.dir, path.join(PROJECT_DIR, 'img'));
});

test('a different photo for the same view gets a different path', () => {
  const first = resolveBackgroundTarget({
    projectDir: PROJECT_DIR,
    viewId: 'south',
    contentHash: 'aaaaaaaaaaaa',
    ext: '.webp',
  });
  const second = resolveBackgroundTarget({
    projectDir: PROJECT_DIR,
    viewId: 'south',
    contentHash: 'bbbbbbbbbbbb',
    ext: '.webp',
  });
  // The stored `background` string has to change, or nothing re-fetches it.
  assert.notEqual(first.relativePath, second.relativePath);
});

test('rejects view ids that could escape the img directory', () => {
  const hostile = ['../../etc/passwd', '..', 'a/b', 'a\\b', './x', '', 'South Side', null];
  hostile.forEach((viewId) => {
    assert.throws(
      () => resolveBackgroundTarget({ projectDir: PROJECT_DIR, viewId, contentHash: HASH, ext: '.webp' }),
      /Invalid or missing view id/,
      String(viewId)
    );
  });
});

test('rejects a hash or extension that did not come from the server', () => {
  assert.throws(
    () =>
      resolveBackgroundTarget({
        projectDir: PROJECT_DIR,
        viewId: 'south',
        contentHash: '../../evil',
        ext: '.webp',
      }),
    /Invalid content hash/
  );
  assert.throws(
    () =>
      resolveBackgroundTarget({
        projectDir: PROJECT_DIR,
        viewId: 'south',
        contentHash: HASH,
        ext: '.svg',
      }),
    /Unsupported image extension/
  );
});

test('supersedes only this view’s earlier uploads', () => {
  const entries = [
    `south-${HASH}.webp`,
    'south-999999999999.webp',
    'south-888888888888.jpg',
    'southwest-777777777777.webp',
    'south.xcf',
    'top.webp',
  ];
  const stale = supersededBackgrounds(entries, 'south', `south-${HASH}.webp`);
  assert.deepEqual(stale.sort(), ['south-888888888888.jpg', 'south-999999999999.webp']);
});

test('supersedes nothing for an invalid view id', () => {
  assert.deepEqual(supersededBackgrounds(['a.webp'], '../x', 'keep.webp'), []);
});
