// One-time copy of the yards that lived as files under projects/<slug>/ into
// app.db (nl-3s5.3), following server/db/legacyImport.js (nl-3s5.11):
//
// - Copy, never move. Every source file is only read; nothing under the
//   projects directory is written, renamed or deleted.
// - Once. The whole set is imported in one BEGIN IMMEDIATE transaction that
//   re-checks the app_meta marker, verifies what it wrote, and records the
//   marker before it commits. A second run is a no-op.
// - Fail closed. A listed yard without project.json, an unreadable history,
//   a layout row with no species id, or a projects directory with yards but no
//   index.json throws before anything is written, and records no marker, so
//   a fixed source can be imported later. Only a MISSING layout-history.json
//   reads as "no history"; one that does not parse is an error, never an
//   empty history.
//
// Run by tools/import-projects.mjs only, never on web start: the commit that
// stops tracking projects/* deletes the tracked files from the dev tree it is
// merged into, and an import that ran on the restart after that merge would
// find the yards half gone. The runbook stops web, imports, then deploys.
//
// What each yard becomes:
//   project.json         -> projects.config_json, verbatim text
//   features.json        -> projects.features_json, verbatim (NULL if absent)
//   location.json        -> projects.location_json, verbatim (NULL if absent)
//   layout-history.json  -> history_entries (ids, timestamps, descriptions kept;
//                           plants reduced to placements) and history_cursor
//   planting_layout.csv  -> not stored. It was what the old client showed, so it
//                           picks the cursor exactly as the old client's
//                           src/history/reconcileLayout.js did: 'current' and
//                           'moved' keep every entry, 'diverged' appends the
//                           CSV as "Layout file edited outside the app", and
//                           'empty' makes the CSV the first entry.
//   img/*                -> DATA_DIR/projects/<projects.id>/img/*, byte for byte
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parsePlantLayoutCsv } from '../../src/data/plantParser.js';
import { toPlacementEntry, toPlacements } from '../../src/data/placements.js';
import { reconcileHistoryWithLayout } from '../../src/history/reconcileLayout.js';
import { isValidProjectId } from '../../src/data/projectConfig.js';
import { BACKGROUND_DIR } from '../../src/data/backgroundStore.js';
import { findOwner } from './legacyImport.js';
import { findOwnedProject, insertProject, projectDataDir, INITIAL_ENTRY_DESCRIPTION } from './projectStore.js';

export const PROJECTS_META_KEY = 'legacy_import.projects';
export const OUTSIDE_EDIT_DESCRIPTION = 'Layout file edited outside the app';
const DEFAULT_ENTRY_DESCRIPTION = 'Manual layout update';

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function readMarker(db) {
  if (!tableExists(db, 'app_meta')) return null;
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PROJECTS_META_KEY);
  return row ? JSON.parse(row.value) : null;
}

function readOptionalText(file) {
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * The slugs to import, in index.json order (the first one was the default,
 * and stays first: projectIndexFor makes the oldest yard the default).
 * `slugs` overrides the index, for a directory that has none.
 *
 * @returns {{ slugs: string[], names: Map<string, string>, unlisted: string[] }}
 */
export function listLegacySlugs(projectsDir, slugs) {
  const onDisk = existsSync(projectsDir)
    ? readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(path.join(projectsDir, d.name, 'project.json')))
        .map((d) => d.name)
    : [];
  const names = new Map();
  let listed;
  if (Array.isArray(slugs) && slugs.length) {
    listed = slugs;
  } else {
    const indexText = readOptionalText(path.join(projectsDir, 'index.json'));
    if (indexText === null) {
      if (onDisk.length) {
        throw new Error(
          `${projectsDir} has yards (${onDisk.join(', ')}) but no index.json; name them explicitly (--slug) rather than guess`
        );
      }
      return { slugs: [], names, unlisted: [] };
    }
    const index = JSON.parse(indexText);
    listed = (Array.isArray(index.projects) ? index.projects : []).map((entry) => {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (entry && typeof entry === 'object' && entry.name) names.set(id, String(entry.name));
      return id;
    });
  }
  listed.forEach((slug) => {
    if (!isValidProjectId(slug)) throw new Error(`Invalid project slug "${slug}" in the import list`);
  });
  if (new Set(listed).size !== listed.length) throw new Error('The import list names a yard twice');
  return { slugs: listed, names, unlisted: onDisk.filter((slug) => !listed.includes(slug)) };
}

/**
 * Read one legacy yard and work out exactly what it will become. Throws on
 * anything that would make the copy lossy or a guess.
 *
 * @param {string} projectsDir
 * @param {string} slug
 * @param {string} [indexName] the name index.json gave it (the picker label)
 */
export function readLegacyProject(projectsDir, slug, indexName) {
  const dir = path.join(projectsDir, slug);
  const configText = readOptionalText(path.join(dir, 'project.json'));
  if (configText === null) throw new Error(`${slug}: project.json is missing`);
  const config = JSON.parse(configText);
  const name = String(indexName || config.name || slug);

  const featuresText = readOptionalText(path.join(dir, 'features.json'));
  if (featuresText !== null) JSON.parse(featuresText); // must parse; stored verbatim
  const locationText = readOptionalText(path.join(dir, 'location.json'));
  if (locationText !== null) JSON.parse(locationText);

  const historyText = readOptionalText(path.join(dir, 'layout-history.json'));
  let fileEntries = [];
  let fileCursor = -1;
  if (historyText !== null) {
    let parsed;
    try {
      parsed = JSON.parse(historyText);
    } catch (err) {
      throw new Error(`${slug}: layout-history.json does not parse (${err.message}); refusing to import it as empty`);
    }
    if (!Array.isArray(parsed?.entries)) throw new Error(`${slug}: layout-history.json has no entries[]`);
    fileEntries = parsed.entries.map((raw, i) => {
      const entry = toPlacementEntry(raw);
      if (!entry || !Array.isArray(entry.plants)) throw new Error(`${slug}: history entry ${i} has no plants[]`);
      return {
        id: String(entry.id || `imported-${slug}-${i}`),
        timestamp: String(entry.timestamp || new Date(0).toISOString()),
        description: String(entry.description || DEFAULT_ENTRY_DESCRIPTION),
        plants: entry.plants,
      };
    });
    fileCursor =
      typeof parsed.cursor === 'number' && Number.isFinite(parsed.cursor) ? parsed.cursor : fileEntries.length - 1;
  }

  const layoutCsv = readOptionalText(path.join(dir, 'planting_layout.csv'));
  let csvPlacements = null;
  if (layoutCsv !== null) {
    csvPlacements = parsePlantLayoutCsv(layoutCsv).map((row) => {
      if (!row.speciesId) {
        throw new Error(`${slug}: planting_layout.csv row "${row.id}" has no species_id; run tools/migrate-species-ids.mjs first`);
      }
      return { id: row.id, speciesId: row.speciesId, x: row.x, y: row.y };
    });
  }

  let entries;
  let cursor;
  let verdict;
  if (csvPlacements === null) {
    // No layout file: the history is all there is.
    entries = fileEntries;
    cursor = entries.length ? Math.max(0, Math.min(fileCursor, entries.length - 1)) : -1;
    verdict = 'no-layout-file';
  } else {
    const reconciled = reconcileHistoryWithLayout(fileEntries, fileCursor, csvPlacements);
    verdict = reconciled.verdict;
    entries = reconciled.entries;
    cursor = reconciled.cursor;
    const stamp = new Date().toISOString();
    if (verdict === 'empty' && csvPlacements.length) {
      entries = [{ id: `imported-${slug}-initial`, timestamp: stamp, description: INITIAL_ENTRY_DESCRIPTION, plants: csvPlacements }];
      cursor = 0;
    } else if (verdict === 'diverged') {
      entries = [
        ...entries,
        { id: `imported-${slug}-outside-edit`, timestamp: stamp, description: OUTSIDE_EDIT_DESCRIPTION, plants: csvPlacements },
      ];
      cursor = entries.length - 1;
    }
  }
  entries = entries.map((entry) => ({ ...entry, plants: toPlacements(entry.plants) }));

  const imgDir = path.join(dir, BACKGROUND_DIR);
  const photos = existsSync(imgDir)
    ? readdirSync(imgDir, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.tmp'))
        .map((d) => {
          const file = path.join(imgDir, d.name);
          const bytes = readFileSync(file);
          return { name: d.name, file, bytes: bytes.length, sha256: sha256(bytes) };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return {
    slug,
    name,
    configText,
    featuresText,
    locationText,
    fileEntries: fileEntries.length,
    fileCursor,
    verdict,
    entries,
    cursor,
    photos,
  };
}

/** A summary safe to print: no location text, no config body. */
function summarize(project) {
  return {
    slug: project.slug,
    name: project.name,
    fileEntries: project.fileEntries,
    fileCursor: project.fileCursor,
    verdict: project.verdict,
    entries: project.entries.length,
    cursor: project.cursor,
    hasFeatures: project.featuresText !== null,
    hasLocation: project.locationText !== null,
    photos: project.photos.length,
    photoBytes: project.photos.reduce((sum, p) => sum + p.bytes, 0),
  };
}

function copyPhotos(project, dataDir, projectRowId) {
  const target = path.join(projectDataDir(dataDir, projectRowId), BACKGROUND_DIR);
  if (existsSync(target) && readdirSync(target).length) {
    throw new Error(`${project.slug}: ${target} already holds files; refusing to mix them with an import`);
  }
  mkdirSync(target, { recursive: true });
  project.photos.forEach((photo) => {
    const dest = path.join(target, photo.name);
    copyFileSync(photo.file, dest);
    const copied = readFileSync(dest);
    if (copied.length !== photo.bytes || sha256(copied) !== photo.sha256) {
      throw new Error(`${project.slug}: photo ${photo.name} did not copy byte for byte`);
    }
  });
  return target;
}

/**
 * Import every listed yard as `ownerEmail`'s (or the sole admin's), once.
 *
 * @param {import('node:sqlite').DatabaseSync} db app.db, migrated to 003 or later
 * @param {{ projectsDir: string, dataDir: string, ownerEmail?: string, slugs?: string[] }} options
 * @returns {object} what happened; `status` is 'already-imported', 'imported' or 'no-owner'
 */
export function importLegacyProjects(db, { projectsDir, dataDir, ownerEmail, slugs }) {
  const recorded = readMarker(db);
  if (recorded) return { status: 'already-imported', recorded };

  const owner = findOwner(db, ownerEmail);
  if (!owner) {
    return {
      status: 'no-owner',
      reason: ownerEmail
        ? 'no users row for OWNER_EMAIL yet (web seeds it on start)'
        : 'OWNER_EMAIL is unset and app.db does not have exactly one admin',
    };
  }

  // Everything is read, parsed and reconciled before the write lock is taken.
  const list = listLegacySlugs(projectsDir, slugs);
  const projects = list.slugs.map((slug) => readLegacyProject(projectsDir, slug, list.names.get(slug)));

  const createdDirs = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = readMarker(db);
    if (existing) {
      db.exec('COMMIT');
      return { status: 'already-imported', recorded: existing };
    }
    const results = [];
    for (const project of projects) {
      if (findOwnedProject(db, owner.id, project.slug)) {
        // Never merge into a yard the owner already has (made in the app
        // before the import ran): leave both alone and say so.
        results.push({ ...summarize(project), status: 'skipped-exists' });
        continue;
      }
      const projectRowId = insertProject(db, {
        ownerId: owner.id,
        slug: project.slug,
        name: project.name,
        configJson: project.configText,
        featuresJson: project.featuresText,
        locationJson: project.locationText,
        entries: project.entries,
        cursor: project.cursor,
      });
      const photoDir = path.join(projectDataDir(dataDir, projectRowId), BACKGROUND_DIR);
      const existedBefore = existsSync(photoDir);
      copyPhotos(project, dataDir, projectRowId);
      if (!existedBefore) createdDirs.push(projectDataDir(dataDir, projectRowId));

      // Verify inside the transaction, against what was just written.
      const row = db
        .prepare('SELECT config_json, features_json, location_json, history_cursor FROM projects WHERE id = ?')
        .get(projectRowId);
      const count = db.prepare('SELECT COUNT(*) AS n FROM history_entries WHERE project_id = ?').get(projectRowId).n;
      const problems = [];
      if (count !== project.entries.length) problems.push(`${count} entries written, ${project.entries.length} expected`);
      if (Number(row.history_cursor) !== project.cursor) problems.push(`cursor ${row.history_cursor}, expected ${project.cursor}`);
      if (row.config_json !== project.configText) problems.push('config differs');
      if ((row.features_json ?? null) !== project.featuresText) problems.push('features differ');
      if ((row.location_json ?? null) !== project.locationText) problems.push('location differs');
      const photosWritten = readdirSync(photoDir).length;
      if (photosWritten !== project.photos.length) problems.push(`${photosWritten} photos copied, ${project.photos.length} expected`);
      if (problems.length) throw new Error(`${project.slug}: ${problems.join('; ')}; rolled back`);

      results.push({ ...summarize(project), status: 'imported', projectRowId });
    }
    const marker = {
      status: 'imported',
      at: new Date().toISOString(),
      from: projectsDir,
      ownerId: owner.id,
      projects: results.map(({ slug, status, projectRowId, entries, cursor, verdict, photos }) => ({
        slug,
        status,
        projectRowId,
        entries,
        cursor,
        verdict,
        photos,
      })),
      unlisted: list.unlisted,
    };
    db.prepare(
      `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(PROJECTS_META_KEY, JSON.stringify(marker), marker.at);
    db.exec('COMMIT');
    return { status: 'imported', owner: { id: owner.id }, projects: results, unlisted: list.unlisted };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // nothing to roll back
    }
    // Only directories this run created; never anything that was there before.
    createdDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    throw err;
  }
}

/**
 * What importLegacyProjects would do, with app.db opened read-only and no
 * migration run: safe against the live data/ with web up, and against an
 * app.db still at schema 002 (no projects table yet). Prints no location or
 * config content, only counts and yes/no.
 *
 * @param {{ projectsDir: string, dataDir: string, ownerEmail?: string, slugs?: string[] }} options
 */
export function previewProjectImport({ projectsDir, dataDir, ownerEmail, slugs }) {
  const appPath = path.join(dataDir, 'app.db');
  const report = {
    projectsDir,
    dataDir,
    appDb: { path: appPath, exists: existsSync(appPath) },
    owner: null,
    marker: null,
    projects: [],
    unlisted: [],
    errors: [],
  };
  let app = null;
  try {
    if (report.appDb.exists) {
      app = new DatabaseSync(appPath, { readOnly: true });
      app.exec('PRAGMA busy_timeout = 5000');
      report.appDb.schemaVersion = tableExists(app, 'schema_version')
        ? app.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v
        : 0;
      report.appDb.hasProjectsTable = tableExists(app, 'projects');
      report.appDb.projectRows = report.appDb.hasProjectsTable
        ? app.prepare('SELECT COUNT(*) AS n FROM projects').get().n
        : null;
      report.owner = findOwner(app, ownerEmail);
      report.marker = readMarker(app);
    }
    let list;
    try {
      list = listLegacySlugs(projectsDir, slugs);
    } catch (err) {
      report.errors.push(err.message);
      return report;
    }
    report.unlisted = list.unlisted;
    for (const slug of list.slugs) {
      try {
        const project = readLegacyProject(projectsDir, slug, list.names.get(slug));
        const exists =
          app && report.appDb.hasProjectsTable && report.owner
            ? !!findOwnedProject(app, report.owner.id, slug)
            : false;
        report.projects.push({ ...summarize(project), alreadyInAppDb: exists });
      } catch (err) {
        report.errors.push(err.message);
      }
    }
    report.wouldImport =
      !report.marker && report.owner && !report.errors.length
        ? report.projects.filter((p) => !p.alreadyInAppDb).map((p) => p.slug)
        : [];
  } finally {
    if (app) app.close();
  }
  return report;
}
