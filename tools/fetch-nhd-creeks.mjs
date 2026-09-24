#!/usr/bin/env node
/**
 * Fetch the nearest named streams to a project's site from USGS NHD
 * (hydro.nationalmap.gov), and merge the result into ecology/anchors.csv
 * keyed by `place` (nl-3hi.7.1, stage 1 of the anchor-data epic nl-3hi.7).
 *
 * Same pattern as fetch-nearby-fauna.mjs: the network call happens here,
 * once, offline, and the app only ever reads the checked-in CSV.
 * src/analysis/ stays pure. Coordinates never reach the CSV or git — see
 * the yard's location in app.db (tools/projectSite.mjs).
 *
 * Anchor location and distance are facts (see nl-3hi.7's hard boundary): no
 * connectivity score is computed here, just the nearest named streams and
 * how far away they are.
 *
 * Usage:
 *   node tools/fetch-nhd-creeks.mjs --project backyard
 *   node tools/fetch-nhd-creeks.mjs --project backyard --smoke
 */
import { readProjectSite, ownerFromArgs } from './projectSite.mjs';
import { openProbeCache, cached } from './usda-plants/probeCache.js';
import { USER_AGENT } from './inatShared.mjs';
import { pointToPolylineMi, roundDistanceMi } from './geoShared.mjs';
import { ANCHORS_CSV, mergeAnchorRows } from './anchorsShared.mjs';


/** NHD "Flowline - Large Scale" layer — high-resolution flowlines, the one layer with real geometry at this scale. */
const NHD_QUERY_URL = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query';

/** Search radius around the site. Wide enough that most sites find at least one named stream. */
const SEARCH_RADIUS_MI = 5;
const SEARCH_RADIUS_M = SEARCH_RADIUS_MI * 1609.34;

/** How many distinct named streams to keep, nearest first. */
const MAX_STREAMS = 3;

/**
 * NHD FType codes seen near Dallas test sites. 460 = StreamRiver (a real
 * channel); 558 = ArtificialPath (a schematic connector drawn through lakes
 * and reservoirs, inheriting the waterbody's name — not a corridor). Stored
 * as a column too (ftype/fcode), so the read side can refine this later
 * without a re-fetch, same as establishment_means in fetch-nearby-fauna.mjs.
 */
const REAL_CHANNEL_FTYPES = new Set([460, 336]); // StreamRiver, CanalDitch

async function main() {
  const args = process.argv.slice(2);
  const projectId = argAfter(args, '--project');
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  if (!projectId) {
    console.error('Usage: node tools/fetch-nhd-creeks.mjs --project <id> [--owner <email>] [--smoke] [--force]');
    process.exit(1);
  }

  // The place label and the location behind it live in app.db (nl-3s5.3);
  // the location never reaches git. tools/projectSite.mjs says how to set one.
  let site;
  try {
    site = readProjectSite(projectId, { ownerEmail: ownerFromArgs(args) });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { place, location } = site;
  const { lat, lng } = await resolveCoordinates(location);


  const probeCache = openProbeCache();
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)},r${SEARCH_RADIUS_MI}`;
  const { raw: body } = await cached(
    probeCache,
    'nhd',
    'flowline-query',
    cacheKey,
    async () => {
      const response = await fetch(buildQueryUrl(lat, lng), {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    { force }
  );

  if (body.error) {
    throw new Error(`NHD query failed: ${JSON.stringify(body.error)}`);
  }

  const streams = extractNamedStreams(body, lat, lng);

  if (smoke) {
    console.log(`\n--smoke run: found ${streams.length} named streams within ${SEARCH_RADIUS_MI}mi, NOT writing ${ANCHORS_CSV}\n`);
    console.table(streams);
    return;
  }

  const newRows = streams.map((stream) => ({
    place,
    kind: 'stream',
    name: stream.name,
    status: 'anchor', // NHD hydrology is the epic's "best ecological signal" — a fact, not an admin label.
    distance_mi: roundDistanceMi(stream.distanceMi),
    detail: REAL_CHANNEL_FTYPES.has(stream.ftype) ? 'channel' : 'artificial-path',
    fetched_on: new Date().toISOString().slice(0, 10),
    source: 'hydro.nationalmap.gov nhd/MapServer/6 (Flowline - Large Scale)',
  }));

  mergeAnchorRows(place, 'stream', newRows);
  console.log(`Wrote ${newRows.length} stream row(s) for "${place}" to ${ANCHORS_CSV}`);
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
function extractNamedStreams(body, lat, lng) {
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

async function resolveCoordinates(location) {
  if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    return { lat: location.lat, lng: location.lng };
  }
  if (!location.address) {
    throw new Error('the stored location has neither lat/lng nor an address');
  }
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location.address)}`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Geocoding failed: HTTP ${response.status}`);
  const results = await response.json();
  if (!results.length) throw new Error(`Geocoding found nothing for "${location.address}"`);
  return { lat: Number(results[0].lat), lng: Number(results[0].lon) };
}

function argAfter(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
