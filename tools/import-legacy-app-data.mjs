#!/usr/bin/env node
/**
 * Preview or run the one-time copy of data/saved-areas.db and
 * data/feed-state.db into data/app.db (nl-3s5.11, server/db/legacyImport.js).
 *
 *   node tools/import-legacy-app-data.mjs --dry-run   # read-only report
 *   node tools/import-legacy-app-data.mjs             # migrate app.db and import
 *
 * --dry-run opens app.db and both legacy files read-only and runs no
 * migration, so it is safe against the live data/ while web and feed-poller
 * are up. It prints app.db's schema version, row counts and import markers,
 * each legacy file's row count, how many rows would be copied, and the owner
 * imported areas would get. Run it again after the import to verify counts.
 *
 * Without --dry-run it does exactly what web does on start: openAppDb (apply
 * migrations, seed OWNER_EMAIL as admin, import each table once). Web runs the
 * import on its own, so this is only needed to import without restarting web.
 *
 * DATA_DIR picks the directory (default data/ under the repo), and
 * OWNER_EMAIL picks the owner, as for web. Without OWNER_EMAIL, the sole
 * admin in app.db is used; with neither, imported areas are unowned.
 * The legacy files are never modified either way.
 */
import { openAppDb, resolveDataDir } from '../server/db/appDb.js';
import { previewLegacyImport } from '../server/db/legacyImport.js';

const dryRun = process.argv.includes('--dry-run');
const dataDir = resolveDataDir();
const ownerEmail = process.env.OWNER_EMAIL;

if (dryRun) {
  console.log(JSON.stringify(previewLegacyImport({ dataDir, ownerEmail }), null, 2));
} else {
  let results = [];
  const db = openAppDb({ dataDir, ownerEmail, onLegacyImport: (r) => (results = r) });
  db.close();
  console.log(JSON.stringify({ dataDir, results }, null, 2));
  console.log(JSON.stringify(previewLegacyImport({ dataDir, ownerEmail }), null, 2));
}
