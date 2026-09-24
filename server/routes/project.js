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
import { collectPayload, collectBinaryBody, json, loadOwnedProject, requireUser } from '../http.js';
import { writeFileAtomic, removeSupersededBackgrounds, removeOrphanedBackgrounds } from '../files.js';
import {
  currentPlacements,
  findCallerProject,
  findOwnedProject,
  insertProject,
  moveHistoryCursor,
  projectDataDir,
  projectIndexFor,
  readHistory,
  recordLayout,
  saveProjectConfig,
  saveProjectFeatures,
  withTransaction,
} from '../db/projectStore.js';

const PHOTO_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

/**
 * Per-project persistence for the design tool, backed by app.db
 * (server/db/projectStore.js, nl-3s5.3): the caller's yard list, config,
 * layout + undo history, features, and the yard's photos.
 *
 * Every route needs a signed-in caller, and every ?project=<slug> is resolved
 * among THAT caller's yards through loadOwnedProject (server/http.js): 401
 * when anonymous, the same 404 for a slug that does not exist and one that
 * belongs to someone else. Slugs are unique per owner, so there is no other
 * way to resolve one.
 *
 * Returns true when it handled the request (a response has been sent), false
 * to let server.js try the next route module.
 */
export async function handleProjectRoutes(req, res, ctx) {
  const { url, pathname } = ctx;
  const db = ctx.db.app;
  const owned = () => loadOwnedProject(ctx, res, projectIdFromUrl(url), { findProject: findCallerProject });

  // The caller's yard picker (replaces the static projects/index.json).
  if (pathname === '/api/projects' && req.method === 'GET') {
    const user = requireUser(ctx, res);
    if (!user) return true;
    json(res, 200, projectIndexFor(db, user.id));
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
      json(res, 200, { index: projectIndexFor(db, user.id), config: serialized });
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  // The config as it was saved; the client normalizes it, as it did the file.
  if (pathname === '/api/project' && req.method === 'GET') {
    const project = owned();
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
    const project = owned();
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
      // the two can no longer drift apart the way index.json and project.json could.
      saveProjectConfig(db, project.id, {
        name: config.name,
        configJson: `${JSON.stringify(serialized, null, 2)}\n`,
      });
      await removeOrphanedBackgrounds(projectDataDir(ctx.dataDir, project.id), config);
      console.log(`Project config saved for '${project.slug}' (${config.views.length} views)`);
      json(res, 200, { config: serialized, index: projectIndexFor(db, project.ownerId) });
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const project = owned();
    if (!project) return true;
    const history = readHistory(db, project.id);
    // Placements only in the response, even for an entry imported unreduced.
    json(res, 200, { entries: history.entries.map(toPlacementEntry), cursor: history.cursor });
    return true;
  }

  // The layout the yard shows now (the entry at the cursor), as the CSV that
  // used to be stored. An export only: nothing reads it back.
  if (pathname === '/api/layout' && req.method === 'GET') {
    const project = owned();
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
    const project = owned();
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
    const project = owned();
    if (!project) return true;
    try {
      const payload = await collectPayload(req, { requirePlants: false });
      const result = moveHistoryCursor(db, project.id, Number(payload.cursor));
      console.log(`Layout for '${project.slug}' rewound to '${result.entry.id}' (cursor ${result.cursor})`);
      json(res, 200, { entry: toPlacementEntry(result.entry), cursor: result.cursor });
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/features' && req.method === 'GET') {
    const project = owned();
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
    const project = owned();
    if (!project) return true;
    try {
      const body = await collectPayload(req, { requirePlants: false });
      // An absent features[] means "this body is not a feature list", not "no
      // features": accepting it would erase the whole yard model, and unlike
      // the layout there is no history to recover it from.
      if (!Array.isArray(body.features)) {
        throw new Error('Missing features[]');
      }
      const features = serializeFeatures(normalizeFeatures(body, project.slug));
      saveProjectFeatures(db, project.id, `${JSON.stringify(features, null, 2)}\n`);
      console.log(`Features saved for '${project.slug}' (${features.features.length} features)`);
      json(res, 200, features);
    } catch (err) {
      console.error(err);
      json(res, 400, { error: err.message });
    }
    return true;
  }

  // A yard's photo, to its owner only. Photos live under DATA_DIR, outside
  // the served root, so this is the only way to reach one.
  if (pathname === '/api/project-photo' && req.method === 'GET') {
    const project = owned();
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
    const project = owned();
    if (!project) {
      req.resume(); // drain the unread body so the 401/404 reaches the client
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

      const contentHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
      const { dir, file, relativePath } = resolveBackgroundTarget({
        projectDir: projectDataDir(ctx.dataDir, project.id),
        viewId,
        contentHash,
        ext: sniffed.ext,
      });

      await fs.mkdir(dir, { recursive: true });
      await writeFileAtomic(file, body);
      await removeSupersededBackgrounds(dir, viewId, path.basename(file));

      console.log(`Background saved for '${project.slug}' view '${viewId}' (${body.length} bytes)`);
      json(res, 200, { background: relativePath, bytes: body.length });
    } catch (err) {
      console.error(err);
      const tooLarge = err.code === 'PAYLOAD_TOO_LARGE';
      res.writeHead(tooLarge ? 413 : 400, {
        'Content-Type': 'application/json',
        // The rest of an oversized body is never read, so the connection
        // cannot be reused; say so and hang up once the error is delivered.
        ...(tooLarge ? { Connection: 'close' } : {}),
      });
      res.end(JSON.stringify({ error: err.message }), () => {
        if (tooLarge) req.destroy();
      });
    }
    return true;
  }

  return false;
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
