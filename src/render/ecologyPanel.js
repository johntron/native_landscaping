/**
 * The ecology check, drawn beside the species table.
 *
 * One row per dimension, because the analysis reports per dimension and refuses
 * to roll up — there is deliberately no overall score here to render.
 *
 * Presentation only: every judgement was made in src/analysis/, and this file
 * must not invent a status, a threshold, or a verdict of its own.
 */

/**
 * Exactly the four statuses src/analysis/ecology.js emits, and nothing else. A
 * fifth would render as an unlabelled chip rather than fail, so the mapping is
 * kept closed on both sides.
 */
const STATUS_LABELS = {
  ok: 'Good',
  partial: 'Partial',
  gap: 'Gap',
  'not-declared': 'Not declared',
};

const HEADLINE = {
  ok: 'checks pass',
  partial: 'partly met',
  gap: 'needs work',
  'not-declared': 'not checked',
};

/**
 * Rebuild the panel from a fresh set of results.
 *
 * Called from refreshSpeciesTable, never from render(): render() fires on every
 * month-slider input event, and rebuilding this DOM mid-drag would throw away
 * the row a reader had just expanded.
 *
 * @param {Array<{id: string, title: string, status: string, summary: string, findings: string[], suggestions: string[]}>} results
 * @param {HTMLElement} container
 */
export function renderEcologyPanel(results, container) {
  if (!container) return;
  // Which rows were open survives the rebuild — a plant added while a dimension
  // is expanded should update that dimension in place, not collapse it.
  const expanded = new Set(
    Array.from(container.querySelectorAll('[data-rule-id].is-expanded')).map(
      (row) => row.dataset.ruleId
    )
  );
  const collapsed = container.querySelector('.ecology-check__body')?.hidden === true;
  container.innerHTML = '';

  const list = Array.isArray(results) ? results : [];
  if (!list.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const body = document.createElement('div');
  body.className = 'ecology-check__body';
  body.id = 'ecologyCheckBody';
  body.hidden = collapsed;

  container.appendChild(buildHeader(list, body, collapsed));
  list.forEach((result) => body.appendChild(buildRow(result, expanded.has(result.id))));
  container.appendChild(body);
}

function buildHeader(results, body, collapsed) {
  const header = document.createElement('div');
  header.className = 'ecology-check__header';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ecology-check__toggle';
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.setAttribute('aria-controls', body.id);
  toggle.textContent = 'Ecology check';
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  header.appendChild(toggle);

  // A count per status rather than a score: the reader sees the shape of the
  // report without the panel implying the dimensions can be added together.
  const tally = document.createElement('div');
  tally.className = 'ecology-check__tally';
  Object.keys(STATUS_LABELS).forEach((status) => {
    const count = results.filter((result) => result.status === status).length;
    if (!count) return;
    const chip = document.createElement('span');
    chip.className = `ecology-chip ecology-chip--${status}`;
    chip.textContent = `${count} ${HEADLINE[status]}`;
    tally.appendChild(chip);
  });
  header.appendChild(tally);

  return header;
}

function buildRow(result, startExpanded) {
  const row = document.createElement('div');
  row.className = 'ecology-check__row';
  row.dataset.ruleId = result.id;

  const hasDetail = Boolean(result.findings?.length || result.suggestions?.length);
  if (startExpanded && hasDetail) row.classList.add('is-expanded');

  const chip = document.createElement('span');
  chip.className = `ecology-chip ecology-chip--${result.status}`;
  chip.textContent = STATUS_LABELS[result.status] || result.status;

  const title = document.createElement('span');
  title.className = 'ecology-check__title';
  title.textContent = result.title;

  const summary = document.createElement('span');
  summary.className = 'ecology-check__summary';
  summary.textContent = result.summary;

  const head = document.createElement('div');
  head.className = 'ecology-check__row-head';
  head.append(chip, title, summary);

  if (hasDetail) {
    // Same disclosure as the species table's Details button, so the two lists
    // below the drawing behave the same way.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ecology-check__details-btn';
    const sync = () => {
      const open = row.classList.contains('is-expanded');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? 'Hide details' : 'Details';
    };
    toggle.addEventListener('click', () => {
      row.classList.toggle('is-expanded');
      sync();
    });
    sync();
    head.appendChild(toggle);
  }
  row.appendChild(head);

  if (hasDetail) {
    const detail = document.createElement('div');
    detail.className = 'ecology-check__detail';
    if (result.findings?.length) {
      detail.appendChild(buildList('What the planting says', result.findings, 'findings'));
    }
    if (result.suggestions?.length) {
      detail.appendChild(
        buildList('From the catalog, this would help', result.suggestions, 'suggestions')
      );
    }
    row.appendChild(detail);
  }

  return row;
}

function buildList(heading, items, modifier) {
  const wrap = document.createElement('div');
  wrap.className = `ecology-check__list ecology-check__list--${modifier}`;

  const label = document.createElement('div');
  label.className = 'ecology-check__list-heading';
  label.textContent = heading;
  wrap.appendChild(label);

  const ul = document.createElement('ul');
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  });
  wrap.appendChild(ul);

  return wrap;
}
