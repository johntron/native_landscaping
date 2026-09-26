// Species a person has marked favorite / most wanted (nl-3on). Table:
// server/db/migrations/007_species_favorites.sql. server/routes/favorites.js is
// the only writer; the shopping list reads them through the same route.

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @returns {string[]} plants.csv species ids, oldest favorite first
 */
export function listFavorites(db, userId) {
  return db
    .prepare('SELECT species_id FROM species_favorites WHERE user_id = ? ORDER BY created_at, species_id')
    .all(Number(userId))
    .map((row) => row.species_id);
}

/**
 * Mark or unmark one species. Idempotent either way.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userId: number, speciesId: string, favorite: boolean, now?: () => string }} args
 */
export function setFavorite(db, { userId, speciesId, favorite, now = () => new Date().toISOString() }) {
  if (favorite) {
    db.prepare(
      'INSERT INTO species_favorites (user_id, species_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
    ).run(Number(userId), speciesId, now());
  } else {
    db.prepare('DELETE FROM species_favorites WHERE user_id = ? AND species_id = ?').run(Number(userId), speciesId);
  }
}
