// Entry point: `node server.js` (npm run serve, docker compose, the Playwright
// webServer). Routes live in server/routes/*.js; each returns true once it has
// answered a request, and the first taker wins. The static fallback is last.
import http from 'node:http';
import path from 'node:path';
import { handleProjectRoutes } from './server/routes/project.js';
import { handleEcosystemRoutes } from './server/routes/ecosystem.js';
import { handleFeedRoutes } from './server/routes/feed.js';
import { handleClaimsRoutes } from './server/routes/claims.js';
import { rejectCrossSite } from './server/http.js';
import { legacyRedirect, serveStaticFile, isAdminOnlyStaticPath } from './server/static.js';
import { openAppDb, resolveDataDir } from './server/db/appDb.js';
import { createIdentity } from './server/identity.js';
import { openServerDatabases } from './server/dbHandles.js';
import { resolveRequestLogMode, shouldLogRequest, formatRequestLog } from './server/requestLog.js';

const envPort = Number(process.env.PORT);
const PORT = Number.isFinite(envPort) ? envPort : 8000;
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.resolve(process.cwd());

// Where app.db and every yard's photos live (DATA_DIR/projects/<id>/img/,
// nl-3s5.3): outside the served root, reached only through /api routes.
const DATA_DIR = resolveDataDir();

const ROUTES = [handleProjectRoutes, handleEcosystemRoutes, handleFeedRoutes, handleClaimsRoutes];

// Built once so its configuration warnings log at startup (server/identity.js).
const identify = createIdentity();

// Every SQLite store is opened once at startup and shared through ctx.db,
// instead of each route opening (and leaking) a handle per request: app.db
// (nl-3s5.23) plus the tools/ stores (nl-3s5.14, server/dbHandles.js).
const db = { app: openAppDb({ dataDir: DATA_DIR }), ...openServerDatabases() };

// REQUEST_LOG=all|api|off, default 'api': see server/requestLog.js for why
// 'api' (skip static-asset 200s, keep everything else) is the quiet default.
const requestLogMode = resolveRequestLogMode(process.env.REQUEST_LOG);

const server = http.createServer(async (req, res) => {
  // A fixed base, not the client's Host header: a malformed Host (e.g.
  // "a b") made this throw outside any try, and the unhandled rejection took
  // the whole process down. Nothing reads url.host; the CSRF guard reads the
  // Host header itself.
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  const method = req.method || 'GET';
  const startedAt = process.hrtime.bigint();
  const ctx = { url, pathname, publicDir: PUBLIC_DIR, dataDir: DATA_DIR, db };

  res.on('finish', () => {
    if (!shouldLogRequest(requestLogMode, pathname, res.statusCode)) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      formatRequestLog({ method, pathname, status: res.statusCode, userId: ctx.user?.id, durationMs })
    );
  });

  try {
    ctx.user = await identify(req, ctx.db.app); // { id, email, isAdmin } or null; not enforced here

    // CSRF guard (nl-3s5.16): answered once, here, for every state-changing
    // method, before any route sees the request. See server/http.js for why.
    if (rejectCrossSite(req, res, pathname)) return;

    for (const handle of ROUTES) {
      if (await handle(req, res, ctx)) return;
    }

    // Links to the pre-rename layout. The argument page is the one built to be
    // sent to a room, so its old URL is the one most likely to be sitting in
    // somebody's email; and an old design-tool bookmark carries ?project=, which
    // now lands on the argument page and silently shows the wrong thing rather
    // than erroring. Both redirect instead.
    const legacy = legacyRedirect(pathname, url.search);
    if (legacy) {
      res.writeHead(301, { Location: legacy });
      res.end();
      return;
    }

    // Admin-only pages (nl-3s5.7): same 404 an unknown file gets, so a
    // non-admin caller can't tell "exists but not for you" from "never existed".
    if (isAdminOnlyStaticPath(pathname) && !ctx.user?.isAdmin) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    await serveStaticFile(res, pathname, PUBLIC_DIR);
  } catch (err) {
    // Previously reached console.error with no request context; the
    // finish listener above still fires and logs whatever status code
    // ends up on the response.
    console.error(`${method} ${pathname} failed:`, err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal error');
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  const address = server.address();
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const boundPort = address && address.port ? address.port : PORT;
  console.log(`Serving native-landscaping at http://${host}:${boundPort}`);
});
