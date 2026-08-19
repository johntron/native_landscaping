import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSouthElevation } from '../src/render/elevationViews.js';
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

  renderSouthElevation(svg, plantStates, 2);
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
