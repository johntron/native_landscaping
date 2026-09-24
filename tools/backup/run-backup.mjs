#!/usr/bin/env node
// Nightly off-machine backup of app.db and the yard photos (nl-3s5.13).
// Run by the systemd user timer in tools/backup/systemd/; safe to run by hand.
// Restore steps: AGENTS.md, "Data safety".
//
//   DATA_DIR=/path/to/data BACKUP_REMOTE=rewilder-crypt: node tools/backup/run-backup.mjs
//
// Each run:
//   1. snapshots DATA_DIR into a private temp dir (snapshot.js: app.db by
//      VACUUM INTO, integrity_check, projects/**, MANIFEST.json with sha256s
//      and row counts) and verifies it,
//   2. uploads it to <BACKUP_REMOTE>snapshots/<YYYY-MM-DDTHHMMSSZ>/, data files
//      first and MANIFEST.json last, so a folder with a manifest is complete,
//   3. checks the upload with `rclone cryptcheck` (every file's checksum,
//      compared through the encryption),
//   4. prunes to 14 dailies and 8 weeklies (retention.js),
//   5. writes DATA_DIR/backup-status.json.
// Any failure exits 1, skips the prune, logs to stderr (journalctl) and records
// lastError in the status file. The temp dir is always removed.
//
// Environment:
//   DATA_DIR            required. The live data dir; only read (plus the status file).
//   BACKUP_REMOTE       the rclone crypt remote, default "rewilder-crypt:". It
//                       must be a crypt remote: Drive may only ever see ciphertext.
//   BACKUP_KEEP_DAILY   default 14
//   BACKUP_KEEP_WEEKLY  default 8
//   RCLONE_BIN          default "rclone" on PATH
//   RCLONE_CONFIG       read by rclone itself; default ~/.config/rclone/rclone.conf
//   TMPDIR              where the staging copy is made (it holds a plaintext
//                       copy of app.db for the length of the run, mode 0700)
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot, verifySnapshot, MANIFEST } from './snapshot.js';
import { planRetention, snapshotName } from './retention.js';
import { rclone, remotePath, listRemoteSnapshots } from './rclone.js';

export const STATUS_FILE = 'backup-status.json';

const log = (msg) => console.log(`backup: ${msg}`);

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}

/**
 * Refuse any remote rclone does not report as type crypt, so a typo such as
 * BACKUP_REMOTE=gdrive: can never upload plaintext.
 * @param {string} remote
 */
function assertCryptRemote(remote) {
  const name = remote.split(':')[0];
  const dump = JSON.parse(rclone(['config', 'dump']));
  const type = dump[name]?.type;
  if (type !== 'crypt') {
    throw new Error(`BACKUP_REMOTE ${remote} is ${type ? `type ${type}` : 'not configured'}; it must be a crypt remote (see tools/backup/setup-crypt-remote.sh)`);
  }
}

/** Write the status file atomically, keeping lastSuccess* from earlier runs. */
function writeStatus(dataDir, patch) {
  const path = join(dataDir, STATUS_FILE);
  let previous = {};
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // first run, or an unreadable file: start fresh
  }
  const next = { ...previous, ...patch };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}

export async function main() {
  const startedAt = new Date();
  const dataDirEnv = process.env.DATA_DIR;
  if (!dataDirEnv) {
    console.error('backup: DATA_DIR is required (the live data dir holding app.db)');
    return 1;
  }
  const dataDir = resolve(dataDirEnv);
  const remote = process.env.BACKUP_REMOTE || 'rewilder-crypt:';
  const name = snapshotName(startedAt);
  let stageDir;
  try {
    const daily = intEnv('BACKUP_KEEP_DAILY', 14);
    const weekly = intEnv('BACKUP_KEEP_WEEKLY', 8);
    assertCryptRemote(remote);

    stageDir = mkdtempSync(join(tmpdir(), 'rewilder-backup-'));
    log(`snapshot ${name} of ${dataDir}`);
    const { dir, manifest } = createSnapshot({ dataDir, stageDir, name, now: startedAt });
    const check = verifySnapshot(dir);
    if (!check.ok) throw new Error(`local snapshot failed verification: ${check.problems.join('; ')}`);
    const rows = Object.entries(manifest.appDb.tables).map(([t, c]) => `${t}=${c}`).join(' ');
    log(`app.db ok (${rows}); ${manifest.files.length} files`);

    const dest = remotePath(remote, 'snapshots', name);
    rclone(['copy', '--exclude', `/${MANIFEST}`, dir, dest], { quietStdout: true });
    rclone(['copyto', join(dir, MANIFEST), remotePath(dest, MANIFEST)], { quietStdout: true });
    rclone(['cryptcheck', '--one-way', dir, dest], { quietStdout: true });
    log(`uploaded and cryptchecked ${dest}`);

    const plan = planRetention(listRemoteSnapshots(remote), { daily, weekly, protect: name });
    for (const old of plan.prune) {
      rclone(['purge', remotePath(remote, 'snapshots', old)], { quietStdout: true });
      log(`pruned ${old}`);
    }
    log(`keeping ${plan.keep.length} snapshots${plan.ignored.length ? `; ignored ${plan.ignored.join(', ')}` : ''}`);

    const finishedAt = new Date().toISOString();
    writeStatus(dataDir, {
      lastAttemptAt: startedAt.toISOString(),
      lastSuccessAt: finishedAt,
      lastSnapshot: name,
      lastError: null,
      remote,
      files: manifest.files.length,
      tables: manifest.appDb.tables,
      kept: plan.keep.length,
      pruned: plan.prune,
    });
    log(`done ${name}`);
    return 0;
  } catch (err) {
    console.error(`backup: FAILED ${name}: ${err.message}`);
    try {
      writeStatus(dataDir, {
        lastAttemptAt: startedAt.toISOString(),
        lastError: `${new Date().toISOString()} ${err.message}`,
        remote,
      });
    } catch (statusErr) {
      console.error(`backup: could not write ${STATUS_FILE}: ${statusErr.message}`);
    }
    return 1;
  } finally {
    if (stageDir) rmSync(stageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
