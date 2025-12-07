const DEFAULT_DESCRIPTION = 'Manual layout update';

function clonePlants(plants) {
  if (!Array.isArray(plants)) return [];
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(plants);
    } catch (err) {
      // Fall through to JSON fallback.
    }
  }
  try {
    return JSON.parse(JSON.stringify(plants));
  } catch (err) {
    return plants.map((plant) => ({ ...plant }));
  }
}

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
    const snapshot = clonePlants(plants);
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
          plants: clonePlants(seed.plants),
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
    return clonePlants(entries[cursor].plants);
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
      Object.assign(entry, meta);
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
      return entry ? clonePlants(entry.plants) : [];
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
