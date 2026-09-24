#!/usr/bin/env node
/**
 * Fetch candidate green-space anchors (parks, nature reserves, cemeteries,
 * forest, golf courses) near a project's site from OpenStreetMap via
 * Overpass, and merge the result into ecology/anchors.csv keyed by `place`
 * (nl-3hi.7.2, stage 2 of the anchor-data epic nl-3hi.7).
 *
 * Same offline-fetch/checked-in-CSV pattern as fetch-nearby-fauna.mjs and
 * fetch-nhd-creeks.mjs. Coordinates never reach the CSV or git — see
 * the yard's location in app.db (tools/projectSite.mjs).
 *
 * OSM's leisure/landuse tags are ADMINISTRATIVE, not ecological (a live test
 * against Dallas returned "Texas State Fair Grounds" and "Old East Dallas
 * Work Yard" as leisure=park). Every row this tool writes gets
 * status=candidate, never status=anchor — nl-3hi.7.5 is what promotes a
 * candidate once a human confirms it, this tool never does.
 *
 * Usage:
 *   node tools/fetch-osm-greenspace.mjs --project backyard
 *   node tools/fetch-osm-greenspace.mjs --project backyard --smoke
 */
import { readProjectSite, ownerFromArgs } from './projectSite.mjs';
import { openProbeCache, cached } from './usda-plants/probeCache.js';
import { USER_AGENT, fetchWithBackoff } from './inatShared.mjs';
import { pointToPolylineMi, ringAreaAcres, roundDistanceMi } from './geoShared.mjs';
import { ANCHORS_CSV, mergeAnchorRows } from './anchorsShared.mjs';


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
 * reading this table to promote real anchors — a Dallas-density 5mi pull
 * returns 100+ named parks/cemeteries, which is a data dump, not a
 * reviewable candidate list. Another judgment call, not a fact.
 */
const MAX_CANDIDATES = 15;

async function main() {
  const args = process.argv.slice(2);
  const projectId = argAfter(args, '--project');
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  if (!projectId) {
    console.error('Usage: node tools/fetch-osm-greenspace.mjs --project <id> [--owner <email>] [--smoke] [--force]');
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
  const query = buildQuery(lat, lng);
  const { raw: body } = await cached(
    probeCache,
    'overpass',
    'greenspace-query',
    cacheKey,
    async () => {
      const response = await fetchWithBackoff(OVERPASS_URL, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'text/plain' },
        body: query,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    },
    { force }
  );

  const candidates = extractCandidates(body, lat, lng);

  if (smoke) {
    console.log(
      `\n--smoke run: ${candidates.length} candidates >= ${MIN_ACRES} acre(s) within ${SEARCH_RADIUS_MI}mi, NOT writing ${ANCHORS_CSV}\n`
    );
    console.table(candidates.map((c) => ({ ...c, acres: Math.round(c.acres) })));
    return;
  }

  const newRows = candidates.map((c) => ({
    place,
    kind: c.tag.split('=')[1],
    name: c.name,
    status: 'candidate', // OSM tags are administrative, never promoted to "anchor" by this tool (nl-3hi.7.2).
    distance_mi: roundDistanceMi(c.distanceMi),
    detail: `${c.tag}, ~${Math.round(c.acres)} acres`,
    fetched_on: new Date().toISOString().slice(0, 10),
    source: 'OpenStreetMap via Overpass (overpass-api.de)',
  }));

  for (const [, tag] of TAGS) {
    const kind = tag;
    mergeAnchorRows(
      place,
      kind,
      newRows.filter((row) => row.kind === kind)
    );
  }
  console.log(`Wrote ${newRows.length} candidate row(s) for "${place}" to ${ANCHORS_CSV}`);
}

function buildQuery(lat, lng) {
  const clauses = TAGS.map(
    ([key, value]) => `  way["${key}"="${value}"](around:${SEARCH_RADIUS_M},${lat},${lng});`
  ).join('\n');
  return `[out:json][timeout:55];\n(\n${clauses}\n);\nout geom;`;
}

/** Distance to the nearest point on each way's ring, and its area — not a centroid distance (nl-3hi.7.2). */
function extractCandidates(body, lat, lng) {
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
