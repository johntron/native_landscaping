import {
  listSavedAreas,
  getSavedArea,
  createSavedArea,
  updateSavedArea,
  deleteSavedArea,
  exportSavedAreasJson,
} from '../../tools/savedAreas/savedAreasDb.js';
import { listEvents } from '../../tools/observationEventsDb.js';
import { setFeedState } from '../../tools/feedState/feedStateDb.js';
import { queryFeed } from '../../tools/feedState/feed.js';
import { pollSavedAreas } from '../../tools/feedState/pollAreas.js';
import { collectPayload } from '../http.js';

/**
 * The observation feed: saved monitoring areas and read/dismissed state
 * (hand-entered, so both live in data/app.db, ctx.db.app, which cannot be
 * rebuilt), the raw event log, the paged feed, and the on-demand poll.
 *
 * Returns true when it handled the request (a response has been sent), false
 * to let server.js try the next route module. `user` is ctx.user
 * (server/identity.js), or null.
 */
export async function handleFeedRoutes(req, res, { url, pathname, db, user }) {
  // Saved monitoring areas (nl-1qy.1.2) — arbitrary center+radius areas for the
  // observation feed, independent of any yard project, so these live behind
  // their own SQLite-backed CRUD routes rather than a per-project file.
  const savedAreaMatch = pathname.match(/^\/api\/saved-areas(?:\/([^/]+))?$/);
  if (savedAreaMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    const areaId = savedAreaMatch[1] ? decodeURIComponent(savedAreaMatch[1]) : null;
    try {
      const savedAreasDb = db.app;
      if (req.method === 'GET' && !areaId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ areas: listSavedAreas(savedAreasDb) }));
        return true;
      }
      if (req.method === 'GET' && areaId) {
        const area = getSavedArea(savedAreasDb, areaId);
        if (!area) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No saved area with id "${areaId}"` }));
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ area }));
        return true;
      }
      if (req.method === 'POST' && !areaId) {
        const body = await collectPayload(req, { requirePlants: false });
        // owner_id records who created it; nothing is scoped by it yet (nl-3s5.5).
        const area = createSavedArea(savedAreasDb, body, { ownerId: user?.id ?? null });
        exportSavedAreasJson(savedAreasDb);
        console.log(`Saved area '${area.id}' created ('${area.name}')`);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ area }));
        return true;
      }
      if (req.method === 'PUT' && areaId) {
        const body = await collectPayload(req, { requirePlants: false });
        const area = updateSavedArea(savedAreasDb, areaId, body);
        exportSavedAreasJson(savedAreasDb);
        console.log(`Saved area '${area.id}' updated`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ area }));
        return true;
      }
      if (req.method === 'DELETE' && areaId) {
        const deleted = deleteSavedArea(savedAreasDb, areaId);
        if (!deleted) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No saved area with id "${areaId}"` }));
          return true;
        }
        exportSavedAreasJson(savedAreasDb);
        console.log(`Saved area '${areaId}' deleted`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: areaId, deleted: true }));
        return true;
      }
      // POST with an id, PUT/DELETE without one, etc. — no route matches this
      // method+id combination.
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Method ${req.method} not allowed on ${pathname}` }));
    } catch (err) {
      console.error(err);
      const notFound = /^No saved area with id/.test(err.message);
      res.writeHead(notFound ? 404 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Read-only window onto the observation event log (nl-1qy.1.1) populated
  // offline by tools/fetch-observation-events.mjs. Deliberately thin: no
  // read/unread state (nl-1qy.1.3) and no saved-area CRUD (nl-1qy.1.2, being
  // built in parallel) — this just makes the event log reachable over HTTP
  // so those later routes, and any earlier manual checking, have something
  // to build on rather than the data being CLI/SQLite-only.
  if (pathname === '/api/observation-events' && req.method === 'GET') {
    try {
      const areaId = url.searchParams.get('area_id');
      if (!areaId) {
        throw new Error('Missing required area_id query param');
      }
      const taxonIdParam = url.searchParams.get('taxon_id');
      const rows = listEvents(db.observationEvents, {
        areaId,
        taxonId: taxonIdParam != null ? Number(taxonIdParam) : undefined,
        sinceObservedOn: url.searchParams.get('since_observed_on') || undefined,
        sinceIngestedAt: url.searchParams.get('since_ingested_at') || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ area_id: areaId, rows }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Paginated, filterable observation feed joined with per-item read/dismissed
  // state (nl-1qy.1.3) — what nl-1qy.1.4's feed UI reads from. Built on top of
  // the same event log as /api/observation-events above, but that route stays
  // as the thin raw-log window; this one adds the read-state join and paging
  // the UI actually needs.
  if (pathname === '/api/feed' && req.method === 'GET') {
    try {
      const areaId = url.searchParams.get('area_id');
      if (!areaId) {
        throw new Error('Missing required area_id query param');
      }
      const taxonIdParam = url.searchParams.get('taxon_id');
      const pageParam = url.searchParams.get('page');
      const pageSizeParam = url.searchParams.get('page_size');
      const lane = url.searchParams.get('lane') || undefined;
      // The yard-relevance lane (nl-1qy.2) classifies against the saved
      // area's own ecoregion, not a project's — saved areas have no project
      // link (see savedAreasDb.js) — so it's looked up here rather than
      // threaded through as a query param the client could spoof or omit.
      let ecoregion;
      let place;
      if (lane === 'yard-relevance') {
        const area = getSavedArea(db.app, areaId);
        ecoregion = area?.filters?.ecoregion;
      } else if (lane === 'rarity') {
        // Same "look it up server-side" reasoning as ecoregion above — place
        // is a per-saved-area fact (filters.place), not something the client
        // should be trusted to pass directly.
        const area = getSavedArea(db.app, areaId);
        place = area?.filters?.place;
      }
      const rarityThresholdParam = url.searchParams.get('rarity_threshold');
      const rarityIncludeConservationStatus = url.searchParams.get('rarity_conservation_status') === 'true';
      const rarityIncludeProtectedSpecies = url.searchParams.get('rarity_protected_species') === 'true';
      const result = queryFeed(db.observationEvents, db.app, {
        areaId,
        taxonId: taxonIdParam != null ? Number(taxonIdParam) : undefined,
        sinceObservedOn: url.searchParams.get('since_observed_on') || undefined,
        sinceIngestedAt: url.searchParams.get('since_ingested_at') || undefined,
        unreadOnly: url.searchParams.get('unread_only') === 'true',
        includeDismissed: url.searchParams.get('include_dismissed') === 'true',
        page: pageParam != null ? Number(pageParam) : undefined,
        pageSize: pageSizeParam != null ? Number(pageSizeParam) : undefined,
        lane,
        ecoregion,
        place,
        ecosystemDb: db.ecosystem,
        rarityThreshold: rarityThresholdParam != null ? Number(rarityThresholdParam) : undefined,
        rarityIncludeConservationStatus,
        rarityIncludeProtectedSpecies,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Manual "Refresh now" (nl-1qy follow-up): polls ONE saved area against
  // iNaturalist synchronously and returns before responding, rather than
  // just re-querying the local event log like /api/feed does. Reuses the
  // same in-process pollArea the feed-poller service loop calls (see
  // tools/feedState/pollAreas.js) — never --backfill, and a page cap well
  // under fetch-observation-events.mjs's own default so a button click
  // resolves quickly rather than potentially crawling a well-established
  // area's full incremental backlog in one request.
  if (pathname === '/api/feed/refresh' && req.method === 'POST') {
    try {
      const body = await collectPayload(req, { requirePlants: false });
      const { areaId } = body;
      if (!areaId) {
        throw new Error('Body requires "areaId"');
      }
      const { results } = await pollSavedAreas({
        areaIds: [areaId],
        maxPages: 3,
        appDb: db.app,
        eventsDb: db.observationEvents,
      });
      if (!results.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `No saved area with id "${areaId}"` }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: results[0] }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // Mark one observation's read and/or dismissed state within one area.
  // Body: { areaId, observationId, read?, dismissed? } — only the flags
  // present are changed (see setFeedState's PATCH semantics).
  if (pathname === '/api/feed/state' && req.method === 'POST') {
    try {
      const body = await collectPayload(req, { requirePlants: false });
      const { areaId, observationId } = body;
      if (!areaId || observationId == null) {
        throw new Error('Body requires "areaId" and "observationId"');
      }
      const state = setFeedState(db.app, observationId, areaId, {
        read: body.read,
        dismissed: body.dismissed,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}
