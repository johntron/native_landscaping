#!/usr/bin/env node
/**
 * Preview or run the one-time copy of the yards under projects/<slug>/ into
 * app.db (nl-3s5.3, server/db/projectImport.js).
 *
 *   node tools/import-projects.mjs --dry-run      # read-only report
 *   node tools/import-projects.mjs                # migrate app.db and import
 *
 * Options:
 *   --projects-dir <dir>  where the yards are (default: projects/ in this checkout)
 *   --slug <slug>         import only these (repeatable); needed when the
 *                         directory has no index.json
 *
 * DATA_DIR picks where app.db and the copied photos go (default data/ in this
 * checkout), and OWNER_EMAIL picks the owner, as for web. Without
 * OWNER_EMAIL, the sole admin in app.db is used; with neither, nothing is
 * imported. The source files are only ever read.
 *
 * --dry-run opens app.db read-only and runs no migration, so it is safe
 * against the live data/ with web running, and works on an app.db that has
 * no projects table yet. It prints counts and yes/no only: never a location
 * or a config body.
 *
 * Web never runs this import on its own: see the header of
 * server/db/projectImport.js for why, and docs/design-tool.md for the order
 * to run it in on a deploy.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAppDb, resolveDataDir } from '../server/db/appDb.js';
import { importLegacyProjects, previewProjectImport } from '../server/db/projectImport.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const valuesOf = (flag) => args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]] : []));
const projectsDir = path.resolve(
  valuesOf('--projects-dir')[0] || fileURLToPath(new URL('../projects', import.meta.url))
);
const slugs = valuesOf('--slug');
const dataDir = resolveDataDir();
const ownerEmail = process.env.OWNER_EMAIL;
const options = { projectsDir, dataDir, ownerEmail, slugs: slugs.length ? slugs : undefined };

if (dryRun) {
  const report = previewProjectImport(options);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length ? 1 : 0);
}

// openAppDb applies migrations and seeds OWNER_EMAIL, exactly as web does on
// start; the saved-areas legacy import it also runs is a no-op once recorded.
const db = openAppDb({ dataDir, ownerEmail });
let result;
try {
  result = importLegacyProjects(db, options);
} finally {
  db.close();
}
console.log(JSON.stringify(result, null, 2));
if (result.status === 'no-owner') process.exit(1);
console.log(JSON.stringify(previewProjectImport(options), null, 2));
