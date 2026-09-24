#!/usr/bin/env node
/**
 * Show or set a yard's exact location, which lives in app.db
 * (projects.location_json) and never in git (nl-3s5.3). It replaces
 * hand-writing projects/<id>/location.json, which is what the fetch scripts
 * used to read (tools/projectSite.mjs).
 *
 *   node tools/project-location.mjs --project backyard                     # has one? (prints no coordinates)
 *   node tools/project-location.mjs --project backyard --lat 32.9 --lng -96.7
 *   node tools/project-location.mjs --project backyard --address "..."
 *   node tools/project-location.mjs --project backyard --clear
 *
 * `--owner <email>` (else OWNER_EMAIL, else the sole admin) picks whose yard,
 * since slugs are unique per owner. DATA_DIR picks the directory. A write is
 * one transaction against the live app.db, safe with web running.
 */
import { openAppDb } from '../server/db/appDb.js';
import { saveProjectLocation, parseLocation } from '../server/db/projectStore.js';
import { findYard, ownerFromArgs } from './projectSite.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const slug = valueOf('--project');
if (!slug) {
  console.error('Usage: node tools/project-location.mjs --project <slug> [--owner <email>] [--lat <n> --lng <n> | --address "..." | --clear]');
  process.exit(1);
}
const ownerEmail = ownerFromArgs(args) ?? process.env.OWNER_EMAIL;

let location;
if (args.includes('--clear')) {
  location = null;
} else if (valueOf('--lat') !== undefined || valueOf('--lng') !== undefined) {
  const lat = Number(valueOf('--lat'));
  const lng = Number(valueOf('--lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    console.error('--lat and --lng must both be given, as numbers in range');
    process.exit(1);
  }
  location = { lat, lng, source: 'tools/project-location.mjs' };
} else if (valueOf('--address')) {
  location = { address: valueOf('--address'), source: 'tools/project-location.mjs' };
}

// openAppDb migrates and seeds exactly as web does; everything it would do is
// idempotent, and it gives this process a busy_timeout for the write.
const db = openAppDb({ ownerEmail: process.env.OWNER_EMAIL, importLegacy: false });
try {
  const project = findYard(db, slug, { ownerEmail });
  if (location !== undefined) {
    saveProjectLocation(db, project.id, location);
    console.log(location === null ? `Cleared the location of "${slug}".` : `Set the location of "${slug}".`);
  } else {
    const current = parseLocation(project);
    console.log(
      current
        ? `"${slug}" has a location (${[
            Number.isFinite(current.lat) && Number.isFinite(current.lng) ? 'coordinates' : null,
            current.address ? 'address' : null,
          ]
            .filter(Boolean)
            .join(' and ')}).`
        : `"${slug}" has no location.`
    );
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
