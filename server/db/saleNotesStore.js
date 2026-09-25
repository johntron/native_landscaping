// Raw notes an admin jots down on plant sales they've found (nl-2bw), so they
// can be read later, researched, and turned by hand into a sourced row of
// sourcing/plant-sales.csv. Table: server/db/migrations/006_sale_notes.sql.
// Admin-only end to end; server/routes/saleNotes.js is the only caller other
// than tools/list-sale-notes.mjs (read-only, for reading them back).

/** Judgement call, not a measured limit: long enough for a real note, short enough to keep the table light. */
export const MAX_BODY_LENGTH = 5000;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{ id: number, authorId: number, authorEmail: string, body: string, createdAt: string }>} newest first
 */
export function listSaleNotes(db) {
  return db
    .prepare(
      `SELECT sale_notes.id, sale_notes.author_id, users.email AS author_email, sale_notes.body, sale_notes.created_at
         FROM sale_notes
         JOIN users ON users.id = sale_notes.author_id
        ORDER BY sale_notes.created_at DESC, sale_notes.id DESC`
    )
    .all()
    .map((row) => ({
      id: row.id,
      authorId: row.author_id,
      authorEmail: row.author_email,
      body: row.body,
      createdAt: row.created_at,
    }));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ authorId: number, body: string, now?: () => string }} args
 * @returns {{ id: number, authorId: number, body: string, createdAt: string }}
 */
export function createSaleNote(db, { authorId, body, now = () => new Date().toISOString() }) {
  const createdAt = now();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO sale_notes (author_id, body, created_at) VALUES (?, ?, ?)')
    .run(authorId, body, createdAt);
  return { id: Number(lastInsertRowid), authorId, body, createdAt };
}

/**
 * Delete a note by id. Not owner-scoped beyond "any admin can manage any
 * note" — these are the site's own research notes, not per-user data (unlike
 * a yard or a saved area), so any admin may delete any of them.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {boolean} whether a row was deleted
 */
export function deleteSaleNote(db, id) {
  const { changes } = db.prepare('DELETE FROM sale_notes WHERE id = ?').run(id);
  return changes > 0;
}
