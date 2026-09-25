// The app.db side of the per-yard nearby-species index (nl-3s5.6): which
// yards have a site to index, which yard's index a caller may read, and which
// yard's index the shared example shows. Read-only queries; the index itself
// is data/ecosystem.db (tools/ecosystemIndexDb.js).
import { EXAMPLE_OWNER_EMAIL, findExampleProject, findProjectById, parseLocation } from './projectStore.js';

/** app_meta key the example refresh writes its provenance under (server/db/exampleYard.js EXAMPLE_META_KEY). */
const EXAMPLE_META_KEY = 'example_yard';

function placeOf(configJson) {
  try {
    return String(JSON.parse(configJson)?.place || '').trim();
  } catch {
    return '';
  }
}

/**
 * Every yard with a location set, oldest first: what feed-poller's index queue
 * walks. The example's owner is left out (its location is always NULL anyway).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{ id: number, ownerId: number, slug: string, location: object }>}
 */
export function listLocatedProjects(db) {
  return db
    .prepare(
      `SELECT p.id, p.owner_id, p.slug, p.location_json
         FROM projects p JOIN users u ON u.id = p.owner_id
        WHERE p.location_json IS NOT NULL AND u.email <> ?
        ORDER BY p.id`
    )
    .all(EXAMPLE_OWNER_EMAIL)
    .map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      slug: row.slug,
      location: parseLocation({ locationJson: row.location_json }),
    }))
    .filter((row) => row.location);
}

/**
 * One owner's yards with their place labels, oldest first. The rarity lane and
 * /api/ecosystem/places resolve a place label among these only, so a label
 * never reaches another owner's index.
 *
 * @returns {Array<{ id: number, slug: string, place: string, location: object | null }>}
 */
export function listOwnerProjectSites(db, ownerId) {
  if (ownerId == null) return [];
  return db
    .prepare('SELECT id, slug, config_json, location_json FROM projects WHERE owner_id = ? ORDER BY id')
    .all(Number(ownerId))
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      place: placeOf(row.config_json),
      location: parseLocation({ locationJson: row.location_json }),
    }));
}

/**
 * The yard whose index the shared example shows: the owner's yard it was last
 * refreshed from (tools/refresh-example-yard.mjs records its id in app_meta).
 * The example itself never has a location, so it has no index of its own. null
 * when the example was only ever seeded from the tracked files, or its source
 * yard is gone.
 *
 * @returns {import('./projectStore.js').ProjectRecord | null}
 */
export function exampleIndexSource(db) {
  const example = findExampleProject(db);
  if (!example) return null;
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(EXAMPLE_META_KEY);
  if (!row) return null;
  let provenance;
  try {
    provenance = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (provenance?.from !== 'app.db' || !Number.isInteger(provenance.projectId)) return null;
  const source = findProjectById(db, provenance.projectId);
  if (!source || source.id === example.id) return null;
  return source;
}
