#!/usr/bin/env node
// Fetch and verify a backup snapshot (nl-3s5.13). It never writes into DATA_DIR:
// it downloads into an empty directory you name and checks it against its
// MANIFEST.json. Putting it live is a separate, deliberate step (stop the
// services, move the old files aside); see AGENTS.md, "Data safety".
//
//   node tools/backup/restore.mjs list
//   node tools/backup/restore.mjs fetch <snapshot|latest> <empty-dir>
//   node tools/backup/restore.mjs verify <snapshot-dir>
//
// BACKUP_REMOTE (default "rewilder-crypt:"), RCLONE_BIN and RCLONE_CONFIG as in
// run-backup.mjs. Exits 1 when verification fails.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySnapshot } from './snapshot.js';
import { parseSnapshotName } from './retention.js';
import { rclone, remotePath, listRemoteSnapshots } from './rclone.js';

function report(dir) {
  const result = verifySnapshot(dir);
  if (result.manifest) {
    console.log(`snapshot ${result.manifest.name} (created ${result.manifest.createdAt})`);
    console.log(`  files checked: ${result.fileCount} (sha256 and size against the manifest)`);
    for (const [table, count] of Object.entries(result.tables)) console.log(`  ${table}: ${count} rows`);
  }
  if (result.ok) {
    console.log('  integrity_check: ok; row counts match the manifest; OK');
    return 0;
  }
  for (const p of result.problems) console.error(`  PROBLEM: ${p}`);
  console.error('verification FAILED');
  return 1;
}

export function main(argv = process.argv.slice(2)) {
  const remote = process.env.BACKUP_REMOTE || 'rewilder-crypt:';
  const [command, a, b] = argv;
  if (command === 'list') {
    const all = listRemoteSnapshots(remote);
    const ours = all.filter((s) => parseSnapshotName(s.name)).sort((x, y) => (x.name < y.name ? 1 : -1));
    for (const s of ours) console.log(`${s.name}${s.complete ? '' : '  (incomplete: no manifest)'}`);
    for (const s of all.filter((x) => !parseSnapshotName(x.name))) console.log(`${s.name}  (not a snapshot; never pruned)`);
    return 0;
  }
  if (command === 'verify' && a) return report(resolve(a));
  if (command === 'fetch' && a && b) {
    const target = resolve(b);
    if (existsSync(target) && readdirSync(target).length > 0) {
      console.error(`restore: ${target} is not empty; fetch only into a new or empty directory`);
      return 1;
    }
    let name = a;
    if (name === 'latest') {
      const complete = listRemoteSnapshots(remote)
        .filter((s) => s.complete && parseSnapshotName(s.name))
        .map((s) => s.name)
        .sort();
      name = complete.at(-1);
      if (!name) {
        console.error(`restore: no complete snapshot under ${remotePath(remote, 'snapshots')}`);
        return 1;
      }
    }
    mkdirSync(target, { recursive: true });
    rclone(['copy', remotePath(remote, 'snapshots', name), target], { quietStdout: true });
    return report(target);
  }
  console.error('usage: restore.mjs list | fetch <snapshot|latest> <empty-dir> | verify <snapshot-dir>');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`restore: FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}
