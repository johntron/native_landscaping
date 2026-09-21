// SQLite store for per-observation read/dismissed flags (nl-1qy.1.3).
//
// Deliberately its own database file rather than a column on
// observation_events: the event log is rebuilt wholesale by re-running
// tools/fetch-observation-events.mjs's upsert (see tools/observationEventsDb.js),
// and state a person set by hand — "I already saw this" — must survive that
// independent of whatever the fetch script does to the event row. Same
// separation-of-concerns reasoning as area_cursor living apart from
// observation_events in that module.
//
// Keyed by (observation_id, area_id), matching observation_events' primary
// key, since the same iNaturalist observation can appear in more than one
// area's feed with independent read/dismissed state per area.
//
// No row for a given (observation_id, area_id) means "unread, not
// dismissed" — the default a freshly-fetched observation should show as.
// Server-side (not localStorage) because this is a single-user local app
// with no auth, and state should be consistent across devices/browsers.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PATH = fileURLToPath(new URL('../../data/feed-state.db', import.meta.url));

export function openFeedStateDb(path = DEFAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_state (
      observation_id INTEGER NOT NULL,
      area_id        TEXT NOT NULL,
      read           INTEGER NOT NULL DEFAULT 0,
      dismissed      INTEGER NOT NULL DEFAULT 0,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (observation_id, area_id)
    )
  `);
  return db;
}

function rowToState(row) {
  if (!row) return { read: false, dismissed: false, updatedAt: null };
  return { read: !!row.read, dismissed: !!row.dismissed, updatedAt: row.updated_at };
}

/** State for one observation in one area, defaulting to unread/not-dismissed if never set. */
export function getFeedState(db, observationId, areaId) {
  const row = db
    .prepare('SELECT read, dismissed, updated_at FROM feed_state WHERE observation_id = ? AND area_id = ?')
    .get(observationId, areaId);
  return rowToState(row);
}

/**
 * Every stored state row for an area, as a Map keyed by observation_id
 * (number) for O(1) lookup while joining against an event list. Areas with
 * thousands of logged observations but only a handful ever touched will
 * have a correspondingly small map — rows are only written on an explicit
 * mark-read/dismiss call, never pre-seeded per observation.
 */
export function listFeedStates(db, areaId) {
  const rows = db
    .prepare('SELECT observation_id, read, dismissed, updated_at FROM feed_state WHERE area_id = ?')
    .all(areaId);
  const map = new Map();
  for (const row of rows) {
    map.set(row.observation_id, rowToState(row));
  }
  return map;
}

/**
 * Set read and/or dismissed for one (observationId, areaId). Only the flags
 * present in `patch` are changed — PATCH semantics, matching
 * updateSavedArea — so a client marking an item read doesn't have to also
 * resend its dismissed state.
 */
export function setFeedState(db, observationId, areaId, patch, updatedAt = new Date().toISOString()) {
  if (!Number.isFinite(Number(observationId))) {
    throw new Error('"observationId" must be a number');
  }
  if (!areaId || typeof areaId !== 'string') {
    throw new Error('"areaId" must be a non-empty string');
  }
  const existing = getFeedState(db, observationId, areaId);
  const merged = {
    read: patch.read !== undefined ? !!patch.read : existing.read,
    dismissed: patch.dismissed !== undefined ? !!patch.dismissed : existing.dismissed,
  };
  db.prepare(
    `INSERT INTO feed_state (observation_id, area_id, read, dismissed, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(observation_id, area_id) DO UPDATE SET
       read = excluded.read, dismissed = excluded.dismissed, updated_at = excluded.updated_at`
  ).run(Number(observationId), areaId, merged.read ? 1 : 0, merged.dismissed ? 1 : 0, updatedAt);
  return { observationId: Number(observationId), areaId, ...merged, updatedAt };
}
