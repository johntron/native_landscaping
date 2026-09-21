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
 */
export function queryFeed(eventsDb, feedStateDb, options) {
  const { areaId, taxonId, sinceObservedOn, sinceIngestedAt, unreadOnly = false, includeDismissed = false } = options;
  if (!areaId) {
    throw new Error('"areaId" is required');
  }
  const page = Number.isFinite(options.page) && options.page > 0 ? Math.floor(options.page) : 1;
  const pageSize = Number.isFinite(options.pageSize) && options.pageSize > 0 ? Math.floor(options.pageSize) : 50;

  const events = listEvents(eventsDb, { areaId, taxonId, sinceObservedOn, sinceIngestedAt });
  const states = listFeedStates(feedStateDb, areaId);

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

  return { areaId, page, pageSize, total, items };
}
