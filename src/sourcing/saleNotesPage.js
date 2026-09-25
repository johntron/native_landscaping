/**
 * "Your sale notes (private)" on sourcing.html (nl-2bw): a free-form place for
 * an admin to jot down a plant sale they've found, read later and turned by
 * hand into a sourced row of sourcing/plant-sales.csv (never automatically —
 * see the section's own copy and AGENTS.md's "Buy plants" row).
 *
 * Admin-only, and sourcing.html is a public page (nl-3s5.8), so this module
 * decides whether to show the section the same way the page decides anything
 * about the caller: by asking the API and reading the answer. GET
 * /api/sale-notes 404s (or 401s, anonymous) for anyone but an admin
 * (server/http.js requireAdmin) — the same 404 a route that doesn't exist
 * gets — so a non-admin or anonymous visitor sees nothing wrong, just no
 * section, and the page never renders a "you're not allowed" state that would
 * itself leak who's an admin.
 */
const section = document.getElementById('saleNotesSection');
const form = document.getElementById('saleNoteForm');
const bodyInput = document.getElementById('saleNoteBody');
const errorEl = document.getElementById('saleNoteError');
const listEl = document.getElementById('saleNotesList');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = '';
}

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function noteItem(note) {
  const li = document.createElement('li');
  li.className = 'sale-note';

  const meta = document.createElement('p');
  meta.className = 'sale-note__meta';
  meta.textContent = formatDate(note.createdAt);

  const body = document.createElement('p');
  body.className = 'sale-note__body';
  // textContent only, never innerHTML (AGENTS.md): white-space: pre-wrap
  // (sourcing.css) is what keeps the note's own line breaks visible.
  body.textContent = note.body;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'pill-button pill-button--danger sale-note__delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteNote(note.id, li));

  li.append(meta, body, deleteBtn);
  return li;
}

function renderNotes(notes) {
  listEl.innerHTML = '';
  if (!notes.length) {
    const empty = document.createElement('li');
    empty.className = 'sale-note sale-note--empty';
    empty.textContent = 'No notes saved yet.';
    listEl.append(empty);
    return;
  }
  for (const note of notes) listEl.append(noteItem(note));
}

async function loadNotes() {
  const res = await fetch('/api/sale-notes');
  if (!res.ok) return null; // 404 (not admin) or 401 (anonymous): stay hidden
  const { notes } = await res.json();
  return notes;
}

async function deleteNote(id, li) {
  try {
    const res = await fetch(`/api/sale-notes/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    li.remove();
    if (!listEl.children.length) renderNotes([]);
  } catch (err) {
    console.error(err);
    showError(err.message);
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  clearError();
  const body = bodyInput.value.trim();
  if (!body) {
    showError('Write something first.');
    return;
  }
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/sale-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parsed.error || `Request failed (${res.status})`);
    bodyInput.value = '';
    const notes = await loadNotes();
    renderNotes(notes || [parsed.note]);
  } catch (err) {
    console.error(err);
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
  }
}

async function init() {
  let notes;
  try {
    notes = await loadNotes();
  } catch (err) {
    console.error(err); // network error: still fails closed, section stays hidden
    return;
  }
  if (!notes) return;
  section.hidden = false;
  renderNotes(notes);
  form.addEventListener('submit', handleSubmit);
}

init();
