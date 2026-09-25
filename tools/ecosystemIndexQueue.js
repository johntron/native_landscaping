// The nearby-species index queue (nl-3s5.6): feed-poller builds the index of
// every yard that has a location and no index for it, so a new yard's "What's
// nearby" fills in without anyone running tools/fetch-ecosystem-index.mjs.
//
// The queue is derived, not stored. Each tick it compares the yards with a
// location in app.db against the builds recorded in ecosystem.db
// (project_index_builds): a yard is due when it has never been built, when
// its location changed since its last build (a different locationKey), when
// its build failed and the retry wait has passed, or when a build was left
// 'building' long enough ago that whoever ran it must have died. So no route
// has to enqueue anything when a location is saved, whoever saves it
// (tools/project-location.mjs today, a route later), and app.db needs no new
// table: feed-poller only reads it.
//
// Politeness: builds run one at a time, and a tick runs at most
// MAX_NETWORK_BUILDS_PER_TICK builds that touched the network. A build served
// entirely from the probe cache (the same site built before, or a second yard
// at the same address) costs iNaturalist nothing and does not count. One
// full build is ~50 requests at one per 1.5 s (fetch-ecosystem-index.mjs), so
// at the default 30-minute tick this stays far under iNaturalist's ~1 req/s
// and ~10K/day guidance. Every limit below is a judgement call, not a
// sourced figure.
import { indexStatus, locationKey, readIndexBuild } from './ecosystemIndexDb.js';
import { listLocatedProjects } from '../server/db/projectSites.js';

/** Judgement: one network-touching build per tick; a new yard waits at most (its place in line) ticks. */
export const MAX_NETWORK_BUILDS_PER_TICK = 1;
/** Judgement: a full build takes a few minutes, so one 'building' for an hour was abandoned. */
export const STALE_BUILD_MINUTES = 60;
/** Judgement: a failed build is retried after 1 h, doubling per attempt, capped at a day. */
export const RETRY_BASE_MINUTES = 60;
export const RETRY_MAX_MINUTES = 24 * 60;

const MINUTE_MS = 60_000;

function retryWaitMs(attempts) {
  const minutes = Math.min(RETRY_BASE_MINUTES * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MINUTES);
  return minutes * MINUTE_MS;
}

/**
 * The yards whose index is due, in the order they will be built: never built
 * or moved first (oldest yard first), then retries (longest waiting first).
 *
 * @param {import('node:sqlite').DatabaseSync} appDb
 * @param {import('node:sqlite').DatabaseSync} ecosystemDb
 * @param {{ now?: number }} [options] epoch ms
 * @returns {Array<{ id: number, slug: string, location: object, reason: 'new'|'moved'|'retry'|'stale' }>}
 */
export function dueIndexBuilds(appDb, ecosystemDb, { now = Date.now() } = {}) {
  const fresh = [];
  const retries = [];
  for (const project of listLocatedProjects(appDb)) {
    const key = locationKey(project.location);
    if (!key) continue;
    const status = indexStatus(ecosystemDb, project.id, key);
    if (status.state === 'queued') {
      const moved = Boolean(readIndexBuild(ecosystemDb, project.id));
      fresh.push({ ...project, reason: moved ? 'moved' : 'new' });
      continue;
    }
    const build = readIndexBuild(ecosystemDb, project.id);
    if (status.state === 'building') {
      const started = Date.parse(build.startedAt || '') || 0;
      if (now - started >= STALE_BUILD_MINUTES * MINUTE_MS) retries.push({ ...project, reason: 'stale', since: started });
    } else if (status.state === 'failed') {
      const finished = Date.parse(build.finishedAt || '') || 0;
      if (now - finished >= retryWaitMs(build.attempts)) retries.push({ ...project, reason: 'retry', since: finished });
    }
  }
  retries.sort((a, b) => a.since - b.since);
  return [...fresh, ...retries.map(({ since, ...project }) => project)];
}

/**
 * Drop index rows and build records of yards that no longer exist in app.db.
 * Yard ids are AUTOINCREMENT and never reused, so this is tidiness, not
 * safety.
 */
export function pruneDeletedProjects(appDb, ecosystemDb) {
  const live = new Set(appDb.prepare('SELECT id FROM projects').all().map((row) => Number(row.id)));
  const stored = ecosystemDb
    .prepare('SELECT project_id FROM project_index_builds UNION SELECT DISTINCT project_id FROM project_species_observations')
    .all()
    .map((row) => Number(row.project_id));
  const gone = stored.filter((id) => !live.has(id));
  for (const id of gone) {
    ecosystemDb.prepare('DELETE FROM project_species_observations WHERE project_id = ?').run(id);
    ecosystemDb.prepare('DELETE FROM project_index_builds WHERE project_id = ?').run(id);
  }
  return gone;
}

/**
 * One tick of the queue: build due yards in order until
 * MAX_NETWORK_BUILDS_PER_TICK of them have touched the network.
 *
 * @param {object} args
 * @param {import('node:sqlite').DatabaseSync} args.appDb
 * @param {import('node:sqlite').DatabaseSync} args.ecosystemDb
 * @param {(project: { id: number, location: object }) => Promise<{ state: string, rows: number, networkRequests: number, error?: string }>} args.build
 *   builds and records one yard (fetch-ecosystem-index.mjs buildAndRecordEcosystemIndex)
 * @param {number} [args.maxNetworkBuilds]
 * @param {number} [args.now]
 * @returns {Promise<{ due: number, built: Array<{ projectId: number, reason: string, state: string, rows: number, networkRequests: number }>, pruned: number[] }>}
 */
export async function runIndexQueue({ appDb, ecosystemDb, build, maxNetworkBuilds = MAX_NETWORK_BUILDS_PER_TICK, now }) {
  const pruned = pruneDeletedProjects(appDb, ecosystemDb);
  const due = dueIndexBuilds(appDb, ecosystemDb, { now });
  const built = [];
  let networkBuilds = 0;
  for (const project of due) {
    if (networkBuilds >= maxNetworkBuilds) break;
    const result = await build({ id: project.id, location: project.location });
    built.push({
      projectId: project.id,
      reason: project.reason,
      state: result.state,
      rows: result.rows,
      networkRequests: result.networkRequests,
    });
    if (result.networkRequests > 0) networkBuilds += 1;
  }
  return { due: due.length, built, pruned };
}
