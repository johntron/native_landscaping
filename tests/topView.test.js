import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTopView } from '../src/render/topView.js';

// 800x600 px over 26.67x20 ft is 30 px/ft — the old 2.5 px/in, stated in feet.
const PLAN_VIEW = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 800 / 30, height: 600 / 30 },
};
import { resetDocument } from './helpers/fakeDom.js';

const sharedState = {
  foliageColor: '#5b8c3a',
  flowerColor: null,
  fruitColor: null,
  isGrowing: true,
  isFlowering: false,
  isFruiting: false,
};

test('renderTopView clears nodes and renders groups along with highlight/target markers', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.appendChild(doc.createElementNS('http://www.w3.org/2000/svg', 'circle'));

  const plantStates = [
    {
      plant: {
        id: 'alpha',
        commonName: 'Alpha Shrub',
        botanicalName: 'Ceanothus americanus',
        botanicalKey: 'ceanothus americanus',
        width: 3,
        height: 4,
        x: 10,
        y: 5,
        sunPref: 'Full sun',
        waterPref: 'Moderate',
        soilPref: 'Loam',
      },
      state: sharedState,
    },
    {
      plant: {
        id: 'beta',
        commonName: 'Beta Grass',
        botanicalName: 'Bouteloua curtipendula',
        botanicalKey: 'bouteloua curtipendula',
        width: 2,
        height: 2,
        x: 12,
        y: 6,
        sunPref: 'Full sun',
        waterPref: 'Dry',
        soilPref: 'Clay',
      },
      state: sharedState,
    },
  ];

  renderTopView(svg, plantStates, PLAN_VIEW, {
    highlightedSpeciesKey: 'bouteloua curtipendula',
    targetedPlantId: 'alpha',
    hoveredPlantId: 'beta',
  });

  const plantGroups = svg.querySelectorAll('g[data-plant-id]');
  assert.equal(plantGroups.length, plantStates.length);
  assert.equal(
    plantGroups[0].querySelectorAll('title').length,
    0,
    'no native SVG title tooltip is rendered; details come from the click-to-open sheet instead'
  );

  const highlightRing = svg
    .querySelectorAll('circle')
    .find((circle) => circle.getAttribute('stroke-dasharray') === '7 6');
  assert.ok(highlightRing, 'highlight ring is appended');

  const targetRing = svg
    .querySelectorAll('circle')
    .find((circle) => circle.getAttribute('stroke') === '#1b74d8');
  assert.ok(targetRing, 'target marker is appended for hovered/targeted plants');
});

const FEATURE_STYLE = { fill: '#e6e1d8', stroke: '#c9c3b8', strokeWidthFt: 0.1 };

function lowClimberState(id, x, y, width = 5) {
  return {
    plant: {
      id,
      commonName: 'Test Vine',
      botanicalName: 'Passiflora incarnata',
      botanicalKey: 'passiflora incarnata',
      growthShape: 'low-climber',
      width,
      height: 10,
      x,
      y,
    },
    state: sharedState,
  };
}

test('a low-climber next to a wall tall enough to contain it draws a narrower footprint', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const wall = {
    id: 'fence',
    type: 'wall',
    pathFt: [{ x: 10.2, y: 0 }, { x: 10.2, y: 20 }],
    heightFt: 12, // taller than the plant's declared 10 ft height
    style: FEATURE_STYLE,
  };

  renderTopView(svg, [lowClimberState('vine', 10, 5, 5)], PLAN_VIEW, { features: [wall] });

  // renderFoliageDome's shade circle radius is radius * 0.72 — back out the
  // canopy radius from it rather than parsing the wavy silhouette path.
  const shade = svg.querySelectorAll('circle')[0];
  assert.ok(shade, 'canopy shade circle is rendered');
  const canopyRadiusPx = Number(shade.getAttribute('r')) / 0.72;
  // Full declared width would be 5 ft (75 px radius); climbing caps it at 1.5 ft (22.5 px).
  assert.ok(canopyRadiusPx < 30, `canopy narrows near the wall (got ${canopyRadiusPx}px radius)`);
});

test('a low-climber next to a trellis is treated as climbable, just like a wall', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const trellis = {
    id: 'trellis',
    type: 'trellis',
    pathFt: [{ x: 10.2, y: 0 }, { x: 10.2, y: 20 }],
    heightFt: 12,
    style: FEATURE_STYLE,
  };

  renderTopView(svg, [lowClimberState('vine', 10, 5, 5)], PLAN_VIEW, { features: [trellis] });

  const shade = svg.querySelectorAll('circle')[0];
  assert.ok(shade, 'canopy shade circle is rendered');
  const canopyRadiusPx = Number(shade.getAttribute('r')) / 0.72;
  assert.ok(canopyRadiusPx < 30, `canopy narrows near the trellis (got ${canopyRadiusPx}px radius)`);
});

test('a low-climber that would outgrow the wall keeps its full natural width', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const wall = {
    id: 'fence',
    type: 'wall',
    pathFt: [{ x: 10.2, y: 0 }, { x: 10.2, y: 20 }],
    heightFt: 6, // shorter than the plant's declared 10 ft height — it tops the fence
    style: FEATURE_STYLE,
  };

  renderTopView(svg, [lowClimberState('vine', 10, 5, 5)], PLAN_VIEW, { features: [wall] });

  const shade = svg.querySelectorAll('circle')[0];
  assert.ok(shade, 'canopy shade circle is rendered');
  const canopyRadiusPx = Number(shade.getAttribute('r')) / 0.72;
  // Full declared width is 5 ft (75 px radius) — not narrowed to the 1.5 ft climbing cap.
  assert.ok(canopyRadiusPx > 70, `canopy keeps full spread when it outgrows the wall (got ${canopyRadiusPx}px radius)`);
});

test('a low-climber next to only a box gets a warning ring but keeps full width', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const box = {
    id: 'ac-unit',
    type: 'box',
    footprintFt: [
      { x: 9, y: 4 },
      { x: 11, y: 4 },
      { x: 11, y: 6 },
      { x: 9, y: 6 },
    ],
    heightFt: 3,
    style: FEATURE_STYLE,
  };

  renderTopView(svg, [lowClimberState('vine', 10, 3, 5)], PLAN_VIEW, { features: [box] });

  const warningRing = svg
    .querySelectorAll('circle')
    .find((circle) => circle.getAttribute('stroke') === '#d64545');
  assert.ok(warningRing, 'a warning ring is drawn for a climber only near a non-climbable box');
});

test('a low-climber with no wall or box nearby keeps its declared width and no ring', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');

  renderTopView(svg, [lowClimberState('vine', 10, 5, 5)], PLAN_VIEW, { features: [] });

  const warningRing = svg
    .querySelectorAll('circle')
    .find((circle) => circle.getAttribute('stroke') === '#d64545');
  assert.equal(warningRing, undefined, 'no warning ring without a nearby feature');
});
