// The backup job's local half (tools/backup/snapshot.js), and, when rclone is
// installed, the whole job end to end against a throwaway crypt remote layered
// on a local directory: backup, prune, restore, and a check that the backing
// directory holds only ciphertext. Never touches ~/.config/rclone or data/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot, verifySnapshot, describeDb, sha256File } from '../tools/backup/snapshot.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nl-backup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A DATA_DIR with an app.db in WAL mode whose latest rows sit only in the -wal
 * (the writer is left open, so nothing is checkpointed), plus two yards' photos.
 * @returns {{ dataDir: string, writer: DatabaseSync }}
 */
function fakeDataDir(t, root) {
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'projects', '1', 'img'), { recursive: true });
  mkdirSync(join(dataDir, 'projects', '2', 'img'), { recursive: true });
  writeFileSync(join(dataDir, 'projects', '1', 'img', 'top.webp'), Buffer.from('RIFF....WEBPVP8 one'));
  writeFileSync(join(dataDir, 'projects', '1', 'img', 'east.xcf'), Buffer.alloc(4096, 7));
  writeFileSync(join(dataDir, 'projects', '2', 'img', 'north-abc.webp'), Buffer.from('RIFF....WEBPVP8 two'));
  const writer = new DatabaseSync(join(dataDir, 'app.db'));
  t.after(() => {
    if (writer.isOpen) writer.close();
  });
  writer.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER);
    INSERT INTO users (email) VALUES ('a@example.test'), ('b@example.test');
    INSERT INTO projects (name, owner_id) VALUES ('front', 1), ('back', 2), ('side', 2);
  `);
  return { dataDir, writer };
}

test('createSnapshot copies app.db consistently (WAL rows included), photos, and a manifest that verifies', (t) => {
  const root = scratch(t);
  const { dataDir, writer } = fakeDataDir(t, root);
  const stageDir = join(root, 'stage');
  mkdirSync(stageDir);

  const { dir, manifest } = createSnapshot({ dataDir, stageDir, name: '2026-09-24T033000Z' });
  assert.deepEqual(manifest.appDb.tables, { projects: 3, users: 2 });
  assert.equal(manifest.appDb.integrityCheck, 'ok');
  assert.deepEqual(
    manifest.files.map((f) => f.path),
    ['app.db', 'projects/1/img/east.xcf', 'projects/1/img/top.webp', 'projects/2/img/north-abc.webp']
  );
  for (const f of manifest.files.filter((x) => x.path.startsWith('projects/'))) {
    assert.equal(f.sha256, sha256File(join(dataDir, ...f.path.split('/'))), f.path);
  }
  const result = verifySnapshot(dir);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);

  // The snapshot is a standalone file: no -wal beside it, rows all there.
  assert.deepEqual(readdirSync(dir).sort(), ['MANIFEST.json', 'app.db', 'projects']);
  assert.equal(new DatabaseSync(join(dir, 'app.db'), { readOnly: true }).prepare('SELECT count(*) c FROM projects').get().c, 3);

  // The live database was not touched: still writable, same rows.
  writer.exec("INSERT INTO projects (name, owner_id) VALUES ('later', 1)");
  assert.equal(describeDb(join(dataDir, 'app.db')).tables.projects, 4);
});

test('verifySnapshot catches a changed photo, a missing file, an extra file and a row-count mismatch', (t) => {
  const root = scratch(t);
  const { dataDir } = fakeDataDir(t, root);
  const { dir } = createSnapshot({ dataDir, stageDir: join(root, 'stage'), name: '2026-09-24T033000Z' });

  appendFileSync(join(dir, 'projects', '1', 'img', 'top.webp'), 'x');
  rmSync(join(dir, 'projects', '2', 'img', 'north-abc.webp'));
  writeFileSync(join(dir, 'projects', '2', 'img', 'stray.webp'), 'stray');
  const manifestPath = join(dir, 'MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.appDb.tables.users = 99;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const result = verifySnapshot(dir);
  assert.equal(result.ok, false);
  const text = result.problems.join('\n');
  assert.match(text, /size differs: projects\/1\/img\/top\.webp/);
  assert.match(text, /missing: projects\/2\/img\/north-abc\.webp/);
  assert.match(text, /not in manifest: projects\/2\/img\/stray\.webp/);
  assert.match(text, /row count differs for users/);
});

test('a folder without MANIFEST.json is reported incomplete', (t) => {
  const dir = scratch(t);
  const result = verifySnapshot(dir);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /incomplete/);
});

test('createSnapshot refuses a DATA_DIR with no app.db, and a staging dir inside DATA_DIR', (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'empty'));
  assert.throws(
    () => createSnapshot({ dataDir: join(root, 'empty'), stageDir: join(root, 'stage'), name: 'x' }),
    /no app\.db/
  );
  const { dataDir } = fakeDataDir(t, root);
  assert.throws(
    () => createSnapshot({ dataDir, stageDir: join(dataDir, 'stage'), name: 'x' }),
    /outside DATA_DIR/
  );
  assert.throws(() => createSnapshot({ dataDir, stageDir: dataDir, name: 'x' }), /outside DATA_DIR/);
});

// ---- end to end, against a local stand-in remote -------------------------

function findRclone() {
  for (const candidate of [process.env.RCLONE_BIN, 'rclone', '/home/linuxbrew/.linuxbrew/bin/rclone']) {
    if (!candidate) continue;
    const r = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (r.status === 0) return candidate;
  }
  return null;
}
const RCLONE = findRclone();

function run(cmd, args, env) {
  const r = spawnSync(cmd === 'node' ? process.execPath : cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Every file path under dir, relative, forward slashes. */
function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [full.slice(base.length + 1)];
  });
}

test('run-backup and restore end to end through a crypt remote on a local directory', { skip: !RCLONE && 'rclone not installed' }, (t) => {
  const root = scratch(t);
  const { dataDir, writer } = fakeDataDir(t, root);
  const backing = join(root, 'backing');
  mkdirSync(backing);
  const env = {
    RCLONE_BIN: RCLONE,
    RCLONE_CONFIG: join(root, 'rclone.conf'),
    DATA_DIR: dataDir,
    BACKUP_REMOTE: 'testcrypt:',
    TMPDIR: root,
  };
  writeFileSync(env.RCLONE_CONFIG, `[standin]\ntype = local\n`);

  // Refuses a remote that is not crypt, before snapshotting anything.
  const plain = run('node', ['tools/backup/run-backup.mjs'], { ...env, BACKUP_REMOTE: 'standin:' + backing });
  assert.equal(plain.status, 1, plain.out);
  assert.match(plain.out, /must be a crypt remote/);
  assert.match(JSON.parse(readFileSync(join(dataDir, 'backup-status.json'), 'utf8')).lastError, /crypt/);

  // The setup script, against the stand-in in place of gdrive.
  const pwFile = join(root, 'crypt.env');
  const setup = run('bash', ['tools/backup/setup-crypt-remote.sh', '--name', 'testcrypt', '--target', `standin:${backing}`, '--password-file', pwFile], env);
  assert.equal(setup.status, 0, setup.out);
  assert.equal(statSync(pwFile).mode & 0o777, 0o600);
  const again = run('bash', ['tools/backup/setup-crypt-remote.sh', '--name', 'testcrypt', '--target', `standin:${backing}`, '--password-file', pwFile], env);
  assert.equal(again.status, 1, 'a second run must refuse to replace the remote');
  assert.match(again.out, /refusing to replace/);

  // Old snapshots to prune: 20 fabricated complete dailies ending yesterday, one
  // stale incomplete folder, and one foreign folder that must survive.
  const fake = join(root, 'fake');
  mkdirSync(fake);
  writeFileSync(join(fake, 'MANIFEST.json'), '{}');
  const today = new Date();
  for (let i = 1; i <= 20; i += 1) {
    const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    assert.equal(run(RCLONE, ['copy', fake, `testcrypt:snapshots/${d}T010000Z`], env).status, 0);
  }
  const staleIncomplete = `${new Date(today.getTime() - 3 * 86400000).toISOString().slice(0, 10)}T120000Z`;
  assert.equal(run(RCLONE, ['mkdir', `testcrypt:snapshots/${staleIncomplete}`], env).status, 0);
  writeFileSync(join(root, 'part'), 'partial');
  assert.equal(run(RCLONE, ['copyto', join(root, 'part'), `testcrypt:snapshots/${staleIncomplete}/app.db`], env).status, 0);
  assert.equal(run(RCLONE, ['copyto', join(root, 'part'), 'testcrypt:snapshots/keep-me/note'], env).status, 0);

  writer.exec("INSERT INTO projects (name, owner_id) VALUES ('wal-only', 1)");
  const backup = run('node', ['tools/backup/run-backup.mjs'], { ...env, BACKUP_KEEP_DAILY: '5', BACKUP_KEEP_WEEKLY: '2' });
  assert.equal(backup.status, 0, backup.out);
  const status = JSON.parse(readFileSync(join(dataDir, 'backup-status.json'), 'utf8'));
  assert.equal(status.lastError, null);
  assert.ok(status.lastSuccessAt);
  assert.equal(status.tables.projects, 4);
  assert.ok(status.pruned.includes(staleIncomplete), 'stale incomplete folder pruned');

  const listed = run('node', ['tools/backup/restore.mjs', 'list'], env);
  assert.equal(listed.status, 0, listed.out);
  const names = listed.out.trim().split('\n').filter((l) => !l.includes('not a snapshot'));
  assert.equal(names[0], status.lastSnapshot);
  // today's run + 4 more dailies, + the newest of one more ISO week at most
  assert.ok(names.length >= 5 && names.length <= 6, listed.out);
  const remaining = run(RCLONE, ['lsf', '--dirs-only', 'testcrypt:snapshots'], env).out;
  assert.match(remaining, /keep-me\//, 'a folder that is not a snapshot is never pruned');

  // Ciphertext only in the backing directory: no readable names, no SQLite header.
  const stored = walk(backing);
  assert.ok(stored.length > 0);
  for (const p of stored) {
    assert.doesNotMatch(p, /app\.db|MANIFEST|projects|snapshots|\.webp|\.xcf|keep-me/, p);
    assert.equal(readFileSync(join(backing, p)).includes('SQLite format 3'), false, p);
  }

  // Restore with a fresh config rebuilt from the password file alone.
  const freshEnv = { ...env, RCLONE_CONFIG: join(root, 'fresh.conf') };
  writeFileSync(freshEnv.RCLONE_CONFIG, `[standin]\ntype = local\n`);
  const rebuilt = run('bash', ['tools/backup/setup-crypt-remote.sh', '--name', 'testcrypt', '--target', `standin:${backing}`, '--password-file', pwFile], freshEnv);
  assert.equal(rebuilt.status, 0, rebuilt.out);
  const target = join(root, 'restored');
  const restore = run('node', ['tools/backup/restore.mjs', 'fetch', 'latest', target], freshEnv);
  assert.equal(restore.status, 0, restore.out);
  assert.match(restore.out, /OK/);
  assert.deepEqual(describeDb(join(target, 'app.db')).tables, { projects: 4, users: 2 });
  for (const p of ['projects/1/img/top.webp', 'projects/1/img/east.xcf', 'projects/2/img/north-abc.webp']) {
    assert.equal(sha256File(join(target, p)), sha256File(join(dataDir, p)), p);
  }
  const notEmpty = run('node', ['tools/backup/restore.mjs', 'fetch', 'latest', target], freshEnv);
  assert.equal(notEmpty.status, 1, 'fetch refuses a non-empty directory');
});

test('createSnapshot works on a WAL-mode db with no -wal or -shm (web stopped cleanly)', (t) => {
  const root = scratch(t);
  const { dataDir, writer } = fakeDataDir(t, root);
  writer.exec("INSERT INTO projects (name, owner_id) VALUES ('last', 1)");
  writer.close(); // a clean close checkpoints and removes -wal and -shm
  assert.deepEqual(readdirSync(dataDir).filter((f) => f.startsWith('app.db')), ['app.db']);
  const { dir, manifest } = createSnapshot({ dataDir, stageDir: join(root, 'stage'), name: '2026-09-24T033000Z' });
  assert.equal(manifest.appDb.tables.projects, 4);
  assert.equal(verifySnapshot(dir).ok, true);
});
