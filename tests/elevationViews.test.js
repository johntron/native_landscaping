import test from 'node:test';
import assert from 'node:assert/strict';
import { renderElevationView } from '../src/render/elevationViews.js';
import { PLANT_BLEND_OPACITY } from '../src/constants.js';
import { resetDocument } from './helpers/fakeDom.js';

const evergreenState = {
  foliageColor: '#4d6a3d',
  flowerColor: null,
  fruitColor: null,
  isGrowing: true,
  isFlowering: false,
  isFruiting: false,
};

function renderTreeCanopyPath(width) {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const plantStates = [
    {
      plant: {
        id: 'yaupon-holly',
        commonName: 'American Yaupon Holly',
        botanicalName: 'Ilex vomitoria',
        botanicalKey: 'ilex vomitoria',
        growthShape: 'tree',
        width,
        height: 15,
        x: 10,
        y: 5,
        sunPref: 'part-sun',
        waterPref: 'medium',
        soilPref: 'loamy',
      },
      state: evergreenState,
    },
  ];

  renderElevationView(svg, plantStates, 2, { id: 'south', viewFrom: 'south' });
  const canopyPaths = svg.querySelectorAll(`path[fill-opacity="${PLANT_BLEND_OPACITY}"]`);
  assert.equal(canopyPaths.length, 1, 'tree profile should include one canopy path');
  return canopyPaths[0]?.getAttribute('d');
}

test('tree canopy width is driven by species spread, not height', () => {
  const narrowCanopy = renderTreeCanopyPath(6);
  const wideCanopy = renderTreeCanopyPath(12);

  assert.ok(narrowCanopy, 'canopy path exists for the tree');
  assert.ok(wideCanopy, 'canopy path exists after resizing');
  assert.notEqual(narrowCanopy, wideCanopy, 'canopy shape responds to width changes');
});

function renderAt(viewFrom, plants) {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const plantStates = plants.map((plant) => ({ plant, state: evergreenState }));
  renderElevationView(svg, plantStates, 2, {
    id: viewFrom,
    viewFrom,
    viewBox: { width: 800, height: 600 },
    bottomOffsetPx: 100,
    leftOffsetPx: 0,
  });
  return Array.from(svg.querySelectorAll('g[data-plant-id]')).map((g) =>
    g.getAttribute('data-plant-id')
  );
}

const westPlant = {
  id: 'west-plant',
  commonName: 'West',
  botanicalName: 'Aster ericoides',
  growthShape: 'mound',
  width: 3,
  height: 3,
  x: 2,
  y: 4,
};
const eastPlant = {
  id: 'east-plant',
  commonName: 'East',
  botanicalName: 'Aster oblongifolius',
  growthShape: 'mound',
  width: 3,
  height: 3,
  x: 18,
  y: 4,
};

test('viewing from the opposite side reverses front-to-back draw order', () => {
  // Depth on a south/north elevation is y. Looking north, the high-y plant is
  // farthest and so is drawn first; looking south, that order inverts.
  const near = { ...westPlant, id: 'near', x: 5, y: 2 };
  const far = { ...eastPlant, id: 'far', x: 5, y: 12 };
  assert.deepEqual(renderAt('south', [near, far]), ['far', 'near']);
  assert.deepEqual(renderAt('north', [near, far]), ['near', 'far']);
});

test('mirrored elevations flip which side of the drawing a plant lands on', () => {
  const doc = resetDocument();
  const measure = (viewFrom, plant) => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    renderElevationView(svg, [{ plant, state: evergreenState }], 2, {
      id: viewFrom,
      viewFrom,
      viewBox: { width: 800, height: 600 },
      bottomOffsetPx: 100,
      leftOffsetPx: 0,
    });
    // The silhouette path carries the plant's horizontal placement.
    const path = svg.querySelectorAll('path')[0];
    const numbers = (path.getAttribute('d').match(/-?\d+(\.\d+)?/g) || []).map(Number);
    return Math.min(...numbers.filter((_, i) => i % 2 === 0));
  };

  // Standing east, north (+y) is on the right; standing west, it is on the left.
  const eastView = measure('east', { ...westPlant, y: 3 });
  const westView = measure('west', { ...westPlant, y: 3 });
  assert.ok(eastView < 400, `expected a low-y plant near the left edge when viewed from the east, got ${eastView}`);
  assert.ok(westView > 400, `expected a low-y plant near the right edge when viewed from the west, got ${westView}`);
});
