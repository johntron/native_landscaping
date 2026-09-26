import { json, requireUser } from '../http.js';
import { currentPlacements } from '../db/projectStore.js';
import { listFavorites } from '../db/favoritesStore.js';
import { plannedCounts } from '../../src/sourcing/shoppingList.js';

// The shopping list on sourcing.html (nl-46b): what is planned in each of the
// caller's own yards, and their favorite species.
//
//   GET /api/shopping-list -> { yards: [{ id, name, planned: { speciesId: n } }], favorites: [...] }
//
// Signed-in only (401 otherwise). Only yards the caller owns, in the picker's
// order (oldest first): the shared example yard (owned by the system user) is
// not theirs to buy for. Counts come from each yard's current revision, the
// one its page shows.

export async function handleShoppingListRoutes(req, res, ctx) {
  if (ctx.pathname !== '/api/shopping-list') return false;
  const user = requireUser(ctx, res);
  if (!user) return true;
  if (req.method !== 'GET') {
    json(res, 405, { error: `Method ${req.method} not allowed on ${ctx.pathname}` });
    return true;
  }
  const db = ctx.db.app;
  const yards = db
    .prepare('SELECT id, slug, name FROM projects WHERE owner_id = ? ORDER BY id')
    .all(Number(user.id))
    .map((row) => ({ id: row.slug, name: row.name, planned: plannedCounts(currentPlacements(db, row.id)) }));
  json(res, 200, { yards, favorites: listFavorites(db, user.id) });
  return true;
}
