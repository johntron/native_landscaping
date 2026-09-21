// Joins the observation event log (tools/observationEventsDb.js) with
// per-observation read/dismissed state (tools/feedState/feedStateDb.js) into
// the paginated feed GET /api/feed serves (nl-1qy.1.3). Kept out of
// server.js so the route handler stays a thin HTTP adapter over this.
//
// The join happens in JS rather than SQL across the two SQLite files
// (ATTACH DATABASE) because the two stores are independently sized: an
// area's event log can run to thousands of rows, but its feed_state table
// only ever holds rows for observations someone actually touched (see
// feedStateDb.js) — building a Map from the small side and looking up
// against the larger list, once, is simpler than a cross-database SQL join
// and just as cheap at this scale.
import { listEvents } from '../observationEventsDb.js';
import { listFeedStates } from './feedStateDb.js';
import { classifyYardRelevance } from '../../src/analysis/yardRelevance.js';
import { loadYardRelevanceTables } from './yardRelevanceTables.js';
import { classifyInvasive } from '../../src/analysis/invasiveWatchlist.js';
import { loadInvasiveWatchlist } from './invasiveWatchlistTable.js';
import { classifyRarity } from '../../src/analysis/rarity.js';
import { loadRarityTables } from './rarityTables.js';

/** Earliest observed_on already logged for this area, per taxon_id — the fact backing "first seen here" on an invasive-monitor item. Built once per request from the area's full (unfiltered) event log, not per matched row. */
function firstObservedOnByTaxon(eventsDb, areaId) {
  const byTaxon = new Map();
  for (const event of listEvents(eventsDb, { areaId })) {
    if (event.taxon_id == null || !event.observed_on) continue;
    const current = byTaxon.get(event.taxon_id);
    if (!current || event.observed_on < current) byTaxon.set(event.taxon_id, event.observed_on);
  }
  return byTaxon;
}

/**
 * @param {object} eventsDb open handle from openObservationEventsDb
 * @param {object} feedStateDb open handle from openFeedStateDb
 * @param {object} options
 * @param {string} options.areaId required
 * @param {number} [options.taxonId]
 * @param {string} [options.sinceObservedOn]
 * @param {string} [options.sinceIngestedAt]
 * @param {boolean} [options.unreadOnly] when true, drop items already marked read
 * @param {boolean} [options.includeDismissed] when false (default), drop dismissed items
 * @param {number} [options.page] 1-based, default 1
 * @param {number} [options.pageSize] default 50
 * @param {string} [options.lane] 'yard-relevance' narrows to events classifyYardRelevance
 *   finds relevant (see src/analysis/yardRelevance.js); 'invasive-monitor' narrows to events
 *   matching ecology/invasive-watchlist.csv (see src/analysis/invasiveWatchlist.js), each
 *   tagged with whether this is the first time that taxon was logged in this area. Either way
 *   `.relevance` is attached to each surviving item; omitted/other values return the plain
 *   all-observations feed.
 * @param {string} [options.ecoregion] required when lane is 'yard-relevance' — the saved
 *   area's `filters.ecoregion`. Missing/unmatched ecoregion returns zero items plus `warning`
 *   rather than throwing, matching computePlantMatches' "report, don't guess" bail-out.
 * @param {string} [options.place] required when lane is 'rarity' — the saved area's
 *   `filters.place`, matched against data/ecosystem.db's species_observations.place. Missing
 *   place, or no local index for it, returns zero items plus `warning` the same way.
 * @param {number} [options.rarityThreshold] when lane is 'rarity', drop events whose local
 *   observation_count exceeds this; omitted, every event with a known local count is surfaced
 *   (a facet, not an invented cutoff — see src/analysis/rarity.js).
 * @param {string} [options.ecosystemDbPath] test-only override for which data/ecosystem.db
 *   file the 'rarity' lane reads (see tools/feedState/rarityTables.js).
 */
export function queryFeed(eventsDb, feedStateDb, options) {
  const {
    areaId,
    taxonId,
    sinceObservedOn,
    sinceIngestedAt,
    unreadOnly = false,
    includeDismissed = false,
    lane,
  } = options;
  if (!areaId) {
    throw new Error('"areaId" is required');
  }
  const page = Number.isFinite(options.page) && options.page > 0 ? Math.floor(options.page) : 1;
  const pageSize = Number.isFinite(options.pageSize) && options.pageSize > 0 ? Math.floor(options.pageSize) : 50;

  let events = listEvents(eventsDb, { areaId, taxonId, sinceObservedOn, sinceIngestedAt });
  const states = listFeedStates(feedStateDb, areaId);

  let warning;
  if (lane === 'yard-relevance') {
    const tables = loadYardRelevanceTables({ ecoregion: options.ecoregion });
    if (!tables.ok) {
      warning = tables.reason;
      events = [];
    } else {
      // Classify (and drop non-matches) BEFORE pagination — otherwise page 2
      // would slice a different candidate set than page 1's classification
      // implied, since listEvents returns the whole area unpaginated.
      events = events
        .map((event) => ({ event, relevance: classifyYardRelevance(event, tables) }))
        .filter((row) => row.relevance)
        .map(({ event, relevance }) => ({ ...event, relevance }));
    }
  } else if (lane === 'invasive-monitor') {
    const watchlist = loadInvasiveWatchlist();
    if (!watchlist.size) {
      warning = 'No invasive watchlist configured (ecology/invasive-watchlist.csv is missing or empty).';
      events = [];
    } else {
      const firstSeen = firstObservedOnByTaxon(eventsDb, areaId);
      events = events
        .map((event) => ({ event, relevance: classifyInvasive(event, { watchlist }) }))
        .filter((row) => row.relevance)
        .map(({ event, relevance }) => {
          const firstObservedOn = firstSeen.get(event.taxon_id) ?? null;
          return { ...event, relevance: { ...relevance, firstObservedOn, firstSeenHere: firstObservedOn === event.observed_on } };
        });
    }
  } else if (lane === 'rarity') {
    // ecosystemDbPath is test-only — see rarityTables.js's dbPath override.
    const tables = loadRarityTables({ place: options.place, dbPath: options.ecosystemDbPath });
    if (!tables.ok) {
      warning = tables.reason;
      events = [];
    } else {
      events = events
        .map((event) => ({
          event,
          relevance: classifyRarity(event, {
            speciesObservations: tables.speciesObservations,
            maxObservationCount: options.rarityThreshold,
          }),
        }))
        .filter((row) => row.relevance)
        .map(({ event, relevance }) => ({ ...event, relevance }));
    }
  }

  const joined = events
    .map((event) => {
      const state = states.get(event.observation_id) || { read: false, dismissed: false, updatedAt: null };
      return { ...event, read: state.read, dismissed: state.dismissed, stateUpdatedAt: state.updatedAt };
    })
    .filter((item) => (includeDismissed ? true : !item.dismissed))
    .filter((item) => (unreadOnly ? !item.read : true));

  const total = joined.length;
  const start = (page - 1) * pageSize;
  const items = joined.slice(start, start + pageSize);

  return { areaId, page, pageSize, total, items, ...(warning ? { warning } : {}) };
}
