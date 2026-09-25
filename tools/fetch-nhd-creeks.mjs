#!/usr/bin/env node
/**
 * Fetch the nearest named streams to a yard from USGS NHD
 * (hydro.nationalmap.gov) into the yard's 'streams' layer in
 * data/ecosystem.db (nl-3hi.7.1, stage 1 of the anchor-data epic nl-3hi.7;
 * per yard since nl-3s5.31, when the rows left the committed
 * ecology/anchors.csv).
 *
 * The location is read from app.db (tools/projectSite.mjs) and never written
 * anywhere. Anchor location and distance are facts (see nl-3hi.7's hard
 * boundary): no connectivity score is computed here, just the nearest named
 * streams and how far away they are, rounded to a quarter mile.
 *
 * feed-poller builds this layer for every yard with a location
 * (tools/ecosystemIndexQueue.js), so running it by hand is for a forced
 * refresh or a --smoke look.
 *
 * Usage:
 *   node tools/fetch-nhd-creeks.mjs --project backyard [--owner <email>]
 *   node tools/fetch-nhd-creeks.mjs --project backyard --smoke   # print, write nothing
 *   node tools/fetch-nhd-creeks.mjs --project backyard --force   # bypass the response cache
 */
import { readProjectSite, ownerFromArgs } from './projectSite.mjs';
import { openProbeCache } from './usda-plants/probeCache.js';
import { openEcosystemDb } from './ecosystemIndexDb.js';
import { pointToPolylineMi, roundDistanceMi } from './geoShared.mjs';
import {
  USER_AGENT,
  argAfter,
  buildAndRecordLayer,
  cachedRequest,
  createIo,
  isEntryPoint,
  resolveCoordinates,
  today,
} from './siteLayerShared.mjs';

/** NHD "Flowline - Large Scale" layer — high-resolution flowlines, the one layer with real geometry at this scale. */
const NHD_QUERY_URL = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query';

/** Search radius around the site. Wide enough that most sites find at least one named stream. */
const SEARCH_RADIUS_MI = 5;
const SEARCH_RADIUS_M = SEARCH_RADIUS_MI * 1609.34;

/** How many distinct named streams to keep, nearest first. A judgement call, not a sourced figure. */
const MAX_STREAMS = 3;

/**
 * NHD FType codes seen near Dallas test sites. 460 = StreamRiver (a real
 * channel); 558 = ArtificialPath (a schematic connector drawn through lakes
 * and reservoirs, inheriting the waterbody's name — not a corridor). Stored
 * in the row's detail, so the read side can refine this later without a
 * re-fetch.
 */
const REAL_CHANNEL_FTYPES = new Set([460, 336]); // StreamRiver, CanalDitch

export const STREAMS_SOURCE = 'hydro.nationalmap.gov nhd/MapServer/6 (Flowline - Large Scale)';

/**
 * The yard's nearest named streams, as 'streams' layer rows. One NHD request
 * (cached by rounded point and radius). Nothing is written here; see
 * buildAndRecordLayer.
 *
 * @param {{ location: object, probeCache: import('node:sqlite').DatabaseSync, fetchImpl?: typeof fetch,
 *   force?: boolean, logger?: { log: Function, warn: Function } }} args
 */
export async function buildStreamsLayer({ location, probeCache, fetchImpl, force = false, logger = console }) {
  const io = createIo({ probeCache, fetchImpl, force, logger });
  const { lat, lng } = await resolveCoordinates(location, io);
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)},r${SEARCH_RADIUS_MI}`;
  const { raw: body } = await cachedRequest(io, 'nhd', 'flowline-query', cacheKey, () => [
    buildQueryUrl(lat, lng),
    { headers: { 'User-Agent': USER_AGENT } },
  ]);
  if (body.error) {
    // The code alone: an ArcGIS error's details can echo the query geometry.
    const err = new Error(`NHD query failed: code ${Number(body.error.code) || 'unknown'}`);
    err.networkRequests = io.networkRequests;
    throw err;
  }
  const fetchedOn = today();
  const rows = extractNamedStreams(body, lat, lng).map((stream) => ({
    kind: 'stream',
    name: stream.name,
    status: 'anchor', // NHD hydrology is the epic's "best ecological signal" — a fact, not an admin label.
    distance_mi: roundDistanceMi(stream.distanceMi),
    detail: REAL_CHANNEL_FTYPES.has(stream.ftype) ? 'channel' : 'artificial-path',
    fetched_on: fetchedOn,
    source: STREAMS_SOURCE,
  }));
  return { rows, networkRequests: io.networkRequests, failures: io.failures, fetchedOn };
}

/** Build and record one yard's 'streams' layer (feed-poller's queue and the CLI). */
export function buildAndRecordStreams(args) {
  return buildAndRecordLayer('streams', buildStreamsLayer, args);
}

function buildQueryUrl(lat, lng) {
  const url = new URL(NHD_QUERY_URL);
  url.searchParams.set('geometry', JSON.stringify({ x: lng, y: lat }));
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('distance', String(SEARCH_RADIUS_M));
  url.searchParams.set('units', 'esriSRUnit_Meter');
  url.searchParams.set('outFields', 'gnis_name,ftype,fcode');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('f', 'json');
  return url;
}

/** Nearest distance per distinct named stream, using actual line geometry, not a centroid (nl-3hi.7.1). */
export function extractNamedStreams(body, lat, lng) {
  const point = [lng, lat];
  const nearestByName = new Map(); // gnis_name -> { name, distanceMi, ftype }

  for (const feature of body.features || []) {
    const name = feature.attributes?.gnis_name;
    if (!name) continue; // deliverable is *named* streams; unnamed ones are stored nowhere, not invented.
    const paths = feature.geometry?.paths;
    if (!paths) continue;
    const distanceMi = pointToPolylineMi(point, paths);
    const existing = nearestByName.get(name);
    if (!existing || distanceMi < existing.distanceMi) {
      nearestByName.set(name, { name, distanceMi, ftype: feature.attributes.ftype });
    }
  }

  return [...nearestByName.values()]
    .sort((a, b) => a.distanceMi - b.distanceMi)
    .slice(0, MAX_STREAMS);
}

async function main() {
  const args = process.argv.slice(2);
  const slug = argAfter(args, '--project');
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  if (!slug) {
    console.error('Usage: node tools/fetch-nhd-creeks.mjs --project <slug> [--owner <email>] [--smoke] [--force]');
    process.exit(1);
  }
  let site;
  try {
    site = readProjectSite(slug, { ownerEmail: ownerFromArgs(args), requirePlace: false });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const probeCache = openProbeCache();
  if (smoke) {
    const { rows } = await buildStreamsLayer({ location: site.location, probeCache, force });
    console.log(`\n--smoke run: ${rows.length} named stream(s) within ${SEARCH_RADIUS_MI}mi, NOT writing data/ecosystem.db\n`);
    console.table(rows);
    return;
  }
  const db = openEcosystemDb();
  const result = await buildAndRecordStreams({ projectId: site.projectId, location: site.location, db, probeCache, force });
  console.log(
    `Yard "${slug}" (#${site.projectId}) streams: ${result.state}, ${result.rows} row(s), ${result.networkRequests} network request(s)` +
      (result.error ? ` — ${result.error}` : '')
  );
  if (result.state !== 'ready') process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
