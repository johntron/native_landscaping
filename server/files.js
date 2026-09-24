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
 * Drop a view's earlier uploads. Best effort: the new background is already on
 * disk and usable, so a failure to tidy up must not fail the request.
 */
export async function removeSupersededBackgrounds(dir, viewId, keepFileName) {
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(
      supersededBackgrounds(entries, viewId, keepFileName).map((name) =>
        fs.rm(path.join(dir, name), { force: true })
      )
    );
  } catch (err) {
    console.warn(`Could not remove superseded backgrounds in ${dir}:`, err.message);
  }
}

/**
 * Delete uploaded backgrounds no view in the just-saved config references any
 * more — the cleanup point for an upload the user abandoned by never running
 * Save views. Best effort: the config write already succeeded, so a failure
 * to tidy up img/ must not fail the request.
 */
export async function removeOrphanedBackgrounds(projectDir, config) {
  const dir = path.join(projectDir, BACKGROUND_DIR);
  try {
    const referenced = config.views
      .map((view) => view.background)
      .filter(Boolean)
      .map((background) => path.basename(background));
    const entries = await fs.readdir(dir);
    await Promise.all(
      orphanedBackgrounds(entries, referenced).map((name) =>
        fs.rm(path.join(dir, name), { force: true })
      )
    );
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not sweep orphaned backgrounds in ${dir}:`, err.message);
  }
}
