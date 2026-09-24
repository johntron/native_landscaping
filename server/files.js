// Filesystem helpers for the project routes: atomic writes, the layout and
// history files, features.json, and background-upload housekeeping.
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildLayoutCsv } from '../src/data/layoutExporter.js';
import { normalizeProjectIndex, PROJECT_INDEX_PATH } from '../src/data/projectConfig.js';
import { supersededBackgrounds, orphanedBackgrounds, BACKGROUND_DIR } from '../src/data/backgroundStore.js';

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}


/**
 * Keep projects/index.json's label for a project in step with project.json's
 * own `name` after a Setup-mode save. Best effort: the config write already
 * succeeded, and a stale picker label is recoverable (save again, or fix the
 * index by hand) in a way a failed config save is not.
 */
export async function syncProjectIndexName(publicDir, projectId, name) {
  const indexFile = path.join(publicDir, PROJECT_INDEX_PATH);
  try {
    const index = normalizeProjectIndex(JSON.parse(await fs.readFile(indexFile, 'utf-8')));
    const entry = index.projects.find((p) => p.id === projectId);
    if (!entry || entry.name === name) return index;
    entry.name = name;
    await writeJsonAtomic(indexFile, index);
    return index;
  } catch (err) {
    console.warn(`Could not sync project index name for '${projectId}':`, err.message);
    return null;
  }
}

/**
 * Write JSON through a temporary file in the same directory, so a crash or a
 * concurrent read never sees a half-written project.json. Same directory
 * matters: rename is only atomic within a filesystem.
 */
export async function writeJsonAtomic(targetFile, value) {
  const tempFile = `${targetFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tempFile, targetFile);
  } catch (err) {
    await fs.rm(tempFile, { force: true });
    throw err;
  }
}

export async function writeLayoutFile(layoutFile, plants) {
  await fs.writeFile(layoutFile, buildLayoutCsv(plants || []));
}


/**
 * A project that has never drawn a feature has no features.json, and that is
 * the normal case rather than an error — it reads as an empty yard model. A
 * file that exists but is unreadable is a real fault and is left to throw.
 */
export async function readFeaturesFile(featuresFile) {
  try {
    return JSON.parse(await fs.readFile(featuresFile, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function readHistoryFile(historyFile) {
  try {
    const raw = await fs.readFile(historyFile, 'utf-8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const cursor =
      typeof parsed.cursor === 'number' && Number.isFinite(parsed.cursor)
        ? parsed.cursor
        : entries.length - 1;
    return { entries, cursor: cursor >= 0 ? cursor : -1 };
  } catch (err) {
    return { entries: [], cursor: -1 };
  }
}

/**
 * Entries are written as they are handed in: new ones are placements already
 * (makeEntry in routes/project.js), and legacy full-object entries still on
 * disk are left for tools/migrate-history-placements.mjs, which backs the file
 * up first. Written in place, not through a rename, so the file keeps its
 * owner and mode whatever uid the server runs as.
 */
export async function writeHistoryFile(historyFile, history) {
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const cursor =
    typeof history.cursor === 'number' && Number.isFinite(history.cursor)
      ? history.cursor
      : entries.length - 1;
  await fs.writeFile(historyFile, JSON.stringify({ entries, cursor }, null, 2));
}


/** Same temp-then-rename discipline as writeJsonAtomic, for opaque bytes. */
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
