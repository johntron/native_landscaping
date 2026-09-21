#!/usr/bin/env node
/**
 * Long-running loop for the docker-compose `feed-poller` service: polls
 * every saved area (tools/savedAreas/savedAreasDb.js) on an interval via
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
 */
import { pollSavedAreas } from './feedState/pollAreas.js';

const DEFAULT_INTERVAL_MINUTES = 30;
const intervalMinutes = Number(process.env.FEED_POLL_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES;
const intervalMs = intervalMinutes * 60_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick() {
  const startedAt = new Date().toISOString();
  try {
    const { results } = await pollSavedAreas({});
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

async function main() {
  console.log(`feed-poller starting — polling every ${intervalMinutes} minute(s)`);
  for (;;) {
    await tick();
    await sleep(intervalMs);
  }
}

main();
