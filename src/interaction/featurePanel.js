/**
 * The Features-mode control panel: the yard's shapes, and a form over the
 * selected one.
 *
 * The setup panel's sibling, and it keeps the same contract: every edit goes
 * through `onCommit(features)`, which hands the app a candidate list to
 * validate and apply. The panel never mutates the live model — a rejected edit
 * must leave the drawing on the last good state, and the only way to guarantee
 * that is to let the app own the transition.
 *
 * Height, base, and label are form fields rather than gestures. That is the
 * whole reason this editor stays small: a footprint is a drag in plan space, a
 * height is a number, and elevations are derived from both.
 */

export const FEATURE_TYPES = ['surface', 'wall', 'box'];

const TYPE_HINTS = {
  surface: 'flat — bed, path, driveway',
  wall: 'extruded line — fence, edging',
  box: 'extruded shape — house, shed',
};

export function createFeaturePanel({ root, onCommit, onSave, onSelect, onAdd }) {
  if (!root) {
    return {
      render: () => {},
      getSelectedId: () => '',
      setSelectedId: () => {},
      setStatus: () => {},
    };
  }

  const state = { selectedId: '', features: [], status: null };

  function render(features) {
    state.features = Array.isArray(features) ? features : [];
    if (state.selectedId && !state.features.some((f) => f.id === state.selectedId)) {
      state.selectedId = '';
    }
    root.replaceChildren(buildList(), buildForm(), buildFooter());
  }

  function selected() {
    return state.features.find((feature) => feature.id === state.selectedId) || null;
  }

  function commit(nextFeatures, nextSelectedId) {
    if (nextSelectedId !== undefined) state.selectedId = nextSelectedId;
    onCommit?.(nextFeatures);
  }

  function buildList() {
    const wrap = el('div', 'feature-panel__section');
    wrap.appendChild(el('h3', 'feature-panel__heading', 'Yard features'));

    if (!state.features.length) {
      wrap.appendChild(
        el('p', 'feature-panel__hint', 'Nothing drawn yet. Add a shape, then drag it on the plan.')
      );
    }

    const list = el('ul', 'feature-panel__list');
    state.features.forEach((feature, index) => {
      const item = el('li', 'feature-panel__item');
      if (feature.id === state.selectedId) item.classList.add('is-selected');

      const pick = button(feature.label, 'feature-panel__pick', () => {
        state.selectedId = feature.id;
        render(state.features);
        onSelect?.(feature.id);
      });
      pick.setAttribute('aria-pressed', feature.id === state.selectedId ? 'true' : 'false');
      pick.appendChild(el('span', 'feature-panel__item-kind', feature.type));
      item.appendChild(pick);

      const actions = el('div', 'feature-panel__item-actions');
      // Array order is the plan's z-order, so up and down are a real edit here.
      actions.appendChild(
        iconButton('↑', 'Move up', index === 0, () => commit(swap(state.features, index, -1)))
      );
      actions.appendChild(
        iconButton('↓', 'Move down', index === state.features.length - 1, () =>
          commit(swap(state.features, index, 1))
        )
      );
      actions.appendChild(
        iconButton('✕', 'Remove', false, () =>
          commit(
            state.features.filter((entry) => entry.id !== feature.id),
            state.selectedId === feature.id ? '' : state.selectedId
          )
        )
      );
      item.appendChild(actions);
      list.appendChild(item);
    });
    wrap.appendChild(list);

    const adders = el('div', 'feature-panel__adders');
    FEATURE_TYPES.forEach((type) => {
      const add = button(`+ ${type}`, 'button pill-button feature-panel__add', () => onAdd?.(type));
      add.title = TYPE_HINTS[type];
      adders.appendChild(add);
    });
    wrap.appendChild(adders);
    return wrap;
  }

  function buildForm() {
    const feature = selected();
    const wrap = el('div', 'feature-panel__section');
    if (!feature) return wrap;
    wrap.appendChild(el('h3', 'feature-panel__heading', 'Selected feature'));

    const patch = (changes) =>
      commit(
        state.features.map((entry) => (entry.id === feature.id ? { ...entry, ...changes } : entry))
      );

    const grid = el('div', 'feature-panel__grid');
    grid.appendChild(textField('Name', feature.label, (value) => patch({ label: value })));
    // Type is not editable: surface and box are authored as a polygon, a wall as
    // a path, so switching would need the footprint rebuilt. Delete and re-add.
    grid.appendChild(readOnlyField('Kind', `${feature.type} — ${TYPE_HINTS[feature.type]}`));

    if (feature.type !== 'surface') {
      grid.appendChild(
        numberField('Height (ft)', feature.heightFt, 0.5, (value) => patch({ heightFt: value }))
      );
    }
    grid.appendChild(
      numberField('Base (ft)', feature.baseFt, 0.5, (value) => patch({ baseFt: value }))
    );
    grid.appendChild(
      colorField('Fill', feature.style.fill, (value) =>
        patch({ style: { ...feature.style, fill: value } })
      )
    );
    grid.appendChild(
      colorField('Outline', feature.style.stroke, (value) =>
        patch({ style: { ...feature.style, stroke: value } })
      )
    );
    wrap.appendChild(grid);

    wrap.appendChild(
      el(
        'p',
        'feature-panel__hint',
        'Drag the shape to move it, or a corner to reshape it. Elevations follow.'
      )
    );
    return wrap;
  }

  function buildFooter() {
    const wrap = el('div', 'feature-panel__section feature-panel__footer');
    wrap.appendChild(button('Save features', 'button pill-button', () => onSave?.()));
    const status = el('span', 'feature-panel__status');
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
    setSelectedId: (id) => {
      state.selectedId = String(id || '');
      render(state.features);
    },
    setStatus: (message, stateName) => {
      state.status = message ? { message, state: stateName || 'info' } : null;
      render(state.features);
    },
  };
}

function swap(features, index, delta) {
  const next = index + delta;
  if (next < 0 || next >= features.length) return features;
  const moved = [...features];
  [moved[index], moved[next]] = [moved[next], moved[index]];
  return moved;
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
  const node = button(glyph, 'feature-panel__icon-btn', onClick);
  node.title = title;
  node.setAttribute('aria-label', title);
  node.disabled = Boolean(disabled);
  return node;
}

function field(labelText, input) {
  const wrap = el('label', 'feature-panel__field');
  wrap.appendChild(el('span', 'feature-panel__field-label', labelText));
  wrap.appendChild(input);
  return wrap;
}

function readOnlyField(labelText, value) {
  const wrap = el('div', 'feature-panel__field');
  wrap.appendChild(el('span', 'feature-panel__field-label', labelText));
  wrap.appendChild(el('span', 'feature-panel__field-static', value));
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
  input.value = String(Math.round((Number(value) || 0) * 100) / 100);
  input.addEventListener('change', (event) => {
    const parsed = Number(event.target.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return field(labelText, input);
}

function colorField(labelText, value, onChange) {
  const input = document.createElement('input');
  input.type = 'color';
  // The picker only speaks #rrggbb; a named colour from a hand-edited file
  // would blank it out, so fall back to something it can show.
  input.value = /^#[0-9a-f]{6}$/i.test(String(value)) ? value : '#cccccc';
  input.addEventListener('change', (event) => onChange(event.target.value));
  return field(labelText, input);
}
