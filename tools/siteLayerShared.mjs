/**
 * What the three per-yard site-layer fetches share (nl-3s5.31): streams
 * (tools/fetch-nhd-creeks.mjs), green space (tools/fetch-osm-greenspace.mjs)
 * and nearby fauna (tools/fetch-nearby-fauna.mjs).
 *
 * Until nl-3s5.31 each of those merged its rows into a committed CSV keyed
 * by the yard's free-text `place` label (ecology/anchors.csv,
 * ecology/nearby-fauna.csv), which put one owner's site in a public repo.
 * They now write to data/ecosystem.db under the yard's app.db id, the same
 * way the species index does (tools/fetch-ecosystem-index.mjs), and record a
 * build row per (yard, layer) so the page can say where a layer stands and
 * feed-poller's queue (tools/ecosystemIndexQueue.js) can build the layers of
 * a new yard without anyone running these by hand.
 *
 * The location is read from app.db and never written anywhere: not to a row,
 * not to a build record, not to a log line (feed-poller's logs are kept).
 */
import { cached, getCached } from './usda-plants/probeCache.js';
import { geocodeAddress } from './geocode.mjs';
import { USER_AGENT, sleep } from './inatShared.mjs';
import { locationKey, markLayerFinished, markLayerStarted, replaceLayerRows } from './ecosystemIndexDb.js';

/**
 * The request context a build threads through its calls: the injected fetch
 * (tests stub it, so no test reaches an upstream), the probe cache, and a
 * count of real network requests, which the queue's politeness budget reads.
 *
 * @param {{ probeCache: import('node:sqlite').DatabaseSync, fetchImpl?: typeof fetch, force?: boolean,
 *   requestDelayMs?: number, logger?: { log: Function, warn: Function } }} args
 */
export function createIo({ probeCache, fetchImpl = fetch, force = false, requestDelayMs = 0, logger = console }) {
  return { probeCache, fetchImpl, force, requestDelayMs, logger, networkRequests: 0, failures: 0 };
}

/**
 * One upstream request through the probe cache: a replay is a disk read, a
 * real request is counted, retried on 429/5xx with backoff, and followed by
 * the politeness delay.
 *
 * @param {ReturnType<typeof createIo>} io
 * @param {string} source probe-cache source ('inaturalist', 'nhd', 'overpass')
 * @param {string} endpoint probe-cache endpoint label
 * @param {string} key probe-cache key
 * @param {() => [string | URL, RequestInit]} request the URL and options to fetch
 * @param {(response: Response) => Promise<any>} [parse]
 * @returns {Promise<{ raw: any, fromCache: boolean }>}
 */
export async function cachedRequest(io, source, endpoint, key, request, parse = (response) => response.json()) {
  const { raw, cached: fromCache } = await cached(
    io.probeCache,
    source,
    endpoint,
    key,
    async () => {
      try {
        const [url, options] = request();
        const response = await fetchWithBackoff(io, url, options);
        // The status alone, never the body: an upstream's error page can echo
        // the request (Overpass quotes its query, around:<m>,<lat>,<lng>), and
        // this message is stored in project_layer_builds and logged by feed-poller.
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await parse(response);
      } finally {
        if (io.requestDelayMs) await sleep(io.requestDelayMs);
      }
    },
    { force: io.force }
  );
  return { raw, fromCache: Boolean(fromCache) };
}

async function fetchWithBackoff(io, url, options, attempt = 1) {
  io.networkRequests += 1;
  const response = await io.fetchImpl(url, options);
  if ((response.status === 429 || response.status >= 500) && attempt <= 3) {
    const retryAfterMs = Number(response.headers?.get?.('retry-after')) * 1000 || attempt * 5000;
    io.logger.warn(`  HTTP ${response.status} — backing off ${retryAfterMs}ms before retry ${attempt}/3`);
    await sleep(io.requestDelayMs ? retryAfterMs : 0);
    return fetchWithBackoff(io, url, options, attempt + 1);
  }
  return response;
}

/**
 * The yard's coordinates, geocoding a stored address through the shared
 * Nominatim cache when it has no lat/lng. Counted as a network request unless
 * it will replay.
 */
export async function resolveCoordinates(location, io) {
  if (Number.isFinite(location?.lat) && Number.isFinite(location?.lng)) {
    return { lat: location.lat, lng: location.lng };
  }
  if (!location?.address) throw new Error('the stored location has neither lat/lng nor an address');
  if (io.force || !getCached(io.probeCache, 'nominatim', 'search', String(location.address).trim())) {
    io.networkRequests += 1;
  }
  const { lat, lng } = await geocodeAddress(location.address, { probeCache: io.probeCache, force: io.force });
  return { lat, lng };
}

/**
 * An error message with any quoted text blanked: the geocoder quotes the
 * address back, and this message is stored and logged, neither of which may
 * hold a location. (fetch-ecosystem-index.mjs has its own copy for the index.)
 */
export function withoutQuotedText(message) {
  return String(message ?? '').replace(/"[^"]*"/g, '"…"');
}

/**
 * Build one site layer of one yard and record the build around it
 * (project_layer_builds): 'building' while it runs, then 'ready', or 'failed'
 * when it threw or a request failed. On failure the layer's previous rows for
 * this location are left as they were: `build` returns its rows and they are
 * written only when it succeeds.
 *
 * @param {'fauna'|'streams'|'greenspace'} layer
 * @param {(args: object) => Promise<{ rows: object[], networkRequests: number, failures: number, fetchedOn: string }>} build
 * @param {{ projectId: number, location: object, db: import('node:sqlite').DatabaseSync }} args
 * @returns {Promise<{ state: 'ready'|'failed', rows: number, networkRequests: number, failures: number, error?: string }>}
 */
export async function buildAndRecordLayer(layer, build, args) {
  const key = locationKey(args.location);
  if (!key) throw new Error(`Yard #${args.projectId} has no usable location`);
  markLayerStarted(args.db, args.projectId, layer, key);
  try {
    const result = await build(args);
    if (result.failures) {
      const error = `${result.failures} request(s) failed`;
      markLayerFinished(args.db, args.projectId, layer, { state: 'failed', error });
      return { state: 'failed', rows: 0, networkRequests: result.networkRequests, failures: result.failures, error };
    }
    replaceLayerRows(args.db, args.projectId, layer, result.rows);
    markLayerFinished(args.db, args.projectId, layer, { state: 'ready', fetchedOn: result.fetchedOn });
    return { state: 'ready', rows: result.rows.length, networkRequests: result.networkRequests, failures: 0 };
  } catch (err) {
    const error = withoutQuotedText(err.message);
    markLayerFinished(args.db, args.projectId, layer, { state: 'failed', error });
    // An exception may have come after any number of real requests; count it
    // as one, so the queue never treats a failed build as free.
    return { state: 'failed', rows: 0, networkRequests: Math.max(1, err.networkRequests || 0), failures: 1, error };
  }
}

/** Today, as the YYYY-MM-DD every row's fetched_on carries. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** `--flag value` from argv, or null. */
export function argAfter(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

/** True when the importing module is the process entry point (the CLI), not an import (feed-poller). */
export function isEntryPoint(importMetaUrl) {
  return Boolean(process.argv[1]) && importMetaUrl === new URL(process.argv[1], 'file:').href;
}

export { USER_AGENT };
