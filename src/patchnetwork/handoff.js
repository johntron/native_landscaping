/*
 * The project picker that turns the general argument into one specific yard.
 *
 * It lives on the argument page rather than in the design tool's header because
 * choosing a yard IS the drill-down. The tool keeps its own switcher for
 * changing yards while working -- a different job, and the reason this is a
 * separate small module instead of a shared widget: they look alike but answer
 * different questions ("which yard am I opening?" vs "switch me to another").
 */
import { loadProjectIndex } from '../data/projectConfig.js';

export async function initHandoff() {
  const select = document.getElementById('handoffProject');
  const open = document.getElementById('handoffOpen');
  const note = document.getElementById('handoffNote');
  if (!select || !open) return;

  const go = () => {
    if (select.value) window.location.href = `design.html?project=${encodeURIComponent(select.value)}`;
  };

  try {
    const index = await loadProjectIndex(fetch, document.baseURI);
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
