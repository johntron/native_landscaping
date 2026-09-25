#!/usr/bin/env node
/**
 * Re-copy the shared, read-only example yard (nl-3s5.24) from the owner's live
 * yard in app.db.
 *
 *   node tools/refresh-example-yard.mjs --dry-run     # what would change; writes nothing
 *   node tools/refresh-example-yard.mjs               # copy it
 *   node tools/refresh-example-yard.mjs --from backyard --owner <email>
 *
 * The source is `--from` (default backyard) among the yards of `--owner`
 * (else OWNER_EMAIL, else the sole admin). It is only read. The example gets
 * the source's state at its cursor as ONE revision (its config, features and
 * placements), plus the photos that config names, with no location: the
 * source's location_json is never read, every lat/lng/address-like key is
 * stripped and then checked for again, and the example's location_json is set
 * NULL. When and from what are recorded in app_meta ('example_yard').
 *
 * Idempotent: a second run with nothing changed in the source writes nothing.
 * One transaction for the rows; photos are staged and swapped in after it.
 * Safe with web running (busy_timeout); open tabs on the example keep working,
 * since the example's row id never changes. DATA_DIR picks the directory.
 *
 * Output never includes the owner's email, an address or coordinates.
 */
import { openAppDb, resolveDataDir } from '../server/db/appDb.js';
import { snapshotFromOwnerYard, writeExampleYard } from '../server/db/exampleYard.js';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node tools/refresh-example-yard.mjs [--dry-run] [--from <slug>] [--owner <email>]');
  process.exit(0);
}
const dryRun = args.includes('--dry-run');
const slug = valueOf('--from') || 'backyard';
const ownerEmail = valueOf('--owner') ?? process.env.OWNER_EMAIL;
const dataDir = resolveDataDir();

// openAppDb migrates and seeds exactly as web does; everything it would do is
// idempotent, and it gives this process a busy_timeout for the write.
const db = openAppDb({ dataDir, ownerEmail: process.env.OWNER_EMAIL, importLegacy: false });
try {
  const { snapshot, provenance, revisionTimestamp } = snapshotFromOwnerYard(db, { dataDir, ownerEmail, slug });
  const result = writeExampleYard(db, { dataDir, snapshot, provenance, revisionTimestamp, dryRun });
  const verb = {
    created: 'Created the example yard',
    updated: 'Refreshed the example yard',
    unchanged: 'The example yard already matches; nothing written',
    'would-create': 'Would create the example yard (dry run)',
    'would-update': 'Would refresh the example yard (dry run)',
  }[result.status];
  console.log(`${verb} from "${slug}" (revision ${provenance.revision ? provenance.revision.seq : 'none'}).`);
  console.log(`  plants: ${result.plants}; photos: ${result.photos.join(', ') || 'none'}; location: none`);
  if (result.missingPhotos.length) {
    console.warn(`  photos the config names but the source does not have: ${result.missingPhotos.join(', ')}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
