/**
 * "Your shopping list" on sourcing.html (nl-46b): every planned plant in the
 * signed-in person's own yards, by species, with their favorites (nl-3on)
 * first and togglable here, and favorites not placed anywhere listed as
 * wanted. The counting and ordering are src/sourcing/shoppingList.js.
 *
 * sourcing.html is public (nl-3s5.8), so this asks the API and shows the
 * section only on a 200. A signed-out visitor has no Cloudflare Access cookie,
 * so the fetch uses redirect: 'manual': the login redirect becomes an ordinary
 * non-ok response instead of a cross-origin network error (the same reasoning
 * as saleNotesPage.js). Everything a person named (a yard) reaches the page
 * through textContent, never innerHTML.
 */
import { fetchCsv, parseCsv } from '../data/csvLoader.js';
import { buildShoppingList, shoppingListText } from './shoppingList.js';

const section = document.getElementById('shoppingListSection');
const yardsEl = document.getElementById('shoppingYards');
const summaryEl = document.getElementById('shoppingSummary');
const rowsEl = document.getElementById('shoppingRows');
const wantedHeading = document.getElementById('shoppingWantedHeading');
const wantedEl = document.getElementById('shoppingWanted');
const copyBtn = document.getElementById('shoppingCopyBtn');
const copyStatus = document.getElementById('shoppingCopyStatus');

// Which yards are left out, remembered per browser: a convenience only, so
// every read and write is guarded and the list works without it.
const EXCLUDED_KEY = 'rewilder-shopping-excluded-yards';
function readExcluded() {
  try {
    const value = JSON.parse(localStorage.getItem(EXCLUDED_KEY) || '[]');
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}
function writeExcluded(excluded) {
  try {
    localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...excluded]));
  } catch {
    // storage blocked: the choice lasts until the page is closed
  }
}

const STANDING_TEXT = {
  native: '✓ native to North Central Texas',
  cultivar: 'cultivar',
  introduced: 'not native here',
  unconfirmed: 'nativity not confirmed',
};

const state = { yards: [], species: [], favorites: new Set(), excluded: readExcluded() };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function currentList() {
  return buildShoppingList({
    yards: state.yards,
    species: state.species,
    favorites: state.favorites,
    includedYardIds: state.yards.map((yard) => yard.id).filter((id) => !state.excluded.has(id)),
  });
}

function starButton(row) {
  const button = el('button', 'shopping-star', row.favorite ? '★' : '☆');
  button.type = 'button';
  button.setAttribute('aria-pressed', row.favorite ? 'true' : 'false');
  button.setAttribute('aria-label', `Favorite: ${row.commonName}`);
  button.title = row.favorite ? 'Favorite (most wanted). Click to unmark.' : 'Mark as a favorite (most wanted)';
  button.addEventListener('click', () => toggleFavorite(row.speciesId, !row.favorite, button));
  return button;
}

function rowItem(row, { wanted = false } = {}) {
  const item = el('li', 'shopping-row');
  item.dataset.speciesId = row.speciesId;
  const count = el('span', 'shopping-row__count', wanted ? '–' : String(row.total));
  const body = el('div', 'shopping-row__body');
  const name = el('p', 'shopping-row__name', row.commonName);
  if (row.botanicalName && row.botanicalName !== row.commonName) {
    name.append(' ', el('span', 'shopping-row__botanical', row.botanicalName));
  }
  const meta = [STANDING_TEXT[row.standing]];
  if (!wanted && row.byYard.length) meta.push(row.byYard.map((y) => `${y.name} ${y.count}`).join(', '));
  body.append(name, el('p', 'shopping-row__meta', meta.join(' · ')));
  item.append(starButton(row), count, body);
  return item;
}

function render() {
  const list = currentList();
  const included = state.yards.filter((yard) => !state.excluded.has(yard.id));
  rowsEl.replaceChildren();
  if (!list.rows.length) {
    rowsEl.append(
      el(
        'li',
        'shopping-row shopping-row--empty',
        included.length ? 'Nothing planned in the chosen yards.' : 'Choose a yard above.'
      )
    );
  }
  list.rows.forEach((row) => rowsEl.append(rowItem(row)));
  wantedEl.replaceChildren();
  wantedEl.classList.add('shopping-list--wanted');
  list.wanted.forEach((row) => wantedEl.append(rowItem(row, { wanted: true })));
  wantedHeading.hidden = !list.wanted.length;

  const plants = list.totalPlants;
  const kinds = list.rows.length;
  summaryEl.textContent = kinds
    ? `${plants} plant${plants === 1 ? '' : 's'} of ${kinds} species across ${included.length} yard${included.length === 1 ? '' : 's'}.`
    : '';
  copyBtn.disabled = !list.rows.length && !list.wanted.length;
}

function renderYards() {
  yardsEl.replaceChildren();
  state.yards.forEach((yard) => {
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.value = yard.id;
    box.checked = !state.excluded.has(yard.id);
    box.addEventListener('change', () => {
      if (box.checked) state.excluded.delete(yard.id);
      else state.excluded.add(yard.id);
      writeExcluded(state.excluded);
      render();
    });
    label.append(box, yard.name);
    yardsEl.append(label);
  });
}

async function toggleFavorite(speciesId, favorite, button) {
  button.disabled = true;
  try {
    const res = await fetch('/api/favorites', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speciesId, favorite }),
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    state.favorites = new Set((await res.json()).speciesIds);
  } catch (err) {
    console.error('Could not save the favorite', err);
  }
  render();
  // The row moved (favorites sort first); keep focus on its star.
  document.querySelector(`[data-species-id="${CSS.escape(speciesId)}"] .shopping-star`)?.focus();
}

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shoppingListText(currentList()));
    copyStatus.textContent = 'Copied.';
  } catch (err) {
    console.error(err);
    copyStatus.textContent = 'Could not copy; your browser blocked the clipboard.';
  }
});

async function init() {
  let body;
  try {
    const res = await fetch('/api/shopping-list', { redirect: 'manual' });
    if (!res.ok) return; // signed out (opaqueredirect or 401): the section stays hidden
    body = await res.json();
  } catch (err) {
    console.error(err);
    return;
  }
  try {
    state.species = parseCsv(await fetchCsv('plants.csv')).map((row) => ({
      speciesId: row.id,
      commonName: row.common_name,
      botanicalName: row.botanical_name,
      nativity: row.nativity_nctx,
    }));
  } catch (err) {
    // Without the catalog the rows still show, under their species ids.
    console.warn('Could not load plants.csv; the shopping list shows species ids', err);
  }
  state.yards = body.yards || [];
  state.favorites = new Set(body.favorites || []);
  section.hidden = false;
  renderYards();
  render();
}

init();
