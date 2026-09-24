/**
 * Setup mode: declaring the yard, adding and ordering views, placing each
 * view's photograph and each elevation's camera, and repairing a design the
 * yard no longer contains. Owns the setup panel, the one-view-at-a-time setup
 * overlay, validation of every view edit, and the stranded-plant actions.
 * Like Features mode, it saves only when asked, and each save is one revision
 * in the yard's history (nl-3s5.20): undo can take it back, and
 * restoreConfig is how an undo or redo puts a revision's setup on screen.
 *
 * The setup CONTROLLERS stay built by src/app.js, in rebuildViews, beside the
 * drag and feature controllers (see src/interaction/featuresMode.js for why),
 * and so does the photo-aspect cache they read at construction. Everything
 * app.js may reassign (the view panels, the controller list, render,
 * commitLayoutChange) comes in as a getter or a forwarding function; `project`
 * is passed directly because app.js assigns it once and only ever mutates it
 * in place (Object.assign in applyViewEdit).
 */
import { createSetupPanel } from './setupPanel.js';
import { normalizeProjectConfig, projectAssetPath, serializeProjectConfig } from '../data/projectConfig.js';
import { compressBackgroundImage, uploadViewBackground } from '../data/backgroundUpload.js';
import {
  clearSetupOverlay,
  renderSetupOverlay,
  viewBoxAttribute,
  workingExtentFt,
} from '../render/setupOverlay.js';
import { featurePoints, patchView, round2, scaleFeatures, translateFeaturesInside } from '../state/yardEdits.js';
import { formatFileSize } from '../ui/controls.js';

/**
 * @param {object} deps
 * @param {HTMLElement|null} deps.root                  the setup panel's row
 * @param {object} deps.appState
 * @param {object} deps.project                         mutated in place, never replaced
 * @param {HTMLElement|null} deps.viewsContainer
 * @param {() => Array<object>} deps.getViewPanels
 * @param {() => Array<object|null>} deps.getControllers   index-aligned with the view panels
 * @param {(view: object) => number} deps.photoAspectFor
 * @param {() => void} deps.applyPageScale
 * @param {() => void} deps.rebuildViews
 * @param {() => void} deps.render
 * @param {(description: string) => void} deps.commitLayoutChange
 * @param {(project: object, status: Function) => Promise<object|null>} deps.saveSetup
 *   records and persists the setup as one revision (layoutHistoryController.commitSetup)
 * @param {{ apply: Function, save: Function }} deps.featuresMode
 * @param {(project: object) => void} deps.onProjectRenamed  update the page title and picker label
 */
export function createSetupMode({
  root: setupRow,
  appState,
  project,
  viewsContainer,
  getViewPanels,
  getControllers,
  photoAspectFor,
  applyPageScale,
  rebuildViews,
  render,
  commitLayoutChange,
  saveSetup,
  featuresMode,
  onProjectRenamed,
}) {
  const setupPanel = createSetupPanel({
    root: setupRow,
    onCommit: (candidate) => applyViewEdit(candidate),
    onSelect: () => syncSetupOverlay(),
    onShowChange: () => syncSetupOverlay(),
    onResolveConflicts: (request) => resolveStrandedPlants(request),
    getPlants: () => appState.plants,
    getFeatures: () => appState.features,
    /**
     * Picked photo to live background: compress, upload, then commit the path
     * the server chose. The view is only patched after the bytes are on disk —
     * committing first would point the drawing at a file that may never arrive.
     */
    onUploadBackground: async (file, viewId) => {
      setupPanel.setStatus('Preparing photo…', 'info');
      try {
        const { blob, contentType, width, height } = await compressBackgroundImage(file);
        setupPanel.setStatus(`Uploading ${formatFileSize(blob.size)}…`, 'info');
        const background = await uploadViewBackground({
          projectId: project.id,
          viewId,
          blob,
          contentType,
        });
        // The photo is on disk either way, but if the candidate views[] is
        // refused the panel is still showing the old background — and
        // applyViewEdit has already explained why. Reporting success over the
        // top of that would be a straight lie.
        // A new photo is a new picture: whatever placement the last one had
        // describes a rectangle of a different image, so it goes with it.
        if (!applyViewEdit({ views: patchView(project.views, viewId, { background, photoFt: undefined }) }))
          return;
        setupPanel.setStatus(
          `Background set — ${width}×${height}, ${formatFileSize(blob.size)}. Save views to keep it.`,
          'success'
        );
      } catch (err) {
        console.warn('Background upload failed', err);
        setupPanel.setStatus(err.message || 'Background upload failed', 'error');
      }
    },
    onSave: async () => {
      setupPanel.setStatus('Saving…', 'info');
      const saved = await saveSetup(project, (message, state) => setupPanel.setStatus(message, state));
      if (saved && !saved.unchanged) setupPanel.setStatus('Views saved', 'success');
    },
  });

  /**
   * Validate a candidate project the same way a reload would, then swap it in.
   * Round-tripping through serialize + normalize means a rejected edit leaves
   * the drawing on the last good state instead of throwing mid-render.
   *
   * @param {object} candidate the full next project — setupPanel's commit()
   * always spreads its own state.project under the patch before calling this,
   * so candidate already carries everything, including any optional field the
   * edit cleared. Merging it back onto `serializeProjectConfig(project)` would
   * undo exactly that: an optional field's serializer omits it once cleared
   * (falsy), and the old value would resurface from the base object instead of
   * staying gone.
   * @returns {boolean} whether the edit was applied — a caller that reports its
   * own success afterwards must not paper over the rejection message set here.
   */
  function applyViewEdit(candidate) {
    let validated;
    try {
      validated = normalizeProjectConfig(serializeCandidate(candidate), project.id);
    } catch (err) {
      setupPanel.setStatus(err.message, 'error');
      return false;
    }
    Object.assign(project, validated);
    appState.project = project;
    onProjectRenamed(project);
    rebuildViews();
    setupPanel.render(project);
    return true;
  }

  /**
   * Put a revision's setup on screen (undo, redo). Unlike applyViewEdit this
   * REPLACES the project rather than merging onto it: an older setup without
   * an ecoregion, a site, a place or a photo placement must come back
   * without it, not with today's value showing through. `project` is
   * mutated in place, never replaced, because app.js and this module share it.
   *
   * The ecology tables were loaded once for the ecoregion the page opened
   * with; a restored setup with another ecoregion is checked against those
   * until a reload.
   *
   * @param {object} config the revision's config, file shape
   * @returns {boolean} whether it was applied
   */
  function restoreConfig(config) {
    let validated;
    try {
      validated = normalizeProjectConfig(config, project.id);
    } catch (err) {
      setupPanel.setStatus(err.message, 'error');
      return false;
    }
    Object.keys(project).forEach((key) => {
      if (!(key in validated)) delete project[key];
    });
    Object.assign(project, validated);
    appState.project = project;
    onProjectRenamed(project);
    rebuildViews();
    setupPanel.render(project);
    return true;
  }

  /**
   * A candidate carries normalized views, which serializeProjectConfig would
   * refuse to read from a half-built object. Run it through the same serializer
   * so the yard, the padding, and each view's photo arrive in file shape.
   */
  function serializeCandidate(candidate) {
    return serializeProjectConfig({ ...project, ...candidate });
  }

  /**
   * Move the plants a resized yard has left outside it.
   *
   * Never automatic. Resizing is exploratory — you type 6, look, type 8 — so a
   * yard edit redraws and reports, and only a button here moves anything. Both
   * actions are one entry in the layout history, so either is one undo.
   *
   * The two are not two mechanisms, they are two intents, and the panel says so:
   *
   * - **scale** is the "I mis-measured" correction. Every plant AND every
   *   feature moves together, uniformly, about the yard's corner, so the design
   *   keeps its shape. Uniform and never enlarging: a non-uniform fit would
   *   distort the spacing between plants, which is most of what a planting plan
   *   is, and growing a design to fill a yard is not a repair.
   * - **clamp** is the "that ground is gone" correction, and touches only what
   *   is stranded. A plant is clamped point-by-point; a feature is translated
   *   as a whole instead (nl-1ug) — clamping its points independently would
   *   deform the shape a bed or wall is supposed to keep.
   *
   * @param {{ action: 'scale'|'clamp', plantIds?: Array<string>, featureIds?: Array<string> }} request
   */
  function resolveStrandedPlants({ action, plantIds, featureIds }) {
    const yardFt = project.yardFt;
    if (!(yardFt?.width > 0) || !(yardFt?.depth > 0)) return;

    if (action === 'clamp') {
      const wantedPlants = new Set(plantIds || []);
      const wantedFeatures = new Set(featureIds || []);
      if (wantedPlants.size) {
        appState.plants = appState.plants.map((plant) =>
          wantedPlants.has(plant.id)
            ? { ...plant, x: clamp(plant.x, 0, yardFt.width), y: clamp(plant.y, 0, yardFt.depth) }
            : plant
        );
      }
      let featuresChanged = false;
      if (wantedFeatures.size) {
        const translated = translateFeaturesInside(appState.features, wantedFeatures, yardFt);
        featuresChanged = translated !== appState.features && featuresMode.apply(translated);
      }
      const movedCount = wantedPlants.size + wantedFeatures.size;
      commitLayoutChange(movedCount === 1 ? 'Moved an item inside the yard' : 'Moved items inside the yard');
      if (featuresChanged) featuresMode.save();
      setupPanel.render(project);
      setupPanel.setStatus(`Moved ${movedCount} inside the boundary.`, 'success');
      render();
      return;
    }

    // The factor comes from what is actually drawn, not from the yard's own
    // previous size — which nothing remembers by the time a resize has been
    // typed, deleted, and retyped a few times.
    const reach = contentReach();
    if (!reach) return;
    const factor = Math.min(1, yardFt.width / reach.x, yardFt.depth / reach.y);
    if (!(factor > 0) || factor >= 1) {
      // Nothing overshoots the far side, so everything stranded is off the
      // SOUTH or WEST edge — at a negative coordinate, which shrinking about
      // the origin only pushes further out. Saying so beats a button that
      // appears to do nothing.
      setupPanel.setStatus(
        'Scaling cannot help here: what is outside is off the south or west edge, ' +
          'and scaling about the yard corner only moves it further out. Move those ' +
          'inside the boundary instead.',
        'error'
      );
      return;
    }

    appState.plants = appState.plants.map((plant) => ({
      ...plant,
      x: round2(plant.x * factor),
      y: round2(plant.y * factor),
    }));
    const features = scaleFeatures(appState.features, factor);
    commitLayoutChange('Scaled the design to fit the yard');
    // The layout is written the moment it changes and features are not, so
    // leaving these to a separate Save would land a reload in exactly the state
    // this action exists to prevent: beds at one size, the plants in them at
    // another.
    const featuresChanged = features !== appState.features && featuresMode.apply(features);
    if (featuresChanged) featuresMode.save();
    setupPanel.render(project);
    setupPanel.setStatus(
      `Scaled everything to ${Math.round(factor * 100)}% about the yard corner` +
        (featuresChanged ? ', features included.' : '.'),
      'success'
    );
    render();
  }

  /**
   * How far the design reaches from the yard's corner, plants and features alike.
   *
   * Only the far side: scaling about the origin is what "fit" means here, and a
   * negative coordinate is not something it can pull in.
   */
  function contentReach() {
    let x = 0;
    let y = 0;
    appState.plants.forEach((plant) => {
      x = Math.max(x, plant.x);
      y = Math.max(y, plant.y);
    });
    featurePoints(appState.features).forEach((point) => {
      x = Math.max(x, point.x);
      y = Math.max(y, point.y);
    });
    return x > 0 && y > 0 ? { x, y } : null;
  }

  /**
   * Setup draws ONE view: the selected one, scaled to the whole page.
   *
   * Every panel used to draw the guides so the foot grid could be compared
   * across views, because each view carried its own rectangle and had to be
   * aligned against its neighbours by eye. The yard is declared now, so there
   * is nothing left to align — and the page's whole width spent on one drawing
   * beats four small ones for the work that remains, which is framing photos
   * and placing cameras.
   *
   * Rendering clears each SVG, so this runs after every render rather than once.
   */
  function syncSetupOverlay() {
    const viewPanels = getViewPanels();
    const setupControllers = getControllers();
    const inSetup = appState.mode === 'setup';
    const selectedId = inSetup ? setupPanel.getSelectedId() : '';
    const show = inSetup ? setupPanel.getShow() : { plants: true, features: true };

    // Setup shows ONE view at a time. Every panel used to draw its guides so the
    // foot grid could be compared across views, which mattered when each view
    // carried its own rectangle and had to be aligned by eye. The yard is
    // declared now, so there is nothing left to align — and the whole page's
    // width spent on one drawing is worth far more than four small ones.
    if (viewsContainer) {
      viewsContainer.toggleAttribute('data-setup-focus', inSetup);
      viewsContainer.toggleAttribute('data-hide-plants', inSetup && !show.plants);
      viewsContainer.toggleAttribute('data-hide-features', inSetup && !show.features);
    }

    viewPanels.forEach(({ view, svg, panel, container }, index) => {
      const isSelected = view.id === selectedId;
      const focused = inSetup && isSelected;
      panel.classList.toggle('is-setup-focus', focused);
      setupControllers[index]?.setLocked?.(!isSelected);
      // Setup widens the drawing's window so a photo reaching past the view is
      // visible while it is being positioned; same units and origin, larger box.
      svg.setAttribute('viewBox', viewBoxAttribute(view, { working: focused }));
      // The panel is sized to whichever window it is showing, so the widened
      // one is not letterboxed inside a panel shaped for the narrow one.
      if (container?.style) {
        const extentFt = focused ? workingExtentFt(view) : view.extentFt;
        container.style.setProperty('--extent-w', String(extentFt.width));
        container.style.setProperty('--extent-h', String(extentFt.height));
        container.style.setProperty(
          '--view-aspect-ratio',
          `${extentFt.width} / ${extentFt.height}`
        );
      }
      // Only the shown view is drawn. Guides on a hidden panel are work nobody
      // sees, and they used to be the neighbours' cross-view reference — which
      // a declared yard has made unnecessary.
      if (!focused) {
        clearSetupOverlay(svg);
        return;
      }
      renderSetupOverlay(svg, view, {
        interactive: isSelected,
        yardFt: project.yardFt,
        paddingFt: project.paddingFt,
        photoAspect: photoAspectFor(view),
        // Setup draws the photo itself rather than leaving it to the panel's
        // CSS background, which is clipped to its element.
        photoUrl: view.background
          ? new URL(projectAssetPath(project.id, view.background), document.baseURI).toString()
          : '',
        // A plan draws every elevation's camera, so it needs the whole list;
        // the selected one is emphasised so the list and the drawing agree
        // about which view is being set up.
        views: project.views,
        highlightId: selectedId,
      });
    });
    // The focused panel has the page to itself, so it is scaled to fill it.
    applyPageScale();
  }

  return {
    panel: setupPanel,
    sync: syncSetupOverlay,
    applyViewEdit,
    restoreConfig,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}
