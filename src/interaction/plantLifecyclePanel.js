/**
 * The lifecycle section of the plant detail sheet (nl-3s5.22): whether the
 * plant is planned or planted, the date it went in, where it came from, and
 * whether it was grown from local stock (nl-ky8).
 *
 * It builds its own markup and puts it before the sheet's Clone/Remove row,
 * so design.html needs no change. Every edit goes through setPlantLifecycle
 * (src/state/plantEdits.js) for a plant in no drift, and then through
 * `onCommit`, the app's ordinary layout save: each change is one revision in
 * the yard's history, and Undo takes it back.
 *
 * nl-o47.6.10: "one planting status per drift" is strict — a drift's members
 * share status/date/source/ecotype, never edited separately — so this panel
 * TARGETS A SET of plants, not always just one. `open(plantId)` resolves the
 * targets from `plantId`'s OWN driftId at the moment it is opened: a plant in
 * no drift targets just itself; a drift member (drilled into from the
 * selection bar, or the drift's own "Planting" entry in More, which opens
 * with any one of its members as the anchor — see src/ui/detailSheet.js's
 * `drift` option) targets every CURRENT member of that drift, read fresh on
 * every sync() rather than cached, so an undo/redo or another edit is
 * reflected immediately. Every edit then goes through setDriftLifecycle
 * (src/state/driftEdits.js) instead, writing every member as one history
 * entry, and the panel says so ("Applies to all N plants in <drift label>").
 * A drift whose members happen to differ (older data, an import) shows the
 * FIRST member's values with a note; the next edit unifies them
 * (driftLifecycleSummary, src/state/driftGeometry.js).
 *
 * The source is free text first. Rows of sourcing/nurseries.csv and
 * sourcing/plant-sales.csv are offered as suggestions while typing, and one is
 * linked only when it is clicked: typed text is never matched on the person's
 * behalf, and a source never has to match anything. Everything a person typed
 * reaches the page through textContent or an input's value, never innerHTML.
 *
 * On a read-only yard (`appState.readOnly`, nl-3s5.24) the section is hidden
 * and nothing is applied; the drawing still shows planned and planted.
 */
import { fetchCsv, parseCsv } from '../data/csvLoader.js';
import {
  SOURCE_NAME_MAX,
  STATUS_PLANNED,
  STATUS_PLANTED,
  describeSourceRef,
  lifecycleOf,
  localIsoDate,
  resolveSourceRef,
  suggestSources,
} from '../data/plantLifecycle.js';
import { setPlantLifecycle } from '../state/plantEdits.js';
import { setDriftLifecycle } from '../state/driftEdits.js';
import { driftLifecycleSummary, driftMembers } from '../state/driftGeometry.js';
import { humanizeDriftId } from '../data/driftId.js';

/**
 * Parsed sourcing/ tables, loaded once, on first need. A failed load leaves
 * both empty: suggestions are a convenience, and free text still works.
 * @returns {Promise<{ nurseries: Array<object>, sales: Array<object> }>}
 */
let sourcingTablesPromise = null;
function loadSourcingTables() {
  if (!sourcingTablesPromise) {
    const load = (path) =>
      fetchCsv(new URL(path, document.baseURI))
        .then(parseCsv)
        .catch((err) => {
          console.warn(`Could not load ${path}; source suggestions are off`, err);
          return [];
        });
    sourcingTablesPromise = Promise.all([load('sourcing/nurseries.csv'), load('sourcing/plant-sales.csv')]).then(
      ([nurseries, sales]) => ({ nurseries, sales })
    );
  }
  return sourcingTablesPromise;
}

/**
 * @param {object} deps
 * @param {HTMLElement|null} deps.sheet               the #detailSheet element (or another sheet
 *   built the same way — any element with a `.detail-sheet__panel` descendant)
 * @param {{ plants: object[] }} deps.appState         read and replaced through
 *   setPlantLifecycle/setDriftLifecycle
 * @param {(description: string) => void} deps.onCommit  re-render and record one layout revision
 * @returns {{ open: (plantId: string) => void, refresh: () => void, setReadOnly: (readOnly: boolean) => void }}
 */
export function createPlantLifecyclePanel({ sheet, appState, onCommit }) {
  const panel = sheet?.querySelector('.detail-sheet__panel');
  if (!panel) return { open() {}, refresh() {}, setReadOnly() {} };

  const section = el('section', 'plant-lifecycle');
  section.setAttribute('aria-labelledby', 'plantLifecycleHeading');
  const heading = el('h3', 'plant-lifecycle__heading', 'In the ground');
  heading.id = 'plantLifecycleHeading';
  const key = el(
    'p',
    'plant-lifecycle__key',
    'Planned plants are drawn with a dashed outline, planted ones with a solid outline. ' +
      'A local-ecotype plant has a second ring inside its outline in the plan.'
  );
  // nl-o47.6.10: only shown when the targets ARE a drift (2+ plants) — see sync().
  const scopeNote = el('p', 'plant-lifecycle__scope');
  scopeNote.setAttribute('role', 'status');

  const statusRow = el('div', 'plant-lifecycle__status');
  statusRow.setAttribute('role', 'group');
  statusRow.setAttribute('aria-label', 'Status');
  const statusButtons = [STATUS_PLANNED, STATUS_PLANTED].map((status) => {
    const button = el('button', 'chip plant-lifecycle__status-button', status === STATUS_PLANTED ? 'Planted' : 'Planned');
    button.type = 'button';
    button.dataset.lifecycleStatus = status;
    statusRow.appendChild(button);
    return button;
  });

  const dateField = el('label', 'plant-lifecycle__field');
  dateField.appendChild(el('span', 'plant-lifecycle__label', 'Planted on (optional)'));
  const dateInput = el('input', 'plant-lifecycle__input');
  dateInput.type = 'date';
  dateInput.name = 'plantedOn';
  dateField.appendChild(dateInput);

  const sourceField = el('label', 'plant-lifecycle__field');
  sourceField.appendChild(el('span', 'plant-lifecycle__label', 'Source (optional)'));
  const sourceInput = el('input', 'plant-lifecycle__input');
  sourceInput.type = 'text';
  sourceInput.name = 'source';
  sourceInput.maxLength = SOURCE_NAME_MAX;
  sourceInput.autocomplete = 'off';
  sourceInput.placeholder = 'Anywhere: a nursery, a sale, "neighbour’s division"';
  sourceField.appendChild(sourceInput);

  const ecotypeField = el('label', 'plant-lifecycle__check');
  const ecotypeInput = el('input');
  ecotypeInput.type = 'checkbox';
  ecotypeInput.name = 'localEcotype';
  ecotypeField.append(ecotypeInput, el('span', '', 'Local ecotype (grown from local seed or stock)'));

  const linked = el('p', 'plant-lifecycle__linked');
  const linkedText = el('span', 'plant-lifecycle__linked-text');
  const unlinkButton = el('button', 'plant-lifecycle__unlink', 'Unlink');
  unlinkButton.type = 'button';
  linked.append(linkedText, ' ', unlinkButton);

  const suggestions = el('ul', 'plant-lifecycle__suggestions');
  suggestions.setAttribute('aria-label', 'Nurseries and plant sales that match');
  const message = el('p', 'plant-lifecycle__message');
  message.setAttribute('role', 'status');

  section.append(heading, key, scopeNote, statusRow, dateField, sourceField, linked, suggestions, ecotypeField, message);
  const actions = panel.querySelector('.detail-sheet__actions');
  panel.insertBefore(section, actions || null);

  let plantId = '';
  let readOnly = false;
  let tables = { nurseries: [], sales: [] };
  let tablesLoaded = false;

  // A yard the viewer may not edit (the shared example, nl-3s5.24, sets
  // appState.readOnly) shows none of these controls: its writes answer 403.
  const isReadOnly = () => readOnly || Boolean(appState.readOnly);

  /**
   * The plant(s) this panel edits, read fresh every time (never cached): a
   * plant in no drift targets just itself; a drift member targets every
   * CURRENT member of its drift (nl-o47.6.10) — driftMembers on the anchor's
   * OWN driftId, so an undo/redo that shrinks/grows the drift, or drops the
   * label entirely (nl-o47.6.9's >= 2 rule), is reflected on the next sync().
   */
  const currentTargets = () => {
    const anchor = appState.plants.find((plant) => String(plant.id) === String(plantId));
    if (!anchor) return [];
    if (!anchor.driftId) return [anchor];
    const members = driftMembers(appState.plants, anchor.driftId);
    return members.length ? members : [anchor];
  };

  const showMessage = (text) => {
    message.textContent = text || '';
    message.hidden = !text;
  };

  /** Apply `fields` to every current target; on a refusal, say why and put the inputs back. */
  const apply = (fields, description) => {
    if (isReadOnly() || !plantId) return;
    const targets = currentTargets();
    if (!targets.length) return;
    if (targets.length > 1) {
      // Every caller's description names "plant" ("Marked plant planted");
      // this one history entry touches every member, so "drift" reads truer
      // in the undo history — the on-screen note above already says how many.
      const driftDescription = description.replace('plant', 'drift');
      const { members, problems } = setDriftLifecycle(appState, targets[0].driftId, fields);
      if (problems.length) {
        showMessage(problems.join(' '));
        sync();
        return;
      }
      showMessage('');
      if (members.length) onCommit(driftDescription);
      sync();
      return;
    }
    const { plant, problems } = setPlantLifecycle(appState, targets[0].id, fields);
    if (problems.length) {
      showMessage(problems.join(' '));
      sync();
      return;
    }
    showMessage('');
    if (plant) onCommit(description);
    sync();
  };

  /** Put every control in line with the target(s) as they now are. */
  const sync = () => {
    const targets = currentTargets();
    section.hidden = !targets.length || isReadOnly();
    if (section.hidden) return;
    // The FIRST member's lifecycle, always (nl-o47.6.10's driftLifecycleSummary) —
    // for one plant that IS the plant; for a drift, it is what an edit here
    // merges onto and what every OTHER member gets unified to.
    const { lifecycle, uniform } = driftLifecycleSummary(targets);
    if (targets.length > 1) {
      const label = humanizeDriftId(targets[0].driftId);
      scopeNote.hidden = false;
      scopeNote.textContent = uniform
        ? `Applies to all ${targets.length} plants in ${label}.`
        : `These plants had different settings; saving applies these to all ${targets.length} plants in ${label}.`;
    } else {
      scopeNote.hidden = true;
      scopeNote.textContent = '';
    }
    const { status, plantedOn, source, localEcotype } = lifecycle;
    section.dataset.status = status;
    ecotypeInput.checked = localEcotype;
    statusButtons.forEach((button) => {
      const active = button.dataset.lifecycleStatus === status;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    dateField.hidden = status !== STATUS_PLANTED;
    dateInput.value = plantedOn;
    dateInput.max = localIsoDate();
    if (document.activeElement !== sourceInput) sourceInput.value = source?.name || '';
    renderLinked(source);
    renderSuggestions();
  };

  const renderLinked = (source) => {
    const ref = source?.ref;
    linked.hidden = !ref;
    linkedText.replaceChildren();
    if (!ref) return;
    const row = resolveSourceRef(ref, tables);
    const kind = ref.table === 'nurseries' ? 'nursery' : 'plant sale';
    if (!row) {
      linkedText.textContent = tablesLoaded
        ? `Linked: ${describeSourceRef(ref)} (${kind}; no longer listed on the Buy plants page).`
        : `Linked: ${describeSourceRef(ref)} (${kind}).`;
      return;
    }
    linkedText.append(`Linked: ${describeSourceRef(ref)} (${[kind, row.city].filter(Boolean).join(', ')})`);
    const href = safeHttpUrl(ref.table === 'nurseries' ? row.website : row.url);
    if (href) {
      const link = el('a', 'plant-lifecycle__link', 'website');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      linkedText.append(' · ', link);
    }
  };

  const renderSuggestions = () => {
    suggestions.replaceChildren();
    const targets = currentTargets();
    const text = sourceInput.value;
    const ref = targets.length ? driftLifecycleSummary(targets).lifecycle.source?.ref : null;
    const offered = isReadOnly() ? [] : suggestSources(text, tables).filter((s) => !sameRef(s.ref, ref));
    suggestions.hidden = !offered.length;
    offered.forEach((suggestion) => {
      const item = document.createElement('li');
      const button = el('button', 'plant-lifecycle__suggestion');
      button.type = 'button';
      button.append(
        'Link to ',
        el('strong', '', suggestion.label),
        el('span', 'plant-lifecycle__suggestion-detail', ` (${suggestion.detail})`)
      );
      // Keep focus in the text box: a blur would commit the typed text as its
      // own revision and redraw this list out from under the click.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        // Keep what the person typed unless it was the start of this name.
        const typed = sourceInput.value.trim();
        const name = !typed || suggestion.label.toLowerCase().includes(typed.toLowerCase()) ? suggestion.label : typed;
        sourceInput.value = name;
        apply({ source: { name, ref: suggestion.ref } }, 'Linked plant source');
      });
      item.appendChild(button);
      suggestions.appendChild(item);
    });
  };

  statusButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const status = button.dataset.lifecycleStatus;
      apply({ status }, status === STATUS_PLANTED ? 'Marked plant planted' : 'Marked plant planned');
    });
  });

  dateInput.addEventListener('change', () => {
    apply({ plantedOn: dateInput.value }, dateInput.value ? 'Set planting date' : 'Cleared planting date');
  });

  sourceInput.addEventListener('input', renderSuggestions);
  sourceInput.addEventListener('change', () => {
    const targets = currentTargets();
    const ref = targets.length ? driftLifecycleSummary(targets).lifecycle.source?.ref : null;
    const name = sourceInput.value;
    apply({ source: name.trim() ? { name, ref } : null }, name.trim() ? 'Set plant source' : 'Cleared plant source');
  });
  sourceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sourceInput.blur();
  });

  ecotypeInput.addEventListener('change', () => {
    const localEcotype = ecotypeInput.checked;
    apply({ localEcotype }, localEcotype ? 'Marked plant local ecotype' : 'Cleared local ecotype');
  });

  unlinkButton.addEventListener('click', () => {
    const targets = currentTargets();
    const source = targets.length ? driftLifecycleSummary(targets).lifecycle.source : null;
    if (!source) return;
    apply({ source: { name: source.name } }, 'Unlinked plant source');
  });

  return {
    open(id) {
      plantId = String(id ?? '');
      showMessage('');
      sourceInput.value = '';
      sync();
      loadSourcingTables().then((loaded) => {
        tables = loaded;
        tablesLoaded = true;
        if (!sheet.hidden) sync();
      });
    },
    /** Re-read the plant (after an undo, say) without clearing a message. */
    refresh() {
      if (plantId && !sheet.hidden) sync();
    },
    /** For a yard the viewer may not edit, besides appState.readOnly: the section is hidden. */
    setReadOnly(value) {
      readOnly = Boolean(value);
      sync();
    },
  };
}

/** `value` when it is an http(s) URL, else ''. */
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function sameRef(a, b) {
  return Boolean(a && b) && JSON.stringify(a) === JSON.stringify(b);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
