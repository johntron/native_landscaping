// Filesystem helpers for the project routes: the one thing about a yard that
// is still a file since nl-3s5.3 is its photos (DATA_DIR/projects/<id>/img/),
// so what is left is an atomic write and background-upload housekeeping.
// Config, features, location and history live in app.db
// (server/db/projectStore.js).
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { supersededBackgrounds, orphanedBackgrounds, BACKGROUND_DIR } from '../src/data/backgroundStore.js';

/**
 * Write through a temporary file in the same directory, so a crash or a
 * concurrent read never sees a half-written photo. Same directory matters:
 * rename is only atomic within a filesystem.
 */
export async function writeFileAtomic(targetFile, contents) {
  const tempFile = `${targetFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempFile, contents);
    await fs.rename(tempFile, targetFile);
  } catch (err) {
    await fs.rm(tempFile, { force: true });
    throw err;
  }
}

/**
 * Drop a view's earlier uploads, except any a revision still names: an undo
 * can bring back the setup that shows it (nl-3s5.20). Best effort: the new
 * background is already on disk and usable, so a failure to tidy up must not
 * fail the request.
 *
 * @param {string} dir the yard's img/ directory
 * @param {string} viewId
 * @param {string} keepFileName the upload that just succeeded
 * @param {Set<string>|string[]} referenced basenames any revision references
 */
export async function removeSupersededBackgrounds(dir, viewId, keepFileName, referenced = []) {
  const keep = new Set(referenced);
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(
      supersededBackgrounds(entries, viewId, keepFileName)
        .filter((name) => !keep.has(name))
        .map((name) => fs.rm(path.join(dir, name), { force: true }))
    );
  } catch (err) {
    console.warn(`Could not remove superseded backgrounds in ${dir}:`, err.message);
  }
}

/**
 * Delete uploaded backgrounds that neither the just-saved config nor any
 * revision in the yard's history references: the cleanup point for an upload
 * the user abandoned by never running Save views. A photo an older revision
 * still names is kept, so undoing back to that setup finds it (nl-3s5.20);
 * one that only a truncated redo tail named goes on the next sweep. Best
 * effort: the config write already succeeded, so a failure to tidy up img/
 * must not fail the request.
 *
 * @param {string} projectDir the yard's directory under DATA_DIR
 * @param {Set<string>|string[]} referenced basenames still referenced
 */
export async function removeOrphanedBackgrounds(projectDir, referenced) {
  const dir = path.join(projectDir, BACKGROUND_DIR);
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(
      orphanedBackgrounds(entries, [...referenced]).map((name) =>
        fs.rm(path.join(dir, name), { force: true })
      )
    );
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not sweep orphaned backgrounds in ${dir}:`, err.message);
  }
}
