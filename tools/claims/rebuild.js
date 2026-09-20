// Rebuild entry point for the claim store (nl-scx.1 AC): drops and repopulates
// data/claims.db from scratch, replaying manual-corrections.tsv last. Nothing
// else in the epic (ingest, export, MCP tools) can proceed without this.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { openClaimsStore, createSchema, DEFAULT_PATH } from './claimsStore.js';
import { seedPlantableCore } from './taxaSeed.js';
import { replayManualCorrections } from './correctionsReplay.js';
import { loadCorpusText, buildFloraIndex, buildGenusDictionary } from './floraCorpus.js';
import { reconcileCatalog } from './nameReconciliation.js';
import { parseCsv } from '../../src/data/csvLoader.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function rebuildClaimsStore({
  dbPath = DEFAULT_PATH,
  plantsCsvPath = `${REPO_ROOT}plants.csv`,
  blacklandCsvPath = `${REPO_ROOT}blackland-prairie-natives.csv`,
  correctionsPath = `${REPO_ROOT}manual-corrections.tsv`,
  reconcileNames = true,
} = {}) {
  const db = openClaimsStore(dbPath);
  createSchema(db);
  const seeded = seedPlantableCore(db, { plantsCsvPath, blacklandCsvPath });

  let reconciliationCounts = null;
  if (reconcileNames) {
    // Runs over the wider catalog (blackland-prairie-natives.csv), not just
    // plantable_core — the mapping is reusable by any future book source
    // (06 §3), not scoped to today's plantable set.
    const catalog = parseCsv(readFileSync(blacklandCsvPath, 'utf8'));
    const genusDictionary = buildGenusDictionary(catalog);
    const floraIndex = buildFloraIndex(loadCorpusText(), genusDictionary);
    reconciliationCounts = reconcileCatalog(db, catalog, floraIndex);
  }

  const { applied } = replayManualCorrections(db, correctionsPath);
  return { db, plantableCoreSize: seeded, correctionsApplied: applied, reconciliationCounts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { plantableCoreSize, correctionsApplied, reconciliationCounts } = rebuildClaimsStore();
  console.log(`Rebuilt claims store: ${plantableCoreSize} plantable_core rows, ${correctionsApplied} corrections applied.`);
  if (reconciliationCounts) {
    console.log(
      `Name reconciliation: ${reconciliationCounts.direct} direct, ${reconciliationCounts['flora-synonym']} flora-synonym, ` +
        `${reconciliationCounts.unmatched} unmatched (${reconciliationCounts.review} of the matches are 06 §4 partial ` +
        `rank matches needing review, already counted above).`,
    );
  }
}
