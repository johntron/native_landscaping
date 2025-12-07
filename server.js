import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildLayoutCsv } from './src/data/layoutExporter.js';

const envPort = Number(process.env.PORT);
const PORT = Number.isFinite(envPort) ? envPort : 8000;
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.resolve(process.cwd());
const HISTORY_FILE = path.join(PUBLIC_DIR, 'layout-history.json');
const LAYOUT_FILE = path.join(PUBLIC_DIR, 'planting_layout.csv');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/history' && req.method === 'GET') {
    const history = await readHistoryFile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries: history.entries, cursor: history.cursor }));
    return;
  }

  if (pathname === '/api/layout' && req.method === 'POST') {
    try {
      const payload = await collectPayload(req);
      const history = await readHistoryFile();
      const trimmed = history.entries.slice(0, Math.max(history.cursor + 1, 0));
      const entry = makeEntry(payload.plants, payload.description, payload.id);
      trimmed.push(entry);
      const cursor = trimmed.length - 1;
      await writeLayoutFile(entry.plants);
      await writeHistoryFile({ entries: trimmed, cursor });
      console.log(`Layout saved (history entries: ${trimmed.length})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entry, cursor }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/history/cursor' && req.method === 'POST') {
    try {
      const payload = await collectPayload(req, { requirePlants: false });
      const history = await readHistoryFile();
      const cursor = Number(payload.cursor);
      if (!Number.isFinite(cursor) || cursor < 0 || cursor >= history.entries.length) {
        throw new Error('Invalid cursor');
      }
      const entry = history.entries[cursor];
      await writeLayoutFile(entry.plants);
      await writeHistoryFile({ entries: history.entries, cursor });
      console.log(`Layout rewound to '${entry.id}' (cursor ${cursor})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entry, cursor }));
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
  const boundPort = address && address.port ? address.port : PORT;
  console.log(`Serving native-landscaping at http://localhost:${boundPort}`);
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

async function writeLayoutFile(plants) {
  await fs.writeFile(LAYOUT_FILE, buildLayoutCsv(plants || []));
}

async function readHistoryFile() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
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

async function writeHistoryFile(history) {
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const cursor =
    typeof history.cursor === 'number' && Number.isFinite(history.cursor)
      ? history.cursor
      : entries.length - 1;
  await fs.writeFile(HISTORY_FILE, JSON.stringify({ entries, cursor }, null, 2));
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

async function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
