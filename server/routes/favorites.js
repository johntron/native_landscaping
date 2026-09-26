import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectPayload, createRateLimiter, enforceRateLimit, json, rateLimitKeyFor, requireUser } from '../http.js';
import { listFavorites, setFavorite } from '../db/favoritesStore.js';
import { parseCsv } from '../../src/data/csvLoader.js';

// Species a signed-in person marks favorite / most wanted (nl-3on), from the
// Add plant picker on design.html and the shopping list on sourcing.html.
//
//   GET /api/favorites                       -> { speciesIds: [...] }
//   PUT /api/favorites { speciesId, favorite } -> { speciesIds: [...] }
//
// Signed-in only (401 otherwise); every row is the caller's own. A speciesId
// must be a plants.csv id, so the table cannot fill with names nothing draws.

// A person starring species while browsing is nowhere near this; it blunts a
// scripted flood, the same judgement as server/routes/saleNotes.js.
const writeLimiter = createRateLimiter({ capacity: 60, refillPerSecond: 2 });

/** plants.csv's ids, read per call: the file is small and changes on deploy. */
function catalogIds(publicDir) {
  const text = readFileSync(join(publicDir, 'plants.csv'), 'utf8');
  return new Set(parseCsv(text).map((row) => String(row.id || '').trim()).filter(Boolean));
}

export async function handleFavoritesRoutes(req, res, ctx) {
  if (ctx.pathname !== '/api/favorites') return false;
  const user = requireUser(ctx, res);
  if (!user) return true;
  const db = ctx.db.app;

  if (req.method === 'GET') {
    json(res, 200, { speciesIds: listFavorites(db, user.id) });
    return true;
  }

  if (req.method === 'PUT') {
    if (!enforceRateLimit(writeLimiter, rateLimitKeyFor(ctx, req), res)) return true;
    let body;
    try {
      body = await collectPayload(req, { requirePlants: false });
    } catch (err) {
      json(res, 400, { error: err.message });
      return true;
    }
    const speciesId = typeof body.speciesId === 'string' ? body.speciesId.trim() : '';
    if (!speciesId || !catalogIds(ctx.publicDir).has(speciesId)) {
      json(res, 400, { error: 'speciesId must be a species id from plants.csv' });
      return true;
    }
    if (typeof body.favorite !== 'boolean') {
      json(res, 400, { error: 'favorite must be true or false' });
      return true;
    }
    setFavorite(db, { userId: user.id, speciesId, favorite: body.favorite });
    json(res, 200, { speciesIds: listFavorites(db, user.id) });
    return true;
  }

  json(res, 405, { error: `Method ${req.method} not allowed on ${ctx.pathname}` });
  return true;
}
