// Full store rebuild INCLUDING the USDA ingest (nl-scx.2), with the
// ordering nl-scx.1's rebuild.js already established for corrections (09
// §2.1: manual-corrections.tsv replays LAST, after every sourced claim).
//
// rebuild.js's own rebuildClaimsStore() stays untouched and synchronous —
// dozens of existing tests call it directly and expect a plain object back,
// not a Promise, and it must never make a network call. This module
// composes it instead of editing it: build everything BUT the correction
// replay (by pointing correctionsPath at a file that doesn't exist), run the
// (async, network-calling) USDA ingest, then replay the real corrections
// file last — reproducing rebuild.js's own ordering with USDA claims now
// included in what corrections can supersede.
import { fileURLToPath } from 'node:url';
import { rebuildClaimsStore } from './rebuild.js';
import { replayManualCorrections } from './correctionsReplay.js';
import { ingestUsdaClaims } from './usdaIngest.js';
import { UsdaClient } from '../usda-plants/usdaClient.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_CORRECTIONS_PATH = `${REPO_ROOT}catalog/manual-corrections.tsv`;
const SKIP_REPLAY_PATH = fileURLToPath(new URL('./__no-early-replay__.tsv', import.meta.url)); // never created

export async function rebuildClaimsStoreWithUsda({
  dbPath,
  correctionsPath = DEFAULT_CORRECTIONS_PATH,
  client = new UsdaClient(),
} = {}) {
  const built = rebuildClaimsStore({ dbPath, correctionsPath: SKIP_REPLAY_PATH });
  const usdaCounts = await ingestUsdaClaims(built.db, { client });
  const { applied } = replayManualCorrections(built.db, correctionsPath);
  return { ...built, usdaCounts, correctionsApplied: applied };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { plantableCoreSize, correctionsApplied, usdaCounts } = await rebuildClaimsStoreWithUsda();
  console.log(`Rebuilt claims store with USDA ingest: ${plantableCoreSize} plantable_core rows, ${correctionsApplied} corrections applied.`);
  console.log(
    `USDA: ${usdaCounts.speciesTotal} taxa, ${usdaCounts.cultivarsSkipped} cultivars skipped, ` +
      `${usdaCounts.unresolved} unresolved, ${usdaCounts.noCharacteristicsRecord} with no characteristics record, ` +
      `${usdaCounts.withCharacteristics} with a record, ${usdaCounts.claimsInserted} claims inserted.`,
  );
  console.log(
    `County presence (48113): ${usdaCounts.countyPresent} present, ${usdaCounts.countyAbsent} absent, ` +
      `${usdaCounts.countyUnknown} unknown (fetch failed or species unresolved).`,
  );
  console.log('nl-yud field fill rates (out of species with a characteristics record), NOT asserted as claims:');
  for (const [name, count] of Object.entries(usdaCounts.nlYudFillRates)) {
    console.log(`  ${name}: ${count}/${usdaCounts.withCharacteristics}`);
  }
}
