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

// Maintainer-only pages over the plant-data claim store (nl-3s5.7): a
// non-admin caller must get the same 404 an unknown file gets, not a 403
// that would confirm the page exists. Checked by the caller (server.js, which
// has ctx.user) before falling through to serveStaticFile below, so this
// module doesn't need to know about identity.
const ADMIN_ONLY_STATIC_PATHS = new Set(['/claims-coverage.html', '/claims-conflicts.html']);

/**
 * @param {string} pathname request pathname, e.g. "/claims-coverage.html"
 */
export function isAdminOnlyStaticPath(pathname) {
  return ADMIN_ONLY_STATIC_PATHS.has(pathname);
}

// What the browser is allowed to load, and nothing else (nl-3s5.1). The repo
// root is the served root, so anything not listed here (.env with the tunnel
// token, data/*.db, .git, .beads, projects/*/location.json with an exact
// address, the flora PDFs we may not redistribute) is a 404 no matter how the
// Cloudflare Access policy in front of the site is configured. An allowlist, not
// a denylist: a new file is private until someone decides a page needs it.
const PROJECT_ID = '[a-z0-9][a-z0-9_-]*';
const SERVABLE_PATHS = [
  /^[a-z0-9-]+\.html$/, // the pages
  /^[a-z0-9-]+\.css$/,
  /^favicon\.svg$/,
  /^plants\.csv$/,
  /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/,
  /^(?:ecology|catalog|sourcing)\/[a-z0-9-]+\.csv$/,
  /^projects\/index\.json$/,
  new RegExp(`^projects/${PROJECT_ID}/(?:project\\.json|planting_layout\\.csv)$`),
  new RegExp(`^projects/${PROJECT_ID}/img/[A-Za-z0-9_-]+\\.(?:webp|png|jpe?g|svg)$`),
  /^node_modules\/jszip\/dist\/jszip\.min\.js$/, // the HOA packet export
  // Pages link to these as "see how this was made".
  /^docs\/(?:[a-z0-9-]+\/)*[A-Za-z0-9_.-]+\.md$/,
  /^tools\/[a-z0-9-]+\.mjs$/,
];

/**
 * Whether a request path may be served. Dot segments are refused outright, so
 * no pattern can be widened into .env or .git by accident.
 *
 * @param {string} relativePath path relative to the served root, "/"-separated
 */
export function isServableStaticPath(relativePath) {
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return false;
  return SERVABLE_PATHS.some((pattern) => pattern.test(relativePath));
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
    const relativePath = path.relative(publicDir, targetPath).split(path.sep).join('/');
    if (!isServableStaticPath(relativePath)) {
      // 404, not 403: a refusal would confirm that the file exists.
      res.writeHead(404);
      res.end('Not found');
      return;
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
