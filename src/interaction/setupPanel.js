import { VIEW_FROM_DIRECTIONS } from '../render/elevationOrientation.js';

/**
 * The Setup-mode control panel: a list of the project's views, and a form over
 * the selected one.
 *
 * Every edit goes through `onCommit(views)`, which hands the app a candidate
 * `views[]` to validate and apply. The panel never mutates the live project
 * itself — a rejected edit must leave the canvas showing the last good state,
 * and the only way to guarantee that is to let the app own the transition.
 *
 * The numeric fields and the drawing are two views of the same state, so the
 * form re-reads from the project after every commit rather than trusting what
 * the user typed.
 */
export function createSetupPanel({ root, onCommit, onSave }) {
  if (!root) {
    return { render: () => {}, getSelectedId: () => '', setStatus: () => {} };
  }

  const state = { selectedId: '', views: [], status: null };

  function render(views) {
    state.views = Array.isArray(views) ? views : [];
    if (!state.views.some((view) => view.id === state.selectedId)) {
      state.selectedId = state.views[0]?.id || '';
    }
    root.replaceChildren(buildList(), buildForm(), buildFooter());
  }

  function selected() {
    return state.views.find((view) => view.id === state.selectedId) || null;
  }

  /** Commit a transformed copy; the panel keeps no draft of its own. */
  function commit(nextViews, nextSelectedId) {
    if (nextSelectedId !== undefined) state.selectedId = nextSelectedId;
    onCommit?.(nextViews);
  }

  function buildList() {
    const wrap = el('div', 'setup-panel__section');
    wrap.appendChild(el('h3', 'setup-panel__heading', 'Views'));

    const list = el('ul', 'setup-panel__list');
    state.views.forEach((view, index) => {
      const item = el('li', 'setup-panel__item');
      if (view.id === state.selectedId) item.classList.add('is-selected');

      const pick = button(`${view.label}`, 'setup-panel__pick', () => {
        state.selectedId = view.id;
        render(state.views);
      });
      pick.setAttribute('aria-pressed', view.id === state.selectedId ? 'true' : 'false');
      const kind = el('span', 'setup-panel__item-kind', view.type === 'plan' ? 'plan' : view.viewFrom);
      pick.appendChild(kind);
      item.appendChild(pick);

      const actions = el('div', 'setup-panel__item-actions');
      actions.appendChild(
        iconButton('↑', 'Move up', index === 0, () => commit(moveView(state.views, index, -1)))
      );
      actions.appendChild(
        iconButton('↓', 'Move down', index === state.views.length - 1, () =>
          commit(moveView(state.views, index, 1))
        )
      );
      actions.appendChild(
        iconButton('⧉', 'Duplicate', false, () => {
          const copy = { ...view, id: uniqueId(state.views, view.id), label: `${view.label} copy` };
          const next = [...state.views];
          next.splice(index + 1, 0, copy);
          commit(next, copy.id);
        })
      );
      // A project with no views has nothing to draw, so the last one stays.
      actions.appendChild(
        iconButton('✕', 'Remove', state.views.length < 2, () =>
          commit(state.views.filter((_, i) => i !== index), '')
        )
      );
      item.appendChild(actions);
      list.appendChild(item);
    });
    wrap.appendChild(list);

    wrap.appendChild(
      button('+ Add view', 'button pill-button setup-panel__add', () => {
        const added = newView(state.views);
        commit([...state.views, added], added.id);
      })
    );
    return wrap;
  }

  function buildForm() {
    const view = selected();
    const wrap = el('div', 'setup-panel__section');
    if (!view) return wrap;
    wrap.appendChild(el('h3', 'setup-panel__heading', 'Selected view'));

    const patch = (changes) =>
      commit(state.views.map((v) => (v.id === view.id ? applyPatch(v, changes) : v)));

    const grid = el('div', 'setup-panel__grid');
    grid.appendChild(textField('Name', view.label, (value) => patch({ label: value })));
    grid.appendChild(textField('Subtitle', view.sublabel, (value) => patch({ sublabel: value })));
    grid.appendChild(
      selectField('Type', view.type, ['plan', 'elevation'], (value) => patch({ type: value }))
    );
    if (view.type === 'elevation') {
      grid.appendChild(
        selectField('Viewed from', view.viewFrom, VIEW_FROM_DIRECTIONS, (value) =>
          patch({ viewFrom: value })
        )
      );
    }

    grid.appendChild(
      numberField('Width (ft)', view.extentFt.width, 0.1, (value) =>
        patch({ extentWidthFt: value })
      )
    );
    grid.appendChild(
      numberField('Height (ft)', view.extentFt.height, 0.1, (value) =>
        patch({ extentHeightFt: value })
      )
    );
    grid.appendChild(
      numberField(
        view.type === 'elevation' ? 'Near edge (ft)' : 'Left edge (ft)',
        view.originFt.x,
        0.1,
        (value) => patch({ originX: value })
      )
    );
    grid.appendChild(
      numberField(
        view.type === 'elevation' ? 'Ground height (ft)' : 'Bottom edge (ft)',
        view.originFt.y,
        0.1,
        (value) => patch({ originY: value })
      )
    );
    grid.appendChild(
      numberField('Drawing width (px)', view.viewBox.width, 1, (value) =>
        patch({ viewBoxWidth: value })
      )
    );
    grid.appendChild(
      numberField('Drawing height (px)', view.viewBox.height, 1, (value) =>
        patch({ viewBoxHeight: value })
      )
    );
    grid.appendChild(
      textField('Background image', view.background || '', (value) =>
        patch({ background: value.trim() || null })
      )
    );
    grid.appendChild(
      selectField(
        'Borrow background from',
        view.backgroundFrom || '',
        ['', ...state.views.filter((v) => v.id !== view.id && v.background).map((v) => v.id)],
        (value) => patch({ backgroundFrom: value || undefined })
      )
    );
    wrap.appendChild(grid);
    wrap.appendChild(
      el(
        'p',
        'setup-panel__hint',
        'Drop background images in the project folder under img/ and type the path, e.g. img/east.webp.'
      )
    );
    return wrap;
  }

  function buildFooter() {
    const wrap = el('div', 'setup-panel__section setup-panel__footer');
    wrap.appendChild(button('Save views', 'button pill-button', () => onSave?.()));
    const status = el('span', 'setup-panel__status');
    if (state.status) {
      status.textContent = state.status.message;
      status.dataset.state = state.status.state;
    }
    wrap.appendChild(status);
    return wrap;
  }

  return {
    render,
    getSelectedId: () => state.selectedId,
    setStatus: (message, stateName) => {
      state.status = message ? { message, state: stateName || 'info' } : null;
      render(state.views);
    },
  };
}

/**
 * Apply one field change, keeping the feet extent and the pixel drawing at the
 * same aspect ratio. They are two knobs on one scale: letting them drift apart
 * is exactly the non-uniform view that createViewTransform rejects, so the form
 * moves the paired value rather than letting the user author a broken state.
 */
function applyPatch(view, changes) {
  const next = { ...view, viewBox: { ...view.viewBox }, extentFt: { ...view.extentFt }, originFt: { ...view.originFt } };

  if ('label' in changes) next.label = changes.label;
  if ('sublabel' in changes) next.sublabel = changes.sublabel;
  if ('background' in changes) next.background = changes.background;
  if ('backgroundFrom' in changes) {
    if (changes.backgroundFrom) next.backgroundFrom = changes.backgroundFrom;
    else delete next.backgroundFrom;
  }
  if ('type' in changes) {
    next.type = changes.type;
    if (next.type === 'elevation' && !next.viewFrom) next.viewFrom = 'south';
    if (next.type === 'plan') delete next.viewFrom;
  }
  if ('viewFrom' in changes) next.viewFrom = changes.viewFrom;
  if ('originX' in changes) next.originFt.x = changes.originX;
  if ('originY' in changes) next.originFt.y = changes.originY;

  const aspect = next.viewBox.height / next.viewBox.width;
  if ('extentWidthFt' in changes) {
    next.extentFt.width = changes.extentWidthFt;
    next.extentFt.height = changes.extentWidthFt * aspect;
  }
  if ('extentHeightFt' in changes) {
    next.extentFt.height = changes.extentHeightFt;
    next.extentFt.width = aspect ? changes.extentHeightFt / aspect : next.extentFt.width;
  }
  if ('viewBoxWidth' in changes || 'viewBoxHeight' in changes) {
    if ('viewBoxWidth' in changes) next.viewBox.width = changes.viewBoxWidth;
    if ('viewBoxHeight' in changes) next.viewBox.height = changes.viewBoxHeight;
    // Resizing the drawing keeps the yard width it covers and re-derives the rest.
    next.extentFt.height = next.extentFt.width * (next.viewBox.height / next.viewBox.width);
  }
  return next;
}

function moveView(views, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= views.length) return views;
  const next = [...views];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function newView(views) {
  const id = uniqueId(views, 'view');
  return {
    id,
    type: 'plan',
    label: 'New view',
    sublabel: 'Looking Down',
    viewBox: { width: 800, height: 600 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: 30, height: 22.5 },
    background: null,
  };
}

/** Ids are path-safe slugs and must be unique within the project. */
function uniqueId(views, base) {
  const slug = String(base).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '') || 'view';
  if (!views.some((view) => view.id === slug)) return slug;
  let n = 2;
  while (views.some((view) => view.id === `${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function iconButton(glyph, title, disabled, onClick) {
  const node = button(glyph, 'setup-panel__icon-btn', onClick);
  node.title = title;
  node.setAttribute('aria-label', title);
  node.disabled = Boolean(disabled);
  return node;
}

function field(labelText, input) {
  const wrap = el('label', 'setup-panel__field');
  wrap.appendChild(el('span', 'setup-panel__field-label', labelText));
  wrap.appendChild(input);
  return wrap;
}

function textField(labelText, value, onChange) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.addEventListener('change', (event) => onChange(event.target.value));
  return field(labelText, input);
}

function numberField(labelText, value, step, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(roundForDisplay(value));
  input.addEventListener('change', (event) => {
    const parsed = Number(event.target.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return field(labelText, input);
}

function selectField(labelText, value, options, onChange) {
  const select = document.createElement('select');
  options.forEach((option) => {
    const node = document.createElement('option');
    node.value = option;
    node.textContent = option === '' ? '—' : option;
    node.selected = option === value;
    select.appendChild(node);
  });
  select.addEventListener('change', (event) => onChange(event.target.value));
  return field(labelText, select);
}

/** Feet are authored to a hundredth; a full float in a form field is noise. */
function roundForDisplay(value) {
  const num = Number(value) || 0;
  return Math.round(num * 100) / 100;
}
