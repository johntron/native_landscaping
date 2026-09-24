/**
 * The undo/redo stack: one revision per save of the planting, the setup or
 * the features (nl-3s5.20), in the same order and with the same indices as
 * the server's stream (server/db/projectStore.js).
 *
 * An entry is a full snapshot: `{ id, timestamp, description, kind, plants,
 * config, features }`. `plants` holds placements only, `{ id, speciesId, x, y }`
 * (src/data/placements.js): recording a list of full plant objects keeps just
 * where each plant stands and which species it is, and everything handed back
 * (undo, redo, getCurrentPlants) is placements for the caller to turn into
 * plants with plantsFromPlacements. Seed entries in the legacy full-object
 * shape are reduced the same way as they load (nl-3s5.19). `config` is the
 * setup in file shape (serializeProjectConfig) and `features` the features
 * file (`{ features: [...] }`, or null for none drawn). An entry that does not
 * give one carries the previous entry's, by reference, so a few hundred
 * planting revisions share one config object rather than copying it.
 */
import { toPlacements } from '../data/placements.js';

const DEFAULT_DESCRIPTION = 'Manual layout update';
export const REVISION_KINDS = Object.freeze(['planting', 'setup', 'features']);

function newEntryId() {
  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function kindOf(value) {
  return REVISION_KINDS.includes(value) ? value : 'planting';
}

/**
 * @param {Array<object>} [initialPlants]  the yard's plants when there is no history
 * @param {{ seedEntries?: Array<object>, initialCursor?: number|null,
 *   initialConfig?: object|null, initialFeatures?: object|null }} [options]
 *   initialConfig / initialFeatures are what the first entry carries when it
 *   (or the empty stack's base entry) does not say.
 */
export function createLayoutHistory(initialPlants = [], options = {}) {
  const { seedEntries = [], initialCursor = null, initialConfig = null, initialFeatures = null } = options;
  const entries = [];
  let cursor = -1;

  const carried = (key, fallback) => (entries.length ? entries[entries.length - 1][key] : fallback);

  const push = (plants, meta = {}) => {
    const base = entries[cursor];
    const entry = {
      id: meta.id || newEntryId(),
      timestamp: meta.timestamp || new Date().toISOString(),
      description: meta.description || DEFAULT_DESCRIPTION,
      kind: kindOf(meta.kind),
      plants: toPlacements(plants),
      config: 'config' in meta ? meta.config : base ? base.config : initialConfig,
      features: 'features' in meta ? meta.features : base ? base.features : initialFeatures,
    };
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
          id: seed.id || newEntryId(),
          timestamp: seed.timestamp || new Date().toISOString(),
          description: seed.description || DEFAULT_DESCRIPTION,
          kind: kindOf(seed.kind),
          plants: toPlacements(seed.plants),
          // A key that is present wins, even when null (no features drawn);
          // an absent one carries the entry before (GET /api/history's encoding).
          config: 'config' in seed ? seed.config : carried('config', initialConfig),
          features: 'features' in seed ? seed.features : carried('features', initialFeatures),
        });
      });
      cursor = entries.length - 1;
    }
    if (!entries.length) {
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

  /** Adopt the server's copy of an entry (id, timestamp, ...); plants are reduced. */
  const annotate = (entry, meta) => {
    if (!entry) return null;
    const { plants, ...rest } = meta || {};
    Object.assign(entry, rest);
    if (Array.isArray(plants)) entry.plants = toPlacements(plants);
    return entry;
  };

  return {
    /**
     * Record one revision after the cursor, dropping the redo tail.
     * `meta.kind` says what the save changed; `meta.config` / `meta.features`
     * replace the current entry's, which are carried otherwise.
     */
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
      return annotate(entries[cursor], meta);
    },
    /** Like annotateCurrentEntry, for the entry at `index` whatever the cursor. */
    annotateEntry(index, meta = {}) {
      return annotate(entries[index], meta);
    },
    /**
     * Take back the entry at `index` if it is the last one and the cursor is
     * on it: a save the server refused must not stay in the local stack, or
     * every later index would be one ahead of the server's. False otherwise.
     */
    dropTip(index) {
      if (index !== entries.length - 1 || cursor !== index || index <= 0) return false;
      entries.pop();
      cursor = entries.length - 1;
      return true;
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
    getEntry(index) {
      return entries[index] || null;
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
        kind: entry.kind,
        index,
      }));
    },
  };
}
