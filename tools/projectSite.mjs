// A yard's site for the offline fetch scripts (fetch-ecosystem-index,
// fetch-nearby-fauna, fetch-nhd-creeks, fetch-osm-greenspace): its `place`
// label and the exact location behind it. Both lived in files until nl-3s5.3
// (projects/<id>/project.json and the gitignored location.json); they are
// now in app.db (projects.config_json and projects.location_json), so these
// scripts read them from there.
//
// Slugs are unique per owner, so the yard is looked up among one owner's:
// `--owner <email>`, else OWNER_EMAIL, else the sole admin (the same rule as
// the imports, server/db/legacyImport.js findOwner). app.db is opened
// read-only, so this is safe with web running. DATA_DIR picks the directory.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDataDir } from './dataDir.js';
import { findOwner } from '../server/db/legacyImport.js';
import { findOwnedProject, parseLocation } from '../server/db/projectStore.js';

/**
 * Open app.db read-only, or throw a message that says what to do.
 * @param {string} [dataDir]
 */
export function openAppDbReadOnly(dataDir) {
  const file = path.join(resolveDataDir(dataDir), 'app.db');
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist; web creates it on start, and tools/import-projects.mjs fills in the yards`);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Find a yard by slug among one owner's.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} slug
 * @param {{ ownerEmail?: string }} [options]
 * @returns {import('../server/db/projectStore.js').ProjectRecord}
 */
export function findYard(db, slug, { ownerEmail = process.env.OWNER_EMAIL } = {}) {
  const owner = findOwner(db, ownerEmail);
  if (!owner) {
    throw new Error(
      ownerEmail
        ? `No user ${ownerEmail} in app.db`
        : 'Whose yard? Pass --owner <email> or set OWNER_EMAIL (app.db does not have exactly one admin)'
    );
  }
  const project = findOwnedProject(db, owner.id, slug);
  if (!project) {
    throw new Error(`No yard "${slug}" for ${owner.email} in app.db (run tools/import-projects.mjs if it is still only on disk)`);
  }
  return project;
}

/**
 * The yard's id, place label and location the fetch scripts need, or a thrown
 * message saying which is missing and how to set it.
 *
 * The nearby-species index is keyed by the yard's id (nl-3s5.6), so
 * tools/fetch-ecosystem-index.mjs passes `requirePlace: false`; the scripts
 * that still write place-keyed committed tables (nearby fauna, anchors) keep
 * requiring one.
 *
 * @param {string} slug
 * @param {{ ownerEmail?: string, dataDir?: string, requirePlace?: boolean }} [options]
 * @returns {{ projectId: number, place: string, location: { lat?: number, lng?: number, address?: string } }}
 */
export function readProjectSite(slug, { ownerEmail, dataDir, requirePlace = true } = {}) {
  const db = openAppDbReadOnly(dataDir);
  try {
    const project = findYard(db, slug, { ownerEmail: ownerEmail ?? process.env.OWNER_EMAIL });
    const config = JSON.parse(project.configJson);
    const place = String(config.place || '').trim();
    if (!place && requirePlace) {
      throw new Error(`Yard "${slug}" declares no "place"; add one before fetching.`);
    }
    const location = parseLocation(project);
    if (!location) {
      throw new Error(
        `Yard "${slug}" has no location. Set one (it never reaches git): ` +
          `node tools/project-location.mjs --project ${slug} --lat <lat> --lng <lng>  (or --address "...")`
      );
    }
    return { projectId: project.id, place, location };
  } finally {
    db.close();
  }
}

/** `--owner <email>` from argv, if given. */
export function ownerFromArgs(args) {
  const i = args.indexOf('--owner');
  return i >= 0 ? args[i + 1] : undefined;
}
