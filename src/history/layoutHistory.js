/**
 * The undo/redo stack. An entry holds placements only, `{ id, speciesId, x, y }`
 * (src/data/placements.js): recording a list of full plant objects keeps just
 * where each plant stands and which species it is, and everything handed back
 * (undo, redo, getCurrentPlants) is placements for the caller to turn into
 * plants with plantsFromPlacements. Seed entries in the legacy full-object shape
 * are reduced the same way as they load (nl-3s5.19).
 */
import { toPlacements } from '../data/placements.js';

const DEFAULT_DESCRIPTION = 'Manual layout update';

function makeEntry(plants, meta = {}) {
  return {
    id: meta.id || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: meta.timestamp || new Date().toISOString(),
    description: meta.description || DEFAULT_DESCRIPTION,
    plants,
  };
}

export function createLayoutHistory(initialPlants = [], options = {}) {
  const { seedEntries = [], initialCursor = null } = options;
  const entries = [];
  let cursor = -1;

  const push = (plants, meta = {}) => {
    const snapshot = toPlacements(plants);
    const entry = makeEntry(snapshot, meta);
    entries.splice(cursor + 1);
    entries.push(entry);
    cursor = entries.length - 1;
    return entry;
  };

  const initWithSeeds = () => {
    if (Array.isArray(seedEntries) && seedEntries.length) {
      seedEntries.forEach((seed) => {
        if (!seed || !Array.isArray(seed.plants)) return;
        entries.push({
          id: seed.id || makeEntry([], {}).id,
          timestamp: seed.timestamp || new Date().toISOString(),
          description: seed.description || DEFAULT_DESCRIPTION,
          plants: toPlacements(seed.plants),
        });
      });
      cursor = entries.length - 1;
    } else {
      push(initialPlants, { description: 'Current layout' });
    }
  };

  const clampCursor = (target) => {
    if (!entries.length) return -1;
    if (target < 0) return 0;
    if (target >= entries.length) return entries.length - 1;
    return target;
  };

  const moveTo = (target) => {
    if (!entries.length) return null;
    const next = clampCursor(target);
    if (next === cursor) return null;
    cursor = next;
    return toPlacements(entries[cursor].plants);
  };

  initWithSeeds();

  if (typeof initialCursor === 'number' && Number.isFinite(initialCursor)) {
    const target = clampCursor(initialCursor);
    if (target >= 0) {
      cursor = target;
    }
  }

  return {
    record(plants, meta = {}) {
      return push(plants, meta);
    },
    undo() {
      return moveTo(cursor - 1);
    },
    redo() {
      return moveTo(cursor + 1);
    },
    moveCursor(delta) {
      return moveTo(cursor + delta);
    },
    setCursor(target) {
      return moveTo(target);
    },
    annotateCurrentEntry(meta = {}) {
      const entry = entries[cursor];
      if (!entry) return null;
      // The server's copy of the entry (its id and timestamp) is adopted, but
      // its plants, if any, are reduced like every other snapshot.
      const { plants, ...rest } = meta || {};
      Object.assign(entry, rest);
      if (Array.isArray(plants)) entry.plants = toPlacements(plants);
      return entry;
    },
    canUndo() {
      return cursor > 0;
    },
    canRedo() {
      return cursor < entries.length - 1;
    },
    getCursor() {
      return cursor;
    },
    getCurrentEntry() {
      return entries[cursor] || null;
    },
    getCurrentPlants() {
      const entry = entries[cursor];
      return entry ? toPlacements(entry.plants) : [];
    },
    getEntries() {
      return entries.map((entry, index) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        description: entry.description,
        index,
      }));
    },
  };
}
