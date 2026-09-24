// The few rclone calls the backup and restore scripts make (nl-3s5.13).
//
// RCLONE_BIN picks the binary (the systemd unit passes the linuxbrew path,
// because linuxbrew is not on a user unit's PATH). Which config file rclone
// reads is rclone's own business: RCLONE_CONFIG in the environment, else
// ~/.config/rclone/rclone.conf. Tests point RCLONE_CONFIG at a throwaway
// config with a local stand-in remote.
import { spawnSync } from 'node:child_process';

export function rcloneBin() {
  return process.env.RCLONE_BIN || 'rclone';
}

/**
 * Run rclone; stderr streams to ours (so it lands in the journal), stdout is
 * returned. Throws on a non-zero exit.
 * @param {string[]} args
 * @param {object} [options]
 * @param {boolean} [options.quietStdout] stream stdout instead of capturing it
 * @returns {string}
 */
export function rclone(args, { quietStdout = false } = {}) {
  const result = spawnSync(rcloneBin(), args, {
    encoding: 'utf8',
    stdio: ['ignore', quietStdout ? 'inherit' : 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`rclone ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`rclone ${args[0]} exited ${result.status}`);
  return result.stdout || '';
}

/**
 * Join a remote root ("rewilder-crypt:" or "rewilder-crypt:sub") and a path.
 * @param {string} remote
 * @param {...string} parts
 */
export function remotePath(remote, ...parts) {
  const base = remote.endsWith(':') || remote.endsWith('/') ? remote : `${remote}/`;
  return base + parts.join('/');
}

/**
 * Every folder under `<remote>snapshots/`, and whether it holds a MANIFEST.json.
 * An absent snapshots folder is an empty list, not an error.
 * @param {string} remote
 * @returns {{ name: string, complete: boolean }[]}
 */
export function listRemoteSnapshots(remote) {
  const root = remotePath(remote, 'snapshots');
  let dirs;
  try {
    dirs = rclone(['lsf', '--dirs-only', root]);
  } catch (err) {
    // lsf on a missing directory fails on most backends; tell that apart from
    // a real failure by checking whether the parent lists.
    if (rclone(['lsf', '--dirs-only', remote]).split('\n').includes('snapshots/')) throw err;
    return [];
  }
  const manifests = new Set(
    rclone(['lsf', '--files-only', '--recursive', '--max-depth', '2', '--include', '*/MANIFEST.json', root])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('/')[0])
  );
  return dirs
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/\/$/, ''))
    .map((name) => ({ name, complete: manifests.has(name) }));
}
