/*
 * The nearby-ecosystem reference, pullable from any page.
 *
 * The same mechanism as a disclosure marker at a larger size: reference
 * material shown without leaving what you are doing. It carries the plant-
 * matches lookup only; the full observation index stays a page and is linked
 * from the footer here.
 *
 * Project-scoped, so it is deliberately INERT on the argument page until a yard
 * is chosen -- that page is about a neighbourhood and has no yard to be near.
 * Data loads on first open, not on page load: most visits never open it, and
 * the index is a network round trip.
 */
import { computePlantMatches, fetchObservationRows, resolveProject } from '../ecosystem/plantMatches.view.js';

const MARKUP = `
  <button type="button" class="eco-drawer__tab" id="ecoDrawerTab"
          aria-expanded="false" aria-controls="ecoDrawerPanel">
    <span aria-hidden="true">&#9906;</span> Nearby ecosystem
  </button>
  <aside class="eco-drawer__panel" id="ecoDrawerPanel" hidden
         role="dialog" aria-label="Nearby ecosystem reference">
    <header class="eco-drawer__head">
      <h2>Nearby ecosystem</h2>
      <button type="button" class="eco-drawer__close" id="ecoDrawerClose" aria-label="Close">&times;</button>
    </header>
    <div class="eco-drawer__body" id="ecoDrawerBody">
      <p class="data-note">Loading&hellip;</p>
    </div>
  </aside>`;

function groups({ note, candidates, alreadyInCatalog }, project) {
  if (!candidates) return `<p class="data-note">${note}</p>`;
  return `
    <p class="data-note">${note}</p>
    <h3>Candidates to add</h3>
    <p class="data-note">
      Keystone or larval-host genera the catalog carries no species in, ranked by local evidence
      &mdash; never by how often iNaturalist happened to see something.
    </p>
    <ul class="plant-matches__list">${candidates}</ul>
    <h3>Already in your catalog</h3>
    <ul class="plant-matches__list">${alreadyInCatalog}</ul>
    <p class="data-note">
      <a href="ecosystem.html?project=${encodeURIComponent(project.id)}">
        Full index of species reported nearby &rarr;
      </a>
    </p>`;
}

export function initEcosystemDrawer() {
  // No yard in the URL means nothing to be "near" -- the argument page.
  if (!new URLSearchParams(window.location.search).get('project')) return;

  const host = document.createElement('div');
  host.className = 'eco-drawer';
  host.innerHTML = MARKUP;
  document.body.appendChild(host);

  const tab = host.querySelector('#ecoDrawerTab');
  const panel = host.querySelector('#ecoDrawerPanel');
  const body = host.querySelector('#ecoDrawerBody');
  let loaded = false;

  const setOpen = (open) => {
    panel.hidden = !open;
    tab.setAttribute('aria-expanded', String(open));
    if (open && !loaded) {
      loaded = true;   // set before awaiting, so a double-click cannot load twice
      fill();
    }
  };

  async function fill() {
    try {
      const project = await resolveProject();
      const { rows, error, waiting } = await fetchObservationRows(project);
      if (error || waiting) {
        // "Building…" and "no location set" are states, not failures: shown
        // plainly, and the next open asks again (nl-3s5.6).
        const p = document.createElement('p');
        p.className = 'data-note';
        p.textContent = error || waiting;
        body.replaceChildren(p);
        if (waiting) loaded = false;
        return;
      }
      body.innerHTML = groups(await computePlantMatches(project, rows), project);
    } catch (err) {
      console.error(err);
      body.innerHTML = '<p class="data-note">The nearby index could not be loaded.</p>';
      loaded = false;   // a network blip should not disable the drawer for good
    }
  }

  tab.addEventListener('click', () => setOpen(panel.hidden));
  host.querySelector('#ecoDrawerClose').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { setOpen(false); tab.focus(); }
  });
}
