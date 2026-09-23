/**
 * The design tool's project picker and "+ New project" form. Both switch
 * projects by navigating to ?project=<id>; the page reloads rather than
 * re-initializing in place.
 */
export const PROJECT_QUERY_PARAM = 'project';

/**
 * Populate the project picker. Switching navigates to `?project=<id>` and lets the
 * page reload — the render loop, history stack, and drag controllers are all built
 * once against a single project, so a reload is both simpler and linkable.
 */
export function initProjectPicker(selectEl, projectIndex, activeId) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  projectIndex.projects.forEach((entry) => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    option.selected = entry.id === activeId;
    selectEl.appendChild(option);
  });
  selectEl.disabled = projectIndex.projects.length < 2;
  selectEl.addEventListener('change', (event) => {
    const nextId = event.target.value;
    if (!nextId || nextId === activeId) return;
    const url = new URL(window.location.href);
    url.searchParams.set(PROJECT_QUERY_PARAM, nextId);
    window.location.assign(url.toString());
  });
}

/**
 * "+ New project": a name, a server-derived slug, and a reload onto it —
 * the same navigation `initProjectPicker` uses to switch, so a freshly
 * created project boots exactly like any other rather than needing its own
 * in-place initialization path.
 */
export function initNewProjectForm({ button, form, nameInput, cancelButton, status }) {
  if (!button || !form || !nameInput) return;

  const setStatus = (message, state) => {
    if (!status) return;
    status.textContent = message || '';
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };

  const close = () => {
    form.hidden = true;
    nameInput.value = '';
    setStatus('');
  };

  button.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) nameInput.focus();
  });
  cancelButton?.addEventListener('click', close);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const id = slugifyProjectName(name);
    if (!id) {
      setStatus('Enter a name first.', 'error');
      return;
    }
    setStatus('Creating…');
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      const url = new URL(window.location.href);
      url.searchParams.set(PROJECT_QUERY_PARAM, id);
      window.location.assign(url.toString());
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });
}

/** A project id is a path segment — see PROJECT_ID_PATTERN in projectConfig.js. */
function slugifyProjectName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}
