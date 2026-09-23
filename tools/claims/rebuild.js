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
import { buildTreatmentIndex, ingestFloraNativity } from './floraNativity.js';
import { parseCsv } from '../../src/data/csvLoader.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function rebuildClaimsStore({
  dbPath = DEFAULT_PATH,
  plantsCsvPath = `${REPO_ROOT}plants.csv`,
  blacklandCsvPath = `${REPO_ROOT}catalog/blackland-prairie-natives.csv`,
  correctionsPath = `${REPO_ROOT}catalog/manual-corrections.tsv`,
  reconcileNames = true,
} = {}) {
  const db = openClaimsStore(dbPath);
  createSchema(db);
  const seeded = seedPlantableCore(db, { plantsCsvPath, blacklandCsvPath });

  let reconciliationCounts = null;
  let nativityCounts = null;
  if (reconcileNames) {
    // Runs over the wider catalog (blackland-prairie-natives.csv), not just
    // plantable_core — the mapping is reusable by any future book source
    // (06 §3), not scoped to today's plantable set. plants.csv rows absent
    // from that catalog are appended too: plantable_core is plants.csv ∪
    // npsot_yes (taxaSeed.js), and a plants.csv-only species (e.g. one added
    // to the live catalog before ever being added to the wider list) must
    // still get a name_reconciliations row — otherwise it gets no
    // nativity_nctx claim at all, not even 'unknown', which 04 §5's
    // "missing" lookup and nl-scx.12's stopping condition both need to tell
    // apart from a genuine unknown.
    const blacklandCatalog = parseCsv(readFileSync(blacklandCsvPath, 'utf8'));
    const plantsRows = parseCsv(readFileSync(plantsCsvPath, 'utf8'));
    const blacklandNames = new Set(blacklandCatalog.map((row) => row.botanical_name.trim()));
    const catalog = [...blacklandCatalog, ...plantsRows.filter((row) => !blacklandNames.has(row.botanical_name.trim()))];
    const genusDictionary = buildGenusDictionary(catalog);
    const floraIndex = buildFloraIndex(loadCorpusText(), genusDictionary);
    reconciliationCounts = reconcileCatalog(db, catalog, floraIndex);

    // nl-scx.4: consumes the name_reconciliations rows just written above, so
    // it must run after reconcileCatalog and — per 09 §2.1 — before
    // replayManualCorrections, which has to see nativity_nctx's sourced
    // claims to know what it's superseding.
    const treatmentIndex = buildTreatmentIndex(genusDictionary);
    nativityCounts = ingestFloraNativity(db, treatmentIndex);
  }

  const { applied } = replayManualCorrections(db, correctionsPath);
  return { db, plantableCoreSize: seeded, correctionsApplied: applied, reconciliationCounts, nativityCounts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { plantableCoreSize, correctionsApplied, reconciliationCounts, nativityCounts } = rebuildClaimsStore();
  console.log(`Rebuilt claims store: ${plantableCoreSize} plantable_core rows, ${correctionsApplied} corrections applied.`);
  if (reconciliationCounts) {
    console.log(
      `Name reconciliation: ${reconciliationCounts.direct} direct, ${reconciliationCounts['flora-synonym']} flora-synonym, ` +
        `${reconciliationCounts.unmatched} unmatched (${reconciliationCounts.review} of the matches are 06 §4 partial ` +
        `rank matches needing review, already counted above).`,
    );
  }
  if (nativityCounts) {
    console.log(
      `Flora nativity: ${nativityCounts.asserted_native} native, ${nativityCounts.asserted_introduced} introduced, ` +
        `${nativityCounts.review} review, ${nativityCounts.unknown} unknown.`,
    );
  }
}
