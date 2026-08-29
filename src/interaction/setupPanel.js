import {
  VIEW_FROM_DIRECTIONS,
  resolveElevationOrientation,
} from '../render/elevationOrientation.js';
import { SITE_VOCABULARY } from '../data/projectConfig.js';

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
  onUploadBackground,
  onShowChange,
  onResolveConflicts,
  getPlants,
}) {
  if (!root) {
    return {
      render: () => {},
      getSelectedId: () => '',
      getShow: () => ({ plants: false, features: false }),
      setStatus: () => {},
    };
  }

  const state = {
    selectedId: '',
    project: { yardFt: { width: 0, depth: 0 }, paddingFt: 0, elevationFt: { above: 0, below: 0 }, pxPerFt: 0, views: [] },
    views: [],
    status: null,
    // What the single viewport draws besides the guides. Off by default:
    // setup is about the yard and the views, and a full planting is noise
    // against a photo being framed. Forced on while a resize has stranded
    // something, because then the plants ARE the subject.
    show: { plants: false, features: false },
  };

  function render(project) {
    state.project = project || state.project;
    state.views = Array.isArray(state.project.views) ? state.project.views : [];
    if (!state.views.some((view) => view.id === state.selectedId)) {
      state.selectedId = state.views[0]?.id || '';
    }
    root.replaceChildren(buildYard(), buildConflicts(), buildList(), buildForm(), buildFooter());
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
      grid.appendChild(
        textField('Sky colour', view.skyColor || '', (value) =>
          patch({ skyColor: value.trim() || null })
        )
      );
      grid.appendChild(
        textField('Ground colour', view.groundColor || '', (value) =>
          patch({ groundColor: value.trim() || null })
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
   * Positioning the photograph.
   *
   * Two gestures on the drawing and one button here, because there is nothing
   * to type: where a photo sits against the yard is something you see or you do
   * not. The drawing widens in Setup so the parts reaching outside the view are
   * visible while they are being moved.
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
        'Drag the photo to line it up with the orange yard outline; pull a corner ' +
          'to resize it. It keeps its own proportions, and whatever reaches past ' +
          'the view is simply cropped everywhere else.'
      )
    );
    const reset = button('Centre the photo in the view', 'button pill-button', () =>
      patch({ photoFt: null })
    );
    reset.disabled = !view.photoFt;
    wrap.appendChild(reset);
    wrap.appendChild(
      checkboxField('Hide photo outside Setup', Boolean(view.photoHidden), false, (value) =>
        patch({ photoHidden: value })
      )
    );
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
    wrap.appendChild(buildEcology());
    wrap.appendChild(buildShowToggles());
    return wrap;
  }

  /**
   * What the ecology rules need and this project may not have said yet: the
   * EPA Level I ecoregion the keystone-genus lists are keyed by, and the site
   * conditions each planted species gets checked against. Both optional — a
   * project that never declares them gets "not declared" on those rules rather
   * than a guess graded against the wrong ground.
   */
  function buildEcology() {
    const wrap = el('div', 'setup-panel__ecology');
    wrap.appendChild(el('h3', 'setup-panel__heading', 'Ecoregion & site'));
    const { ecoregion, site } = state.project;

    const grid = el('div', 'setup-panel__grid');
    grid.appendChild(
      textField('EPA Level I ecoregion', ecoregion || '', (value) => {
        const trimmed = value.trim();
        commit({ ecoregion: trimmed || null });
      })
    );
    ['sun', 'water', 'soil'].forEach((key) => {
      grid.appendChild(
        selectField(
          siteFieldLabel(key),
          site?.[key] || '',
          ['', ...SITE_VOCABULARY[key]],
          (value) => commit({ site: { ...site, [key]: value || null } })
        )
      );
    });
    wrap.appendChild(grid);
    wrap.appendChild(
      el(
        'p',
        'setup-panel__hint',
        'The ecoregion (e.g. "9" for the Blackland Prairie / Great Plains) picks which ' +
          'keystone-genus lists this planting is graded against. Sun, water, and soil ' +
          'describe the site itself, which each planted species is checked against — ' +
          'leave any of them blank to skip that check.'
      )
    );
    return wrap;
  }

  function siteFieldLabel(key) {
    if (key === 'sun') return 'Sun';
    if (key === 'water') return 'Water';
    return 'Soil';
  }

  /**
   * What the viewport draws besides the guides.
   *
   * Both off by default. Setup is about stating the yard and framing the views,
   * and a full planting drawn over a photo being positioned is noise — but a
   * feature you are checking against the picture, or the plant you are looking
   * for, is exactly what you want. The plants switch is disabled while
   * something is out of bounds: `getShow` forces them on there, and a control
   * that appears to turn them off while they stay on is worse than no control.
   */
  function buildShowToggles() {
    const wrap = el('div', 'setup-panel__toggles');
    const stranded = outOfBounds().length > 0;
    wrap.appendChild(
      checkboxField('Show plants', state.show.plants || stranded, stranded, (value) => {
        state.show.plants = value;
        onShowChange?.();
        rerender();
      })
    );
    wrap.appendChild(
      checkboxField('Show features', state.show.features, false, (value) => {
        state.show.features = value;
        onShowChange?.();
        rerender();
      })
    );
    return wrap;
  }

  /**
   * Plants the yard no longer contains.
   *
   * Shrinking a yard below what is standing in it is the one way the declared
   * yard can still strand something: no VIEW can miss the yard any more, but
   * the yard is a number a person can type, and `resolveYardBounds` clamps only
   * new drags — a plant already outside cannot be dragged back in.
   *
   * Reported, never repaired on its own. Resizing is exploratory: you type 6,
   * look, type 8. Anything that moved a plant per keystroke would be
   * unrecoverable in practice however good the undo stack is. So the list
   * stands until a button is pressed, and it comes back on reload for a project
   * saved in that state.
   */
  function outOfBounds() {
    const { yardFt } = state.project;
    if (!(yardFt?.width > 0) || !(yardFt?.depth > 0)) return [];
    // Read through rather than snapshotted: the layout finishes loading after
    // the panel is first built, and the conflict list has to notice.
    const plants = getPlants?.() || [];
    return plants.filter(
      (plant) =>
        plant.x < 0 || plant.x > yardFt.width || plant.y < 0 || plant.y > yardFt.depth
    );
  }

  function buildConflicts() {
    const wrap = el('div', 'setup-panel__section setup-panel__conflicts');
    const stranded = outOfBounds();
    if (!stranded.length) return wrap;

    wrap.appendChild(
      el('h3', 'setup-panel__heading', `${stranded.length} outside the yard`)
    );
    wrap.appendChild(
      el(
        'p',
        'setup-panel__yard-alarm',
        'These sit off the property as the yard is now measured. They still draw ' +
          'in the margin, but nothing can be dragged back to where they are.'
      )
    );

    const list = el('ul', 'setup-panel__list setup-panel__strays');
    stranded.forEach((plant) => {
      const item = el('li', 'setup-panel__item');
      const name = el('span', 'setup-panel__stray-name', plant.commonName || plant.id);
      const at = el(
        'span',
        'setup-panel__stray-at',
        `${roundForDisplay(plant.x)}, ${roundForDisplay(plant.y)} ft — ${describeStray(plant)}`
      );
      const text = el('div', 'setup-panel__stray-text');
      text.append(name, at);
      item.appendChild(text);
      item.appendChild(
        button('Move inside', 'setup-panel__stray-action', () =>
          onResolveConflicts?.({ action: 'clamp', ids: [plant.id] })
        )
      );
      list.appendChild(item);
    });
    wrap.appendChild(list);

    const actions = el('div', 'setup-panel__stray-bulk');
    actions.appendChild(
      button('Move all inside the boundary', 'button pill-button', () =>
        onResolveConflicts?.({ action: 'clamp', ids: stranded.map((p) => p.id) })
      )
    );
    actions.appendChild(
      button('Scale the whole design to fit', 'button pill-button', () =>
        onResolveConflicts?.({ action: 'scale' })
      )
    );
    wrap.appendChild(actions);
    wrap.appendChild(
      el(
        'p',
        'setup-panel__hint',
        'Scaling moves every plant and feature together about the yard corner, so ' +
          'the design keeps its shape — that is the fix for a yard that was ' +
          'mis-measured. Moving inside touches only what is stranded, which is the ' +
          'fix for ground that is genuinely gone.'
      )
    );
    return wrap;
  }

  /** Which way a stray is out, in the words the yard fields use. */
  function describeStray(plant) {
    const { yardFt } = state.project;
    const ways = [];
    if (plant.x < 0) ways.push(`${roundForDisplay(-plant.x)} ft west of it`);
    if (plant.x > yardFt.width) ways.push(`${roundForDisplay(plant.x - yardFt.width)} ft east of it`);
    if (plant.y < 0) ways.push(`${roundForDisplay(-plant.y)} ft south of it`);
    if (plant.y > yardFt.depth) ways.push(`${roundForDisplay(plant.y - yardFt.depth)} ft north of it`);
    return ways.join(' and ');
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
    /** Plants are forced on while something is stranded; see buildConflicts. */
    getShow: () => ({
      plants: state.show.plants || outOfBounds().length > 0,
      features: state.show.features,
    }),
    setStatus: (message, stateName) => {
      state.status = message ? { message, state: stateName || 'info' } : null;
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
  if ('photoHidden' in changes) {
    if (changes.photoHidden) next.photoHidden = true;
    else delete next.photoHidden;
  }
  if ('viewerAtFt' in changes) {
    // Blank is a real answer — "this view has no camera position" — and it is
    // the default, so it has to be reachable by clearing the field.
    if (changes.viewerAtFt === null) delete next.viewerAtFt;
    else next.viewerAtFt = changes.viewerAtFt;
  }
  if ('skyColor' in changes) {
    if (changes.skyColor) next.skyColor = changes.skyColor;
    else delete next.skyColor;
  }
  if ('groundColor' in changes) {
    if (changes.groundColor) next.groundColor = changes.groundColor;
    else delete next.groundColor;
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

function checkboxField(labelText, checked, disabled, onChange) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.disabled = Boolean(disabled);
  input.addEventListener('change', (event) => onChange(event.target.checked));
  const wrap = el('label', 'setup-panel__checkbox');
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'setup-panel__field-label', labelText));
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
