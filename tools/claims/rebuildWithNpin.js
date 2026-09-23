// Full store rebuild INCLUDING both USDA and NPIN ingest (nl-scx.2, nl-scx.8),
// preserving rebuild.js's ordering for corrections (09 §2.1: manual-
// corrections.tsv replays LAST, after every sourced claim).
//
// NPIN ingest depends on usda_symbol being populated on each taxa row
// (02 §2.3: NPIN's URL keys on that symbol directly, no name-matching
// fallback) — usdaIngest.js is what backfills it (usdaIngest.js's own
// `UPDATE taxa SET usda_symbol = ...` when a search resolves one it didn't
// have). So NPIN must run after USDA within one rebuild, same file, rather
// than as an independently composable step the way rebuildWithUsda.js
// composes over rebuild.js — there'd be nothing for it to key on otherwise.
//
// rebuildClaimsStoreWithUsda() itself stays untouched: this module reuses it
// with corrections replay skipped (same __no-early-replay__ trick it already
// uses over rebuild.js), runs NPIN ingest against the now-symbol-populated
// taxa, then replays the real corrections file last.
import { fileURLToPath } from 'node:url';
import { rebuildClaimsStoreWithUsda } from './rebuildWithUsda.js';
import { replayManualCorrections } from './correctionsReplay.js';
import { ingestNpinClaims } from './npinIngest.js';
import { NpinClient } from './npinClient.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_CORRECTIONS_PATH = `${REPO_ROOT}catalog/manual-corrections.tsv`;
const SKIP_REPLAY_PATH = fileURLToPath(new URL('./__no-early-replay__.tsv', import.meta.url)); // never created

export async function rebuildClaimsStoreWithNpin({
  dbPath,
  correctionsPath = DEFAULT_CORRECTIONS_PATH,
  usdaClient,
  npinClient = new NpinClient(),
} = {}) {
  const built = await rebuildClaimsStoreWithUsda({ dbPath, correctionsPath: SKIP_REPLAY_PATH, client: usdaClient });
  const npinCounts = await ingestNpinClaims(built.db, { client: npinClient });
  const { applied } = replayManualCorrections(built.db, correctionsPath);
  return { ...built, npinCounts, correctionsApplied: applied };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { plantableCoreSize, correctionsApplied, usdaCounts, npinCounts } = await rebuildClaimsStoreWithNpin();
  console.log(`Rebuilt claims store with USDA + NPIN ingest: ${plantableCoreSize} plantable_core rows, ${correctionsApplied} corrections applied.`);
  console.log(
    `USDA: ${usdaCounts.speciesTotal} taxa, ${usdaCounts.claimsInserted} claims inserted, ` +
      `${usdaCounts.countyPresent} county-present, ${usdaCounts.countyAbsent} county-absent.`,
  );
  console.log(
    `NPIN: ${npinCounts.pageResolved} pages resolved, ${npinCounts.noSymbol} taxa with no usda_symbol to look up, ` +
      `${npinCounts.pageUnresolved} symbols that didn't resolve, ${npinCounts.fetchFailed} fetch failures, ` +
      `${npinCounts.claimsInserted} claims inserted.`,
  );
  console.log(`NPIN crawl: ${npinCounts.crawlSummary}`);
}
