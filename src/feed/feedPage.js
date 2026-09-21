/**
 * Feed UI shell (nl-1qy.1.4) — the "trivial all-new-observations feed" that
 * validates the pipeline built by nl-1qy.1.1 (event log), .1.2 (saved
 * areas), and .1.3 (/api/feed + read/dismiss state) end to end, before any
 * feature-specific lane (invasive/rarity/yard-relevance) is layered on top.
 *
 * Saved areas are independent of yard projects (see
 * tools/savedAreas/savedAreasDb.js), so this page has no project-scoping —
 * it manages its own area picker against /api/saved-areas directly.
 */
const AREA_QUERY_PARAM = 'area';
const AREA_STORAGE_KEY = 'feed.selectedAreaId';
const PAGE_SIZE = 25;

const areaSelect = document.getElementById('areaSelect');
const newAreaToggle = document.getElementById('newAreaToggle');
const newAreaForm = document.getElementById('newAreaForm');
const newAreaCancel = document.getElementById('newAreaCancel');
const areaNote = document.getElementById('areaNote');
const taxonFilter = document.getElementById('taxonFilter');
const unreadOnlyEl = document.getElementById('unreadOnly');
const includeDismissedEl = document.getElementById('includeDismissed');
const refreshBtn = document.getElementById('refreshFeed');
const feedCountEl = document.getElementById('feedCount');
const feedListEl = document.getElementById('feedList');
const loadMoreBtn = document.getElementById('loadMore');

let areas = [];
let selectedAreaId = null;
let items = []; // accumulated across "Load more"
let page = 1;
let total = 0;

async function init() {
  await loadAreas();
  wireControls();
}

async function loadAreas() {
  areaSelect.innerHTML = '<option value="">Loading areas…</option>';
  let body;
  try {
    const response = await fetch('/api/saved-areas');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (err) {
    areaSelect.innerHTML = '<option value="">Failed to load areas</option>';
    console.error(err);
    return;
  }
  areas = body.areas || [];

  if (!areas.length) {
    areaSelect.innerHTML = '<option value="">No saved areas yet — add one</option>';
    areaNote.textContent = 'No saved areas yet. Use "+ New area" to add one.';
    return;
  }

  areaSelect.innerHTML = areas
    .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`)
    .join('');

  const fromQuery = new URLSearchParams(window.location.search).get(AREA_QUERY_PARAM);
  const fromStorage = safeLocalStorageGet(AREA_STORAGE_KEY);
  const candidate = [fromQuery, fromStorage].find((id) => id && areas.some((a) => a.id === id));
  selectedAreaId = candidate || areas[0].id;
  areaSelect.value = selectedAreaId;
  areaNote.textContent = '';

  await loadFeed({ reset: true });
}

function wireControls() {
  areaSelect.addEventListener('change', () => {
    selectedAreaId = areaSelect.value || null;
    safeLocalStorageSet(AREA_STORAGE_KEY, selectedAreaId);
    updateAreaQueryParam();
    if (selectedAreaId) loadFeed({ reset: true });
  });

  newAreaToggle.addEventListener('click', () => {
    newAreaForm.hidden = !newAreaForm.hidden;
  });
  newAreaCancel.addEventListener('click', () => {
    newAreaForm.reset();
    newAreaForm.hidden = true;
  });
  newAreaForm.addEventListener('submit', onCreateArea);

  taxonFilter.addEventListener('change', renderItems);
  unreadOnlyEl.addEventListener('change', () => loadFeed({ reset: true }));
  includeDismissedEl.addEventListener('change', () => loadFeed({ reset: true }));
  refreshBtn.addEventListener('click', () => loadFeed({ reset: true }));
  loadMoreBtn.addEventListener('click', () => loadFeed({ reset: false }));
}

async function onCreateArea(evt) {
  evt.preventDefault();
  const name = document.getElementById('newAreaName').value.trim();
  const lat = Number(document.getElementById('newAreaLat').value);
  const lng = Number(document.getElementById('newAreaLng').value);
  const radiusMi = Number(document.getElementById('newAreaRadius').value);
  try {
    const response = await fetch('/api/saved-areas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, lat, lng, radiusMi }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    newAreaForm.reset();
    newAreaForm.hidden = true;
    await loadAreas();
    selectedAreaId = body.area.id;
    areaSelect.value = selectedAreaId;
    safeLocalStorageSet(AREA_STORAGE_KEY, selectedAreaId);
    updateAreaQueryParam();
    await loadFeed({ reset: true });
  } catch (err) {
    areaNote.textContent = `Could not save area: ${err.message}`;
  }
}

function updateAreaQueryParam() {
  const url = new URL(window.location.href);
  if (selectedAreaId) url.searchParams.set(AREA_QUERY_PARAM, selectedAreaId);
  else url.searchParams.delete(AREA_QUERY_PARAM);
  window.history.replaceState(null, '', url.toString());
}

async function loadFeed({ reset }) {
  if (!selectedAreaId) return;
  if (reset) {
    page = 1;
    items = [];
    feedListEl.innerHTML = '<li class="feed-empty">Loading…</li>';
  } else {
    page += 1;
  }

  const params = new URLSearchParams({
    area_id: selectedAreaId,
    page: String(page),
    page_size: String(PAGE_SIZE),
    unread_only: String(unreadOnlyEl.checked),
    include_dismissed: String(includeDismissedEl.checked),
  });

  let body;
  try {
    const response = await fetch(`/api/feed?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (err) {
    feedListEl.innerHTML = `<li class="feed-empty">Failed to load feed: ${escapeHtml(err.message)}</li>`;
    console.error(err);
    return;
  }

  total = body.total;
  items = reset ? body.items : items.concat(body.items);
  refreshTaxonOptions();
  renderItems();
  loadMoreBtn.hidden = items.length >= total;
}

function refreshTaxonOptions() {
  const current = taxonFilter.value;
  const taxa = [...new Set(items.map((i) => i.iconic_taxon).filter(Boolean))].sort();
  taxonFilter.innerHTML =
    '<option value="">All</option>' + taxa.map((t) => `<option value="${t}">${t}</option>`).join('');
  if (taxa.includes(current)) taxonFilter.value = current;
}

function renderItems() {
  const taxon = taxonFilter.value;
  const visible = taxon ? items.filter((i) => i.iconic_taxon === taxon) : items;

  feedCountEl.textContent = `${visible.length} of ${total}`;

  if (!visible.length) {
    feedListEl.innerHTML = '<li class="feed-empty">Nothing here yet.</li>';
    return;
  }

  feedListEl.innerHTML = visible.map(renderItem).join('');

  feedListEl.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', onItemAction);
  });
}

function renderItem(item) {
  const classes = ['feed-item'];
  if (item.read) classes.push('feed-item--read');
  if (item.dismissed) classes.push('feed-item--dismissed');

  const thumb = item.photo_url
    ? `<img class="feed-item__thumb" src="${escapeHtml(item.photo_url)}" alt="" loading="lazy" />`
    : '<div class="feed-item__thumb"></div>';

  const title = escapeHtml(item.taxon_name || 'Unknown species');
  const common = item.common_name ? ` <span class="feed-item__common">(${escapeHtml(item.common_name)})</span>` : '';
  const link = item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">iNaturalist</a>` : '';

  return `
    <li class="${classes.join(' ')}" data-observation-id="${item.observation_id}">
      ${thumb}
      <div class="feed-item__body">
        <div class="feed-item__title">${title}${common}</div>
        <div class="feed-item__meta">
          ${escapeHtml(item.iconic_taxon || '')} · ${escapeHtml(item.observed_on || 'unknown date')}
          · ${escapeHtml(item.quality_grade || '')} ${link}
        </div>
      </div>
      <div class="feed-item__actions">
        <button type="button" class="pill-button" data-action="toggle-read">
          ${item.read ? 'Mark unread' : 'Mark read'}
        </button>
        <button type="button" class="pill-button pill-button--danger" data-action="toggle-dismiss">
          ${item.dismissed ? 'Restore' : 'Dismiss'}
        </button>
      </div>
    </li>
  `;
}

async function onItemAction(evt) {
  const li = evt.currentTarget.closest('[data-observation-id]');
  const observationId = Number(li.dataset.observationId);
  const item = items.find((i) => i.observation_id === observationId);
  if (!item) return;

  const action = evt.currentTarget.dataset.action;
  const patch = action === 'toggle-read' ? { read: !item.read } : { dismissed: !item.dismissed };

  try {
    const response = await fetch('/api/feed/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ areaId: selectedAreaId, observationId, ...patch }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    Object.assign(item, { read: body.state.read, dismissed: body.state.dismissed });

    // A now-read or now-dismissed item may no longer belong in the current
    // view (unread-only / dismissed-hidden) — refetch rather than patch the
    // list in place, so counts and "Load more" stay correct.
    if ((unreadOnlyEl.checked && item.read) || (!includeDismissedEl.checked && item.dismissed)) {
      await loadFeed({ reset: true });
    } else {
      renderItems();
    }
  } catch (err) {
    console.error(err);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function safeLocalStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Ignore — a private window or blocked storage just means the area
    // choice won't survive a reload.
  }
}

init();
