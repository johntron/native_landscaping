import { projectAssetPath } from '../data/projectConfig.js';

/**
 * Apply the active project's geometry, backgrounds, and labels to the view panels.
 *
 * Backgrounds used to live in styles.css, which cannot express one image per
 * project; they are now set here from project config so the CSS and JS cannot
 * drift apart. Everything else — viewBox, aspect ratio, panel headings — likewise
 * comes from the project rather than from global constants.
 *
 * @param {{ topSvg: SVGSVGElement, elevationSvgs: SVGSVGElement[] }} svgRefs
 * @param {{ topView?: HTMLElement, elevationViews?: HTMLElement[] }} [containerRefs]
 * @param {{ labelRefs?: Array<{ label?: HTMLElement, sublabel?: HTMLElement }> }} [labelRefs]
 * @param {object} project normalized project config
 */
export function configureViews({ svgRefs, containerRefs, labelRefs, project }) {
  if (!project) return;
  const { topSvg, elevationSvgs = [] } = svgRefs;
  const panels = [
    {
      view: project.plan,
      svg: topSvg,
      container: containerRefs?.topView,
      labels: labelRefs?.[0],
    },
    ...project.elevations.map((elevation, index) => ({
      view: elevation,
      svg: elevationSvgs[index],
      container: containerRefs?.elevationViews?.[index],
      labels: labelRefs?.[index + 1],
    })),
  ];

  panels.forEach(({ view, svg, container, labels }) => {
    if (!view) return;
    setViewBox(svg, view.viewBox);
    if (svg) {
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    if (container?.style) {
      container.style.setProperty(
        '--view-aspect-ratio',
        `${view.viewBox.width} / ${view.viewBox.height}`
      );
      container.style.backgroundImage = `url('${cssUrl(
        projectAssetPath(project.id, view.background)
      )}')`;
    }
    if (labels?.label) {
      labels.label.textContent = view.label;
    }
    if (labels?.sublabel) {
      labels.sublabel.textContent = view.sublabel;
    }
  });
}

function setViewBox(svg, viewBox) {
  if (!svg || !viewBox) return;
  svg.setAttribute('viewBox', `0 0 ${viewBox.width} ${viewBox.height}`);
}

/** Escape the few characters that would otherwise break out of a CSS url('…'). */
function cssUrl(path) {
  return String(path).replace(/['"\\\n]/g, encodeURIComponent);
}
