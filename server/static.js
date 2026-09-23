// The static-file fallback and the redirects for pre-rename URLs. Always tried
// last, after every /api route module has declined the request.
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

/**
 * Where a pre-rename URL should go now, or null if it is already current.
 * The argument page is project-agnostic, so a ?project= on it is proof the
 * link was written for the design tool back when that lived at /index.html.
 */
export function legacyRedirect(pathname, search) {
  if (pathname === '/patch-network.html') return `/${search || ''}`;
  if ((pathname === '/index.html' || pathname === '/') && /[?&]project=/.test(search || '')) {
    return `/design.html${search}`;
  }
  return null;
}

export async function serveStaticFile(res, pathname, publicDir) {
  let normalizedPath = pathname;
  try {
    normalizedPath = decodeURIComponent(pathname);
  } catch (err) {
    normalizedPath = pathname;
  }
  const safePath = normalizedPath.replace(/\/+/g, '/');
  let targetPath = path.join(publicDir, safePath);
  if (targetPath.endsWith(path.sep)) {
    targetPath = path.join(targetPath, 'index.html');
  }
  if (!targetPath.startsWith(publicDir)) {
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
