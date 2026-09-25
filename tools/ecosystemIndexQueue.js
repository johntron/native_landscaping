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
//
// Since nl-3s5.31 the same queue also builds each yard's three site layers
// (tools/ecosystemIndexDb.js SITE_LAYERS): nearby fauna (iNaturalist, ~50
// requests like the index), streams (one USGS NHD query) and green space (one
// OpenStreetMap Overpass query). runSiteQueue spends its politeness budget per
// upstream, so the index and the fauna layer share iNaturalist's one build a
// tick, while NHD and Overpass each get their own: a new yard's layers are all
// in within two ticks.
import {
  SITE_LAYERS,
  indexStatus,
  layerStatus,
  locationKey,
  readIndexBuild,
  readLayerBuild,
} from './ecosystemIndexDb.js';
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
  return dueSiteJobs(appDb, ecosystemDb, { now, jobs: ['index'] }).map(({ job, upstream, ...project }) => project);
}

/**
 * Every job the queue knows, how to read its state, and which upstream it
 * spends. 'index' is the species index (project_index_builds); the rest are
 * the site layers (project_layer_builds).
 */
const JOBS = Object.freeze({
  index: {
    upstream: 'inaturalist',
    status: (db, id, key) => indexStatus(db, id, key),
    build: (db, id) => readIndexBuild(db, id),
  },
  ...Object.fromEntries(
    Object.entries(SITE_LAYERS).map(([layer, { upstream }]) => [
      layer,
      {
        upstream,
        status: (db, id, key) => layerStatus(db, id, layer, key),
        build: (db, id) => readLayerBuild(db, id, layer),
      },
    ])
  ),
});

/** Every job name, index first. */
export const SITE_JOBS = Object.freeze(Object.keys(JOBS));

/**
 * The (yard, job) pairs that are due, in the order they will be run: never
 * built or moved first (oldest yard first, and within a yard in SITE_JOBS
 * order), then retries (longest waiting first).
 *
 * @param {import('node:sqlite').DatabaseSync} appDb
 * @param {import('node:sqlite').DatabaseSync} ecosystemDb
 * @param {{ now?: number, jobs?: string[] }} [options]
 * @returns {Array<{ id: number, slug: string, location: object, job: string, upstream: string, reason: 'new'|'moved'|'retry'|'stale' }>}
 */
export function dueSiteJobs(appDb, ecosystemDb, { now = Date.now(), jobs = SITE_JOBS } = {}) {
  const fresh = [];
  const retries = [];
  for (const project of listLocatedProjects(appDb)) {
    const key = locationKey(project.location);
    if (!key) continue;
    for (const job of jobs) {
      const kind = JOBS[job];
      if (!kind) throw new Error(`Unknown queue job ${job}`);
      const status = kind.status(ecosystemDb, project.id, key);
      const entry = { ...project, job, upstream: kind.upstream };
      if (status.state === 'queued') {
        const moved = Boolean(kind.build(ecosystemDb, project.id));
        fresh.push({ ...entry, reason: moved ? 'moved' : 'new' });
        continue;
      }
      const build = kind.build(ecosystemDb, project.id);
      if (status.state === 'building') {
        const started = Date.parse(build.startedAt || '') || 0;
        if (now - started >= STALE_BUILD_MINUTES * MINUTE_MS) retries.push({ ...entry, reason: 'stale', since: started });
      } else if (status.state === 'failed') {
        const finished = Date.parse(build.finishedAt || '') || 0;
        if (now - finished >= retryWaitMs(build.attempts)) retries.push({ ...entry, reason: 'retry', since: finished });
      }
    }
  }
  retries.sort((a, b) => a.since - b.since);
  return [...fresh, ...retries.map(({ since, ...entry }) => entry)];
}

/**
 * Drop index rows and build records of yards that no longer exist in app.db.
 * Yard ids are AUTOINCREMENT and never reused, so this is tidiness, not
 * safety.
 */
export function pruneDeletedProjects(appDb, ecosystemDb) {
  const live = new Set(appDb.prepare('SELECT id FROM projects').all().map((row) => Number(row.id)));
  const tables = [
    'project_species_observations',
    'project_index_builds',
    'project_anchors',
    'project_nearby_fauna',
    'project_layer_builds',
  ];
  const stored = ecosystemDb
    .prepare(tables.map((table) => `SELECT DISTINCT project_id FROM ${table}`).join(' UNION '))
    .all()
    .map((row) => Number(row.project_id));
  const gone = stored.filter((id) => !live.has(id));
  for (const id of gone) {
    for (const table of tables) ecosystemDb.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
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
  const { due, built, pruned } = await runSiteQueue({
    appDb,
    ecosystemDb,
    builders: { index: build },
    budget: { inaturalist: maxNetworkBuilds },
    now,
  });
  return { due, built: built.map(({ job, ...entry }) => entry), pruned };
}

/**
 * Judgement: network-touching builds per upstream per tick. iNaturalist's is
 * shared by the species index and the fauna layer (MAX_NETWORK_BUILDS_PER_TICK,
 * above); NHD and Overpass each cost one request per build. At one build a
 * tick and the default 30-minute tick that is at most 48 Overpass queries a
 * day, under the 100 a day the OpenStreetMap wiki gives for software that uses
 * the public instance regularly (https://wiki.openstreetmap.org/wiki/Overpass_API,
 * "divide those numbers by 100"; the sourced part), and in practice one query
 * per new or moved yard. NHD publishes no limit; one request per yard is our
 * judgement of polite.
 */
export const UPSTREAM_BUILDS_PER_TICK = Object.freeze({
  inaturalist: MAX_NETWORK_BUILDS_PER_TICK,
  nhd: 1,
  overpass: 1,
});

/**
 * One tick of the whole queue: every due (yard, job) whose builder is given,
 * in dueSiteJobs order, skipping a job once its upstream has spent its budget
 * of network-touching builds this tick. A build served entirely from the
 * probe cache spends nothing.
 *
 * @param {object} args
 * @param {import('node:sqlite').DatabaseSync} args.appDb
 * @param {import('node:sqlite').DatabaseSync} args.ecosystemDb
 * @param {Partial<Record<string, (project: { id: number, location: object }) => Promise<{ state: string, rows: number, networkRequests: number, error?: string }>>>} args.builders
 *   job name -> builds and records one yard's job (the fetch tools' buildAndRecord* functions)
 * @param {Partial<Record<string, number>>} [args.budget] per upstream; defaults to UPSTREAM_BUILDS_PER_TICK
 * @param {number} [args.now]
 * @returns {Promise<{ due: number, built: Array<{ projectId: number, job: string, reason: string, state: string, rows: number, networkRequests: number }>, pruned: number[] }>}
 */
export async function runSiteQueue({ appDb, ecosystemDb, builders, budget = UPSTREAM_BUILDS_PER_TICK, now }) {
  const pruned = pruneDeletedProjects(appDb, ecosystemDb);
  const jobs = SITE_JOBS.filter((job) => typeof builders?.[job] === 'function');
  const due = dueSiteJobs(appDb, ecosystemDb, { now, jobs });
  const spent = {};
  const built = [];
  for (const entry of due) {
    const allowed = budget[entry.upstream] ?? 0;
    if ((spent[entry.upstream] || 0) >= allowed) continue;
    const result = await builders[entry.job]({ id: entry.id, location: entry.location });
    built.push({
      projectId: entry.id,
      job: entry.job,
      reason: entry.reason,
      state: result.state,
      rows: result.rows,
      networkRequests: result.networkRequests,
    });
    if (result.networkRequests > 0) spent[entry.upstream] = (spent[entry.upstream] || 0) + 1;
  }
  return { due: due.length, built, pruned };
}
