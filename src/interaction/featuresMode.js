/**
 * Features mode: drawing the yard model (beds, hardscape, walls, the house)
 * on the plan. Owns the feature panel, the plan's feature overlay, and the
 * edit → validate → save path for features.json. Like Setup mode, it saves
 * only when asked; there is no undo stack behind features.
 *
 * The feature CONTROLLERS stay built by src/app.js, in rebuildViews, next to
 * the drag and setup controllers: all three kinds bind to the same SVGs and are
 * torn down and rebuilt together, in one order. Their callbacks reach this
 * module through the object this returns.
 *
 * Everything app.js may reassign (the view panels, the controller list, the
 * render function) comes in as a getter.
 */
import { createFeaturePanel } from './featurePanel.js';
import { normalizeFeatures } from '../data/featureConfig.js';
import { persistFeatures } from '../data/persistence.js';
import { clearFeatureOverlay, createFeatureShape, renderFeatureOverlay } from '../render/featureOverlay.js';
import { createViewTransform } from '../render/viewTransform.js';
import { resolveYardBounds } from '../render/yardBounds.js';

/**
 * @param {object} deps
 * @param {HTMLElement|null} deps.root                the feature panel's row
 * @param {object} deps.appState                      reads mode; reads and replaces features
 * @param {() => object} deps.getProject
 * @param {() => Array<{ view: object, svg: SVGSVGElement }>} deps.getViewPanels
 * @param {() => Array<object|null>} deps.getControllers  index-aligned with the view panels
 * @param {(viewId: string) => object|undefined} deps.liveView
 * @param {() => void} deps.render
 */
export function createFeaturesMode({ root, appState, getProject, getViewPanels, getControllers, liveView, render }) {
  const featurePanel = createFeaturePanel({
    root,
    onCommit: (features) => applyFeatureEdit(features),
    onSave: () => saveFeatures(),
    onSelect: () => syncFeatureOverlay(),
    onAdd: (type) => addFeature(type),
  });

  /**
   * The feature handles belong to the plan alone, and only in Features mode.
   * Rendering clears each SVG, so this runs after every render rather than once.
   */
  function syncFeatureOverlay() {
    const editing = appState.mode === 'features';
    const featureControllers = getControllers();
    getViewPanels().forEach(({ view, svg }, index) => {
      const active = editing && view.type === 'plan';
      featureControllers[index]?.setLocked?.(!active);
      if (!active) {
        clearFeatureOverlay(svg);
        return;
      }
      renderFeatureOverlay(
        svg,
        appState.features,
        featurePanel.getSelectedId(),
        createViewTransform(liveView(view.id) || view)
      );
    });
  }

  /** Swap one feature for its edited candidate, keeping the list's z-order. */
  function replaceFeature(features, candidate) {
    return features.map((feature) => (feature.id === candidate.id ? candidate : feature));
  }

  /**
   * Validate a candidate feature list before it becomes live.
   *
   * The same contract applyViewEdit has, and for the same reason: a drag that
   * produces something normalizeFeatures refuses must leave the drawing on the
   * last good state rather than half-applying. Nothing here mutates
   * appState.features until the whole list has passed.
   */
  function applyFeatureEdit(features) {
    let validated;
    try {
      // Normalized directly rather than serialized first: a freshly added shape
      // carries no style yet, and normalizeFeatures is what supplies one.
      validated = normalizeFeatures({ features }, getProject().id);
    } catch (err) {
      featurePanel.setStatus(err.message, 'error');
      return false;
    }
    appState.features = validated.features;
    render();
    featurePanel.render(appState.features);
    return true;
  }

  /**
   * Add a shape in the middle of the yard, then select it.
   *
   * Not the middle of the plan panel: that includes the padding drawn around
   * the yard, and a shape placed there would start life off the property.
   */
  function addFeature(type) {
    const project = getProject();
    const planView = project.views.find((view) => view.type === 'plan');
    if (!planView) {
      featurePanel.setStatus('Add a plan view before drawing features', 'error');
      return;
    }
    const transform = createViewTransform(planView);
    const bounds = resolveYardBounds(project) || {
      x: { min: transform.originFt.x, max: transform.originFt.x + transform.extentFt.width },
      y: { min: transform.originFt.y, max: transform.originFt.y + transform.extentFt.height },
    };
    const center = {
      x: (bounds.x.min + bounds.x.max) / 2,
      y: (bounds.y.min + bounds.y.max) / 2,
    };
    const shape = createFeatureShape(type, center, appState.features.map((f) => f.id), bounds);
    if (!applyFeatureEdit([...appState.features, shape])) return;
    featurePanel.setSelectedId(shape.id);
    syncFeatureOverlay();
  }

  /**
   * Features are setup, like the view config and unlike the layout: they save
   * when asked rather than on every gesture, and there is no undo stack behind
   * them. Auto-saving each drag frame would be a write per pointer release.
   */
  function saveFeatures() {
    persistFeatures(
      appState.features,
      (message, state) => featurePanel.setStatus(message, state),
      { projectId: getProject().id }
    );
  }

  return {
    panel: featurePanel,
    sync: syncFeatureOverlay,
    apply: applyFeatureEdit,
    save: saveFeatures,
    replaceFeature,
  };
}
