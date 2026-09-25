// Per-user cap on total uploaded yard-photo bytes (nl-3s5.17, the remaining
// item of the bead whose request-log and Node-pin items already shipped).
//
// Photos are files under DATA_DIR/projects/<projects.id>/img/, one directory
// per yard, keyed by the yard's row id (see server/db/projectStore.js
// projectDataDir). A user's usage is every one of THEIR yards' img/
// directories, summed; the shared example yard is owned by the system user
// (EXAMPLE_OWNER_EMAIL) and so never appears in anyone else's sum, and its
// own photos are written only by tools/refresh-example-yard.mjs, never
// counted against a quota at all.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDataDir } from './projectStore.js';

/**
 * The cap, in MB. A judgement call, not a measured limit: `du -sh` on the
 * live tree's data/projects (each yard's img directory) put the owner's four
 * yards at roughly 3 MB combined, so 50 MB is about 15x that — comfortable
 * headroom for the owner alone, and enough for a handful of other accounts
 * before anyone needs to raise it. `PHOTO_QUOTA_MB` overrides it without a
 * deploy.
 */
export const DEFAULT_PHOTO_QUOTA_MB = 50;

/** The configured cap in bytes. `env` is injectable for tests. */
export function photoQuotaBytes(env = process.env) {
  const raw = Number(env.PHOTO_QUOTA_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PHOTO_QUOTA_MB;
  return mb * 1024 * 1024;
}

// No owner exemption. At 50 MB the owner's own yards (~3 MB) are nowhere
// close to the cap, so exempting them buys nothing today, and a cap that the
// person who reads this code doesn't have to obey is a much weaker guard
// against a bug (or a compromised session) that uploads in a loop. If the
// owner ever legitimately needs more, raise PHOTO_QUOTA_MB rather than
// carving out an exception — that keeps the number every account is
// measured against the same one.

/**
 * Total bytes of files under `dir`, recursively. A missing directory (a
 * yard with no photos yet) counts as zero rather than throwing.
 */
export async function photoDirSizeBytes(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await photoDirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // Removed between readdir and stat (a concurrent sweep) — not a byte
        // this request needs to account for.
      }
    }
  }
  return total;
}

/** The row ids of every yard `ownerId` owns. */
function projectIdsForOwner(db, ownerId) {
  return db
    .prepare('SELECT id FROM projects WHERE owner_id = ?')
    .all(Number(ownerId))
    .map((row) => Number(row.id));
}

/**
 * Bytes of photos across every yard `ownerId` owns, computed on demand.
 *
 * No cached counter: at this scale (a handful of yards, a handful of photos
 * each) walking every img/ directory is milliseconds, and a counter would
 * need to be kept exactly in step with every place bytes can change on
 * disk — an upload, a config save (which sweeps orphaned/superseded photos),
 * an undo, and copy-example — which is four more places a cached number
 * could drift from what is actually on disk. Revisit this if a user's yard
 * or photo count ever grows enough to make the walk slow.
 */
export async function photoUsageBytes(db, dataDir, ownerId) {
  const ids = projectIdsForOwner(db, ownerId);
  let total = 0;
  for (const id of ids) {
    total += await photoDirSizeBytes(path.join(projectDataDir(dataDir, id), 'img'));
  }
  return total;
}

/** Whether `incomingBytes` more would fit under `capBytes`, given `usedBytes` already on disk. */
export function fitsQuota(usedBytes, incomingBytes, capBytes) {
  return usedBytes + incomingBytes <= capBytes;
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * The 413 body for a quota-exceeded upload or copy: `used`/`cap` in bytes
 * (for the client to render its own "X of Y MB" line) plus a human-readable
 * `error` naming both in MB and saying what to do next.
 */
export function quotaExceededBody(usedBytes, incomingBytes, capBytes) {
  return {
    error:
      `Photo storage limit reached: ${mb(usedBytes)} MB of ${mb(capBytes)} MB used, and this photo ` +
      `needs ${mb(incomingBytes)} MB more. Delete or replace an older photo in one of your yards ` +
      '(Setup mode) to free space.',
    used: usedBytes,
    cap: capBytes,
  };
}
