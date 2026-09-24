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
const editAreaToggle = document.getElementById('editAreaToggle');
const pollAreaNowBtn = document.getElementById('pollAreaNow');
const pollAreaNote = document.getElementById('pollAreaNote');
const areaSummaryEl = document.getElementById('areaSummary');
const areaForm = document.getElementById('areaForm');
const areaFormCancel = document.getElementById('areaFormCancel');
const areaFormSubmit = document.getElementById('areaFormSubmit');
const areaFormName = document.getElementById('areaFormName');
const areaFormAddress = document.getElementById('areaFormAddress');
const areaFormGeocodeBtn = document.getElementById('areaFormGeocode');
const areaFormGeocodeNote = document.getElementById('areaFormGeocodeNote');
const areaFormLat = document.getElementById('areaFormLat');
const areaFormLng = document.getElementById('areaFormLng');
const areaFormRadius = document.getElementById('areaFormRadius');
const areaFormEcoregion = document.getElementById('areaFormEcoregion');
const areaFormEcoregionNote = document.getElementById('areaFormEcoregionNote');
const areaFormPlace = document.getElementById('areaFormPlace');
const areaFormPlaceNote = document.getElementById('areaFormPlaceNote');
const areaNote = document.getElementById('areaNote');
const ECOREGION_NOTE_DEFAULT = 'Needed for the yard-relevance lane below.';
const PLACE_NOTE_DEFAULT =
  'Needed for the rarity lane below — must match a place already indexed by tools/fetch-ecosystem-index.mjs.';
let formMode = null; // 'create' | 'edit' | null (form hidden)
const taxonFilter = document.getElementById('taxonFilter');
const laneFilter = document.getElementById('laneFilter');
const rarityThresholdField = document.getElementById('rarityThresholdField');
const rarityThresholdEl = document.getElementById('rarityThreshold');
const rarityConservationStatusField = document.getElementById('rarityConservationStatusField');
const rarityConservationStatusEl = document.getElementById('rarityConservationStatus');
const rarityProtectedSpeciesField = document.getElementById('rarityProtectedSpeciesField');
const rarityProtectedSpeciesEl = document.getElementById('rarityProtectedSpecies');
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

const SIGN_IN_MESSAGE = 'Sign in to see your saved areas and feed.';

/**
 * The message to show for a failed API response. Saved areas and the feed are
 * per-user (nl-3s5.5), so a 401 means "not signed in", and says so plainly
 * rather than surfacing "HTTP 401". A 404 on an area id means it is gone or
 * not yours; the server's own message says which id.
 *
 * @param {Response} response
 * @param {{ error?: string } | null} [body] the parsed JSON body, when there is one
 */
function apiErrorMessage(response, body) {
  if (response.status === 401) return SIGN_IN_MESSAGE;
  return body?.error || `HTTP ${response.status}`;
}

/** Parse a JSON body, or null when the response has none (e.g. a proxy's HTML error page). */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function init() {
  await loadAreas();
  wireControls();
}

async function loadAreas() {
  areaSelect.innerHTML = '<option value="">Loading areas…</option>';
  let body;
  try {
    const response = await fetch('/api/saved-areas');
    body = await readJson(response);
    if (!response.ok) throw new Error(apiErrorMessage(response, body));
  } catch (err) {
    areaSelect.innerHTML = '<option value="">Failed to load areas</option>';
    areaNote.textContent = err.message;
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
  syncAreaSummary();

  await loadFeed({ reset: true });
}

/** Read-only "ecoregion / place" line under the picker, so the current values are visible without opening the edit form. */
function syncAreaSummary() {
  const area = areas.find((a) => a.id === selectedAreaId);
  if (!area) {
    areaSummaryEl.textContent = '';
    return;
  }
  areaSummaryEl.textContent = `Ecoregion: ${area.filters?.ecoregion || 'none'} · Place: ${area.filters?.place || 'none'}`;
}

function wireControls() {
  areaSelect.addEventListener('change', () => {
    selectedAreaId = areaSelect.value || null;
    safeLocalStorageSet(AREA_STORAGE_KEY, selectedAreaId);
    updateAreaQueryParam();
    syncAreaSummary();
    if (selectedAreaId) loadFeed({ reset: true });
  });

  newAreaToggle.addEventListener('click', () => openAreaForm('create'));
  editAreaToggle.addEventListener('click', () => {
    if (selectedAreaId) openAreaForm('edit');
  });
  areaFormCancel.addEventListener('click', closeAreaForm);
  areaForm.addEventListener('submit', onSubmitAreaForm);
  areaFormGeocodeBtn.addEventListener('click', onGeocodeClick);
  pollAreaNowBtn.addEventListener('click', onPollAreaNow);

  taxonFilter.addEventListener('change', renderItems);
  laneFilter.addEventListener('change', () => {
    const isRarity = laneFilter.value === 'rarity';
    rarityThresholdField.hidden = !isRarity;
    rarityConservationStatusField.hidden = !isRarity;
    rarityProtectedSpeciesField.hidden = !isRarity;
    loadFeed({ reset: true });
  });
  rarityThresholdEl.addEventListener('change', () => loadFeed({ reset: true }));
  rarityConservationStatusEl.addEventListener('change', () => loadFeed({ reset: true }));
  rarityProtectedSpeciesEl.addEventListener('change', () => loadFeed({ reset: true }));
  unreadOnlyEl.addEventListener('change', () => loadFeed({ reset: true }));
  includeDismissedEl.addEventListener('change', () => loadFeed({ reset: true }));
  refreshBtn.addEventListener('click', () => loadFeed({ reset: true }));
  loadMoreBtn.addEventListener('click', () => loadFeed({ reset: false }));
}

async function onPollAreaNow() {
  if (!selectedAreaId) return;
  pollAreaNowBtn.disabled = true;
  pollAreaNote.textContent = 'Checking iNaturalist…';
  try {
    const response = await fetch('/api/feed/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ areaId: selectedAreaId }),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(apiErrorMessage(response, body));
    const { fetched } = body.result;
    pollAreaNote.textContent = fetched
      ? `Found ${fetched} new observation${fetched === 1 ? '' : 's'}.`
      : 'No new observations.';
    if (fetched) await loadFeed({ reset: true });
  } catch (err) {
    pollAreaNote.textContent = `Could not fetch: ${err.message}`;
  } finally {
    pollAreaNowBtn.disabled = false;
  }
}

/** Open the create/edit area form. Both modes share one form and the same address-lookup/ecoregion/place-suggestion flow (nl-5nm) — only the submit target differs (POST vs PUT). */
function openAreaForm(mode) {
  formMode = mode;
  areaForm.hidden = false;
  areaFormAddress.value = '';
  areaFormGeocodeNote.textContent = '';

  if (mode === 'edit') {
    const area = areas.find((a) => a.id === selectedAreaId);
    if (!area) return;
    areaFormName.value = area.name;
    areaFormLat.value = area.lat;
    areaFormLng.value = area.lng;
    areaFormRadius.value = area.radiusMi;
    areaFormEcoregion.value = area.filters?.ecoregion || '';
    areaFormPlace.value = area.filters?.place || '';
    areaFormSubmit.textContent = 'Save changes';
  } else {
    areaForm.reset();
    areaFormSubmit.textContent = 'Save area';
  }
  areaFormEcoregionNote.textContent = ECOREGION_NOTE_DEFAULT;
  areaFormPlaceNote.textContent = PLACE_NOTE_DEFAULT;
}

function closeAreaForm() {
  areaForm.reset();
  areaForm.hidden = true;
  formMode = null;
}

/** Address/city/ZIP -> lat/lng (POST /api/geocode), then immediately chains the ecoregion detection and place suggestion off the result — a person shouldn't have to trigger three separate lookups for one typed location. */
async function onGeocodeClick() {
  const query = areaFormAddress.value.trim();
  if (!query) return;
  areaFormGeocodeBtn.disabled = true;
  areaFormGeocodeNote.textContent = 'Looking up…';
  try {
    const response = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    areaFormLat.value = body.lat;
    areaFormLng.value = body.lng;
    areaFormGeocodeNote.textContent = `Found: ${body.displayName}`;
    await Promise.all([detectEcoregion(body.lat, body.lng), suggestPlace(body.city)]);
  } catch (err) {
    areaFormGeocodeNote.textContent = `Could not look up "${query}": ${err.message}`;
  } finally {
    areaFormGeocodeBtn.disabled = false;
  }
}

/** GET /api/ecoregion for a detected point, via the live CEC/EPA Level I FeatureServer lookup (tools/ecoregionLookup.mjs) — a real sourced answer, so it's safe to fill the field with, unlike a guess. A detected code this project has no keystone-genus data for is still filled in (it IS the ecoregion) but flagged as unusable by the yard-relevance lane, rather than silently swapped for something else. */
async function detectEcoregion(lat, lng) {
  try {
    const response = await fetch(`/api/ecoregion?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (!body.code) {
      areaFormEcoregionNote.textContent = 'No ecoregion found for this location.';
      return;
    }
    areaFormEcoregion.value = body.code;
    areaFormEcoregionNote.textContent = body.known
      ? `Detected: ${body.code} (${body.name}).`
      : `Detected: ${body.code} (${body.name}) — this project has no keystone-genus data for it yet, so the yard-relevance lane will report it as not declared.`;
  } catch (err) {
    areaFormEcoregionNote.textContent = `Could not detect ecoregion: ${err.message}`;
  }
}

/** Suggests (never auto-applies) a place name from the geocoded city, and says whether data/ecosystem.db already has an index for it (GET /api/ecosystem/places) — the rarity lane needs a place someone has actually run tools/fetch-ecosystem-index.mjs for, not just a plausible-looking label. */
async function suggestPlace(city) {
  if (!city) {
    areaFormPlaceNote.textContent = PLACE_NOTE_DEFAULT;
    return;
  }
  try {
    const response = await fetch('/api/ecosystem/places');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const indexed = (body.places || []).includes(city);
    areaFormPlaceNote.innerHTML =
      `Suggested place: <button type="button" class="pill-button" id="areaFormPlaceSuggestion">${escapeHtml(city)}</button> — ` +
      (indexed ? 'indexed ✓' : 'not indexed yet (run tools/fetch-ecosystem-index.mjs for it first)');
    document.getElementById('areaFormPlaceSuggestion')?.addEventListener('click', () => {
      areaFormPlace.value = city;
    });
  } catch (err) {
    areaFormPlaceNote.textContent = `Could not check indexed places: ${err.message}`;
  }
}

async function onSubmitAreaForm(evt) {
  evt.preventDefault();
  const name = areaFormName.value.trim();
  const lat = Number(areaFormLat.value);
  const lng = Number(areaFormLng.value);
  const radiusMi = Number(areaFormRadius.value);
  const ecoregion = areaFormEcoregion.value.trim();
  const place = areaFormPlace.value.trim();
  const filters = {};
  if (ecoregion) filters.ecoregion = ecoregion;
  if (place) filters.place = place;

  const isEdit = formMode === 'edit' && selectedAreaId;
  const url = isEdit ? `/api/saved-areas/${encodeURIComponent(selectedAreaId)}` : '/api/saved-areas';
  try {
    const response = await fetch(url, {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, lat, lng, radiusMi, filters }),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(apiErrorMessage(response, body));
    closeAreaForm();
    // loadAreas() picks a selection from the query param/localStorage, which
    // for a brand-new area point at nothing yet — refresh the list first,
    // then force the selection to the area just saved, same order the old
    // create-only flow used.
    await loadAreas();
    selectedAreaId = body.area.id;
    areaSelect.value = selectedAreaId;
    safeLocalStorageSet(AREA_STORAGE_KEY, selectedAreaId);
    updateAreaQueryParam();
    syncAreaSummary();
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
  if (laneFilter.value) params.set('lane', laneFilter.value);
  if (laneFilter.value === 'rarity') {
    if (rarityThresholdEl.value.trim() !== '') {
      params.set('rarity_threshold', rarityThresholdEl.value.trim());
    }
    if (rarityConservationStatusEl.checked) params.set('rarity_conservation_status', 'true');
    if (rarityProtectedSpeciesEl.checked) params.set('rarity_protected_species', 'true');
  }

  let body;
  try {
    const response = await fetch(`/api/feed?${params}`);
    body = await readJson(response);
    if (!response.ok) throw new Error(apiErrorMessage(response, body));
  } catch (err) {
    feedListEl.innerHTML = `<li class="feed-empty">Failed to load feed: ${escapeHtml(err.message)}</li>`;
    console.error(err);
    return;
  }

  total = body.total;
  items = reset ? body.items : items.concat(body.items);
  refreshTaxonOptions();
  if (body.warning) {
    feedListEl.innerHTML = `<li class="feed-empty">${escapeHtml(body.warning)}</li>`;
    feedCountEl.textContent = '';
    loadMoreBtn.hidden = true;
    return;
  }
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
  const relevance = item.relevance ? `<div class="feed-item__relevance">${describeRelevance(item.relevance)}</div>` : '';

  return `
    <li class="${classes.join(' ')}" data-observation-id="${item.observation_id}">
      ${thumb}
      <div class="feed-item__body">
        <div class="feed-item__title">${title}${common}</div>
        <div class="feed-item__meta">
          ${escapeHtml(item.iconic_taxon || '')} · ${escapeHtml(item.observed_on || 'unknown date')}
          · ${escapeHtml(item.quality_grade || '')} ${link}
        </div>
        ${relevance}
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

/** Facts only, no invented score — matches the yard-relevance lane's classifier (src/analysis/yardRelevance.js). */
function describeRelevance(relevance) {
  if (relevance.kind === 'missing-genus') {
    return `Keystone genus <em>${escapeHtml(relevance.genus)}</em> — missing from the catalog.`;
  }
  if (relevance.kind === 'associated-fauna') {
    const genera = relevance.matches.map((m) => `<em>${escapeHtml(m.genus)}</em> (missing)`).join(', ');
    return `Documented to use: ${genera}.`;
  }
  if (relevance.kind === 'invasive-watchlist') {
    const firstSeen = relevance.firstSeenHere ? ' — first time this area has logged it.' : '';
    return `On the invasive watchlist: ${escapeHtml(relevance.commonName)}.${firstSeen}`;
  }
  if (relevance.kind === 'local-scarcity') {
    const count = relevance.observationCount;
    return `Locally scarce: ${count} observation${count === 1 ? '' : 's'} recorded nearby.`;
  }
  if (relevance.kind === 'conservation-status') {
    const name = relevance.statusName ? ` (${escapeHtml(relevance.statusName)})` : '';
    return `Conservation status: ${escapeHtml(relevance.status)}${name}.`;
  }
  if (relevance.kind === 'protected-species') {
    return `Protected/obscured species — iNaturalist ${escapeHtml(relevance.taxonGeoprivacy)}s its location.`;
  }
  return '';
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
    const body = await readJson(response);
    if (!response.ok) throw new Error(apiErrorMessage(response, body));
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
    // Shown where the reader is looking, not only in the console, so a
    // signed-out click says why nothing changed.
    feedCountEl.textContent = `Could not update: ${err.message}`;
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
