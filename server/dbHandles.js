// Opens every server-owned SQLite database once at process startup and
// hands back the handles for server.js to share through ctx.db, so routes
// stop calling open*Db() (and leaking a handle) on every request (nl-3s5.14).
//
// Four of the five stores are opened eagerly here because opening one is
// cheap and side-effect-free by design (mkdir + WAL + busy_timeout +
// CREATE TABLE IF NOT EXISTS — see each tools/*Db.js open function).
//
// The claim store is different: openClaimsStore() creates data/claims.db
// merely by opening it, and most deploys have never run
// tools/claims/rebuild.js — the server must not manufacture an empty file
// just because it started. So `claims` is a function, not a handle: it
// opens (and schema-probes) the store lazily on first call, and only caches
// a handle once that probe succeeds. A failure — the file doesn't exist, or
// exists without the `taxa` table — is never cached, so running the rebuild
// after the server started is picked up on the very next request, with no
// restart required.
import { existsSync } from 'node:fs';
import { openSavedAreasDb } from '../tools/savedAreas/savedAreasDb.js';
import { openFeedStateDb } from '../tools/feedState/feedStateDb.js';
import { openObservationEventsDb } from '../tools/observationEventsDb.js';
import { openEcosystemDb } from '../tools/ecosystemIndexDb.js';
import { openClaimsStore, DEFAULT_PATH as CLAIMS_DEFAULT_PATH } from '../tools/claims/claimsStore.js';

export const CLAIM_STORE_NOT_BUILT_MESSAGE =
  'Claim store not built — run tools/claims/rebuild.js to create data/claims.db';

/**
 * @param {object} [paths] per-store path overrides, for tests (never point
 *   these at the live data/ directory — see AGENTS.md's "Data safety").
 * @param {string} [paths.savedAreas]
 * @param {string} [paths.feedState]
 * @param {string} [paths.observationEvents]
 * @param {string} [paths.ecosystem]
 * @param {string} [paths.claims]
 * @returns {{savedAreas: object, feedState: object, observationEvents: object, ecosystem: object, claims: () => object}}
 */
export function openServerDatabases(paths = {}) {
  const savedAreas = openSavedAreasDb(paths.savedAreas);
  const feedState = openFeedStateDb(paths.feedState);
  const observationEvents = openObservationEventsDb(paths.observationEvents);
  const ecosystem = openEcosystemDb(paths.ecosystem);

  const claimsPath = paths.claims || CLAIMS_DEFAULT_PATH;
  let claimsHandle = null;

  /**
   * Returns the cached claims store handle, opening and schema-probing it
   * first if this is the first successful call. Throws
   * CLAIM_STORE_NOT_BUILT_MESSAGE — without creating data/claims.db — when
   * the store doesn't exist yet or exists without a `taxa` table.
   */
  function claims() {
    if (claimsHandle) return claimsHandle;
    if (!existsSync(claimsPath)) {
      throw new Error(CLAIM_STORE_NOT_BUILT_MESSAGE);
    }
    const db = openClaimsStore(claimsPath);
    try {
      db.prepare('SELECT 1 FROM taxa LIMIT 1').get();
    } catch {
      // Don't leak this handle: a probe failure here means the file exists
      // (existsSync passed) but has no schema, and nothing else will ever
      // close it if it isn't cached.
      try {
        db.close();
      } catch {
        // already unusable — nothing to do
      }
      throw new Error(CLAIM_STORE_NOT_BUILT_MESSAGE);
    }
    claimsHandle = db;
    return claimsHandle;
  }

  return { savedAreas, feedState, observationEvents, ecosystem, claims };
}
