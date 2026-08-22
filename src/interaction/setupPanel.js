import {
  VIEW_FROM_DIRECTIONS,
  resolveElevationOrientation,
} from '../render/elevationOrientation.js';

/**
 * The Setup-mode control panel: the yard, a list of the project's views, and a
 * form over the selected one.
 *
 * **The yard is the only geometry anyone types.** How far it runs east-west and
 * north-south, how much margin to draw around it, and how tall the elevations
 * are — six numbers for the whole project, from which every view's rectangle is
 * derived. The panel used to ask for an extent and an origin per view, which
 * was four numbers times however many views, in coordinates that meant
 * something different per view type, and which could disagree with each other.
 *
 * What is left per view is what genuinely differs: what it is called, what it
 * looks at, and where its photograph sits — and the photograph is placed by
 * dragging it on the drawing, not by typing.
 *
 * Every edit goes through `onCommit(patch)`, which hands the app a candidate
 * project to validate and apply. The panel never mutates the live project
 * itself — a rejected edit must leave the canvas showing the last good state,
 * and the only way to guarantee that is to let the app own the transition.
 *
 * The numeric fields and the drawing are two views of the same state, so the
 * form re-reads from the project after every commit rather than trusting what
 * the user typed.
 */
export function createSetupPanel({
  root,
  onCommit,
  onSave,
  onSelect,
  onRulerToggle,
  onRulerApply,
  onUploadBackground,
}) {
  if (!root) {
    return {
      render: () => {},
      getSelectedId: () => '',
      setStatus: () => {},
      isRulerArmed: () => false,
      setMeasurement: () => {},
    };
  }

  // The ruler's state lives here rather than in the form, because the form is
  // rebuilt wholesale on every commit and a measurement has to outlive that.
  const state = {
    selectedId: '',
    project: { yardFt: { width: 0, depth: 0 }, paddingFt: 0, elevationFt: { above: 0, below: 0 }, pxPerFt: 0, views: [] },
    views: [],
    status: null,
    ruler: false,
    measurement: null,
  };

  function render(project) {
    state.project = project || state.project;
    state.views = Array.isArray(state.project.views) ? state.project.views : [];
    if (!state.views.some((view) => view.id === state.selectedId)) {
      state.selectedId = state.views[0]?.id || '';
    }
    root.replaceChildren(buildYard(), buildList(), buildForm(), buildFooter());
  }

  function selected() {
    return state.views.find((view) => view.id === state.selectedId) || null;
  }

  /** Commit a transformed copy; the panel keeps no draft of its own. */
  function commit(patch, nextSelectedId) {
    if (nextSelectedId !== undefined) state.selectedId = nextSelectedId;
    onCommit?.({ ...state.project, ...patch });
  }

  /** Commit a change to views[] alone. */
  function commitViews(nextViews, nextSelectedId) {
    commit({ views: nextViews }, nextSelectedId);
  }

  const rerender = () => render(state.project);

  function buildList() {
    const wrap = el('div', 'setup-panel__section');
    wrap.appendChild(el('h3', 'setup-panel__heading', 'Views'));

    const list = el('ul', 'setup-panel__list');
    state.views.forEach((view, index) => {
      const item = el('li', 'setup-panel__item');
      if (view.id === state.selectedId) item.classList.add('is-selected');

      const pick = button(`${view.label}`, 'setup-panel__pick', () => {
        state.selectedId = view.id;
        rerender();
        onSelect?.(view.id);
      });
      pick.setAttribute('aria-pressed', view.id === state.selectedId ? 'true' : 'false');
      const kind = el('span', 'setup-panel__item-kind', view.type === 'plan' ? 'plan' : view.viewFrom);
      pick.appendChild(kind);
      item.appendChild(pick);

      const actions = el('div', 'setup-panel__item-actions');
      actions.appendChild(
        iconButton('↑', 'Move up', index === 0, () => commitViews(moveView(state.views, index, -1)))
      );
      actions.appendChild(
        iconButton('↓', 'Move down', index === state.views.length - 1, () =>
          commitViews(moveView(state.views, index, 1))
        )
      );
      actions.appendChild(
        iconButton('⧉', 'Duplicate', false, () => {
          const copy = { ...view, id: uniqueId(state.views, view.id), label: `${view.label} copy` };
          const next = [...state.views];
          next.splice(index + 1, 0, copy);
          commitViews(next, copy.id);
        })
      );
      // A project with no views has nothing to draw, so the last one stays.
      actions.appendChild(
        iconButton('✕', 'Remove', state.views.length < 2, () =>
          commitViews(state.views.filter((_, i) => i !== index), '')
        )
      );
      item.appendChild(actions);
      list.appendChild(item);
    });
    wrap.appendChild(list);

    wrap.appendChild(
      button('+ Add view', 'button pill-button setup-panel__add', () => {
        const added = newView(state.views);
        commitViews([...state.views, added], added.id);
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
      commitViews(state.views.map((v) => (v.id === view.id ? applyPatch(v, changes) : v)));

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

    if (view.type === 'elevation') {
      grid.appendChild(
        optionalNumberField(
          `Camera stands ${cameraPrompt(view)}`,
          view.viewerAtFt,
          0.1,
          (value) => patch({ viewerAtFt: value })
        )
      );
    }
    grid.appendChild(
      textField('Background image', view.background || '', (value) =>
        patch({ background: value.trim() || null })
      )
    );
    grid.appendChild(uploadField(view));
    wrap.appendChild(grid);
    wrap.appendChild(buildPhoto(view, patch));
    return wrap;
  }

  /**
   * Placing the photograph: the two gestures, and a way back out of both.
   *
   * The drawing is fixed — it is the yard — so this is the only geometry left
   * to get right, and neither half of it is a number anyone can look up. Drag
   * until the yard outline sits on the yard in the picture; measure something
   * you know the length of to fix the scale.
   */
  function buildPhoto(view, patch) {
    const wrap = el('div', 'setup-panel__section setup-panel__photo');
    wrap.appendChild(el('h3', 'setup-panel__heading', 'Place the photo'));
    if (!view.background) {
      wrap.appendChild(
        el('p', 'setup-panel__hint', 'Upload a photo above, and it can be positioned here.')
      );
      return wrap;
    }
    wrap.appendChild(
      el(
        'p',
        'setup-panel__hint',
        state.ruler
          ? 'Measuring: drag across something in the photo whose real length you know.'
          : 'Drag the photo on the drawing to line it up with the orange yard outline.'
      )
    );
    wrap.appendChild(buildRuler(view));
    const reset = button('Reset photo to fill the panel', 'button pill-button', () =>
      patch({ photoFt: null })
    );
    reset.disabled = !view.photoFt;
    wrap.appendChild(reset);
    return wrap;
  }

  /**
   * Pick a photo for this view. The file never becomes the background directly:
   * the app resizes and re-encodes it, uploads the result, and commits the path
   * the server chose — so the text field above stays the single description of
   * where the image lives.
   */
  function uploadField(view) {
    const input = document.createElement('input');
    input.type = 'file';
    // Advisory only — the real allowlist is on the server, which checks the
    // bytes rather than the extension. SVG is left out on both sides.
    input.accept = 'image/png,image/jpeg,image/webp';
    input.dataset.backgroundUpload = '';
    input.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      // Clearing lets the same file be picked twice in a row, which is what
      // happens whenever the first attempt failed.
      event.target.value = '';
      if (file) onUploadBackground?.(file, view.id);
    });
    return field('Upload photo', input);
  }

  /**
   * Calibrate against the background photo: drag across something whose real
   * length you know, then say what that length is. The solve lives in
   * src/render/setupOverlay.js; this is only the affordance for it.
   */
  function buildRuler(view) {
    const wrap = el('div', 'setup-panel__ruler');
    const toggle = button(
      state.ruler ? 'Stop measuring' : 'Measure a known length',
      'button pill-button setup-panel__ruler-toggle',
      () => {
        state.ruler = !state.ruler;
        if (!state.ruler) state.measurement = null;
        rerender();
        onRulerToggle?.(state.ruler);
      }
    );
    toggle.dataset.rulerToggle = '';
    toggle.setAttribute('aria-pressed', state.ruler ? 'true' : 'false');
    toggle.classList.toggle('is-active', state.ruler);
    wrap.appendChild(toggle);

    if (!state.ruler) return wrap;

    if (!state.measurement) {
      wrap.appendChild(
        el(
          'p',
          'setup-panel__hint',
          `Drag across a known length on ${view.label}'s photo — a fence panel, a ` +
            'driveway, a doorway.'
        )
      );
      return wrap;
    }

    wrap.appendChild(
      el(
        'p',
        'setup-panel__hint setup-panel__ruler-readout',
        `Measured ${Math.round(state.measurement.pixels)} px — ` +
          `${roundForDisplay(state.measurement.feet)} ft at the current scale.`
      )
    );
    // Deliberately blank rather than pre-filled with the current reading: a
    // pre-filled field that already says the right number fires no change
    // event, so the obvious "yes, that one" gesture would do nothing.
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = '0';
    input.placeholder = 'e.g. 8';
    input.dataset.rulerLength = '';
    input.addEventListener('change', (event) => {
      const parsed = Number(event.target.value);
      if (Number.isFinite(parsed)) onRulerApply?.(parsed);
    });
    const wrapped = field('Real length (ft)', input);
    wrapped.classList.add('setup-panel__ruler-field');
    wrap.appendChild(wrapped);
    return wrap;
  }

  /**
   * The yard every view is derived from.
   *
   * Six numbers for the whole project, and the reason the panels line up: two
   * views cannot disagree about a yard there is only one of. This section used
   * to be a warning — it read out how much of the yard the views still had in
   * common, because each carried its own rectangle and reframing one silently
   * shrank where plants could live in all of them. There is nothing left to
   * warn about.
   */
  function buildYard() {
    const wrap = el('div', 'setup-panel__section setup-panel__yard');
    wrap.appendChild(el('h3', 'setup-panel__heading', 'The yard'));
    const { yardFt, paddingFt, elevationFt, pxPerFt } = state.project;

    const grid = el('div', 'setup-panel__grid');
    grid.appendChild(
      numberField('East–west (ft)', yardFt.width, 0.5, (value) =>
        commit({ yardFt: { ...yardFt, width: value } })
      )
    );
    grid.appendChild(
      numberField('North–south (ft)', yardFt.depth, 0.5, (value) =>
        commit({ yardFt: { ...yardFt, depth: value } })
      )
    );
    grid.appendChild(
      numberField('Margin around it (ft)', paddingFt, 0.5, (value) =>
        commit({ paddingFt: value })
      )
    );
    grid.appendChild(
      numberField('Elevations reach up (ft)', elevationFt.above, 1, (value) =>
        commit({ elevationFt: { ...elevationFt, above: value } })
      )
    );
    grid.appendChild(
      numberField('Foreground below ground (ft)', elevationFt.below, 0.5, (value) =>
        commit({ elevationFt: { ...elevationFt, below: value } })
      )
    );
    grid.appendChild(
      numberField('Resolution (px per ft)', pxPerFt, 1, (value) => commit({ pxPerFt: value }))
    );
    wrap.appendChild(grid);
    wrap.appendChild(
      el(
        'p',
        'setup-panel__hint',
        `Plants and features live in the ${roundForDisplay(yardFt.width)} × ` +
          `${roundForDisplay(yardFt.depth)} ft yard; the margin is drawing room around it, ` +
          'so a plant at the property line still has a grab handle clear of the panel ' +
          'edge. It is in feet, and the panels shrink as the yard grows — a very large ' +
          'yard wants a proportionally larger margin.'
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
      rerender();
    },
    isRulerArmed: () => state.ruler,
    /** @param {{pixels: number, feet: number}|null} measurement */
    setMeasurement: (measurement) => {
      state.measurement = measurement;
      rerender();
    },
  };
}

/**
 * Apply one field change to a view.
 *
 * There is no geometry here any more. A view's rectangle is derived from the
 * project's yard, so the fields that used to live in this function — extent,
 * origin, resolution — moved up to the yard form, where there is one of each
 * for the whole project instead of one set per view that could disagree with
 * the others.
 */
function applyPatch(view, changes) {
  const next = { ...view };

  if ('label' in changes) next.label = changes.label;
  if ('sublabel' in changes) next.sublabel = changes.sublabel;
  if ('background' in changes) next.background = changes.background;
  if ('photoFt' in changes) {
    // Null is "fill the panel again", which is where an uploaded photo starts
    // and the only way back if a drag went badly.
    if (changes.photoFt) next.photoFt = changes.photoFt;
    else delete next.photoFt;
  }
  if ('type' in changes) {
    next.type = changes.type;
    if (next.type === 'elevation' && !next.viewFrom) next.viewFrom = 'south';
    if (next.type === 'plan') delete next.viewFrom;
  }
  if ('viewFrom' in changes) next.viewFrom = changes.viewFrom;
  if ('viewerAtFt' in changes) {
    // Blank is a real answer — "this view has no camera position" — and it is
    // the default, so it has to be reachable by clearing the field.
    if (changes.viewerAtFt === null) delete next.viewerAtFt;
    else next.viewerAtFt = changes.viewerAtFt;
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

/** A new view needs no geometry: the yard supplies it the moment it exists. */
function newView(views) {
  const id = uniqueId(views, 'view');
  return { id, type: 'plan', label: 'New view', sublabel: 'Looking Down', background: null };
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

/**
 * A number the author may also leave unsaid. `numberField` cannot express that:
 * it parses on change and ignores anything non-finite, so an emptied field
 * silently keeps the old value. Here blank reports null.
 */
function optionalNumberField(labelText, value, step, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.placeholder = 'anywhere';
  input.value = Number.isFinite(value) ? String(roundForDisplay(value)) : '';
  input.addEventListener('change', (event) => {
    const raw = event.target.value.trim();
    if (raw === '') {
      onChange(null);
      return;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return field(labelText, input);
}

/**
 * Where an elevation's camera stands, said in compass words.
 *
 * The number is a position on the view's DEPTH axis — x for a view from the
 * east or west, y for one from the north or south — and "x ft" told the reader
 * nothing about which direction that ran or where it was measured from. The
 * axis grows east and north from the yard's south-west corner, so that is what
 * the field says.
 */
function cameraPrompt(view) {
  try {
    const { depthKey } = resolveElevationOrientation(view.viewFrom);
    return depthKey === 'y' ? 'this far north (ft)' : 'this far east (ft)';
  } catch {
    return 'at (ft)';
  }
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
