/*
 * The project picker that turns the general argument into one specific yard.
 *
 * It lives on the argument page rather than in the design tool's header because
 * choosing a yard IS the drill-down. The tool keeps its own switcher for
 * changing yards while working -- a different job, and the reason this is a
 * separate small module instead of a shared widget: they look alike but answer
 * different questions ("which yard am I opening?" vs "switch me to another").
 */
import { normalizeProjectIndex, PROJECT_INDEX_PATH } from '../data/projectConfig.js';

export async function initHandoff() {
  const select = document.getElementById('handoffProject');
  const open = document.getElementById('handoffOpen');
  const note = document.getElementById('handoffNote');
  if (!select || !open) return;

  const go = () => {
    if (select.value) window.location.href = `design.html?project=${encodeURIComponent(select.value)}`;
  };

  const signInMessage = () => {
    note.textContent = 'Sign in to see your yards.';
    select.innerHTML = '<option>Sign in to see your yards</option>';
  };

  try {
    // index.html is public (nl-3s5.8), but api/projects is not: a signed-out
    // visitor's session has no Cloudflare Access cookie, so the request would
    // otherwise be redirected to the login host and fail as a cross-origin
    // network error. redirect: 'manual' turns that into an ordinary
    // "opaqueredirect" response instead of a failing fetch, so a logged-out
    // load never throws or logs a network error -- it just can't read the
    // list, same as any other unauthenticated caller of this route.
    const url = new URL(PROJECT_INDEX_PATH, document.baseURI);
    const response = await fetch(url, { cache: 'no-store', redirect: 'manual' });
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 0) {
      signInMessage();
      return;
    }
    if (!response.ok) throw new Error(`Failed to load ${PROJECT_INDEX_PATH} (${response.status})`);
    const index = normalizeProjectIndex(await response.json());
    const projects = index?.projects ?? [];
    if (!projects.length) {
      note.textContent = 'No yards yet — the design tool can create the first one.';
      select.innerHTML = '<option>None yet</option>';
      return;
    }
    select.innerHTML = projects
      .map((p) => `<option value="${p.id}">${p.name ?? p.id}</option>`)
      .join('');
    select.disabled = false;
    open.disabled = false;
    open.addEventListener('click', go);
    // Picking from a list and then hunting for a button is a step too many.
    select.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  } catch {
    // The argument above stands on its own; say so rather than failing silently.
    note.textContent = 'Could not load the yard list. The argument above does not depend on it.';
    select.innerHTML = '<option>Unavailable</option>';
  }
}
