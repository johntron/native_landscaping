// web and feed-poller both open data/app.db, and a deploy restarts them at
// the same moment, so two processes can run the migration runner against one
// file at once. This races several worker threads (each with its own
// connection, released together from a shared barrier) through
// runMigrations on a fresh file, with migrations that are NOT idempotent
// (plain CREATE TABLE): a runner that decides what to apply outside the write
// transaction would try to apply one twice and fail with "table already
// exists".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = 20;
const MIGRATE_URL = new URL('../server/db/migrate.js', import.meta.url).href;

const WORKER_SOURCE = `
  const { workerData, parentPort } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  (async () => {
    const { runMigrations } = await import(workerData.migrateUrl);
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA busy_timeout = 10000');
    const flag = new Int32Array(workerData.barrier);
    Atomics.add(flag, 1, 1);
    Atomics.wait(flag, 0, 0);
    try {
      runMigrations(db, workerData.migrationsDir);
      parentPort.postMessage({ ok: true });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: String(err && err.message) });
    } finally {
      db.close();
    }
  })();
`;

test('concurrent runners apply every migration exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-concurrency-test-'));
  try {
    const migrationsDir = join(dir, 'migrations');
    mkdirSync(migrationsDir);
    for (let i = 1; i <= MIGRATIONS; i += 1) {
      const n = String(i).padStart(3, '0');
      writeFileSync(join(migrationsDir, `${n}_t${i}.sql`), `CREATE TABLE t${i} (id INTEGER PRIMARY KEY);`);
    }
    const dbPath = join(dir, 'app.db');
    // WAL is set once up front, as openAppDb does before migrating.
    const setup = new DatabaseSync(dbPath);
    setup.exec('PRAGMA journal_mode = WAL');
    setup.close();

    const WORKERS = 12;
    const barrier = new SharedArrayBuffer(8);
    const flag = new Int32Array(barrier);
    const results = [];
    const workers = [];
    for (let i = 0; i < WORKERS; i += 1) {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { migrateUrl: MIGRATE_URL, dbPath, migrationsDir, barrier },
      });
      workers.push(
        new Promise((resolve, reject) => {
          worker.once('message', (msg) => results.push(msg));
          worker.once('error', reject);
          // Wait for exit, not just the message, so each worker's connection
          // is closed before this thread opens its own to check the result.
          worker.once('exit', resolve);
        })
      );
    }
    // Release every worker at once, after all have opened their connection.
    while (Atomics.load(flag, 1) < WORKERS) await new Promise((r) => setTimeout(r, 5));
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    await Promise.all(workers);

    assert.deepEqual(
      results.filter((r) => !r.ok),
      [],
      'no runner may fail'
    );
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 10000');
    try {
      const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
      assert.deepEqual(versions, Array.from({ length: MIGRATIONS }, (_, i) => i + 1));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
