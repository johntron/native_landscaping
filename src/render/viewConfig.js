import { projectAssetPath } from '../data/projectConfig.js';
import { placementToCssBackground, resolvePhotoPlacement } from './photoPlacement.js';

/**
 * Build one panel per entry in the project's views[], and apply each view's
 * geometry, background, and labels to it.
 *
 * Panels are cloned from a `<template>` rather than hand-written, so a project
 * declaring four views gets four panels. Existing panels are reused when their
 * view id is unchanged, which matters twice: the SVG element survives, so drag
 * controllers stay bound to it, and a live edit in Setup mode can re-call this
 * without tearing down the whole grid.
 *
 * Backgrounds used to live in styles.css, which cannot express one image per
 * project; they are set here from project config so the CSS and JS cannot drift.
 *
 * @param {{ container: HTMLElement, template: HTMLTemplateElement, project: object }} params
 * @returns {Array<{ view: object, svg: SVGSVGElement, panel: HTMLElement, container: HTMLElement }>}
 */
export function configureViews({ container, template, project }) {
  if (!container || !template || !project) return [];
  const views = project.views || [];

  const reusable = new Map();
  Array.from(container.querySelectorAll('.view-panel')).forEach((panel) => {
    reusable.set(panel.dataset.viewPanel, panel);
  });

  // The first plan view keeps the historical id so existing selectors still work.
  const firstPlanIndex = views.findIndex((view) => view.type === 'plan');

  const panels = views.map((view, index) => {
    let panel = reusable.get(view.id);
    if (panel) {
      reusable.delete(view.id);
    } else {
      panel = template.content.firstElementChild.cloneNode(true);
      panel.dataset.viewPanel = view.id;
    }
    // Only move a panel that is actually out of place. Re-appending one that is
    // already correct still counts as a DOM move, which disconnects its subtree
    // and drops any pointer capture — that ends a handle drag mid-gesture.
    if (container.children[index] !== panel) {
      container.insertBefore(panel, container.children[index] || null);
    }

    const svg = panel.querySelector('svg');
    const viewEl = panel.querySelector('.view');
    if (svg) {
      svg.id = index === firstPlanIndex ? 'topSvg' : `${view.id}Svg`;
      svg.setAttribute('viewBox', `0 0 ${view.viewBox.width} ${view.viewBox.height}`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }

    const toggle = panel.querySelector('[data-maximize-target]');
    if (toggle) {
      toggle.dataset.maximizeTarget = view.id;
    }

    if (viewEl?.style) {
      // Panels are sized by the yard they cover at one page-wide scale, so a
      // foot is the same size in every view and the elevations share a ground
      // row. The aspect ratio still backs it up for the maximized case.
      viewEl.style.setProperty('--view-aspect-ratio', `${view.viewBox.width} / ${view.viewBox.height}`);
      viewEl.style.setProperty('--extent-w', String(view.extentFt.width));
      viewEl.style.setProperty('--extent-h', String(view.extentFt.height));
      // A view may have no background yet — setting url('projects/x/null')
      // would render a broken tile rather than an empty panel. A photo the
      // user has hidden (see photoHidden) is treated the same way here: this
      // is the panel CSS every mode but Setup draws from, and Setup paints
      // the photo itself in the SVG regardless, so hiding it here is enough.
      const background = view.photoHidden ? { path: null, rect: null } : resolvePhotoPlacement(view);
      if (background.path) {
        viewEl.style.backgroundImage = `url('${cssUrl(projectAssetPath(project.id, background.path))}')`;
      } else {
        viewEl.style.removeProperty('background-image');
      }
      // Panels are reused by id, so a view whose photo stops being placed must
      // have the placement cleared as well as replaced — otherwise it keeps the
      // last photo's offset under a new picture.
      const placement = placementToCssBackground(background.rect, view.viewBox);
      if (placement) {
        viewEl.style.backgroundSize = placement.backgroundSize;
        viewEl.style.backgroundPosition = placement.backgroundPosition;
      } else {
        viewEl.style.removeProperty('background-size');
        viewEl.style.removeProperty('background-position');
      }
    }

    setText(panel.querySelector('[data-view-label]'), view.label);
    setText(panel.querySelector('[data-view-sublabel]'), view.sublabel);

    return { view, svg, panel, container: viewEl };
  });

  // Anything left over belongs to a view the project no longer declares.
  reusable.forEach((panel) => panel.remove());

  return panels;
}

function setText(el, text) {
  if (el) el.textContent = text;
}

/** Escape the few characters that would otherwise break out of a CSS url('…'). */
function cssUrl(path) {
  return String(path).replace(/['"\\\n]/g, encodeURIComponent);
}
