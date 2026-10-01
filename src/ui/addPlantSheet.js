/**
 * Edit mode's "Add plant" sheet (nl-o47.3): search, two filter chips, sort,
 * and a scrollable, tappable list of species — replacing the old strip of
 * loosely related controls (a search box, a sort select, a "Native only"
 * checkbox, a species <select>, an Add button and a Favorite button) that
 * wrapped into a disjointed block on a phone.
 *
 * Same bottom-sheet-on-a-phone / centred-dialog-from-640px pattern as the
 * plant detail sheet (src/ui/detailSheet.js, `.detail-sheet` in styles.css),
 * under its own CSS class family (`.add-plant-sheet`) rather than the shared
 * one: tests-e2e/detailSheet.spec.js locates the detail sheet's close button
 * by bare class name, and a second element sharing it would make that
 * locator ambiguous.
 *
 * The filtering, sorting and favourites logic is exactly what the old picker
 * used — src/data/speciesSearch.js (nl-ah5 search/sort, nl-5j5 native-only)
 * and the `/api/favorites` calls (nl-3on) — moved here, not rewritten.
 *
 * DOM lookups stay in src/app.js (per AGENTS.md), which passes every element
 * in; this module only queries within the elements it is handed.
 */
import { nativeStanding, searchSpecies } from '../data/speciesSearch.js';
import { MAX_DRIFT_COUNT } from '../state/driftEdits.js';

/** Native standing per row: a short badge plus the same title text the old
 * "Native only" checkbox carried, kept verbatim (nl-5j5's own wording). */
const NATIVE_TITLE = 'Native per the Flora of North Central Texas; cultivars excluded';
const BADGE_TEXT = Object.freeze({
  native: 'Native NCTX',
  cultivar: 'Cultivar',
  introduced: 'Not native',
  unconfirmed: 'Nativity unconfirmed',
});

/**
 * @param {object} deps
 * @param {object} deps.elements  every DOM node the sheet touches: `sheet`,
 *   `panel`, `search`, `nativeChip`, `favoritesChip`, `sort`, `status`, `list`,
 *   the "How many?" stepper (nl-o47.6.3): `count`, `countMinus`, `countPlus`,
 *   `countFields` (the span wrapping the stepper, hidden in Paint mode), and
 *   the Place | Paint toggle (nl-o47.6.6): `modePlaceBtn`, `modePaintBtn`
 * @param {object} deps.appState  read for the species catalog (`appState.species`)
 * @param {HTMLElement} deps.trigger  the "Add plant" button; focus returns
 *   here on close
 * @param {(speciesId: string, count: number, options: { paint: boolean }) => void} deps.onPick
 *   called when a row is tapped, with the stepper's current count (1 when
 *   there is no stepper, and meaningless in Paint mode — the caller is
 *   expected to ignore it there) and whether Paint was chosen, then the sheet
 *   closes itself
 * @returns {{ open: () => void, close: () => void }}
 */
export function createAddPlantSheet({ elements, appState, trigger, onPick }) {
  const {
    sheet,
    panel,
    search,
    nativeChip,
    favoritesChip,
    sort,
    status,
    list,
    count,
    countMinus,
    countPlus,
    countFields,
    modePlaceBtn,
    modePaintBtn,
  } = elements;

  // "How many?" (nl-o47.6.3): defaults to 1 (today's single-plant behaviour,
  // unchanged) and resets every time the sheet opens, so a forgotten count
  // never surprises the next add. Bounded by MAX_DRIFT_COUNT, a named
  // judgement call (src/state/driftEdits.js), not a technical limit.
  if (count) count.max = String(MAX_DRIFT_COUNT);

  const clampCount = (value) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? Math.min(MAX_DRIFT_COUNT, Math.max(1, n)) : 1;
  };
  const getCount = () => clampCount(count?.value);
  const setCount = (value) => {
    const next = clampCount(value);
    if (count) count.value = String(next);
    if (countMinus) countMinus.disabled = next <= 1;
    if (countPlus) countPlus.disabled = next >= MAX_DRIFT_COUNT;
  };

  countMinus?.addEventListener('click', () => setCount(getCount() - 1));
  countPlus?.addEventListener('click', () => setCount(getCount() + 1));
  // Normalize a stray typed value (blank, out of range) once the person is
  // done editing, rather than fighting every keystroke.
  count?.addEventListener('change', () => setCount(count.value));

  // Place | Paint (nl-o47.6.6): resets to Place every time the sheet opens,
  // same as the count. The count stepper means nothing in Paint — plants drop
  // along the stroke at the species' own spacing, not a typed-in number — so
  // it hides the instant Paint is chosen, freeing the row's own width back.
  let paintMode = false;
  const setPaintMode = (next) => {
    paintMode = Boolean(next);
    setChipPressed(modePlaceBtn, !paintMode);
    setChipPressed(modePaintBtn, paintMode);
    if (countFields) countFields.hidden = paintMode;
  };
  modePlaceBtn?.addEventListener('click', () => setPaintMode(false));
  modePaintBtn?.addEventListener('click', () => setPaintMode(true));

  // The signed-in person's favorite species (nl-3on). Stars stay off (and the
  // Favorites chip hidden) until this loads; a failed load costs only that.
  let favorites = null;

  const setChipPressed = (chip, pressed) => {
    if (!chip) return;
    chip.classList.toggle('is-active', pressed);
    chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  };

  const buildRow = (entry) => {
    const li = document.createElement('li');
    li.className = 'add-plant-sheet__row';
    li.dataset.speciesId = entry.speciesId;

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'add-plant-sheet__pick';

    const names = document.createElement('span');
    names.className = 'add-plant-sheet__names';
    const primaryName = entry.commonName || entry.botanicalName;
    const common = document.createElement('span');
    common.className = 'add-plant-sheet__name';
    common.textContent = primaryName;
    names.appendChild(common);
    if (entry.commonName && entry.botanicalName) {
      const botanical = document.createElement('span');
      botanical.className = 'add-plant-sheet__botanical';
      botanical.textContent = entry.botanicalName;
      names.appendChild(botanical);
    }

    const standing = nativeStanding(entry);
    const badge = document.createElement('span');
    badge.className = `add-plant-sheet__badge add-plant-sheet__badge--${standing}`;
    badge.textContent = BADGE_TEXT[standing];
    badge.title = NATIVE_TITLE;

    pick.append(names, badge);
    // Adding a plant is a full commit (state change + closing this sheet) in
    // response to this one click; stopping it here keeps the click from also
    // reaching src/app.js's document-level "click outside a plant" handler,
    // which would otherwise immediately clear the target this same action
    // just set (setTargetedPlant), because by the time it bubbles the sheet
    // is already hidden and cannot be told apart from any other outside click.
    pick.addEventListener('click', (event) => {
      event.stopPropagation();
      onPick(entry.speciesId, getCount(), { paint: paintMode });
      close();
    });
    li.appendChild(pick);

    if (favorites) {
      const isFavorite = favorites.has(entry.speciesId);
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'add-plant-sheet__star';
      star.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
      star.setAttribute('aria-label', `${isFavorite ? 'Remove' : 'Mark'} ${primaryName} as a favorite`);
      star.textContent = isFavorite ? '★' : '☆';
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFavorite(entry.speciesId, !isFavorite);
      });
      li.appendChild(star);
    }

    return li;
  };

  const renderList = () => {
    const sortBy = sort?.value || 'common';
    const nativeOnly = nativeChip?.getAttribute('aria-pressed') === 'true';
    const favoritesOnly = favoritesChip?.getAttribute('aria-pressed') === 'true';
    let matches = searchSpecies(appState.species, { query: search?.value || '', sortBy, nativeOnly });
    if (favoritesOnly && favorites) {
      matches = matches.filter((entry) => favorites.has(entry.speciesId));
    }
    if (list) {
      list.replaceChildren(...matches.map((entry) => buildRow(entry)));
    }
    if (status) {
      status.textContent = matches.length
        ? `${matches.length} plant${matches.length === 1 ? '' : 's'}`
        : 'No plants match.';
    }
  };

  async function toggleFavorite(speciesId, favorite) {
    try {
      const res = await fetch('/api/favorites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speciesId, favorite }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      favorites = new Set((await res.json()).speciesIds);
    } catch (err) {
      console.error('Could not save the favorite', err);
    }
    renderList();
    // The row can move (a favorites-only filter drops it, or a resort
    // reorders it); keep focus reachable on whichever star is still shown.
    list?.querySelector(`[data-species-id="${CSS.escape(speciesId)}"] .add-plant-sheet__star`)?.focus();
  }

  async function loadFavorites() {
    try {
      const res = await fetch('/api/favorites', { redirect: 'manual' });
      if (res.ok) favorites = new Set((await res.json()).speciesIds);
    } catch (err) {
      console.warn('Could not load favorites; the star is off', err);
    }
    if (favoritesChip) favoritesChip.hidden = !favorites;
    renderList();
  }
  loadFavorites();

  search?.addEventListener('input', renderList);
  sort?.addEventListener('change', renderList);
  nativeChip?.addEventListener('click', () => {
    setChipPressed(nativeChip, nativeChip.getAttribute('aria-pressed') !== 'true');
    renderList();
  });
  favoritesChip?.addEventListener('click', () => {
    setChipPressed(favoritesChip, favoritesChip.getAttribute('aria-pressed') !== 'true');
    renderList();
  });
  sheet?.querySelectorAll('[data-add-plant-close]').forEach((el) => {
    el.addEventListener('click', close);
  });

  /** True on a touch-primary device: autofocusing the search field there
   * throws the on-screen keyboard up over the list it is meant to filter.
   * A judgement call (coarse pointer as "touch"), not a sourced fact. */
  function isTouchInput() {
    try {
      return Boolean(window.matchMedia?.('(pointer: coarse)').matches);
    } catch {
      return false;
    }
  }

  function open() {
    if (!sheet) return;
    sheet.hidden = false;
    setCount(1);
    setPaintMode(false);
    renderList();
    if (isTouchInput()) {
      // Still move focus into the dialog, so aria-modal is honoured, but onto
      // the panel itself rather than a field that would raise the keyboard.
      panel?.focus({ preventScroll: true });
    } else {
      search?.focus({ preventScroll: true });
    }
  }

  function close() {
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    trigger?.focus();
  }

  return { open, close };
}
