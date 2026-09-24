import { serializeProjectConfig } from './projectConfig.js';
import { normalizeFeatures, serializeFeatures } from './featureConfig.js';
import { toPlacementEntry, toPlacements } from './placements.js';

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

/**
 * Fetch the saved history. Entries come back with their plants as placements
 * (src/data/placements.js), whatever shape the file on disk still holds.
 *
 * This no longer compares history with planting_layout.csv: that is
 * src/history/reconcileLayout.js, run by the history controller's start()
 * against the plants the CSV built. `options.layoutCsv` is accepted and ignored
 * so the existing caller in app.js needs no change (nl-3s5.3 removes it).
 *
 * @param {(message: string, state: string) => void} [updateStatus]
 * @param {{ projectId?: string, fetchFn?: Function, layoutCsv?: string }} [options]
 * @returns {Promise<{ entries: Array<object>, cursor: number }>}
 */
export async function loadLayoutHistory(updateStatus, options = {}) {
  const fetchFn = options.fetchFn || defaultFetch();
  if (!fetchFn) {
    if (updateStatus) {
      updateStatus('Saving requires running `node server.js`', 'error');
    }
    return { entries: [], cursor: -1 };
  }

  try {
    const response = await fetchFn(apiUrl('/api/history', options.projectId), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`History request failed (${response.status})`);
    }
    const data = await response.json();
    const entries = (Array.isArray(data.entries) ? data.entries : []).map(toPlacementEntry);
    const reportedCursor =
      typeof data.cursor === 'number' && Number.isFinite(data.cursor)
        ? data.cursor
        : entries.length - 1;
    const cursor = entries.length
      ? Math.max(0, Math.min(reportedCursor, entries.length - 1))
      : -1;

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
  // Placements only: the server keeps what it is sent in history (nl-3s5.19).
  const payload = {
    plants: toPlacements(plants),
    description: description || DEFAULT_DESCRIPTION,
  };
  if (Array.isArray(options.previousPlants) && options.previousPlants.length) {
    payload.previousPlants = toPlacements(options.previousPlants);
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

/**
 * Load the shared yard model — beds, hardscape, the house footprint.
 *
 * This goes through the API rather than fetching features.json off disk, and
 * the difference is not cosmetic: most projects have never drawn a feature, and
 * a static fetch for a file that is not there makes the browser log a 404 on
 * every single page load. The endpoint answers with an empty list instead.
 *
 * @param {(message: string, state: string) => void} [updateStatus]
 * @param {{ projectId?: string, fetchFn?: Function }} [options]
 * @returns {Promise<{ features: Array<object> }>} empty when nothing can be loaded
 */
export async function loadProjectFeatures(updateStatus, options = {}) {
  const empty = { features: [] };
  const fetchFn = options.fetchFn || defaultFetch();
  if (!fetchFn) return empty;
  try {
    const response = await fetchFn(apiUrl('/api/features', options.projectId), {
      cache: 'no-store',
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `Features request failed (${response.status})`);
    }
    // Normalized again on arrival: the drawing reads style and heightFt off
    // every feature, and a response is no more trusted than a file.
    return normalizeFeatures(await response.json(), options.projectId || 'project');
  } catch (err) {
    console.warn('Unable to load yard features', err);
    updateStatus?.(err.message || 'Unable to load yard features', 'error');
    return empty;
  }
}

/**
 * Save the yard model. Like the view config and unlike the layout there is no
 * history stack — features are setup, not a design decision worth undoing.
 *
 * @param {Array<object>} features normalized features
 * @param {(message: string, state: string) => void} [updateStatus]
 * @param {{ projectId?: string, fetchFn?: Function }} [options]
 */
export async function persistFeatures(features, updateStatus, options = {}) {
  if (!Array.isArray(features)) return null;
  const fetchFn = options.fetchFn || defaultFetch();
  if (!fetchFn) {
    updateStatus?.('Saving requires running `node server.js`', 'error');
    return null;
  }
  try {
    const response = await fetchFn(apiUrl('/api/features', options.projectId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeFeatures({ features })),
    });
    if (!response.ok) {
      // The server explains what it rejected; surface that rather than a bare code.
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `Feature save failed (${response.status})`);
    }
    const data = await response.json();
    updateStatus?.('Features saved', 'success');
    return data;
  } catch (err) {
    console.warn('Unable to persist yard features', err);
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
