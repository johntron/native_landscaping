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
  try {
    const response = await fetchFn('/api/history', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`History request failed (${response.status})`);
    }
    const data = await response.json();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const cursor = typeof data.cursor === 'number' && Number.isFinite(data.cursor)
      ? data.cursor
      : entries.length - 1;
    if (updateStatus) {
      updateStatus(entries.length ? 'Loaded saved history' : 'Local history ready', 'success');
    }
    return { entries, cursor: cursor >= 0 ? cursor : -1 };
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
  try {
    const response = await fetchFn('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plants,
        description: description || DEFAULT_DESCRIPTION,
      }),
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
