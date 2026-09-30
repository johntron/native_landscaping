import { PLANT_BLEND_OPACITY, CLIMB_PROXIMITY_FT, CLIMB_WIDTH_FT } from '../constants.js';
import { createViewTransform } from './viewTransform.js';
import { makeRng, seedForPlant } from '../utils/rng.js';
import { getSpeciesKey } from '../utils/speciesKey.js';
import { clearSvg, createSvgElement } from './svgUtils.js';
import { buildFeatureGroup } from './featureViews.js';
import { buildFlowerCenters } from './inflorescenceStrategies.js';
import { pointInPolygon, nearestFeature } from './geometry.js';
import { buildPlantLabel, clampLabelPosition, driftLabel } from './labels.js';
import { buildFruitCenters } from './fruitPlacement.js';
import { buildSmoothPath } from './pathUtils.js';
import { ECOTYPE_RING_RATIO, isLocalEcotype, outlineStatusAttributes, plantStatus } from './plantStatus.js';
import { allDrifts, driftCentroid, driftMembers, driftOutlinePolygon, memberRadiusFt } from '../state/driftGeometry.js';

const HIGHLIGHT_COLOR = '#ef7d1a';
const HIGHLIGHT_OUTLINE_OPACITY = 0.9;
const TARGET_COLOR = '#1b74d8';
const TARGET_OUTLINE_OPACITY = 0.95;
const CLIMB_WARNING_COLOR = '#d64545';

/**
 * Render a plan view using wavy domed foliage silhouettes scaled to plant width.
 *
 * The view's own transform supplies the scale, so a detail crop — a plan view
 * with a non-zero origin and a smaller extent — renders through this same path.
 *
 * @param {SVGSVGElement} svg
 * @param {Array<{ plant: any, state: any }>} plantStates
 * @param {object} view a normalized plan view (see createViewTransform)
 * @param {{ showLabels?: boolean }} [options]
 */
export function renderTopView(svg, plantStates, view, options = {}) {
  const transform = createViewTransform(view);
  const {
    showLabels = false,
    highlightedSpeciesKey = '',
    highlightedDriftId = '',
    targetedPlantId = '',
    hoveredPlantId = '',
    selectedPlantIds = null,
    selectedDriftId = '',
    suggestedMemberIds = null,
    features = [],
  } = options;
  clearSvg(svg);
  const normalizedHighlightKey = (highlightedSpeciesKey || '').toLowerCase();
  const normalizedHighlightDriftId = String(highlightedDriftId || '');
  const normalizedTargetId = String(targetedPlantId || '');
  const normalizedHoveredId = String(hoveredPlantId || '');
  const toPixels = transform.toPx;
  const highlightTargets = [];
  const targetMarkers = [];
  const selectionMarkers = [];
  const climbWarnings = [];
  const plants = plantStates.map((ps) => ps.plant);
  // The isolated drift's own members (nl-o47.6.2): everything else dims and
  // is unhittable (styles.css '[data-dimmed]') while a drift is selected or
  // drilled into. Derived from THIS render's own plant list (whatever a
  // hidden layer already excluded, exactly like every other decoration here).
  const isolatedMemberIds = selectedDriftId
    ? new Set(driftMembers(plants, selectedDriftId).map((m) => String(m.id)))
    : null;
  // A drift SUGGESTION under review (nl-o47.6.5) isolates the same way, but
  // is never a real drift — no driftId exists yet, so its membership comes
  // straight from the caller (src/interaction/driftReviewMode.js's own
  // adjusted set) rather than from driftMembers. Mutually exclusive with the
  // real-drift isolation above in practice (review clears the selection), so
  // either one alone decides dimming here.
  const reviewMemberIds = suggestedMemberIds && suggestedMemberIds.size ? suggestedMemberIds : null;
  const dimmedOutsideIds = isolatedMemberIds || reviewMemberIds;

  // A plan has no depth to sort on, so features go underneath the plants in the
  // order they were authored — the authoring order IS the z-order.
  features.forEach((feature) => svg.appendChild(buildFeatureGroup(feature, transform)));

  plantStates.forEach(({ plant, state }) => {
    const speciesKey = getSpeciesKey(plant);
    // A drift highlight (nl-o47.6.7, the species table's per-drift entries in
    // View mode) takes over from the species highlight entirely rather than
    // adding to it: OR-ing the two would ring every member of the SPECIES
    // whenever a drift is highlighted, which is exactly the "can't tell the
    // drift apart" bug a drift-scoped variant exists to avoid.
    const isHighlighted = normalizedHighlightDriftId
      ? plant.driftId === normalizedHighlightDriftId
      : Boolean(normalizedHighlightKey && speciesKey === normalizedHighlightKey);
    const isTargeted = normalizedTargetId && String(plant.id) === normalizedTargetId;
    const isHovered = normalizedHoveredId && String(plant.id) === normalizedHoveredId;
    const isSelected = Boolean(selectedPlantIds && selectedPlantIds.has(String(plant.id)));
    const isDimmed = Boolean(dimmedOutsideIds && !dimmedOutsideIds.has(String(plant.id)));
    const status = plantStatus(plant);
    const { x: cx, y: cy } = transform.planToViewBox(plant);
    const group = createSvgElement('g', {
      'data-name': plant.commonName,
      'data-plant-id': plant.id,
      'data-species-key': speciesKey,
      'data-status': status,
      // The plant's own centre in this view's viewBox pixels, independent of
      // whether a label is drawn here at all — a grouped (unselected) drift
      // member draws none of its own (nl-o47.6.7, above), and this is what
      // tests-e2e/helpers.js's plantScreenPosition reads instead of a
      // label's x/y for exactly that case.
      'data-cx': cx,
      'data-cy': cy,
      ...(isLocalEcotype(plant) ? { 'data-local-ecotype': 'true' } : {}),
      ...(isDimmed ? { 'data-dimmed': 'true' } : {}),
    });
    let effectiveWidth = plant.width;
    let isBoxWarning = false;
    if (plant.growthShape === 'low-climber') {
      const point = { x: plant.x, y: plant.y };
      const nearestWall = nearestFeature(point, features, ['wall', 'trellis']);
      if (nearestWall && nearestWall.distanceFt <= CLIMB_PROXIMITY_FT) {
        const supportContainsVine = plant.height <= nearestWall.feature.heightFt;
        effectiveWidth = supportContainsVine ? Math.min(plant.width, CLIMB_WIDTH_FT) : plant.width;
      } else {
        const nearestBox = nearestFeature(point, features, 'box');
        isBoxWarning = Boolean(nearestBox && nearestBox.distanceFt <= CLIMB_PROXIMITY_FT);
      }
    }
    const radius = toPixels(effectiveWidth) / 2;
    const canopySeed = seedForPlant(plant.id);
    const canopyPoints = buildWavyCirclePoints(cx, cy, radius, makeRng(canopySeed));
    const rng = makeRng(canopySeed);

    renderFoliageDome(group, {
      cx,
      cy,
      radius,
      color: state.foliageColor,
      rng,
      outlinePoints: canopyPoints,
      status,
    });

    if (state.flowerColor) {
      const flowerRng = makeRng(seedForPlant(`${plant.id}-flowers`));
      const flowerCenters = buildFlowerCenters({
        variant: 'plan',
        canopy: { plan: { cx, cy, radius } },
        rng: flowerRng,
        inflorescence: plant.inflorescence || plant.inflorescenceType || plant.inflorescence_type,
        flowerCountHint: plant.flowerCountHint ?? plant.flower_count_hint,
        flowerZone: plant.flowerZone || plant.flower_zone,
        accept: (point) => pointInPolygon(point, canopyPoints),
      });
      const flowerRadius = computePlanFlowerRadius(radius, flowerCenters.length);

      flowerCenters.forEach((center) => {
        const jitteredRadius = flowerRadius * (0.9 + flowerRng.next() * 0.18);
        const flower = createSvgElement('circle', {
          cx: center.x,
          cy: center.y,
          r: jitteredRadius,
          fill: state.flowerColor,
        });
        group.appendChild(flower);
      });
    }

    if (state.fruitColor) {
      const fruitRng = makeRng(seedForPlant(`${plant.id}-fruit`));
      const fruitCenters = buildFruitCenters({
        variant: 'plan',
        canopy: { plan: { cx, cy, radius } },
        rng: fruitRng,
        fruitLoad: plant.fruitLoad,
        accept: (point) => pointInPolygon(point, canopyPoints),
      });
      const fruitRadius = computePlanFruitRadius(radius, fruitCenters.length);

      fruitCenters.forEach((center) => {
        const jitteredRadius = fruitRadius * (0.88 + fruitRng.next() * 0.18);
        const fruit = createSvgElement('circle', {
          cx: center.x,
          cy: center.y,
          r: jitteredRadius,
          fill: state.fruitColor,
          stroke: darkenHex(state.fruitColor, 0.6),
          'stroke-width': Math.max(jitteredRadius * 0.35, 0.7),
        });
        group.appendChild(fruit);
      });
    }

    // A member of a drift OTHER than the selected/isolated one draws no label
    // of its own (nl-o47.6.7): the drift is labelled once, below, at its
    // centroid. A plant in no drift, or in the one currently
    // selected/isolated (so a person editing it can tell members apart),
    // keeps its own label exactly as before.
    const showsOwnLabel = !plant.driftId || plant.driftId === selectedDriftId;
    if (showLabels && showsOwnLabel) {
      const label = buildPlantLabel(plant);
      if (label) {
        const fontSize = Math.max(radius * 0.6, 16);
        const text = createSvgElement('text', {
          x: cx,
          y: cy,
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
          'font-size': fontSize,
          'font-weight': 700,
          fill: '#1b1b1b',
          stroke: '#fff',
          'stroke-width': Math.max(fontSize * 0.12, 1.2),
          'paint-order': 'stroke fill',
          'pointer-events': 'none',
        });
        text.textContent = label;
        group.appendChild(text);
      }
    }

    svg.appendChild(group);

    if (isHighlighted) {
      highlightTargets.push({ cx, cy, radius });
    }
    if (isTargeted || isHovered) {
      targetMarkers.push({ cx, cy, radius });
    }
    if (isSelected) {
      selectionMarkers.push({ cx, cy, radius });
    }
    if (isBoxWarning) {
      climbWarnings.push({ cx, cy, radius });
    }
  });

  highlightTargets.forEach((target) => appendHighlightRing(svg, target));
  targetMarkers.forEach((target) => appendTargetRing(svg, target));
  selectionMarkers.forEach((target) => appendSelectionRing(svg, target));
  climbWarnings.forEach((target) => appendClimbWarningRing(svg, target));
  if (isolatedMemberIds && isolatedMemberIds.size) {
    appendDriftOutline(svg, driftMembers(plants, selectedDriftId), transform);
  } else if (reviewMemberIds) {
    appendDriftOutline(
      svg,
      plants.filter((plant) => reviewMemberIds.has(String(plant.id))),
      transform,
      { suggested: true }
    );
  }
  if (showLabels) {
    // Every drift but the selected/isolated one (which just drew its own
    // members' labels above) gets ONE label here, at its centroid — never
    // inside a `g[data-plant-id]`, so it is neither counted as a plant nor
    // draggable, and always `pointer-events: none` so the gap-tap/click
    // hit-testing this same centroid is aimed at (driftHitTest.js) still
    // lands on the plan, not on the label text.
    allDrifts(plants)
      .filter((drift) => drift.driftId !== selectedDriftId)
      .forEach((drift) => appendDriftLabel(svg, drift, transform, Boolean(isolatedMemberIds)));
  }
}

/**
 * A drift's single on-plan label (nl-o47.6.7, nl-o47.6.11): driftLabel(drift's
 * members) — the species' plan initials plus its count ("CV (3x)"), centred
 * at driftCentroid and sized off the same member-radius math a plant's own
 * label uses. Clamped inside the view's own viewBox (clampLabelPosition) so a
 * drift sitting near the plan's edge does not draw text past it — the plan's
 * `<svg>` itself never clips (`.view svg { overflow: visible }`), but its
 * parent panel does (`overflow: hidden`, styles.css), and
 * `captureViewToPng`'s export crops to this exact viewBox.
 */
function appendDriftLabel(svg, drift, transform, dimmed) {
  const centroid = driftCentroid(drift.members);
  if (!centroid) return;
  const label = driftLabel(drift.members);
  if (!label) return;
  const radiusFt = drift.members.reduce((max, m) => Math.max(max, memberRadiusFt(m)), 0);
  const fontSize = Math.max(transform.toPx(radiusFt) * 0.6, 16);
  const raw = transform.planToViewBox(centroid);
  const pos = clampLabelPosition(raw, label, fontSize, transform.viewBox);
  const text = createSvgElement('text', {
    x: pos.x,
    y: pos.y,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    'font-size': fontSize,
    'font-weight': 700,
    fill: '#1b1b1b',
    stroke: '#fff',
    'stroke-width': Math.max(fontSize * 0.12, 1.2),
    'paint-order': 'stroke fill',
    'pointer-events': 'none',
    'data-drift-label': drift.driftId,
    ...(dimmed ? { 'data-dimmed': 'true' } : {}),
  });
  text.textContent = label;
  svg.appendChild(text);
}

/**
 * A selected drift's outline (nl-o47.6.2), or a SUGGESTED one under review
 * (nl-o47.6.5, `{ suggested: true }`): the padded hull
 * (src/state/driftGeometry.js driftOutlinePolygon — the Minkowski-sum
 * approximation that agrees with isPointInDriftOutline's own hit region),
 * mapped into viewBox space and smoothed the same way a plant's own wavy
 * canopy is (buildSmoothPath) so it reads as an organic zone rather than a
 * faceted polygon. A real drift's outline is cyan/apparatus
 * (`.plant-selection-ring`'s own token); a suggestion draws `.drift-outline--
 * suggested` instead — a different token AND a finer dash cadence (styles.css)
 * so it reads as a PROPOSAL, never mistaken for a drift that already exists.
 * Neither ever reaches an export (src/export/exportActions.js blanks both the
 * drift context and the review's own field around every capture).
 * @param {Array<object>} members
 * @param {object} transform
 * @param {{ suggested?: boolean }} [options]
 */
function appendDriftOutline(svg, members, transform, { suggested = false } = {}) {
  const polygon = driftOutlinePolygon(members);
  if (polygon.length < 2) return;
  const points = polygon.map((point) => transform.planToViewBox(point));
  const attrs = {
    d: buildSmoothPath(points),
    class: suggested ? 'drift-outline drift-outline--suggested' : 'drift-outline',
    'pointer-events': 'none',
  };
  attrs[suggested ? 'data-suggestion-outline' : 'data-drift-outline'] = 'true';
  svg.appendChild(createSvgElement('path', attrs));
}

function renderFoliageDome(group, { cx, cy, radius, color, rng, outlinePoints, status }) {
  const points = outlinePoints || buildWavyCirclePoints(cx, cy, radius, rng);
  const d = buildSmoothPath(points);

  const base = createSvgElement('path', {
    d,
    fill: color,
    'fill-opacity': PLANT_BLEND_OPACITY,
  });
  group.appendChild(base);

  const shade = createSvgElement('circle', {
    cx: cx + radius * 0.2,
    cy: cy + radius * 0.18,
    r: radius * 0.72,
    fill: darkenHex(color, 0.7),
    'fill-opacity': 0.4,
  });
  group.appendChild(shade);

  const midHighlight = createSvgElement('circle', {
    cx: cx - radius * 0.12,
    cy: cy - radius * 0.12,
    r: radius * 0.58,
    fill: lightenHex(color, 0.25),
    'fill-opacity': 0.85,
  });
  group.appendChild(midHighlight);

  const brightHighlight = createSvgElement('circle', {
    cx: cx - radius * 0.22,
    cy: cy - radius * 0.26,
    r: radius * 0.38,
    fill: lightenHex(color, 0.45),
    'fill-opacity': 0.7,
  });
  group.appendChild(brightHighlight);

  const outline = createSvgElement('path', {
    d,
    fill: 'none',
    stroke: darkenHex(color, 0.55),
    'stroke-linejoin': 'round',
    ...outlineStatusAttributes(status, Math.max(radius * 0.06, 0.8)),
  });
  group.appendChild(outline);
  if (group.getAttribute('data-local-ecotype') === 'true') {
    group.appendChild(
      createSvgElement('circle', {
        cx,
        cy,
        r: radius * ECOTYPE_RING_RATIO,
        fill: 'none',
        stroke: darkenHex(color, 0.55),
        'data-ecotype-ring': 'true',
        ...outlineStatusAttributes(status, Math.max(radius * 0.04, 0.6)),
      })
    );
  }
}

function buildWavyCirclePath(cx, cy, radius, rng) {
  const points = buildWavyCirclePoints(cx, cy, radius, rng);
  return buildSmoothPath(points);
}

function buildWavyCirclePoints(cx, cy, radius, rng) {
  const pointCount = 14 + Math.floor(rng.next() * 6); // 14-19 points
  const angleStep = (Math.PI * 2) / pointCount;
  const wobble = 0.12;
  const points = [];

  for (let i = 0; i < pointCount; i += 1) {
    const angle = i * angleStep;
    const radialJitter = 1 + (rng.next() - 0.5) * wobble;
    const ripple = 1 + Math.sin(angle * 2) * 0.05;
    const r = radius * radialJitter * ripple;
    points.push({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
    });
  }

  return points;
}

function computePlanFlowerRadius(canopyRadius, count) {
  if (!count) return 0;
  const scaled = (canopyRadius * 0.35) / Math.sqrt(count);
  return Math.max(scaled, 0.6);
}

function computePlanFruitRadius(canopyRadius, count) {
  if (!count) return 0;
  const scaled = (canopyRadius * 0.22) / Math.sqrt(count);
  return Math.max(scaled, 0.5);
}

function darkenHex(color, factor) {
  const { r, g, b } = parseHex(color);
  return formatHex(
    Math.round(r * factor),
    Math.round(g * factor),
    Math.round(b * factor)
  );
}

function lightenHex(color, amount) {
  const { r, g, b } = parseHex(color);
  return formatHex(
    Math.round(r + (255 - r) * amount),
    Math.round(g + (255 - g) * amount),
    Math.round(b + (255 - b) * amount)
  );
}

function parseHex(color) {
  const match = /^#?([a-f\d]{6})$/i.exec(color);
  if (!match) return { r: 0, g: 0, b: 0 };
  const num = parseInt(match[1], 16);
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

function formatHex(r, g, b) {
  const toHex = (value) => value.toString(16).padStart(2, '0');
  return `#${toHex(clampChannel(r))}${toHex(clampChannel(g))}${toHex(clampChannel(b))}`;
}

function clampChannel(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function appendHighlightRing(svg, { cx, cy, radius }) {
  const outer = createSvgElement('circle', {
    cx,
    cy,
    r: radius * 1.05 + 6,
    fill: 'none',
    stroke: HIGHLIGHT_COLOR,
    'stroke-width': Math.max(radius * 0.12, 3),
    'stroke-dasharray': '7 6',
    'stroke-opacity': HIGHLIGHT_OUTLINE_OPACITY,
    'pointer-events': 'none',
  });
  const center = createSvgElement('circle', {
    cx,
    cy,
    r: Math.max(radius * 0.1, 4),
    fill: HIGHLIGHT_COLOR,
    'fill-opacity': 0.8,
    stroke: '#fff',
    'stroke-width': 2,
    'pointer-events': 'none',
  });
  svg.appendChild(outer);
  svg.appendChild(center);
}

/** A low-climber sitting next to a box, with no climbable wall in reach — it will likely just sprawl over it. */
function appendClimbWarningRing(svg, { cx, cy, radius }) {
  const outer = createSvgElement('circle', {
    cx,
    cy,
    r: radius * 1.08 + 5,
    fill: 'none',
    stroke: CLIMB_WARNING_COLOR,
    'stroke-width': Math.max(radius * 0.1, 2.5),
    'stroke-dasharray': '4 4',
    'stroke-opacity': 0.9,
    'pointer-events': 'none',
  });
  svg.appendChild(outer);
}

/**
 * The Edit-mode selection ring (nl-o47.2): a selection is apparatus, not
 * life, so its colour comes from the `.plant-selection-ring` class in
 * styles.css (var(--accent), cyan) rather than a hardcoded hex like the
 * highlight/target rings above — those predate the amber/cyan token rule.
 * Cleared from appState before every export capture (src/export/exportActions.js),
 * so it never reaches a plan bundle or HOA packet PNG.
 */
function appendSelectionRing(svg, { cx, cy, radius }) {
  svg.appendChild(
    createSvgElement('circle', {
      cx,
      cy,
      r: radius * 1.15 + 8,
      class: 'plant-selection-ring',
      'stroke-width': Math.max(radius * 0.14, 3.2),
      'pointer-events': 'none',
      'data-selection-ring': 'true',
    })
  );
}

function appendTargetRing(svg, { cx, cy, radius }) {
  const outer = createSvgElement('circle', {
    cx,
    cy,
    r: radius * 1.02 + 4,
    fill: 'none',
    stroke: TARGET_COLOR,
    'stroke-width': Math.max(radius * 0.18, 3.6),
    'stroke-opacity': TARGET_OUTLINE_OPACITY,
    'pointer-events': 'none',
  });
  const center = createSvgElement('circle', {
    cx,
    cy,
    r: Math.max(radius * 0.16, 5),
    fill: TARGET_COLOR,
    'fill-opacity': 0.9,
    stroke: '#fff',
    'stroke-width': 2,
    'pointer-events': 'none',
  });
  svg.appendChild(outer);
  svg.appendChild(center);
}
