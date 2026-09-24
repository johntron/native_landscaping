// Build and verify one local backup snapshot (nl-3s5.13): a consistent copy of
// app.db plus every file under DATA_DIR/projects/ (the yard photos), with a
// MANIFEST.json of hashes and row counts. No rclone here: run-backup.mjs
// uploads what this builds, and restore.mjs checks a download with
// verifySnapshot. Both halves are tested in tests/backupSnapshot.test.js.
//
// app.db is opened READ-ONLY and copied with VACUUM INTO, which writes a
// transactionally consistent snapshot (committed rows only, WAL included)
// while web and feed-poller keep writing. It is deliberately NOT opened through
// server/db/appDb.js, whose open path migrates, seeds and imports: a backup
// must never write to the database it copies, and a read-only open also means
// a wrong DATA_DIR throws instead of creating an empty app.db and backing that
// up as a success.
//
// Photos are copied after the database snapshot. A photo uploaded in between
// is included without its row (harmless); a photo deleted in between may be
// missing (the row that named it was deleted too, or will be in the next run).
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const MANIFEST = 'MANIFEST.json';
export const MANIFEST_FORMAT = 1;

/** @param {string} path @returns {string} hex sha256 of the file */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Every regular file under `root`, as forward-slash paths relative to `base`.
 * @param {string} root
 * @param {string} base
 * @returns {string[]} sorted
 */
function listFiles(root, base) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
      // Symlinks and other special files are skipped: uploads are plain files.
    }
  };
  walk(root);
  return out.sort();
}

/**
 * integrity_check and a row count for every table of a database file.
 * @param {string} dbPath
 * @returns {{ integrityCheck: string, tables: Record<string, number> }}
 */
export function describeDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrityCheck = db
      .prepare('PRAGMA integrity_check')
      .all()
      .map((r) => r.integrity_check)
      .join('; ');
    const tables = {};
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const name of names) {
      tables[name] = db.prepare(`SELECT count(*) AS c FROM "${name.replace(/"/g, '""')}"`).get().c;
    }
    return { integrityCheck, tables };
  } finally {
    db.close();
  }
}

/**
 * Snapshot DATA_DIR into `<stageDir>/<name>/`: app.db (VACUUM INTO),
 * projects/** (copied), MANIFEST.json (written last).
 *
 * @param {object} options
 * @param {string} options.dataDir the live DATA_DIR; only read
 * @param {string} options.stageDir where the snapshot folder is created; must not be inside dataDir
 * @param {string} options.name the snapshot folder name (retention.js snapshotName)
 * @param {Date} [options.now]
 * @returns {{ dir: string, manifest: object }}
 */
export function createSnapshot({ dataDir, stageDir, name, now = new Date() }) {
  const appDbPath = join(dataDir, 'app.db');
  if (!existsSync(appDbPath)) {
    throw new Error(`no app.db in DATA_DIR (${dataDir}); refusing to back up an empty directory`);
  }
  const rel = relative(dataDir, stageDir);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))) {
    throw new Error(`staging dir ${stageDir} must be outside DATA_DIR ${dataDir}`);
  }
  const dir = join(stageDir, name);
  if (existsSync(dir)) throw new Error(`snapshot folder already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });

  const snapDb = join(dir, 'app.db');
  const live = new DatabaseSync(appDbPath, { readOnly: true });
  try {
    live.exec(`VACUUM INTO '${snapDb.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }
  const { integrityCheck, tables } = describeDb(snapDb);
  if (integrityCheck !== 'ok') throw new Error(`snapshot of app.db failed integrity_check: ${integrityCheck}`);

  const projectsSrc = join(dataDir, 'projects');
  if (existsSync(projectsSrc)) {
    cpSync(projectsSrc, join(dir, 'projects'), { recursive: true, preserveTimestamps: true });
  }

  const files = listFiles(dir, dir).map((path) => {
    const full = join(dir, ...path.split('/'));
    return { path, size: statSync(full).size, sha256: sha256File(full) };
  });
  const manifest = {
    format: MANIFEST_FORMAT,
    name,
    createdAt: now.toISOString(),
    appDb: { integrityCheck, tables },
    files,
  };
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest };
}

/**
 * Check a snapshot folder (freshly built, or downloaded for a restore) against
 * its MANIFEST.json: every listed file present with the same size and sha256,
 * no unlisted files, app.db passes integrity_check, and every table has the
 * row count the manifest recorded.
 *
 * @param {string} dir
 * @returns {{ ok: boolean, problems: string[], manifest: object, tables: Record<string, number>, fileCount: number }}
 */
export function verifySnapshot(dir) {
  const problems = [];
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    return { ok: false, problems: [`no ${MANIFEST}: the snapshot is incomplete`], manifest: null, tables: {}, fileCount: 0 };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== MANIFEST_FORMAT) problems.push(`unknown manifest format ${manifest.format}`);

  const listed = new Set();
  for (const f of manifest.files || []) {
    listed.add(f.path);
    const full = join(dir, ...f.path.split('/'));
    if (!existsSync(full)) {
      problems.push(`missing: ${f.path}`);
      continue;
    }
    const size = statSync(full).size;
    if (size !== f.size) problems.push(`size differs: ${f.path} (${size} != ${f.size})`);
    else if (sha256File(full) !== f.sha256) problems.push(`sha256 differs: ${f.path}`);
  }
  for (const path of listFiles(dir, dir)) {
    if (path !== MANIFEST && !listed.has(path)) problems.push(`not in manifest: ${path}`);
  }

  let tables = {};
  const dbPath = join(dir, 'app.db');
  if (existsSync(dbPath)) {
    const described = describeDb(dbPath);
    tables = described.tables;
    if (described.integrityCheck !== 'ok') problems.push(`app.db integrity_check: ${described.integrityCheck}`);
    const expected = manifest.appDb?.tables || {};
    for (const name of new Set([...Object.keys(expected), ...Object.keys(tables)])) {
      if (expected[name] !== tables[name]) {
        problems.push(`row count differs for ${name}: ${tables[name]} != manifest ${expected[name]}`);
      }
    }
  } else {
    problems.push('missing: app.db');
  }
  return { ok: problems.length === 0, problems, manifest, tables, fileCount: listed.size };
}
