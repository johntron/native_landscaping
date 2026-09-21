// Client for claims-conflicts.html (nl-scx.10), implementing
// docs/data-acquisition/07-mcp-introspection.md §5 and
// docs/data-acquisition/09-conflict-resolution.md §4: the human review queue.
// Fetches /api/claims-conflicts for the queue (server.js -> humanViews.js ->
// claims_conflicts) and submits resolutions to /api/claims-correct, which
// calls the SAME claimsCorrect tool the claims_correct MCP tool calls (07
// §3.5/§4) — one write path, two callers.
//
// Per 09 §4, neither disputed candidate is ever rendered as the "current"
// value — only as one of several choices a human picks among by submitting a
// reason. `author` is never inferred server-side (no auth on this server); it
// is a required field here, remembered in localStorage only as a per-browser
// convenience so a reviewer working through several rows doesn't retype it.

const AUTHOR_STORAGE_KEY = 'claims-conflicts:lastAuthor';

const fieldFilter = document.getElementById('fieldFilter');
const refreshButton = document.getElementById('refreshConflicts');
const countEl = document.getElementById('conflictsCount');
const errorEl = document.getElementById('conflictsError');
const listEl = document.getElementById('conflictsList');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function rememberedAuthor() {
  try {
    return localStorage.getItem(AUTHOR_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function rememberAuthor(value) {
  try {
    localStorage.setItem(AUTHOR_STORAGE_KEY, value);
  } catch {
    /* best effort only — a per-browser convenience, not load-bearing */
  }
}

function renderConflict(row) {
  const el = document.createElement('li');
  el.className = 'conflict-item';

  const candidatesHtml = row.candidates
    .map(
      (c) =>
        `<label class="conflict-candidate">
          <input type="radio" name="value" value="${escapeHtml(c.value ?? '')}" />
          <span>${escapeHtml(c.value ?? '(no value)')}</span>
          <span class="conflict-candidate__source">${escapeHtml(c.source)} · ${escapeHtml(c.status)}</span>
        </label>`,
    )
    .join('');

  el.innerHTML = `
    <div class="conflict-item__header">
      <span class="conflict-item__species">${escapeHtml(row.species ?? '(unknown species)')}</span>
      <span class="conflict-item__field">${escapeHtml(row.field)}</span>
    </div>
    <div class="conflict-candidates">${candidatesHtml}</div>
    <form class="conflict-form">
      <input type="text" class="conflict-form__value" placeholder="or type a different value" />
      <input type="text" class="conflict-form__reason" placeholder="Reason (required)" required />
      <input type="text" class="conflict-form__author" placeholder="Your name/email (required)" value="${escapeHtml(rememberedAuthor())}" required />
      <button type="submit" class="pill-button">Submit resolution</button>
    </form>
    <div class="conflict-form__note" hidden></div>
  `;

  const form = el.querySelector('.conflict-form');
  const radios = el.querySelectorAll('input[name="value"]');
  const typedValue = el.querySelector('.conflict-form__value');
  const reasonInput = el.querySelector('.conflict-form__reason');
  const authorInput = el.querySelector('.conflict-form__author');
  const noteEl = el.querySelector('.conflict-form__note');

  radios.forEach((r) =>
    r.addEventListener('change', () => {
      typedValue.value = '';
    }),
  );
  typedValue.addEventListener('input', () => {
    radios.forEach((r) => {
      r.checked = false;
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const chosenRadio = [...radios].find((r) => r.checked);
    const value = typedValue.value.trim() || chosenRadio?.value || '';
    const reason = reasonInput.value.trim();
    const author = authorInput.value.trim();

    if (!value) {
      noteEl.hidden = false;
      noteEl.textContent = 'Pick a candidate or type a value.';
      return;
    }
    if (!reason || !author) {
      noteEl.hidden = false;
      noteEl.textContent = 'Reason and author are both required.';
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/claims-correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ species: row.speciesId, field: row.field, value, reason, author }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);

      rememberAuthor(author);
      form
        .querySelectorAll('input, button')
        .forEach((input) => {
          input.disabled = true;
        });
      noteEl.hidden = false;
      // Surfaced verbatim: claimsCorrect only appends to manual-corrections.tsv
      // (claims.db is untouched until the next rebuild), so this row will
      // still be in the queue on next refresh — that is expected, not a bug.
      noteEl.textContent = body.note || 'Correction recorded.';
    } catch (err) {
      noteEl.hidden = false;
      noteEl.textContent = `Submit failed: ${err.message}`;
      submitBtn.disabled = false;
    }
  });

  return el;
}

async function loadConflicts() {
  clearError();
  listEl.innerHTML = '';
  countEl.textContent = 'Loading…';

  const params = new URLSearchParams();
  const fieldText = fieldFilter.value.trim();
  if (fieldText) params.set('field', fieldText);

  try {
    const res = await fetch(`/api/claims-conflicts?${params.toString()}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);

    countEl.textContent = `${body.rows.length} open conflicts`;
    if (!body.rows.length) {
      listEl.innerHTML = '<li class="conflicts-empty">Nothing in the queue.</li>';
      return;
    }
    for (const row of body.rows) listEl.appendChild(renderConflict(row));
  } catch (err) {
    countEl.textContent = '';
    showError(err.message);
  }
}

refreshButton.addEventListener('click', loadConflicts);
fieldFilter.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadConflicts();
});

loadConflicts();
