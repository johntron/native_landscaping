import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  normalizeProjectConfig,
  serializeProjectConfig,
  isValidProjectId,
} from '../../src/data/projectConfig.js';
import { normalizeFeatures, serializeFeatures } from '../../src/data/featureConfig.js';
import { projectIdFromUrl, resolveProjectPhoto } from '../../src/data/projectPaths.js';
import { toPlacementEntry, toPlacements } from '../../src/data/placements.js';
import { buildLayoutCsv } from '../../src/data/layoutExporter.js';
import {
  MAX_UPLOAD_BYTES,
  imageTypeForContentType,
  resolveBackgroundTarget,
  sniffImageType,
} from '../../src/data/backgroundStore.js';
import {
  collectPayload,
  collectBinaryBody,
  createRateLimiter,
  enforceRateLimit,
  json,
  loadReadableProject,
  loadWritableProject,
  rateLimitKeyFor,
  requireUser,
} from '../http.js';
import { writeFileAtomic, removeSupersededBackgrounds, removeOrphanedBackgrounds } from '../files.js';
import { geocodeAddress } from '../../tools/geocode.mjs';
import { lookupEcoregion } from '../../tools/ecoregionLookup.mjs';
import { getCached } from '../../tools/usda-plants/probeCache.js';
import { indexStatus, locationKey } from '../../tools/ecosystemIndexDb.js';
import { coveredRegionVerdict } from '../../src/analysis/coveredRegion.js';
import { GEOCODE_SHARED_KEY, ecoregionLimiter, geocodeLimiter } from './ecosystem.js';
import { copyExampleToOwner } from '../db/exampleYard.js';
import {
  RESERVED_SLUGS,
  currentPlacements,
  findCallerProject,
  findExampleFor,
  findExampleProject,
  findOwnedProject,
  insertProject,
  moveHistoryCursor,
  parseLocation,
  projectDataDir,
  projectPickerFor,
  readRevisions,
  recordLayout,
  referencedBackgroundNames,
  saveProjectConfig,
  saveProjectFeatures,
  saveProjectLocation,
  setProjectLocation,
  withTransaction,
} from '../db/projectStore.js';
import {
  fitsQuota,
  photoDirSizeBytes,
  photoQuotaBytes,
  photoUsageBytes,
  quotaExceededBody,
} from '../db/photoQuota.js';

const PHOTO_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// POST /api/projects/copy-example writes a yard and copies its photos, so it
// is throttled per caller. Judgement call, not a measured limit: 5 copies in
// a burst, then one a minute, is far more than a person starting a yard needs
// and bounds a script looping on it to a few hundred KB a minute.
export const copyExampleLimiter = createRateLimiter({ capacity: 5, refillPerSecond: 1 / 60 });

/**
 * The location each caller last looked up for each of their yards (nl-3s5.30),
 * keyed `${userId}:${projectId}`: a save must repeat the caller's OWN pending
 * preview. Checking the probe cache alone would not do: it is server-wide, so
 * a save that succeeded for any cached text would tell one user whether
 * anyone else had looked that address up. In memory only; a restart just
 * means looking up again.
 */
export const pendingLocationPreviews = new Map();
/** Judgement: long enough to read the match and decide, short enough not to linger. */
export const LOCATION_PREVIEW_TTL_MS = 15 * 60 * 1000;

function prunePendingPreviews(pending, now = Date.now()) {
  for (const [key, entry] of pending) {
    if (now - entry.at > LOCATION_PREVIEW_TTL_MS) pending.delete(key);
  }
}

/**
 * Per-project persistence for the design tool, backed by app.db
 * (server/db/projectStore.js, nl-3s5.3): the caller's yard list, config,
 * layout, features, the one revision stream behind undo and redo, and the
 * yard's photos.
 *
 * Revisions (nl-3s5.20): POST /api/layout, POST /api/project and POST
 * /api/features each append one revision to the same stream, and POST
 * /api/history/cursor moves along it, restoring the planting, the setup and
 * the features of the revision it lands on. The payloads are the pre-5.20
 * ones plus fields (kind, config, features, revision), so a tab opened before
 * the deploy keeps working: every write it makes is a revision too, so it can
 * lose nothing; its undo indices can only be off after another tab or a
 * setup/features save added revisions it has not seen, which a reload fixes.
 *
 * Every route needs a signed-in caller, and every ?project=<slug> is resolved
 * among THAT caller's yards (server/http.js loadReadableProject / loadWritableProject): 401
 * when anonymous, the same 404 for a slug that does not exist and one that
 * belongs to someone else. Slugs are unique per owner, so there is no other
 * way to resolve one, with one exception (nl-3s5.24): ?project=example, when
 * the caller has no yard of that name, resolves to the shared example yard,
 * which every READ route serves to any signed-in user and every WRITE route
 * refuses with 403 (loadReadableProject / loadWritableProject). It has no
 * location to leak: the example's location_json is always NULL, and the
 * location routes answer it with null even if a row were edited by hand.
 *
 * Returns true when it handled the request (a response has been sent), false
 * to let server.js try the next route module.
 */
export async function handleProjectRoutes(req, res, ctx) {
  const { url, pathname } = ctx;
  const db = ctx.db.app;
  // Reads resolve the caller's own yard or the shared example (nl-3s5.24);
  // writes resolve the same way and then refuse the example with 403.
  const deps = { findProject: findCallerProject, findExample: findExampleFor };
  const readable = () => loadReadableProject(ctx, res, projectIdFromUrl(url), deps);
  const writable = () => loadWritableProject(ctx, res, projectIdFromUrl(url), deps);

  // The caller's yard picker (replaces the static projects/index.json): their
  // own yards, then the shared example marked readOnly (nl-3s5.24).
  if (pathname === '/api/projects' && req.method === 'GET') {
    const user = requireUser(ctx, res);
    if (!user) return true;
    json(res, 200, projectPickerFor(db, user.id));
    return true;
  }

  // Photo storage usage (nl-3s5.17): owner-scoped, so the Setup panel can
  // show "Photos: X of Y MB" without exposing anyone else's usage.
  if (pathname === '/api/me/storage' && req.method === 'GET') {
    const user = requireUser(ctx, res);
    if (!user) return true;
    const capBytes = photoQuotaBytes();
    const usedBytes = await photoUsageBytes(db, ctx.dataDir, user.id);
    json(res, 200, { usedBytes, capBytes });
    return true;
  }

  // "Copy to my yards" (nl-3s5.24): the example as a new private yard of the
  // caller's, with a fresh slug, one revision and its photos. The body is not
  // read: the source is always the example and the owner always the caller.
  if (pathname === '/api/projects/copy-example' && req.method === 'POST') {
    const user = requireUser(ctx, res);
    if (!user) return true;
    // Sampled pruning, as server/routes/ecosystem.js does for its limiters.
    if (Math.random() < 0.01) copyExampleLimiter.prune();
    if (!enforceRateLimit(ctx.copyExampleLimiter || copyExampleLimiter, rateLimitKeyFor(ctx, req), res)) return true;
    req.resume();
    try {
      // The example's photos count against the caller's quota too, checked
      // before copying (copyExampleToOwner throws NO_EXAMPLE itself when
      // there is none, so skipping the check then is fine).
      const example = findExampleProject(db);
      if (example) {
        const incomingBytes = await photoDirSizeBytes(path.join(projectDataDir(ctx.dataDir, example.id), 'img'));
        const usedBytes = await photoUsageBytes(db, ctx.dataDir, user.id);
        const capBytes = photoQuotaBytes();
        if (!fitsQuota(usedBytes, incomingBytes, capBytes)) {
          json(res, 413, quotaExceededBody(usedBytes, incomingBytes, capBytes));
          return true;
        }
      }
      const { slug } = copyExampleToOwner(db, { dataDir: ctx.dataDir, ownerId: user.id });
      console.log(`Example yard copied to '${slug}' for user ${user.id}`);
      json(res, 200, { id: slug, index: projectPickerFor(db, user.id) });
    } catch (err) {
      if (err.code === 'NO_EXAMPLE') {
        json(res, 404, { error: err.message });
      } else {
        console.error(err);
        json(res, 500, { error: 'Could not copy the example yard' });
      }
    }
    return true;
  }

  if (pathname === '/api/projects' && req.method === 'POST') {
    const user = requireUser(ctx, res);
    if (!user) return true;
    try {
      const body = await collectPayload(req, { requirePlants: false });
      const id = String(body.id || '').trim();
      const name = String(body.name || '').trim() || id;
      if (!isValidProjectId(id)) {
        throw new Error(
          'Project id must start with a lowercase letter or digit, and contain only ' +
            'lowercase letters, digits, "-", or "_"'
        );
      }
      if (RESERVED_SLUGS.includes(id)) {
        throw new Error(`"${id}" is reserved for the shared example yard; choose another name`);
      }
      // No yardFt/views geometry supplied: normalizeProjectConfig fills in
      // the same defaults a hand-created project.json with just a plan view
      // would get, so a fresh project starts exactly where Setup mode's
      // fields already expect the yard to be before anyone has typed a number.
      const config = normalizeProjectConfig({ name, views: [{ id: 'plan', type: 'plan' }] }, id);
      const serialized = serializeProjectConfig(config);
      // Always the caller's own namespace (slugs are unique per owner), and
      // always 'private': a body's `visibility` is not read (nl-3s5.4).
      withTransaction(db, () => {
        if (findOwnedProject(db, user.id, id)) throw new Error(`Project "${id}" already exists`);
        insertProject(db, {
          ownerId: user.id,
          slug: id,
          name: config.name,
          configJson: `${JSON.stringify(serialized, null, 2)}\n`,
        });
      });
      console.log(`Project '${id}' created for user ${user.id}`);
      json(res, 200, { index: projectPickerFor(db, user.id), config: serialized });
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  // The config as it was saved; the client normalizes it, as it did the file.
  if (pathname === '/api/project' && req.method === 'GET') {
    const project = readable();
    if (!project) return true;
    try {
      json(res, 200, JSON.parse(project.configJson));
    } catch (err) {
      console.error(err);
      json(res, 500, { error: 'Stored project config does not parse' });
    }
    return true;
  }

  if (pathname === '/api/project' && req.method === 'POST') {
    const project = writable();
    if (!project) return true;
    try {
      const body = await collectPayload(req, { requirePlants: false });
      // The legacy {plan, elevations[]} reader exists for configs already
      // stored, not for request bodies: without this, a body missing views[]
      // migrates into one default blank plan view and silently overwrites the
      // project. There is no config history to recover from.
      if (!Array.isArray(body.views)) {
        throw new Error('Missing views[]');
      }
      // The id comes from the stored project, never from the body — a client
      // that names a different project must not be able to write to it.
      const config = normalizeProjectConfig({ ...body, id: undefined }, project.slug);
      const serialized = serializeProjectConfig(config);
      // The picker label is stored beside the config, in the same write, so
      // the two can no longer drift apart the way index.json and project.json
      // could. Every save is a setup revision (nl-3s5.20), even one that
      // changes nothing: the client decides whether to save at all, and the
      // two stacks stay one index apart only if each save it sends is one
      // revision here.
      const revision = saveProjectConfig(db, project.id, {
        name: config.name,
        configJson: `${JSON.stringify(serialized, null, 2)}\n`,
      });
      // Photos any revision names are kept: undo can bring that setup back.
      await removeOrphanedBackgrounds(
        projectDataDir(ctx.dataDir, project.id),
        referencedBackgroundNames(db, project.id)
      );
      console.log(
        `Project config saved for '${project.slug}' (${config.views.length} views, revision ${revision.cursor})`
      );
      json(res, 200, {
        config: serialized,
        index: projectPickerFor(db, project.ownerId),
        revision: { entry: revision.entry, cursor: revision.cursor },
      });
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const project = readable();
    if (!project) return true;
    json(res, 200, historyPayload(db, project.id));
    return true;
  }

  // The layout the yard shows now (the entry at the cursor), as the CSV that
  // used to be stored. An export only: nothing reads it back.
  if (pathname === '/api/layout' && req.method === 'GET') {
    const project = readable();
    if (!project) return true;
    try {
      const csv = buildLayoutCsv(currentPlacements(db, project.id));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${project.slug}-planting_layout.csv"`,
        'Cache-Control': 'no-store',
      });
      res.end(`${csv}\n`);
    } catch (err) {
      console.error(err);
      json(res, 500, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/layout' && req.method === 'POST') {
    const project = writable();
    if (!project) return true;
    try {
      // The body is read before the transaction starts: nothing awaits
      // between BEGIN and COMMIT (server/db/projectStore.js).
      const payload = await collectPayload(req);
      const entry = makeEntry(payload.plants, payload.description, payload.id);
      const result = recordLayout(db, project.id, entry, payload.previousPlants);
      console.log(`Layout saved for '${project.slug}' (history entries: ${result.count})`);
      json(res, 200, { entry: result.entry, cursor: result.cursor });
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/history/cursor' && req.method === 'POST') {
    const project = writable();
    if (!project) return true;
    try {
      const payload = await collectPayload(req, { requirePlants: false });
      const result = moveHistoryCursor(db, project.id, Number(payload.cursor));
      console.log(`Yard '${project.slug}' moved to revision '${result.entry.id}' (cursor ${result.cursor})`);
      json(res, 200, { entry: revisionPayload(result.entry, { config: true, features: true }), cursor: result.cursor });
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/features' && req.method === 'GET') {
    const project = readable();
    if (!project) return true;
    try {
      // A yard that has never drawn a feature has none stored, and that is
      // the normal case rather than an error: it reads as an empty yard model.
      const raw = project.featuresJson === null ? null : JSON.parse(project.featuresJson);
      json(res, 200, serializeFeatures(normalizeFeatures(raw, project.slug)));
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/features' && req.method === 'POST') {
    const project = writable();
    if (!project) return true;
    try {
      const body = await collectPayload(req, { requirePlants: false });
      // An absent features[] means "this body is not a feature list", not "no
      // features": accepting it would erase the whole yard model. History
      // would keep the old list (nl-3s5.20), but a body that is not a feature
      // list is a client bug to report, not a revision to record.
      if (!Array.isArray(body.features)) {
        throw new Error('Missing features[]');
      }
      const features = serializeFeatures(normalizeFeatures(body, project.slug));
      const revision = saveProjectFeatures(db, project.id, `${JSON.stringify(features, null, 2)}\n`);
      console.log(
        `Features saved for '${project.slug}' (${features.features.length} features, revision ${revision.cursor})`
      );
      json(res, 200, { ...features, revision: { entry: revision.entry, cursor: revision.cursor } });
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  // --- the yard's location (nl-3s5.30) -------------------------------------
  //
  // The owner sets it in Setup mode in two steps, so a wrong geocode match is
  // never saved silently: POST .../preview geocodes what they typed and shows
  // the match, then POST /api/project-location with the same text saves it.
  // Stored only in projects.location_json, in the CLI's shape
  // (setProjectLocation), never in the config or a revision. What goes back
  // to the browser is the owner's own, rounded (roundForOwner). Nothing here
  // logs the typed text, the match or a coordinate: the request log prints
  // the path alone, and the lines below print the slug and an outcome.

  // Whether the yard has a location, rounded, and whether it is inside the
  // region the data covers. The shared example answers null (it never has
  // one), like /api/ecosystem does. Not rate-limited: it reads only the
  // caller's own saved point, whose ecoregion the save already cached, so it
  // reaches the CEC service at most once per saved point.
  if (pathname === '/api/project-location' && req.method === 'GET') {
    const project = readable();
    if (!project) return true;
    const isExample = project.id === findExampleProject(db)?.id;
    const site = isExample ? null : parseLocation(project);
    if (!site) {
      json(res, 200, { location: null, region: null });
      return true;
    }
    if (!Number.isFinite(site.lat) || !Number.isFinite(site.lng)) {
      // An address-only location the operator set with the CLI: resolved to
      // coordinates when the index is built, so there is nothing to round yet.
      json(res, 200, { location: { set: true, lat: null, lng: null }, region: null });
      return true;
    }
    json(res, 200, { location: { set: true, ...roundForOwner(site) }, region: await regionFor(ctx, site) });
    return true;
  }

  // Step one: geocode the typed text and show the match. Writes nothing.
  // Draws from the same two Nominatim buckets as /api/geocode (per caller,
  // and one shared by the whole server), after the owner check so a 401, 403
  // or 404 never spends the shared token.
  const pendingPreviews = ctx.pendingLocationPreviews || pendingLocationPreviews;
  if (pathname.startsWith('/api/project-location') && Math.random() < 0.01) prunePendingPreviews(pendingPreviews);

  if (pathname === '/api/project-location/preview' && req.method === 'POST') {
    const project = writable();
    if (!project) {
      req.resume();
      return true;
    }
    const limiter = ctx.geocodeLimiter || geocodeLimiter;
    if (!enforceRateLimit(limiter, rateLimitKeyFor(ctx, req), res) || !enforceRateLimit(limiter, GEOCODE_SHARED_KEY, res)) {
      req.resume();
      return true;
    }
    let query;
    try {
      query = locationQuery(await collectPayload(req, { requirePlants: false }));
    } catch (err) {
      json(res, 400, { error: err.message });
      return true;
    }
    let match;
    try {
      match = await geocodeAddress(query, { probeCache: ctx.db.probeCache });
    } catch (err) {
      geocodeFailed(res, project, err);
      return true;
    }
    pendingPreviews.set(`${ctx.user.id}:${project.id}`, { query, at: Date.now() });
    console.log(`Location previewed for '${project.slug}'`);
    json(res, 200, {
      match: { displayName: match.displayName, ...roundForOwner(match) },
      region: await regionFor(ctx, match),
    });
    return true;
  }

  // Step two: save what the owner confirmed, or clear it with { clear: true }.
  // The body carries the same text again, never coordinates, and it must be
  // one the preview already geocoded: the save is a probe-cache read, so it
  // never reaches Nominatim and needs no Nominatim token, and a client cannot
  // skip the confirmation step. "Already geocoded" means by this caller, for
  // this yard (pendingLocationPreviews), not merely cached by anyone. Per-caller throttled on the ecoregion bucket,
  // since a save may make one CEC lookup (normally a cache hit too).
  if (pathname === '/api/project-location' && req.method === 'POST') {
    const project = writable();
    if (!project) {
      req.resume();
      return true;
    }
    if (!enforceRateLimit(ctx.ecoregionLimiter || ecoregionLimiter, rateLimitKeyFor(ctx, req), res)) {
      req.resume();
      return true;
    }
    let body;
    try {
      body = await collectPayload(req, { requirePlants: false });
    } catch (err) {
      json(res, 400, { error: err.message });
      return true;
    }
    const pendingKey = `${ctx.user.id}:${project.id}`;
    if (body.clear === true) {
      pendingPreviews.delete(pendingKey);
      saveProjectLocation(db, project.id, null);
      console.log(`Location cleared for '${project.slug}'`);
      json(res, 200, { location: null, region: null, index: { state: 'no-location' }, pollMinutes: pollMinutes() });
      return true;
    }
    let query;
    try {
      query = locationQuery(body);
    } catch (err) {
      json(res, 400, { error: err.message });
      return true;
    }
    // The caller's own pending preview of this exact text, and (so the save
    // is certain to be a cache read) its cached answer. One 409 for every
    // miss, so the answer says nothing about anyone else's lookups.
    const pending = pendingPreviews.get(pendingKey);
    const fresh = pending && pending.query === query && Date.now() - pending.at <= LOCATION_PREVIEW_TTL_MS;
    if (!fresh || !ctx.db.probeCache || !getCached(ctx.db.probeCache, 'nominatim', 'search', query)) {
      json(res, 409, { error: 'Look the address up first, check the match, then save it.' });
      return true;
    }
    let match;
    try {
      match = await geocodeAddress(query, { probeCache: ctx.db.probeCache });
    } catch (err) {
      geocodeFailed(res, project, err);
      return true;
    }
    let location;
    try {
      location = setProjectLocation(db, project.id, match);
    } catch (err) {
      console.warn(`Location not saved for '${project.slug}'`);
      json(res, 400, { error: err.message });
      return true;
    }
    pendingPreviews.delete(pendingKey);
    console.log(`Location saved for '${project.slug}'`);
    // Whatever the queue will make of it: 'queued' for a new or moved point,
    // the existing state when the same point was saved again.
    const { state } = indexStatus(ctx.db.ecosystem, project.id, locationKey(location));
    json(res, 200, {
      location: { set: true, ...roundForOwner(location) },
      region: await regionFor(ctx, location),
      index: { state },
      pollMinutes: pollMinutes(),
    });
    return true;
  }

  // A yard's photo, to its owner only (or, for the shared example alone, to
  // any signed-in user). Photos live under DATA_DIR, outside the served root,
  // so this is the only way to reach one.
  if (pathname === '/api/project-photo' && req.method === 'GET') {
    const project = readable();
    if (!project) return true;
    const target = resolveProjectPhoto(projectDataDir(ctx.dataDir, project.id), url.searchParams.get('path') || '');
    let body = null;
    if (target) {
      try {
        body = await fs.readFile(target);
      } catch {
        body = null;
      }
    }
    if (!body) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': PHOTO_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // An SVG opened directly would otherwise run any script inside it. The
      // shipped ones are ours and uploads can never be SVG, but a sandboxed
      // response costs nothing.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(body);
    return true;
  }

  if (pathname === '/api/view-background' && req.method === 'POST') {
    const project = writable();
    if (!project) {
      req.resume(); // drain the unread body so the 401/403/404 reaches the client
      return true;
    }
    try {
      const viewId = url.searchParams.get('view') || '';

      // Three independent checks, in cost order: the header the client
      // declared, the size as it arrives, and the bytes themselves. Only the
      // last one is trustworthy, but failing early on the first two keeps a
      // hostile client from making us buffer anything.
      const declared = imageTypeForContentType(req.headers['content-type']);
      if (!declared) {
        json(res, 415, { error: 'Background must be a WebP, JPEG, or PNG image' });
        req.destroy();
        return true;
      }

      const body = await collectBinaryBody(req, MAX_UPLOAD_BYTES);
      const sniffed = sniffImageType(body);
      if (!sniffed || sniffed.contentType !== declared.contentType) {
        throw new Error('Image bytes do not match the declared image type');
      }

      // Per-user total quota (nl-3s5.17), checked before anything is written.
      // usedBytes counts every photo already on disk for this owner, including
      // (for a re-upload of the same view) the file this upload is about to
      // supersede — so a replacement right at the cap can be refused even
      // though the old photo is about to be swept. That is the safe side of
      // the trade-off: checking after the sweep would mean deleting a photo
      // before knowing the replacement fits.
      const capBytes = photoQuotaBytes();
      const usedBytes = await photoUsageBytes(db, ctx.dataDir, project.ownerId);
      if (!fitsQuota(usedBytes, body.length, capBytes)) {
        const err = new Error('Photo storage limit reached');
        err.code = 'QUOTA_EXCEEDED';
        err.body = quotaExceededBody(usedBytes, body.length, capBytes);
        throw err;
      }

      const contentHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
      const { dir, file, relativePath } = resolveBackgroundTarget({
        projectDir: projectDataDir(ctx.dataDir, project.id),
        viewId,
        contentHash,
        ext: sniffed.ext,
      });

      await fs.mkdir(dir, { recursive: true });
      await writeFileAtomic(file, body);
      // Only uploads no revision names: the saved setup (and any older one
      // undo can reach) still shows the photo this one is replacing.
      await removeSupersededBackgrounds(dir, viewId, path.basename(file), referencedBackgroundNames(db, project.id));

      console.log(`Background saved for '${project.slug}' view '${viewId}' (${body.length} bytes)`);
      // The exact figure after the sweep above, not usedBytes + body.length:
      // a re-upload's superseded file is now gone, so the two can differ.
      const photoUsage = {
        usedBytes: await photoUsageBytes(db, ctx.dataDir, project.ownerId),
        capBytes,
      };
      json(res, 200, { background: relativePath, bytes: body.length, photoUsage });
    } catch (err) {
      console.error(err);
      const tooLarge = err.code === 'PAYLOAD_TOO_LARGE';
      const quotaExceeded = err.code === 'QUOTA_EXCEEDED';
      res.writeHead(tooLarge || quotaExceeded ? 413 : 400, {
        'Content-Type': 'application/json',
        // The rest of an oversized body is never read, so the connection
        // cannot be reused; say so and hang up once the error is delivered.
        ...(tooLarge ? { Connection: 'close' } : {}),
      });
      res.end(JSON.stringify(quotaExceeded ? err.body : { error: err.message }), () => {
        if (tooLarge) req.destroy();
      });
    }
    return true;
  }

  return false;
}

/** Judgement: an address, a place or a ZIP fits easily; longer is not an address. */
const MAX_LOCATION_QUERY_CHARS = 200;

/** The typed text, trimmed exactly as tools/geocode.mjs trims its cache key. */
function locationQuery(body) {
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query) throw new Error('Type an address, a town, or a ZIP code');
  if (query.length > MAX_LOCATION_QUERY_CHARS) throw new Error('That is too long to be an address');
  return query;
}

/**
 * What the owner's own UI gets back: coordinates rounded to 3 decimals, about
 * 110 m north-south. Enough to tell the right neighbourhood from a wrong town,
 * or a map pin, and no finer than that: the full-precision point stays in
 * app.db, where the index builder reads it.
 */
function roundForOwner({ lat, lng }) {
  const round3 = (n) => Math.round(n * 1000) / 1000;
  return { lat: round3(lat), lng: round3(lng) };
}

/**
 * The covered-region verdict (src/analysis/coveredRegion.js). A failed or
 * empty ecoregion lookup is passed on as null, which the verdict reports as
 * unchecked, never as outside and never as a refusal.
 */
async function regionFor(ctx, { lat, lng }) {
  let ecoregion = null;
  try {
    if (ctx.db.probeCache) ecoregion = await lookupEcoregion(lat, lng, { probeCache: ctx.db.probeCache });
  } catch {
    ecoregion = null; // the message can quote the coordinates; not logged
  }
  return coveredRegionVerdict({ lat, lng }, ecoregion);
}

/**
 * A geocode that failed, answered without quoting the typed text back into a
 * log: tools/geocode.mjs's "found nothing for ..." message does. The owner's
 * own response may say what happened, in words that do not repeat it either.
 */
function geocodeFailed(res, project, err) {
  const nothing = /found nothing/i.test(String(err?.message));
  console.warn(`Location lookup for '${project.slug}' ${nothing ? 'found no match' : 'failed'}`);
  if (nothing) {
    json(res, 422, { error: 'No match for that. Try adding the town and state, or a ZIP code.' });
  } else {
    json(res, 502, { error: 'The address lookup is not answering right now. Try again in a minute.' });
  }
}

/** feed-poller's cadence (tools/schedule-feed-poll.mjs), for "within the next poll". */
function pollMinutes() {
  return Number(process.env.FEED_POLL_INTERVAL_MINUTES) || 30;
}

/**
 * A new history entry. Its plants are reduced to placements whatever the client
 * sent, so a tab still running the pre-nl-3s5.19 code (which posts full plant
 * objects) cannot put species attributes back into history.
 */
function makeEntry(plants, description, id) {
  return {
    id: id || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    description: description || 'Manual layout update',
    plants: toPlacements(plants),
  };
}

/**
 * A revision as the client reads it: placements only, with its kind, and its
 * config and features when asked for (parsed; features null for a yard that
 * never drew one).
 * @param {import('../db/projectStore.js').Revision} revision
 */
function revisionPayload(revision, { config = false, features = false } = {}) {
  const out = toPlacementEntry({
    id: revision.id,
    timestamp: revision.timestamp,
    description: revision.description,
    kind: revision.kind,
    plants: revision.plants,
  });
  if (config) out.config = JSON.parse(revision.configJson);
  if (features) out.features = revision.featuresJson === null ? null : JSON.parse(revision.featuresJson);
  return out;
}

/**
 * GET /api/history: every revision, placements only as before, plus its kind.
 * Storage holds a full snapshot per revision; the response sends `config` and
 * `features` only on a revision where they differ from the one before (always
 * on the first), and a revision without the key carries the previous one's.
 * Sending every snapshot would be a megabyte and more per page load for a
 * yard with a few hundred revisions. The key's presence is what counts:
 * `features: null` means "no features", not "carried".
 */
function historyPayload(db, projectRowId) {
  const revisions = readRevisions(db, projectRowId);
  const row = db.prepare('SELECT history_cursor FROM projects WHERE id = ?').get(Number(projectRowId));
  const stored = Number(row?.history_cursor ?? -1);
  const cursor = revisions.length ? Math.max(0, Math.min(stored, revisions.length - 1)) : -1;
  const entries = revisions.map((revision, index) => {
    const previous = revisions[index - 1];
    return revisionPayload(revision, {
      config: !previous || previous.configJson !== revision.configJson,
      features: !previous || previous.featuresJson !== revision.featuresJson,
    });
  });
  return { entries, cursor };
}
