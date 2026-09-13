import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildLayoutCsv } from './src/data/layoutExporter.js';
import {
  normalizeProjectConfig,
  serializeProjectConfig,
  normalizeProjectIndex,
  isValidProjectId,
  PROJECT_INDEX_PATH,
} from './src/data/projectConfig.js';
import { normalizeFeatures, serializeFeatures } from './src/data/featureConfig.js';
import { projectIdFromUrl, resolveProjectPaths } from './src/data/projectPaths.js';
import {
  MAX_UPLOAD_BYTES,
  imageTypeForContentType,
  resolveBackgroundTarget,
  sniffImageType,
  supersededBackgrounds,
} from './src/data/backgroundStore.js';
import { openEcosystemDb, listSpeciesObservations } from './tools/ecosystemIndexDb.js';

const envPort = Number(process.env.PORT);
const PORT = Number.isFinite(envPort) ? envPort : 8000;
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.resolve(process.cwd());

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/history' && req.method === 'GET') {
    try {
      const { historyFile } = resolveProjectPaths(projectIdFromUrl(url), PUBLIC_DIR);
      const history = await readHistoryFile(historyFile);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: history.entries, cursor: history.cursor }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/layout' && req.method === 'POST') {
    try {
      const { historyFile, layoutFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), PUBLIC_DIR);
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
    return;
  }

  if (pathname === '/api/project' && req.method === 'POST') {
    try {
      const { configFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), PUBLIC_DIR);
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
      const index = await syncProjectIndexName(projectId, config.name);
      console.log(`Project config saved for '${projectId}' (${config.views.length} views)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config: serializeProjectConfig(config), index }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
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

      const indexFile = path.join(PUBLIC_DIR, PROJECT_INDEX_PATH);
      const index = normalizeProjectIndex(JSON.parse(await fs.readFile(indexFile, 'utf-8')));
      const { projectDir, configFile, layoutFile } = resolveProjectPaths(id, PUBLIC_DIR);
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
    return;
  }

  if (pathname === '/api/features' && req.method === 'GET') {
    try {
      const { featuresFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), PUBLIC_DIR);
      const features = normalizeFeatures(await readFeaturesFile(featuresFile), projectId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(serializeFeatures(features)));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/features' && req.method === 'POST') {
    try {
      const { featuresFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), PUBLIC_DIR);
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
    return;
  }

  if (pathname === '/api/history/cursor' && req.method === 'POST') {
    try {
      const { historyFile, layoutFile, projectId } = resolveProjectPaths(projectIdFromUrl(url), PUBLIC_DIR);
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
    return;
  }

  if (pathname === '/api/view-background' && req.method === 'POST') {
    try {
      const { projectDir, projectId } = resolveProjectPaths(projectIdFromUrl(url), PUBLIC_DIR);
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
        return;
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
    return;
  }

  if (pathname === '/api/ecosystem' && req.method === 'GET') {
    try {
      const place = url.searchParams.get('place') || 'home';
      const iconicTaxon = url.searchParams.get('taxon') || undefined;
      const db = openEcosystemDb();
      const rows = listSpeciesObservations(db, { place, iconicTaxon });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ place, rows }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  await serveStaticFile(res, pathname);
});

server.listen(PORT, () => {
  const address = server.address();
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const boundPort = address && address.port ? address.port : PORT;
  console.log(`Serving native-landscaping at http://${host}:${boundPort}`);
});

async function collectPayload(req, options = {}) {
  const { requirePlants = true } = options;
  const body = await collectRequestBody(req);
  if (!body) {
    throw new Error('Request body is empty');
  }
  const parsed = JSON.parse(body);
  if (requirePlants && !Array.isArray(parsed.plants)) {
    throw new Error('Missing plant list');
  }
  return parsed;
}

function makeEntry(plants, description, id) {
  return {
    id: id || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    description: description || 'Manual layout update',
    plants,
  };
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep projects/index.json's label for a project in step with project.json's
 * own `name` after a Setup-mode save. Best effort: the config write already
 * succeeded, and a stale picker label is recoverable (save again, or fix the
 * index by hand) in a way a failed config save is not.
 */
async function syncProjectIndexName(projectId, name) {
  const indexFile = path.join(PUBLIC_DIR, PROJECT_INDEX_PATH);
  try {
    const index = normalizeProjectIndex(JSON.parse(await fs.readFile(indexFile, 'utf-8')));
    const entry = index.projects.find((p) => p.id === projectId);
    if (!entry || entry.name === name) return index;
    entry.name = name;
    await writeJsonAtomic(indexFile, index);
    return index;
  } catch (err) {
    console.warn(`Could not sync project index name for '${projectId}':`, err.message);
    return null;
  }
}

/**
 * Write JSON through a temporary file in the same directory, so a crash or a
 * concurrent read never sees a half-written project.json. Same directory
 * matters: rename is only atomic within a filesystem.
 */
async function writeJsonAtomic(targetFile, value) {
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tempFile, targetFile);
  } catch (err) {
    await fs.rm(tempFile, { force: true });
    throw err;
  }
}

async function writeLayoutFile(layoutFile, plants) {
  await fs.writeFile(layoutFile, buildLayoutCsv(plants || []));
}

/**
 * A project that has never drawn a feature has no features.json, and that is
 * the normal case rather than an error — it reads as an empty yard model. A
 * file that exists but is unreadable is a real fault and is left to throw.
 */
async function readFeaturesFile(featuresFile) {
  try {
    return JSON.parse(await fs.readFile(featuresFile, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readHistoryFile(historyFile) {
  try {
    const raw = await fs.readFile(historyFile, 'utf-8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const cursor =
      typeof parsed.cursor === 'number' && Number.isFinite(parsed.cursor)
        ? parsed.cursor
        : entries.length - 1;
    return { entries, cursor: cursor >= 0 ? cursor : -1 };
  } catch (err) {
    return { entries: [], cursor: -1 };
  }
}

async function writeHistoryFile(historyFile, history) {
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const cursor =
    typeof history.cursor === 'number' && Number.isFinite(history.cursor)
      ? history.cursor
      : entries.length - 1;
  await fs.writeFile(historyFile, JSON.stringify({ entries, cursor }, null, 2));
}

async function serveStaticFile(res, pathname) {
  let normalizedPath = pathname;
  try {
    normalizedPath = decodeURIComponent(pathname);
  } catch (err) {
    normalizedPath = pathname;
  }
  const safePath = normalizedPath.replace(/\/+/g, '/');
  let targetPath = path.join(PUBLIC_DIR, safePath);
  if (targetPath.endsWith(path.sep)) {
    targetPath = path.join(targetPath, 'index.html');
  }
  if (!targetPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const stats = await fs.stat(targetPath);
    if (stats.isDirectory()) {
      targetPath = path.join(targetPath, 'index.html');
    }
    const body = await fs.readFile(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(404);
    res.end('Not found');
  }
}

/**
 * Read a request body as bytes, refusing one that grows past `limit`.
 *
 * The cap is checked as chunks arrive, not at the end: a check in the 'end'
 * handler has already buffered whatever was sent. Content-Length is not
 * consulted at all — it is a claim, and the accumulated length is a fact.
 */
function collectBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        // Pause rather than destroy: the socket has to stay alive long enough
        // to carry the 413 back, or the client sees a dropped connection and
        // has no idea why. server.js destroys it once the response is out.
        req.pause();
        const err = new Error(`Image is larger than ${Math.round(limit / 1024 / 1024)} MB`);
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Same temp-then-rename discipline as writeJsonAtomic, for opaque bytes. */
async function writeFileAtomic(targetFile, contents) {
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempFile, contents);
    await fs.rename(tempFile, targetFile);
  } catch (err) {
    await fs.rm(tempFile, { force: true });
    throw err;
  }
}

/**
 * Drop a view's earlier uploads. Best effort: the new background is already on
 * disk and usable, so a failure to tidy up must not fail the request.
 */
async function removeSupersededBackgrounds(dir, viewId, keepFileName) {
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(
      supersededBackgrounds(entries, viewId, keepFileName).map((name) =>
        fs.rm(path.join(dir, name), { force: true })
      )
    );
  } catch (err) {
    console.warn(`Could not remove superseded backgrounds in ${dir}:`, err.message);
  }
}

async function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
