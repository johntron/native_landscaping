#!/usr/bin/env node
/**
 * Incrementally fetch individual iNaturalist observations for one or more
 * "saved areas" into an event log (data/observation-events.db), sibling to
 * tools/fetch-ecosystem-index.mjs but fundamentally different in kind: that
 * script hits /observations/species_counts and REPLACES a per-place species
 * presence snapshot on every run; this one hits /observations (individual
 * records, not aggregated counts) and only ever ADDS rows, using
 * `id_above` so a re-run asks iNaturalist for nothing it already has.
 *
 * nl-1qy.1 (the parent epic) stages a thin vertical slice first: any area,
 * any taxon, all-new-observations — no taxon/invasive/rarity filtering here.
 * That logic (nl-1qy.2/.3/.4) reads this event log later; this script's only
 * job is turning "an area" into "the observations recorded near it since we
 * last looked."
 *
 * Saved-area config (nl-1qy.1.2) is being built in parallel and isn't
 * available yet, so areas come from a flat JSON file of
 * { id, name, lat, lng, radius_mi } objects — the same shape nl-1qy.1.2's own
 * bead describes for its saved_areas store, so wiring this script to read
 * from that store later should just mean swapping where AREAS come from, not
 * changing their shape.
 *
 * Cold start: `order=asc&id_above=0` walks forward from an area's OLDEST
 * research-grade observation, which for a well-established area can be
 * 15+ years and thousands of pages in the past — the opposite of what an
 * event FEED wants (new since last checked). So the first-ever poll for an
 * area does one extra `order=desc&per_page=1` request to read the current
 * highest observation_id and seeds the cursor there instead of at 0, meaning
 * a fresh area's first poll starts from "now" and only real new observations
 * from that point on ever show up. Pass --backfill to opt out and actually
 * walk the full history from id_above=0 (e.g. to deliberately pre-populate a
 * new area's log with everything that already exists).
 *
 * The poll cursor (how far an area has been checked) is stored in its own
 * area_cursor table, NOT derived from MAX(observation_id) in the event log:
 * a poll that finds zero new observations — the common case for a small area
 * polled frequently — would otherwise leave nothing to derive a cursor from,
 * and the next poll would re-seed "now" all over again, silently losing
 * whatever was observed in between. See observationEventsDb.js.
 *
 * Usage:
 *   node tools/fetch-observation-events.mjs --areas-file path/to/areas.json
 *   node tools/fetch-observation-events.mjs --areas-file areas.json --smoke --backfill   # one page of real history, print instead of writing, cursor untouched
 *   node tools/fetch-observation-events.mjs --areas-file areas.json --smoke   # cold-start seed only (prints 0 rows on a fresh area — see "Cold start" below)
 *   node tools/fetch-observation-events.mjs --areas-file areas.json --force   # bypass the response cache
 *   node tools/fetch-observation-events.mjs --areas-file areas.json --max-pages 1   # bound a run (e.g. for verification)
 *   node tools/fetch-observation-events.mjs --areas-file areas.json --backfill   # walk full history from id_above=0
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  openObservationEventsDb,
  upsertEvents,
  getAreaCursor,
  setAreaCursor,
  countEvents,
} from './observationEventsDb.js';
import { openProbeCache, cached } from './usda-plants/probeCache.js';
import {
  MI_TO_KM,
  USER_AGENT,
  fetchEstablishmentMeans,
  fetchWithBackoff,
  resolvePlaceId,
  sleep,
} from './inatShared.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** iNaturalist's documented per-request ceiling; also the largest page this script ever asks for. */
const PER_PAGE = 200;

// Same ~1.5s-between-real-requests convention as fetch-ecosystem-index.mjs —
// comfortably under iNaturalist's ~1 req/sec guidance without riding the
// ceiling exactly. Only real network calls pay this; a cache replay is a disk read.
const REQUEST_DELAY_MS = 1500;

// A single area's first-ever backfill (id_above=0, i.e. "everything") could
// in principle be huge for a long-established, heavily-observed area. Cap
// pages per area per run so one area can't starve the others or turn a
// routine poll into an hours-long crawl; a capped run just picks up the
// remainder on the next poll, since the cursor resumes from the last id
// actually reached, not from what was written.
const MAX_PAGES_PER_AREA = 25;

/**
 * The rate-limited, cached iNaturalist JSON fetcher every call in this
 * module goes through. Factored out so a caller that isn't this file's own
 * CLI — the scheduler service, the feed page's "Refresh now" button — can
 * poll areas in-process without re-deriving this plumbing.
 */
export function createFetchJson(probeCache, { force = false } = {}) {
  return async function fetchJson(endpoint, url) {
    const { raw, cached: fromCache } = await cached(
      probeCache,
      'inaturalist',
      endpoint,
      url.toString(),
      async () => {
        const response = await fetchWithBackoff(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
      { force }
    );
    if (!fromCache) await sleep(REQUEST_DELAY_MS);
    return raw;
  };
}

/**
 * Poll one area and (unless `smoke`) write whatever's new to `db`. This is
 * the per-area body `main()` below loops over; factored out so the scheduler
 * service and the manual "Refresh now" route can poll a single saved area
 * without going through the CLI's argv/file plumbing. Logs exactly what the
 * CLI always has, and also returns a plain summary for a caller that wants
 * the count without scraping stdout.
 * @returns {Promise<{areaId: string, fetched: number, written: number}>}
 */
export async function pollArea({ area, db, fetchJson, smoke = false, backfill = false, maxPages = MAX_PAGES_PER_AREA }) {
  console.log(`\n[${area.name || area.id}] lat=${area.lat}, lng=${area.lng}, radius_mi=${area.radius_mi}`);

  const placeId = await resolvePlaceId(area.lat, area.lng, { fetchJson });
  if (placeId) {
    console.log(`  establishment_means will be checked against place_id=${placeId}`);
  } else {
    console.warn('  no state/country place_id resolved — establishment_means left blank for every row.');
  }

  const priorCursor = smoke ? null : getAreaCursor(db, area.id);
  let idAbove = priorCursor ?? 0;
  let coldStartSeeded = false;
  if (priorCursor == null && !backfill) {
    const currentMaxId = await fetchCurrentMaxObservationId({ area, fetchJson });
    if (currentMaxId != null) {
      idAbove = currentMaxId;
      coldStartSeeded = true;
    }
  }
  console.log(
    `  polling from id_above=${idAbove}` +
      (coldStartSeeded
        ? ' (cold start: seeded at the current max id — pass --backfill to walk full history instead)'
        : priorCursor == null
          ? ' (backfill: walking full history from 0)'
          : '')
  );

  const { entries, nextCursor } = await fetchAreaObservations({
    area,
    idAbove,
    fetchJson,
    maxPages: smoke ? 1 : maxPages,
    perPage: PER_PAGE,
  });
  console.log(`  fetched ${entries.length} new observation(s)`);

  if (entries.length && placeId) {
    const meansById = await fetchEstablishmentMeans(
      entries.map((e) => e.taxon_id),
      placeId,
      { fetchJson }
    );
    entries.forEach((e) => {
      e.establishment_means = meansById.get(e.taxon_id) || null;
    });
  }

  if (smoke) {
    console.log(`  --smoke: NOT writing to data/observation-events.db, cursor untouched`);
    entries.slice(0, 10).forEach((r) => {
      console.log(`    #${r.observation_id} ${r.taxon_name} (${r.common_name}) observed_on=${r.observed_on} quality=${r.quality_grade}`);
    });
    return { areaId: area.id, fetched: entries.length, written: 0 };
  }

  if (entries.length) {
    const ingestedAt = new Date().toISOString();
    const rows = entries.map((e) => ({ ...e, area_id: area.id, ingested_at: ingestedAt }));
    upsertEvents(db, rows);
    console.log(`  wrote ${rows.length} row(s); area now has ${countEvents(db, area.id)} total`);
  }
  // Persisted even when nothing new was found: "checked up through id X,
  // nothing there" still has to move the cursor, or the next poll re-checks
  // (and, on a cold-started area, re-seeds) the same ground forever.
  setAreaCursor(db, area.id, nextCursor);
  return { areaId: area.id, fetched: entries.length, written: entries.length };
}

async function main() {
  const args = process.argv.slice(2);
  const areasFile = argAfter(args, '--areas-file');
  const smoke = args.includes('--smoke');
  const force = args.includes('--force');
  const backfill = args.includes('--backfill');
  const maxPagesArg = argAfter(args, '--max-pages');
  const maxPages = maxPagesArg ? Number(maxPagesArg) : MAX_PAGES_PER_AREA;
  if (!areasFile) {
    console.error(
      'Usage: node tools/fetch-observation-events.mjs --areas-file <path.json> ' +
        '[--smoke] [--force] [--backfill] [--max-pages N]\n' +
        '  areas.json: [{ "id": "...", "name": "...", "lat": 0, "lng": 0, "radius_mi": 0 }, ...]'
    );
    process.exit(1);
  }

  const areas = loadAreas(areasFile);
  if (!areas.length) {
    console.error(`${areasFile} declares no areas.`);
    process.exit(1);
  }

  const probeCache = openProbeCache();
  const fetchJson = createFetchJson(probeCache, { force });
  const db = smoke ? null : openObservationEventsDb();

  for (const area of areas) {
    await pollArea({ area, db, fetchJson, smoke, backfill, maxPages });
  }
}

function loadAreas(path) {
  const absolute = path.startsWith('/') ? path : `${ROOT}${path}`;
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((a) => ({
    id: String(a.id),
    name: a.name || String(a.id),
    lat: Number(a.lat),
    lng: Number(a.lng),
    radius_mi: Number(a.radius_mi),
  }));
}

function baseObservationsUrl(area) {
  const url = new URL('https://api.inaturalist.org/v1/observations');
  url.searchParams.set('lat', String(area.lat));
  url.searchParams.set('lng', String(area.lng));
  url.searchParams.set('radius', (area.radius_mi * MI_TO_KM).toFixed(3));
  // Same captive/quality/geoprivacy filters as fetch-ecosystem-index.mjs's
  // species_counts calls, for the same reason: exclude pet-store/cultivated
  // records, anything not vetted to species, and both geoprivacy-obscuring
  // mechanisms (see that script's comment for the empirical detail on why
  // both taxon_geoprivacy=open AND geoprivacy=open are needed — neither
  // alone catches everything the other does).
  url.searchParams.set('captive', 'false');
  url.searchParams.set('quality_grade', 'research');
  url.searchParams.set('taxon_geoprivacy', 'open');
  url.searchParams.set('geoprivacy', 'open');
  return url;
}

/** One request: the current highest observation_id matching an area's filters, or null if it has none. Used only to seed a fresh area's cursor at "now" instead of "the beginning of time" — see the header comment. */
export async function fetchCurrentMaxObservationId({ area, fetchJson }) {
  const url = baseObservationsUrl(area);
  url.searchParams.set('order_by', 'id');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', '1');
  const body = await fetchJson('observations', url);
  return body.results?.[0]?.id ?? null;
}

/**
 * Page through /v1/observations for one area starting at id_above, ascending
 * by id (order_by=id&order=asc — the documented pattern for id_above-based
 * pagination), stopping when a page comes back short of perPage (no more
 * results) or maxPages is hit.
 *
 * Returns both the fetched entries AND nextCursor — the highest id actually
 * reached, whether or not that page was full — so the caller can persist the
 * cursor even on a page that returned zero or partial results.
 */
export async function fetchAreaObservations({ area, idAbove, fetchJson, maxPages = MAX_PAGES_PER_AREA, perPage = PER_PAGE }) {
  const entries = [];
  let cursor = idAbove;
  for (let page = 0; page < maxPages; page += 1) {
    const url = baseObservationsUrl(area);
    url.searchParams.set('id_above', String(cursor));
    url.searchParams.set('order_by', 'id');
    url.searchParams.set('order', 'asc');
    url.searchParams.set('per_page', String(perPage));

    const body = await fetchJson('observations', url);
    const results = body.results || [];
    results.forEach((entry) => entries.push(mapObservationEntry(entry)));
    if (results.length) cursor = results[results.length - 1].id;

    if (results.length < perPage) break; // fewer than a full page: no more to page through
    if (page + 1 >= maxPages) {
      console.warn(`  hit ${maxPages}-page cap for this area — remainder will be picked up on the next poll (cursor resumes from id ${cursor}).`);
    }
  }
  return { entries, nextCursor: cursor };
}

/** Raw /v1/observations result -> the flat shape observationEventsDb.upsertEvents expects. */
export function mapObservationEntry(entry) {
  return {
    observation_id: entry.id,
    taxon_id: entry.taxon?.id ?? null,
    taxon_name: entry.taxon?.name || '',
    common_name: entry.taxon?.preferred_common_name || '',
    iconic_taxon: entry.taxon?.iconic_taxon_name || '',
    observed_on: entry.observed_on || null,
    lat: entry.geojson?.coordinates?.[1] ?? (entry.location ? Number(String(entry.location).split(',')[0]) : null),
    lng: entry.geojson?.coordinates?.[0] ?? (entry.location ? Number(String(entry.location).split(',')[1]) : null),
    quality_grade: entry.quality_grade || '',
    // Only hotlink photos under an actual open license — same reasoning as
    // fetch-ecosystem-index.mjs's photo_url (license_code null means "all
    // rights reserved", so those are left out rather than displayed anyway).
    photo_url: entry.taxon?.default_photo?.license_code ? entry.taxon.default_photo.square_url || '' : '',
    photo_attribution: entry.taxon?.default_photo?.license_code ? entry.taxon.default_photo.attribution || '' : '',
    url: entry.uri || (entry.id ? `https://www.inaturalist.org/observations/${entry.id}` : ''),
  };
}

function argAfter(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
