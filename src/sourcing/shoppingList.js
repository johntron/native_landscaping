/**
 * The shopping list on sourcing.html (nl-46b): every planned plant in a
 * person's yards, by species, so they know what to buy. Pure: no DOM, no
 * fetch. The server counts with plannedCounts (server/routes/shoppingList.js);
 * the page builds its rows with buildShoppingList (src/sourcing/shoppingListPage.js).
 *
 * "Planned" is the lifecycle's own word (src/data/plantLifecycle.js): a plant
 * in the yard's current revision that is not marked planted.
 */
import { lifecycleOf, STATUS_PLANNED } from '../data/plantLifecycle.js';
import { nativeStanding } from '../data/speciesSearch.js';

/**
 * How many planned plants of each species a yard's placements hold.
 * @param {Array<{speciesId?: string}>} placements the yard's current revision
 * @returns {Record<string, number>} species id -> count; planted plants and ids-less rows are left out
 */
export function plannedCounts(placements) {
  const counts = {};
  (placements || []).forEach((placement) => {
    const id = placement?.speciesId;
    if (!id || lifecycleOf(placement).status !== STATUS_PLANNED) return;
    counts[id] = (counts[id] || 0) + 1;
  });
  return counts;
}

/**
 * @typedef {{ id: string, name: string, planned: Record<string, number> }} YardCounts
 * @typedef {{
 *   speciesId: string, commonName: string, botanicalName: string,
 *   standing: 'native'|'cultivar'|'introduced'|'unconfirmed',
 *   favorite: boolean, total: number,
 *   byYard: Array<{ id: string, name: string, count: number }>
 * }} ShoppingRow
 */

/**
 * The list's rows: one per species planned in any included yard, favorites
 * first, then by common name; and the favorites planned in none of them
 * ("wanted, not yet placed"), by common name. A species id the catalog no
 * longer carries still gets a row, under its id, so nothing planned is hidden.
 * @param {{
 *   yards: YardCounts[],
 *   species: Array<{speciesId: string, commonName?: string, botanicalName?: string, nativity?: string}>,
 *   favorites?: Iterable<string>,
 *   includedYardIds?: Iterable<string>|null  null or omitted: every yard
 * }} args
 * @returns {{ rows: ShoppingRow[], wanted: ShoppingRow[], totalPlants: number }}
 */
export function buildShoppingList({ yards, species, favorites = [], includedYardIds = null }) {
  const bySpecies = new Map((species || []).map((entry) => [entry.speciesId, entry]));
  const favoriteIds = new Set(favorites);
  const included = includedYardIds ? new Set(includedYardIds) : null;
  const rowsById = new Map();

  const rowFor = (speciesId) => {
    let row = rowsById.get(speciesId);
    if (!row) {
      const entry = bySpecies.get(speciesId) || { speciesId };
      row = {
        speciesId,
        commonName: entry.commonName || entry.botanicalName || speciesId,
        botanicalName: entry.botanicalName || '',
        standing: nativeStanding(entry),
        favorite: favoriteIds.has(speciesId),
        total: 0,
        byYard: [],
      };
      rowsById.set(speciesId, row);
    }
    return row;
  };

  (yards || []).forEach((yard) => {
    if (included && !included.has(yard.id)) return;
    Object.entries(yard.planned || {}).forEach(([speciesId, count]) => {
      if (!(count > 0)) return;
      const row = rowFor(speciesId);
      row.total += count;
      row.byYard.push({ id: yard.id, name: yard.name, count });
    });
  });

  const byName = (a, b) =>
    a.commonName.localeCompare(b.commonName, undefined, { sensitivity: 'base' }) ||
    a.botanicalName.localeCompare(b.botanicalName, undefined, { sensitivity: 'base' });
  const rows = [...rowsById.values()].sort((a, b) => Number(b.favorite) - Number(a.favorite) || byName(a, b));
  const wanted = [...favoriteIds]
    .filter((id) => !rowsById.has(id) && bySpecies.has(id))
    .map((id) => rowFor(id))
    .sort(byName);
  const totalPlants = rows.reduce((sum, row) => sum + row.total, 0);
  return { rows, wanted, totalPlants };
}

/**
 * The list as plain text, to paste into a note or a message before a sale.
 * @param {{ rows: ShoppingRow[], wanted: ShoppingRow[] }} list
 * @returns {string}
 */
export function shoppingListText({ rows, wanted }) {
  const name = (row) => (row.botanicalName ? `${row.commonName} (${row.botanicalName})` : row.commonName);
  const lines = rows.map((row) => {
    const yards = row.byYard.map((y) => `${y.name} ${y.count}`).join(', ');
    return `${row.favorite ? '★ ' : ''}${row.total} × ${name(row)}${yards ? ` — ${yards}` : ''}`;
  });
  if (wanted.length) {
    lines.push('', 'Wanted, not yet placed:');
    wanted.forEach((row) => lines.push(`★ ${name(row)}`));
  }
  return lines.join('\n');
}
