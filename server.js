// Entry point: `node server.js` (npm run serve, docker compose, the Playwright
// webServer). Routes live in server/routes/*.js; each returns true once it has
// answered a request, and the first taker wins. The static fallback is last.
import http from 'node:http';
import path from 'node:path';
import { handleProjectRoutes } from './server/routes/project.js';
import { handleEcosystemRoutes } from './server/routes/ecosystem.js';
import { handleFeedRoutes } from './server/routes/feed.js';
import { handleClaimsRoutes } from './server/routes/claims.js';
import { legacyRedirect, serveStaticFile } from './server/static.js';
import { openAppDb } from './server/db/appDb.js';

const envPort = Number(process.env.PORT);
const PORT = Number.isFinite(envPort) ? envPort : 8000;
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.resolve(process.cwd());

const ROUTES = [handleProjectRoutes, handleEcosystemRoutes, handleFeedRoutes, handleClaimsRoutes];

// Opened once at startup, not per request. ctx.db is built as an object, one
// handle per store, so the other local SQLite stores (nl-3s5.14: savedAreas,
// feedState, observationEvents, ecosystem, claims) can be merged in under
// their own keys without clobbering this one.
const db = { app: openAppDb() };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const pathname = url.pathname;
  const ctx = { url, pathname, publicDir: PUBLIC_DIR, db };

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

  await serveStaticFile(res, pathname, PUBLIC_DIR);
});

server.listen(PORT, () => {
  const address = server.address();
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const boundPort = address && address.port ? address.port : PORT;
  console.log(`Serving native-landscaping at http://${host}:${boundPort}`);
});
