// Shared entry point for polling saved areas in-process — used by both the
// scheduler service (tools/schedule-feed-poll.mjs) and the manual "Refresh
// now" button (POST /api/feed/refresh in server.js). Neither shells out to
// tools/fetch-observation-events.mjs; both call its exported pollArea
// directly, sourcing areas from the saved-areas store (the CLI's own
// --areas-file flag stays for one-off/backfill runs against an area not yet
// saved, or ad hoc lat/lng — see that script's header).
import { openObservationEventsDb } from '../observationEventsDb.js';
import { openSavedAreasDb, listSavedAreas, getSavedArea } from '../savedAreas/savedAreasDb.js';
import { openProbeCache } from '../usda-plants/probeCache.js';
import { createFetchJson, pollArea } from '../fetch-observation-events.mjs';

/**
 * @param {object} [options]
 * @param {string[]} [options.areaIds] poll only these saved areas; omitted/empty polls every saved area
 * @param {boolean} [options.force] bypass the iNaturalist response cache
 * @param {number} [options.maxPages] passed through to pollArea
 * @returns {Promise<{results: Array<{areaId: string, fetched: number, written: number}>}>}
 */
export async function pollSavedAreas({ areaIds, force = false, maxPages } = {}) {
  const savedAreasDb = openSavedAreasDb();
  const areas = areaIds?.length
    ? areaIds.map((id) => getSavedArea(savedAreasDb, id)).filter(Boolean)
    : listSavedAreas(savedAreasDb);
  if (!areas.length) return { results: [] };

  const eventsDb = openObservationEventsDb();
  const probeCache = openProbeCache();
  const fetchJson = createFetchJson(probeCache, { force });

  const results = [];
  for (const area of areas) {
    const result = await pollArea({
      area: { id: area.id, name: area.name, lat: area.lat, lng: area.lng, radius_mi: area.radiusMi },
      db: eventsDb,
      fetchJson,
      // Never --backfill here: an unattended scheduler or a button click
      // walking a well-established area's full history from id_above=0 is
      // exactly the "hours-long crawl" pollArea's caller is meant to avoid.
      // A fresh area is cold-start-seeded at "now" instead (see
      // fetch-observation-events.mjs's header) — full history backfill
      // stays a deliberate, one-off CLI action.
      backfill: false,
      maxPages,
    });
    results.push(result);
  }
  return { results };
}
