// Response cache for source probes (nl-41o.9). One SQLite file, WAL mode,
// keyed by (source, endpoint, key) so different probe targets (USDA today,
// NPIN/GBIF later per the epic's probe-target ordering) can share one cache
// without colliding. Stores the RAW response verbatim — the probe's whole
// point is seeing what a source actually said, so caching a normalized view
// would defeat it.
//
// Not the claims store nl-41o.4 designs — this is HTTP-response caching only,
// gitignored (*.db), local, and safe to delete: a probe cold-starts from
// nothing but the network. See nl-41o.9's acceptance criteria: "no writes,
// no persistence beyond a cache."

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDataDir } from "../dataDir.js";

// Repo-root-relative (via resolveDataDir), not cwd-relative: an MCP stdio
// server's cwd is whatever the client happened to launch it from, not
// reliably the repo root, so a bare "data/probe-cache.db" would scatter
// cache files around the filesystem depending on who started the server.
// Also honours DATA_DIR (nl-3s5.27), the same as every other tools/*Db.js
// store, so a server opening this at request time (server/routes/ecosystem.js's
// openProbeCache() calls) picks up a scratch DATA_DIR without that route
// file needing to know about it. A function, not a module-level constant:
// DATA_DIR must be resolved at OPEN time, since tests set
// process.env.DATA_DIR after this module is already imported.
export function defaultProbeCachePath(dataDir) {
  return join(resolveDataDir(dataDir), "probe-cache.db");
}

export function openProbeCache(path = defaultProbeCachePath()) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe_cache (
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      raw TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (source, endpoint, cache_key)
    )
  `);
  return db;
}

export function getCached(db, source, endpoint, key) {
  const row = db
    .prepare("SELECT raw, fetched_at FROM probe_cache WHERE source = ? AND endpoint = ? AND cache_key = ?")
    .get(source, endpoint, String(key));
  if (!row) return null;
  return { raw: JSON.parse(row.raw), fetchedAt: row.fetched_at, cached: true };
}

export function setCached(db, source, endpoint, key, raw) {
  const fetchedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO probe_cache (source, endpoint, cache_key, raw, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, endpoint, cache_key) DO UPDATE SET raw = excluded.raw, fetched_at = excluded.fetched_at`,
  ).run(source, endpoint, String(key), JSON.stringify(raw), fetchedAt);
  return fetchedAt;
}

// Fetch-through helper: return the cached entry if present, otherwise call
// `fetcher()`, cache the result, and return it fresh. `force` bypasses the
// cache read (still writes the new result), for re-probing a source that may
// have changed since it was last cached.
export async function cached(db, source, endpoint, key, fetcher, { force = false } = {}) {
  if (!force) {
    const hit = getCached(db, source, endpoint, key);
    if (hit) return hit;
  }
  const raw = await fetcher();
  const fetchedAt = setCached(db, source, endpoint, key, raw);
  return { raw, fetchedAt, cached: false };
}
