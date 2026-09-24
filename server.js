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
import { openAppDb } from './server/db/appDb.js';
import { createIdentity } from './server/identity.js';
import { openServerDatabases } from './server/dbHandles.js';

const envPort = Number(process.env.PORT);
const PORT = Number.isFinite(envPort) ? envPort : 8000;
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.resolve(process.cwd());

const ROUTES = [handleProjectRoutes, handleEcosystemRoutes, handleFeedRoutes, handleClaimsRoutes];

// Built once so its configuration warnings log at startup (server/identity.js).
const identify = createIdentity();

// Every SQLite store is opened once at startup and shared through ctx.db,
// instead of each route opening (and leaking) a handle per request: app.db
// (nl-3s5.23) plus the tools/ stores (nl-3s5.14, server/dbHandles.js).
const db = { app: openAppDb(), ...openServerDatabases() };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const pathname = url.pathname;
  const ctx = { url, pathname, publicDir: PUBLIC_DIR, db };
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
});

server.listen(PORT, () => {
  const address = server.address();
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const boundPort = address && address.port ? address.port : PORT;
  console.log(`Serving native-landscaping at http://${host}:${boundPort}`);
});
