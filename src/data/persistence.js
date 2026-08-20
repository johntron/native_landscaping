import { serializeProjectConfig } from './projectConfig.js';
import { buildLayoutCsv } from './layoutExporter.js';

const DEFAULT_DESCRIPTION = 'Manual layout update';

/** Scope an API call to a project so the server writes the right layout file. */
function apiUrl(path, projectId) {
  return projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path;
}

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
    const response = await fetchFn(apiUrl('/api/history', options.projectId), { cache: 'no-store' });
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
  // An empty array is a legitimate layout — removing the last plant must still
  // reach disk, or the deletion silently survives only until the next reload.
  if (!Array.isArray(plants)) return null;
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
    const response = await fetchFn(apiUrl('/api/layout', options.projectId), {
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

/**
 * Save the project's view configuration. Unlike the layout there is no history
 * stack — a view's geometry is setup, not a design decision worth undoing, and
 * the layout history machinery stays layout-only.
 *
 * @param {object} config a normalized project config
 * @param {(message: string, state: string) => void} [updateStatus]
 * @param {{ projectId?: string, fetchFn?: Function }} [options]
 */
export async function persistProjectConfig(config, updateStatus, options = {}) {
  if (!config || typeof config !== 'object') return null;
  const fetchFn = options.fetchFn || defaultFetch();
  if (!fetchFn) {
    updateStatus?.('Saving requires running `node server.js`', 'error');
    return null;
  }
  try {
    const response = await fetchFn(apiUrl('/api/project', options.projectId || config.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeProjectConfig(config)),
    });
    if (!response.ok) {
      // The server explains what it rejected; surface that rather than a bare code.
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `View config save failed (${response.status})`);
    }
    const data = await response.json();
    updateStatus?.('Views saved', 'success');
    return data;
  } catch (err) {
    console.warn('Unable to persist view config', err);
    updateStatus?.(err.message || 'Saving requires running `node server.js`', 'error');
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
    const response = await fetchFn(apiUrl('/api/history/cursor', options.projectId), {
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
