import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  normalizeProjectConfig,
  serializeProjectConfig,
  normalizeProjectIndex,
  isValidProjectId,
  PROJECT_INDEX_PATH,
} from '../../src/data/projectConfig.js';
import { normalizeFeatures, serializeFeatures } from '../../src/data/featureConfig.js';
import { projectIdFromUrl, resolveProjectPaths } from '../../src/data/projectPaths.js';
import {
  MAX_UPLOAD_BYTES,
  imageTypeForContentType,
  resolveBackgroundTarget,
  sniffImageType,
} from '../../src/data/backgroundStore.js';
import { collectPayload, collectBinaryBody } from '../http.js';
import {
  pathExists,
  syncProjectIndexName,
  writeJsonAtomic,
  writeFileAtomic,
  writeLayoutFile,
  readFeaturesFile,
  readHistoryFile,
  writeHistoryFile,
  removeSupersededBackgrounds,
  removeOrphanedBackgrounds,
} from '../files.js';

/**
 * Per-project persistence for the design tool: layout + undo history, project.json,
 * project creation, features.json, and view background uploads. Every route here
 * is scoped by ?project=<slug> (except creation, which names the new id in the
 * body) and writes inside that project's directory only.
 *
 * Returns true when it handled the request (a response has been sent), false
 * to let server.js try the next route module. `publicDir` is the served root,
 * which the e2e scratch server points somewhere else.
 */
export async function handleProjectRoutes(req, res, { url, pathname, publicDir }) {
  if (pathname === '/api/history' && req.method === 'GET') {
    try {
      const { historyFile } = resolveProjectPaths(projectIdFromUrl(url), publicDir);
      const history = await readHistoryFile(historyFile);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: history.entries, cursor: history.cursor }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/layout' && req.method === 'POST') {
    try {
      const { historyFile, layoutFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), publicDir);
      const payload = await collectPayload(req);
      const history = await readHistoryFile(historyFile);
      const trimmed = history.entries.slice(0, Math.max(history.cursor + 1, 0));
      if (
        trimmed.length === 0 &&
        Array.isArray(payload.previousPlants) &&
        payload.previousPlants.length
      ) {
        trimmed.push(makeEntry(payload.previousPlants, 'Initial layout'));
      }
      const entry = makeEntry(payload.plants, payload.description, payload.id);
      trimmed.push(entry);
      const cursor = trimmed.length - 1;
      await writeLayoutFile(layoutFile, entry.plants);
      await writeHistoryFile(historyFile, { entries: trimmed, cursor });
      console.log(`Layout saved for '${projectId}' (history entries: ${trimmed.length})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entry, cursor }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/project' && req.method === 'POST') {
    try {
      const { configFile, projectDir, projectId } = resolveProjectPaths(projectIdFromUrl(url), publicDir);
      const body = await collectPayload(req, { requirePlants: false });
      // The legacy {plan, elevations[]} reader exists for files already on disk,
      // not for request bodies: without this, a body missing views[] migrates
      // into one default blank plan view and silently overwrites the project.
      // There is no config history to recover from.
      if (!Array.isArray(body.views)) {
        throw new Error('Missing views[]');
      }
      // The id comes from the directory, never from the body — a client that
      // names a different project must not be able to write to it.
      const config = normalizeProjectConfig({ ...body, id: undefined }, projectId);
      await writeJsonAtomic(configFile, serializeProjectConfig(config));
      // The project picker gets its label from index.json, not project.json,
      // so a name edited here would otherwise sit unread until someone
      // hand-edits the index too.
      const index = await syncProjectIndexName(publicDir, projectId, config.name);
      await removeOrphanedBackgrounds(projectDir, config);
      console.log(`Project config saved for '${projectId}' (${config.views.length} views)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config: serializeProjectConfig(config), index }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/projects' && req.method === 'POST') {
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

      const indexFile = path.join(publicDir, PROJECT_INDEX_PATH);
      const index = normalizeProjectIndex(JSON.parse(await fs.readFile(indexFile, 'utf-8')));
      const { projectDir, configFile, layoutFile } = resolveProjectPaths(id, publicDir);
      // Indexed and on-disk are checked separately: a directory can exist
      // without ever having been indexed, if an earlier create died between
      // the two writes below.
      if (index.projects.some((p) => p.id === id) || (await pathExists(projectDir))) {
        throw new Error(`Project "${id}" already exists`);
      }

      // No yardFt/views geometry supplied: normalizeProjectConfig fills in
      // the same defaults a hand-created project.json with just a plan view
      // would get, so a fresh project starts exactly where Setup mode's
      // fields already expect the yard to be before anyone has typed a
      // number.
      const config = normalizeProjectConfig({ name, views: [{ id: 'plan', type: 'plan' }] }, id);

      await fs.mkdir(projectDir, { recursive: true });
      await writeJsonAtomic(configFile, serializeProjectConfig(config));
      await writeLayoutFile(layoutFile, []);

      index.projects.push({ id, name: config.name });
      await writeJsonAtomic(indexFile, index);

      console.log(`Project '${id}' created`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ index, config: serializeProjectConfig(config) }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/features' && req.method === 'GET') {
    try {
      const { featuresFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), publicDir);
      const features = normalizeFeatures(await readFeaturesFile(featuresFile), projectId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(serializeFeatures(features)));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/features' && req.method === 'POST') {
    try {
      const { featuresFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), publicDir);
      const body = await collectPayload(req, { requirePlants: false });
      // An absent features[] means "this body is not a feature list", not "no
      // features": accepting it would erase the whole yard model, and unlike
      // the layout there is no history to recover it from.
      if (!Array.isArray(body.features)) {
        throw new Error('Missing features[]');
      }
      const features = normalizeFeatures(body, projectId);
      await writeJsonAtomic(featuresFile, serializeFeatures(features));
      console.log(`Features saved for '${projectId}' (${features.features.length} features)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(serializeFeatures(features)));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/history/cursor' && req.method === 'POST') {
    try {
      const { historyFile, layoutFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), publicDir);
      const payload = await collectPayload(req, { requirePlants: false });
      const history = await readHistoryFile(historyFile);
      const cursor = Number(payload.cursor);
      if (!Number.isFinite(cursor) || cursor < 0 || cursor >= history.entries.length) {
        throw new Error('Invalid cursor');
      }
      const entry = history.entries[cursor];
      await writeLayoutFile(layoutFile, entry.plants);
      await writeHistoryFile(historyFile, { entries: history.entries, cursor });
      console.log(`Layout for '${projectId}' rewound to '${entry.id}' (cursor ${cursor})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entry, cursor }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/view-background' && req.method === 'POST') {
    try {
      const { projectDir, projectId } = resolveProjectPaths(projectIdFromUrl(url), publicDir);
      const viewId = url.searchParams.get('view') || '';

      // Three independent checks, in cost order: the header the client
      // declared, the size as it arrives, and the bytes themselves. Only the
      // last one is trustworthy, but failing early on the first two keeps a
      // hostile client from making us buffer anything.
      const declared = imageTypeForContentType(req.headers['content-type']);
      if (!declared) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Background must be a WebP, JPEG, or PNG image' }));
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
        projectDir,
        viewId,
        contentHash,
        ext: sniffed.ext,
      });

      await fs.mkdir(dir, { recursive: true });
      await writeFileAtomic(file, body);
      await removeSupersededBackgrounds(dir, viewId, path.basename(file));

      console.log(`Background saved for '${projectId}' view '${viewId}' (${body.length} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ background: relativePath, bytes: body.length }));
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

function makeEntry(plants, description, id) {
  return {
    id: id || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    description: description || 'Manual layout update',
    plants,
  };
}
