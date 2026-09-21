// Client for claims-coverage.html (nl-scx.10), implementing
// docs/data-acquisition/07-mcp-introspection.md §5's coverage view: "7 of 12
// required fields sourced for this species". Fetches /api/claims-coverage
// (server.js), which reshapes tools/claims/claimsTools.js's claims_coverage
// output via tools/claims/humanViews.js — no query logic lives here, only
// rendering.

const speciesFilter = document.getElementById('speciesFilter');
const fieldFilter = document.getElementById('fieldFilter');
const refreshButton = document.getElementById('refreshCoverage');
const countEl = document.getElementById('coverageCount');
const errorEl = document.getElementById('coverageError');
const listEl = document.getElementById('coverageList');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = '';
}

function fieldChipHtml(fieldEntry) {
  const label = fieldEntry.status === 'asserted' ? fieldEntry.field : `${fieldEntry.field} (${fieldEntry.status})`;
  return `<span class="coverage-field coverage-field--${fieldEntry.status}">${escapeHtml(label)}</span>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderSpecies(row) {
  const el = document.createElement('article');
  el.className = 'coverage-species';
  el.innerHTML = `
    <div class="coverage-species__header">
      <span class="coverage-species__name">${escapeHtml(row.species)}</span>
      <span class="coverage-species__ratio">${row.assertedCount} of ${row.totalFields} sourced</span>
    </div>
    <div class="coverage-fields">${row.fields.map(fieldChipHtml).join('')}</div>
  `;
  return el;
}

async function loadCoverage() {
  clearError();
  listEl.innerHTML = '';
  countEl.textContent = 'Loading…';

  const params = new URLSearchParams();
  const speciesText = speciesFilter.value.trim();
  const fieldText = fieldFilter.value.trim();
  if (fieldText) params.set('field', fieldText);

  try {
    const res = await fetch(`/api/claims-coverage?${params.toString()}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);

    let rows = body.rows;
    if (speciesText) {
      const needle = speciesText.toLowerCase();
      rows = rows.filter((r) => r.species.toLowerCase().includes(needle));
    }

    countEl.textContent = `${rows.length} species`;
    if (!rows.length) {
      listEl.innerHTML = '<p class="conflicts-empty">No species match this filter.</p>';
      return;
    }
    for (const row of rows) listEl.appendChild(renderSpecies(row));
  } catch (err) {
    countEl.textContent = '';
    showError(err.message);
  }
}

refreshButton.addEventListener('click', loadCoverage);
speciesFilter.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadCoverage();
});
fieldFilter.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadCoverage();
});

loadCoverage();
