/**
 * Decide which history entry a legacy planting_layout.csv was showing.
 *
 * Until nl-3s5.3 a yard was two files written together on every save and
 * every undo/redo: planting_layout.csv and layout-history.json. They could
 * still disagree (the CSV edited by hand or by a tool, or a save that wrote
 * the CSV and failed before the history), and the design tool showed the CSV,
 * so the layout file always won. Yards now live in app.db, where history is
 * the only copy and the layout is the entry at the cursor, so this runs in
 * exactly one place: server/db/projectImport.js, once per yard, so the
 * imported yard shows what the old app showed. The browser no longer calls it.
 *
 * - 'empty':    there is no history. The stack starts from the layout file.
 * - 'current':  the entry at the cursor is the layout file. Nothing to do.
 * - 'moved':    another entry is the layout file (the latest one that is). The
 *               cursor moves there and every entry is kept, so redo still works;
 *               the import stores that cursor.
 * - 'diverged': no entry is the layout file. History up to the cursor is kept
 *               (so undo still reaches the last state made in the app), and the
 *               import appends the layout file as a new entry, "Layout file
 *               edited outside the app", exactly as the old client saved one.
 *
 * "Is the layout file" is sameLayout (src/data/placements.js): same plants in
 * the same order, same ids and species ids, same coordinates as the CSV writes
 * them. It replaces turning every entry back into CSV text and comparing that.
 *
 * Pure: no DOM, no fetch.
 */
import { sameLayout } from '../data/placements.js';

/**
 * @param {Array<{plants?: Array<object>}>} entries  the saved history
 * @param {number} cursor                            the saved cursor
 * @param {Array<object>} layoutPlants               the plants planting_layout.csv holds
 * @returns {{ entries: Array<object>, cursor: number, verdict: 'empty'|'current'|'moved'|'diverged' }}
 */
export function reconcileHistoryWithLayout(entries, cursor, layoutPlants) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return { entries: [], cursor: -1, verdict: 'empty' };

  const reported = Number.isFinite(cursor) ? cursor : list.length - 1;
  const at = Math.max(0, Math.min(reported, list.length - 1));

  if (sameLayout(list[at]?.plants, layoutPlants)) {
    return { entries: list, cursor: at, verdict: 'current' };
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (sameLayout(list[i]?.plants, layoutPlants)) {
      return { entries: list, cursor: i, verdict: 'moved' };
    }
  }
  return { entries: list.slice(0, at + 1), cursor: at, verdict: 'diverged' };
}
