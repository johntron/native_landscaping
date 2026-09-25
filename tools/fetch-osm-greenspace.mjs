#!/usr/bin/env node
/**
 * Fetch candidate green-space anchors (parks, nature reserves, cemeteries,
 * forest, golf courses) near a yard from OpenStreetMap via Overpass into the
 * yard's 'greenspace' layer in data/ecosystem.db (nl-3hi.7.2, stage 2 of the
 * anchor-data epic nl-3hi.7; per yard since nl-3s5.31, when the rows left the
 * committed ecology/anchors.csv).
 *
 * The location is read from app.db (tools/projectSite.mjs) and never written
 * anywhere.
 *
 * OSM's leisure/landuse tags are ADMINISTRATIVE, not ecological (a live test
 * against Dallas returned "Texas State Fair Grounds" and "Old East Dallas
 * Work Yard" as leisure=park). Every row this tool writes gets
 * status=candidate, never status=anchor — nl-3hi.7.5 is what promotes a
 * candidate once a human confirms it, this tool never does.
 *
 * feed-poller builds this layer for every yard with a location
 * (tools/ecosystemIndexQueue.js), one Overpass query per yard, so running it
 * by hand is for a forced refresh or a --smoke look.
 *
 * Usage:
 *   node tools/fetch-osm-greenspace.mjs --project backyard [--owner <email>]
 *   node tools/fetch-osm-greenspace.mjs --project backyard --smoke   # print, write nothing
 *   node tools/fetch-osm-greenspace.mjs --project backyard --force   # bypass the response cache
 */
import { readProjectSite, ownerFromArgs } from './projectSite.mjs';
import { openProbeCache } from './usda-plants/probeCache.js';
import { openEcosystemDb } from './ecosystemIndexDb.js';
import { pointToPolylineMi, ringAreaAcres, roundDistanceMi } from './geoShared.mjs';
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

/**
 * overpass-api.de returned HTTP 406 to a default curl User-Agent in the
 * epic's live test; a real UA (set below) fixed it there. Both this and the
 * kumi.systems mirror have also been observed to 504 under load with a
 * multi-tag query — the generous [timeout:55] in the query body is what
 * gets a union of five tags to complete rather than time out server-side.
 */
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const SEARCH_RADIUS_MI = 5;
const SEARCH_RADIUS_M = Math.round(SEARCH_RADIUS_MI * 1609.34);

/** Tags worth pulling per the epic's research (nl-3hi.6): administrative labels for plausibly-permeable land. */
const TAGS = [
  ['leisure', 'park'],
  ['leisure', 'nature_reserve'],
  ['landuse', 'cemetery'],
  ['landuse', 'forest'],
  ['leisure', 'golf_course'],
];

/**
 * Size floor in acres. A judgment call (like AMPLE_SHARE in
 * rules/keystoneGenera.js), not a sourced fact: excludes pocket-park- and
 * traffic-island-scale features a naive OSM pull otherwise reports as
 * "green space" alongside an actual park.
 */
const MIN_ACRES = 1;

/**
 * Cap on candidates written, nearest first. Stage 5 (nl-3hi.7.5) is a human
 * reading this list to promote real anchors — a Dallas-density 5mi pull
 * returns 100+ named parks/cemeteries, which is a data dump, not a
 * reviewable candidate list. Another judgment call, not a fact.
 */
const MAX_CANDIDATES = 15;

export const GREENSPACE_SOURCE = 'OpenStreetMap via Overpass (overpass-api.de)';

/**
 * The yard's nearest named green space, as 'greenspace' layer rows. One
 * Overpass query (cached by rounded point and radius).
 *
 * @param {{ location: object, probeCache: import('node:sqlite').DatabaseSync, fetchImpl?: typeof fetch,
 *   force?: boolean, logger?: { log: Function, warn: Function } }} args
 */
export async function buildGreenspaceLayer({ location, probeCache, fetchImpl, force = false, logger = console }) {
  const io = createIo({ probeCache, fetchImpl, force, logger });
  const { lat, lng } = await resolveCoordinates(location, io);
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)},r${SEARCH_RADIUS_MI}`;
  const query = buildQuery(lat, lng);
  const { raw: body } = await cachedRequest(
    io,
    'overpass',
    'greenspace-query',
    cacheKey,
    () => [
      OVERPASS_URL,
      { method: 'POST', headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'text/plain' }, body: query },
    ],
    async (response) => JSON.parse(await response.text())
  );
  const fetchedOn = today();
  const rows = extractCandidates(body, lat, lng).map((c) => ({
    kind: c.tag.split('=')[1],
    name: c.name,
    status: 'candidate', // OSM tags are administrative, never promoted to "anchor" by this tool (nl-3hi.7.2).
    distance_mi: roundDistanceMi(c.distanceMi),
    detail: `${c.tag}, ~${Math.round(c.acres)} acres`,
    fetched_on: fetchedOn,
    source: GREENSPACE_SOURCE,
  }));
  return { rows, networkRequests: io.networkRequests, failures: io.failures, fetchedOn };
}

/** Build and record one yard's 'greenspace' layer (feed-poller's queue and the CLI). */
export function buildAndRecordGreenspace(args) {
  return buildAndRecordLayer('greenspace', buildGreenspaceLayer, args);
}

function buildQuery(lat, lng) {
  const clauses = TAGS.map(
    ([key, value]) => `  way["${key}"="${value}"](around:${SEARCH_RADIUS_M},${lat},${lng});`
  ).join('\n');
  return `[out:json][timeout:55];\n(\n${clauses}\n);\nout geom;`;
}

/** Distance to the nearest point on each way's ring, and its area — not a centroid distance (nl-3hi.7.2). */
export function extractCandidates(body, lat, lng) {
  const point = [lng, lat];
  const results = [];
  for (const element of body.elements || []) {
    if (element.type !== 'way' || !element.geometry) continue;
    const name = element.tags?.name;
    if (!name) continue; // administrative tags without even a name are the least trustworthy signal here.
    const tagEntry = TAGS.find(([key, value]) => element.tags?.[key] === value);
    if (!tagEntry) continue;
    const ring = element.geometry.map((pt) => [pt.lon, pt.lat]);
    if (ring.length < 3) continue;
    const acres = ringAreaAcres(ring);
    if (acres < MIN_ACRES) continue;
    const closedRing = [...ring, ring[0]];
    const distanceMi = pointToPolylineMi(point, [closedRing]);
    results.push({ name, tag: `${tagEntry[0]}=${tagEntry[1]}`, distanceMi, acres });
  }
  // Same name can appear more than once (adjacent ways of one park); keep the nearest.
  const nearestByName = new Map();
  for (const r of results) {
    const existing = nearestByName.get(r.name);
    if (!existing || r.distanceMi < existing.distanceMi) nearestByName.set(r.name, r);
  }
  return [...nearestByName.values()]
    .sort((a, b) => a.distanceMi - b.distanceMi)
    .slice(0, MAX_CANDIDATES);
}

async function main() {
  const args = process.argv.slice(2);
  const slug = argAfter(args, '--project');
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  if (!slug) {
    console.error('Usage: node tools/fetch-osm-greenspace.mjs --project <slug> [--owner <email>] [--smoke] [--force]');
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
    const { rows } = await buildGreenspaceLayer({ location: site.location, probeCache, force });
    console.log(
      `\n--smoke run: ${rows.length} candidate(s) >= ${MIN_ACRES} acre(s) within ${SEARCH_RADIUS_MI}mi, NOT writing data/ecosystem.db\n`
    );
    console.table(rows);
    return;
  }
  const db = openEcosystemDb();
  const result = await buildAndRecordGreenspace({ projectId: site.projectId, location: site.location, db, probeCache, force });
  console.log(
    `Yard "${slug}" (#${site.projectId}) green space: ${result.state}, ${result.rows} row(s), ${result.networkRequests} network request(s)` +
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
