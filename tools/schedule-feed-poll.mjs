#!/usr/bin/env node
/**
 * Long-running loop for the docker-compose `feed-poller` service: polls
 * every saved area (the saved_areas table in data/app.db, read through
 * tools/savedAreas/savedAreasDb.js) on an interval via
 * tools/feedState/pollAreas.js, so the observation feed (nl-1qy) fills in
 * on its own instead of only ever advancing when someone remembers to run
 * tools/fetch-observation-events.mjs by hand.
 *
 * Deliberately a plain setInterval loop in the same image as `web`, not a
 * cron package or a second language runtime — one area's poll is a handful
 * of throttled HTTP requests (see pollAreas.js/fetch-observation-events.mjs
 * for the ~1.5s-per-request pacing), so there's nothing here a scheduler
 * library would buy over "await, then wait, then loop". Never --backfill
 * (see pollAreas.js) — an unattended full-history walk on every area, every
 * tick, is exactly the runaway crawl this loop must not become.
 *
 * FEED_POLL_INTERVAL_MINUTES (env, default 30) sets the cadence. The epic's
 * own design notes put personal-scale polling (a handful of saved areas,
 * every 15-60 min) nowhere near iNaturalist's documented ~1 req/sec, 60/min,
 * ~10K/day limits, so 30 is a reasonable default rather than a tuned one.
 *
 * app.db (nl-3s5.11): this process opens it once at startup but never
 * migrates it, seeds the owner, or runs the legacy import — web does all
 * three on its own start, and only web has OWNER_EMAIL, which the import
 * needs to give imported areas their owner. Until web has created app.db and
 * applied every migration this checkout knows, the open throws
 * AppDbNotReadyError and this loop logs it and retries every
 * APP_DB_RETRY_SECONDS, so a deploy that restarts both services at once
 * sorts itself out within seconds instead of crashing or waiting a full tick.
 * DATA_DIR relocates app.db here exactly as it does for web.
 *
 * Each tick also builds the nearby-species index of any yard that has a
 * location and no index for it yet (nl-3s5.6, tools/ecosystemIndexQueue.js),
 * and its site layers: nearby fauna, streams and green space (nl-3s5.31). At
 * most one network-touching build per upstream per tick, after the saved
 * areas. The two jobs fail independently: a failed index build never skips
 * the feed poll, and the reverse.
 */
import { pollSavedAreas } from './feedState/pollAreas.js';
import { openAppDbWithoutMigrating, AppDbNotReadyError } from '../server/db/appDb.js';
import { openEcosystemDb } from './ecosystemIndexDb.js';
import { runSiteQueue } from './ecosystemIndexQueue.js';
import { buildAndRecordEcosystemIndex } from './fetch-ecosystem-index.mjs';
import { buildAndRecordFauna } from './fetch-nearby-fauna.mjs';
import { buildAndRecordStreams } from './fetch-nhd-creeks.mjs';
import { buildAndRecordGreenspace } from './fetch-osm-greenspace.mjs';
import { openProbeCache } from './usda-plants/probeCache.js';

const DEFAULT_INTERVAL_MINUTES = 30;
const intervalMinutes = Number(process.env.FEED_POLL_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES;
const intervalMs = intervalMinutes * 60_000;
const APP_DB_RETRY_SECONDS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Open app.db, waiting for web to create and migrate it if it has not yet. */
async function openAppDbWhenReady() {
  for (;;) {
    try {
      return openAppDbWithoutMigrating();
    } catch (err) {
      if (!(err instanceof AppDbNotReadyError)) throw err;
      console.warn(`app.db not ready: ${err.message}. Retrying in ${APP_DB_RETRY_SECONDS}s`);
      await sleep(APP_DB_RETRY_SECONDS * 1000);
    }
  }
}

async function pollFeed(appDb, startedAt) {
  try {
    const { results } = await pollSavedAreas({ appDb });
    if (!results.length) {
      console.log(`[${startedAt}] no saved areas to poll`);
      return;
    }
    const summary = results.map((r) => `${r.areaId}: +${r.written}`).join(', ');
    console.log(`[${startedAt}] polled ${results.length} area(s) — ${summary}`);
  } catch (err) {
    // One area's transient failure (network blip, iNaturalist 5xx after
    // retries) must not kill the loop — the next tick tries again.
    console.error(`[${startedAt}] poll failed:`, err);
  }
}

async function buildDueIndexes(appDb, ecosystemDb, probeCache, startedAt) {
  try {
    const args = (project) => ({ projectId: project.id, location: project.location, db: ecosystemDb, probeCache });
    const { due, built } = await runSiteQueue({
      appDb,
      ecosystemDb,
      builders: {
        index: (project) => buildAndRecordEcosystemIndex(args(project)),
        fauna: (project) => buildAndRecordFauna(args(project)),
        streams: (project) => buildAndRecordStreams(args(project)),
        greenspace: (project) => buildAndRecordGreenspace(args(project)),
      },
    });
    if (!due) return;
    const summary = built
      .map((b) => `yard #${b.projectId} ${b.job} (${b.reason}): ${b.state}, ${b.rows} rows, ${b.networkRequests} request(s)`)
      .join('; ');
    console.log(`[${startedAt}] nearby index and site layers: ${due} job(s) due — ${summary || 'none built this tick'}`);
  } catch (err) {
    console.error(`[${startedAt}] nearby index build failed:`, err);
  }
}

async function tick(appDb, ecosystemDb, probeCache) {
  const startedAt = new Date().toISOString();
  await pollFeed(appDb, startedAt);
  await buildDueIndexes(appDb, ecosystemDb, probeCache, startedAt);
}

async function main() {
  console.log(`feed-poller starting — polling every ${intervalMinutes} minute(s)`);
  const appDb = await openAppDbWhenReady();
  const ecosystemDb = openEcosystemDb();
  const probeCache = openProbeCache();
  for (;;) {
    await tick(appDb, ecosystemDb, probeCache);
    await sleep(intervalMs);
  }
}

main();
