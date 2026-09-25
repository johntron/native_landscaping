import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import { insertProject, projectDataDir } from '../server/db/projectStore.js';
import {
  DEFAULT_PHOTO_QUOTA_MB,
  fitsQuota,
  photoDirSizeBytes,
  photoQuotaBytes,
  photoUsageBytes,
  quotaExceededBody,
} from '../server/db/photoQuota.js';

function env(dataDir) {
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  return {
    db,
    dataDir,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function writePhoto(dataDir, projectId, name, bytes) {
  const dir = join(projectDataDir(dataDir, projectId), 'img');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), Buffer.alloc(bytes, 1));
}

test('photoQuotaBytes defaults to 50 MB and honours PHOTO_QUOTA_MB', () => {
  assert.equal(photoQuotaBytes({}), DEFAULT_PHOTO_QUOTA_MB * 1024 * 1024);
  assert.equal(photoQuotaBytes({ PHOTO_QUOTA_MB: '10' }), 10 * 1024 * 1024);
  // Nonsense values fall back to the default rather than producing a
  // zero or negative cap that would refuse every upload.
  assert.equal(photoQuotaBytes({ PHOTO_QUOTA_MB: '0' }), DEFAULT_PHOTO_QUOTA_MB * 1024 * 1024);
  assert.equal(photoQuotaBytes({ PHOTO_QUOTA_MB: 'nope' }), DEFAULT_PHOTO_QUOTA_MB * 1024 * 1024);
});

test('photoDirSizeBytes sums files recursively and treats a missing directory as zero', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'photo-quota-dir-'));
  try {
    assert.equal(await photoDirSizeBytes(join(dataDir, 'nope')), 0);
    const dir = join(dataDir, 'img');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.webp'), Buffer.alloc(100));
    writeFileSync(join(dir, 'sub', 'b.webp'), Buffer.alloc(50));
    assert.equal(await photoDirSizeBytes(dir), 150);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('photoUsageBytes sums across every yard the owner has, and nobody else\'s', async () => {
  const e = env(mkdtempSync(join(tmpdir(), 'photo-quota-usage-')));
  try {
    const alice = upsertUser(e.db, 'alice@example.com');
    const bob = upsertUser(e.db, 'bob@example.com');
    const example = upsertUser(e.db, 'example@rewilder.invalid');

    const a1 = insertProject(e.db, { ownerId: alice.id, slug: 'front', name: 'front', configJson: '{}' });
    const a2 = insertProject(e.db, { ownerId: alice.id, slug: 'back', name: 'back', configJson: '{}' });
    const b1 = insertProject(e.db, { ownerId: bob.id, slug: 'yard', name: 'yard', configJson: '{}' });
    const ex1 = insertProject(e.db, { ownerId: example.id, slug: 'example', name: 'Example', configJson: '{}' });

    writePhoto(e.dataDir, a1, 'p1.webp', 1000);
    writePhoto(e.dataDir, a2, 'p2.webp', 2000);
    writePhoto(e.dataDir, b1, 'p3.webp', 500_000);
    writePhoto(e.dataDir, ex1, 'p4.webp', 999_000);

    assert.equal(await photoUsageBytes(e.db, e.dataDir, alice.id), 3000);
    assert.equal(await photoUsageBytes(e.db, e.dataDir, bob.id), 500_000);
    // The example owner's own usage is real, but nothing here ever sums it
    // into another user's total — that's the point of the per-owner query.
    assert.equal(await photoUsageBytes(e.db, e.dataDir, example.id), 999_000);

    // A user with a yard but no photos yet: zero, not an error.
    const carol = upsertUser(e.db, 'carol@example.com');
    insertProject(e.db, { ownerId: carol.id, slug: 'yard', name: 'yard', configJson: '{}' });
    assert.equal(await photoUsageBytes(e.db, e.dataDir, carol.id), 0);
  } finally {
    e.cleanup();
  }
});

test('fitsQuota and quotaExceededBody', () => {
  assert.equal(fitsQuota(10, 5, 15), true);
  assert.equal(fitsQuota(10, 6, 15), false);
  assert.equal(fitsQuota(0, 0, 0), true);

  const body = quotaExceededBody(48 * 1024 * 1024, 5 * 1024 * 1024, 50 * 1024 * 1024);
  assert.equal(body.used, 48 * 1024 * 1024);
  assert.equal(body.cap, 50 * 1024 * 1024);
  assert.match(body.error, /48\.0 MB of 50\.0 MB used/);
  assert.match(body.error, /5\.0 MB more/);
});
