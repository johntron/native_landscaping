import { buildLayoutCsv } from './layoutExporter.js';

const DEFAULT_DESCRIPTION = 'Manual layout update';

function defaultFetch() {
  if (typeof fetch === 'function') {
    return fetch;
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch;
  }
  return null;
}

export async function loadLayoutHistory(updateStatus, options = {}) {
  const fetchFn = options.fetchFn || defaultFetch();
  if (!fetchFn) {
    if (updateStatus) {
      updateStatus('Saving requires running `node server.js`', 'error');
    }
    return { entries: [], cursor: -1 };
  }
  const layoutCsvText =
    typeof options.layoutCsv === 'string' ? options.layoutCsv.trim() : '';

  try {
    const response = await fetchFn('/api/history', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`History request failed (${response.status})`);
    }
    const data = await response.json();
    let entries = Array.isArray(data.entries) ? data.entries : [];
    const reportedCursor =
      typeof data.cursor === 'number' && Number.isFinite(data.cursor)
        ? data.cursor
        : entries.length - 1;
    let cursor = entries.length
      ? Math.max(0, Math.min(reportedCursor, entries.length - 1))
      : -1;

    if (layoutCsvText && entries.length) {
      const matchIndex = findHistoryEntryIndexByLayout(entries, layoutCsvText);
      if (matchIndex >= 0) {
        entries = entries.slice(0, matchIndex + 1);
        cursor = entries.length - 1;
      } else {
        if (updateStatus) {
          updateStatus('History diverged from planting_layout.csv; using CSV layout.', 'warning');
        }
        return { entries: [], cursor: -1 };
      }
    }

    if (updateStatus) {
      updateStatus(entries.length ? 'Loaded saved history' : 'Local history ready', 'success');
    }
    return { entries, cursor };
  } catch (err) {
    console.warn('Unable to load layout history', err);
    if (updateStatus) {
      updateStatus('Saving requires running `node server.js`', 'error');
    }
    return { entries: [], cursor: -1 };
  }
}

export async function persistLayout(plants, description, updateStatus, options = {}) {
  if (!Array.isArray(plants) || plants.length === 0) return null;
  const fetchFn = options.fetchFn || defaultFetch();
  if (!fetchFn) {
    if (updateStatus) {
      updateStatus('Saving requires running `node server.js`', 'error');
    }
    return null;
  }
  const payload = {
    plants,
    description: description || DEFAULT_DESCRIPTION,
  };
  if (Array.isArray(options.previousPlants) && options.previousPlants.length) {
    payload.previousPlants = options.previousPlants;
  }
  try {
    const response = await fetchFn('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Layout save failed (${response.status})`);
    }
    const data = await response.json();
    if (updateStatus) {
      updateStatus(`Last saved at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'success');
    }
    return data;
  } catch (err) {
    console.warn('Unable to persist layout', err);
    if (updateStatus) {
      updateStatus('Saving requires running `node server.js`', 'error');
    }
    return null;
  }
}

export async function updateHistoryCursor(cursor, updateStatus, options = {}) {
  const fetchFn = options.fetchFn || defaultFetch();
  if (!fetchFn) {
    if (updateStatus) {
      updateStatus('Saving requires running `node server.js`', 'error');
    }
    return null;
  }
  try {
    const response = await fetchFn('/api/history/cursor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor }),
    });
    if (!response.ok) {
      throw new Error(`Cursor update failed (${response.status})`);
    }
    const data = await response.json();
    if (updateStatus) {
      updateStatus(`History set to entry ${cursor + 1}`, 'success');
    }
    return data;
  } catch (err) {
    console.warn('Unable to update cursor', err);
    if (updateStatus) {
      updateStatus('Saving requires running `node server.js`', 'error');
    }
    return null;
  }
}

export function historyMatchesLayout(entries, cursor, layoutCsv) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const index =
    typeof cursor === 'number' && Number.isFinite(cursor)
      ? cursor
      : entries.length - 1;
  if (index < 0 || index >= entries.length) return false;
  const entry = entries[index];
  if (!entry || !Array.isArray(entry.plants)) return false;
  const entryCsv = buildLayoutCsv(entry.plants).trim();
  const layoutText = (layoutCsv || '').trim();
  return Boolean(entryCsv && layoutText && entryCsv === layoutText);
}

function findHistoryEntryIndexByLayout(entries, layoutCsv) {
  if (!Array.isArray(entries) || entries.length === 0) return -1;
  const normalized = (layoutCsv || '').trim();
  if (!normalized) return -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || !Array.isArray(entry.plants)) continue;
    const entryCsv = buildLayoutCsv(entry.plants).trim();
    if (entryCsv && entryCsv === normalized) {
      return i;
    }
  }
  return -1;
}
