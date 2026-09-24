// Resolves the directory every gitignored cache DB and local store lives in
// (data/observation-events.db, data/ecosystem.db, data/claims.db,
// data/probe-cache.db) — the tools/ counterpart to server/db/appDb.js's own
// resolveDataDir, which does the same job for data/app.db. Shared here so
// both sides, and every tools/*Db.js DEFAULT_PATH, agree on one answer
// instead of three separate copies drifting apart (nl-3s5.27).
//
// DATA_DIR lets tests and the e2e scratch server (tests-e2e/scratch-fixture.mjs,
// playwright.config.js) point every one of these stores at a throwaway
// directory instead of the repo's real data/ — see docs/testing.md. Falls
// back to the repo's data/ directory, so tools/ CLI scripts and the
// feed-poller keep working unchanged when DATA_DIR is unset.
//
// Each open*Db()'s default path must call this at OPEN time, not capture it
// in a module-level constant at import time: a test can set
// process.env.DATA_DIR after these modules are already imported, and a
// constant computed at import would miss it.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));

/**
 * @param {string} [dataDir] defaults to process.env.DATA_DIR
 * @returns {string} absolute path to the directory these stores live in
 */
export function resolveDataDir(dataDir = process.env.DATA_DIR) {
  return dataDir ? resolve(dataDir) : REPO_DATA_DIR;
}
