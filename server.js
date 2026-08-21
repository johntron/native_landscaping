import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildLayoutCsv } from './src/data/layoutExporter.js';
import {
  normalizeProjectConfig,
  serializeProjectConfig,
} from './src/data/projectConfig.js';
import { projectIdFromUrl, resolveProjectPaths } from './src/data/projectPaths.js';
import {
  MAX_UPLOAD_BYTES,
  imageTypeForContentType,
  resolveBackgroundTarget,
  sniffImageType,
  supersededBackgrounds,
} from './src/data/backgroundStore.js';

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
      console.log(`Project config saved for '${projectId}' (${config.views.length} views)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config: serializeProjectConfig(config) }));
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
