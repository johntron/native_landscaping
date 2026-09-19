// Rebuild entry point for the claim store (nl-scx.1 AC): drops and repopulates
// data/claims.db from scratch, replaying manual-corrections.tsv last. Nothing
// else in the epic (ingest, export, MCP tools) can proceed without this.
import { fileURLToPath } from 'node:url';
import { openClaimsStore, createSchema, DEFAULT_PATH } from './claimsStore.js';
import { seedPlantableCore } from './taxaSeed.js';
import { replayManualCorrections } from './correctionsReplay.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function rebuildClaimsStore({
  dbPath = DEFAULT_PATH,
  plantsCsvPath = `${REPO_ROOT}plants.csv`,
  blacklandCsvPath = `${REPO_ROOT}blackland-prairie-natives.csv`,
  correctionsPath = `${REPO_ROOT}manual-corrections.tsv`,
} = {}) {
  const db = openClaimsStore(dbPath);
  createSchema(db);
  const seeded = seedPlantableCore(db, { plantsCsvPath, blacklandCsvPath });
  const { applied } = replayManualCorrections(db, correctionsPath);
  return { db, plantableCoreSize: seeded, correctionsApplied: applied };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { plantableCoreSize, correctionsApplied } = rebuildClaimsStore();
  console.log(`Rebuilt claims store: ${plantableCoreSize} plantable_core rows, ${correctionsApplied} corrections applied.`);
}
