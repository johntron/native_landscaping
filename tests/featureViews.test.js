import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDocument } from './helpers/fakeDom.js';
import { normalizeFeatures } from '../src/data/featureConfig.js';
import { orderElevationItems } from '../src/render/elevationOrder.js';
import { buildFeatureGroup } from '../src/render/featureViews.js';
import { renderTopView } from '../src/render/topView.js';
import { renderElevationView } from '../src/render/elevationViews.js';
import { createViewTransform } from '../src/render/viewTransform.js';

// The same 40 x 30 ft yard at 20 px/ft the projection tests use.
const PLAN_VIEW = {
  id: 'plan',
  type: 'plan',
  viewBox: { width: 800, height: 600 },
  originFt: { x: 0, y: 0 },
  extentFt: { width: 40, height: 30 },
};

function elevationView(viewFrom) {
  const alongX = viewFrom === 'south' || viewFrom === 'north';
  return {
    id: viewFrom,
    type: 'elevation',
    viewFrom,
    viewBox: { width: alongX ? 800 : 600, height: 400 },
    originFt: { x: 0, y: 0 },
    extentFt: { width: alongX ? 40 : 30, height: 20 },
  };
}

const FEATURES = normalizeFeatures(
  {
    features: [
      {
        id: 'driveway',
        type: 'surface',
        footprintFt: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 24 },
          { x: 0, y: 24 },
        ],
      },
      {
        // Spans y 12..20, so it straddles a plant standing at y = 15.
        id: 'house',
        type: 'box',
        footprintFt: [
          { x: 8, y: 12 },
          { x: 24, y: 12 },
          { x: 24, y: 20 },
          { x: 8, y: 20 },
        ],
        heightFt: 10,
      },
      {
        id: 'fence',
        type: 'wall',
        pathFt: [
          { x: 4, y: 26 },
          { x: 36, y: 26 },
        ],
        heightFt: 6,
      },
    ],
  },
  'backyard'
).features;

const byId = Object.fromEntries(FEATURES.map((feature) => [feature.id, feature]));

const STATE = {
  foliageColor: '#5b8c3a',
  flowerColor: null,
  fruitColor: null,
  isGrowing: true,
  isFlowering: false,
  isFruiting: false,
};

function plant(id, x, y) {
  return {
    plant: {
      id,
      commonName: id,
      botanicalName: `Genus ${id}`,
      botanicalKey: `genus ${id}`,
      width: 3,
      height: 4,
      x,
      y,
    },
    state: STATE,
  };
}

const PLANTS = [plant('far', 20, 30), plant('mid', 20, 15), plant('near', 20, 5)];

function order(viewFrom, features = [byId.house]) {
  return orderElevationItems({
    plantStates: PLANTS,
    features,
    transform: createViewTransform(elevationView(viewFrom)),
  }).map((item) => (item.kind === 'feature' ? `feature:${item.feature.id}` : item.plant.id));
}

test('a feature sorts among the plants by its own depth, not at zero', () => {
  // Looking north, high y is farthest. The house's near edge is y = 12, which
  // puts it behind the plant at y = 5 and in front of the one at y = 15.
  assert.deepEqual(order('south'), ['far', 'mid', 'feature:house', 'near']);

  // A feature that fell through to depth 0 would land at one end of the list —
  // pinned to the very front here — which looks almost right.
  assert.notDeepEqual(order('south'), ['far', 'mid', 'near', 'feature:house']);
});

test('walking around to the mirrored side reverses the interleave', () => {
  // Standing north, the low-y side is farthest and the house's near edge is y = 20.
  assert.deepEqual(order('north'), ['near', 'mid', 'feature:house', 'far']);
});

test('a flat surface is ground: it draws beneath every plant', () => {
  const drawn = order('south', [byId.driveway, byId.house]);
  assert.equal(drawn[0], 'feature:driveway');
  assert.deepEqual(drawn.slice(1), ['far', 'mid', 'feature:house', 'near']);
});

test('features at the same depth keep the order they were authored in', () => {
  const twins = normalizeFeatures(
    {
      features: [
        { id: 'first', type: 'box', footprintFt: byId.house.footprintFt, heightFt: 4 },
        { id: 'second', type: 'box', footprintFt: byId.house.footprintFt, heightFt: 8 },
      ],
    },
    'backyard'
  ).features;
  const drawn = order('south', twins);
  assert.ok(drawn.indexOf('feature:first') < drawn.indexOf('feature:second'));
});

test('a plan draws a box as a filled footprint and a wall as an open path', () => {
  resetDocument();
  const transform = createViewTransform(PLAN_VIEW);

  const house = buildFeatureGroup(byId.house, transform);
  assert.equal(house.getAttribute('data-feature-id'), 'house');
  assert.equal(house.getAttribute('data-feature-type'), 'box');
  const footprint = house.children[0];
  assert.equal(footprint.tagName, 'POLYGON');
  assert.equal(footprint.getAttribute('points'), '160,360 480,360 480,200 160,200');
  assert.equal(footprint.getAttribute('fill'), byId.house.style.fill);

  // Closing a fence would paint in the whole yard behind it.
  const fence = buildFeatureGroup(byId.fence, transform).children[0];
  assert.equal(fence.tagName, 'POLYLINE');
  assert.equal(fence.getAttribute('fill'), 'none');
});

test('an elevation draws a silhouette rectangle, and a flat one as a line', () => {
  resetDocument();
  const south = createViewTransform(elevationView('south'));

  const house = buildFeatureGroup(byId.house, south).children[0];
  assert.equal(house.tagName, 'RECT');
  assert.deepEqual(
    ['x', 'y', 'width', 'height'].map((key) => house.getAttribute(key)),
    ['160', '200', '320', '200']
  );

  // A surface has no height, and SVG draws no zero-height rect at all — so the
  // band that says "driveway" has to be a line.
  const driveway = buildFeatureGroup(byId.driveway, south).children[0];
  assert.equal(driveway.tagName, 'LINE');
  assert.equal(driveway.getAttribute('y1'), String(south.groundY));
  assert.equal(driveway.getAttribute('y2'), String(south.groundY));

  // Same for the fence seen end-on from the east: zero width, not missing.
  const east = createViewTransform(elevationView('east'));
  const endOn = buildFeatureGroup(byId.fence, east).children[0];
  assert.equal(endOn.tagName, 'LINE');
  assert.equal(endOn.getAttribute('x1'), endOn.getAttribute('x2'));
  assert.ok(Number(endOn.getAttribute('stroke-width')) >= 1);
});

test('renderTopView puts every feature under every plant', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderTopView(svg, PLANTS, PLAN_VIEW, { features: FEATURES });

  const ids = svg.children.map(
    (child) => child.getAttribute('data-feature-id') || child.getAttribute('data-plant-id')
  );
  assert.deepEqual(ids.slice(0, 3), ['driveway', 'house', 'fence']);
  assert.deepEqual(ids.slice(3), ['far', 'mid', 'near']);
});

test('renderElevationView interleaves the two into one list of groups', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderElevationView(svg, PLANTS, elevationView('south'), { features: [byId.house] });

  const ids = svg.children
    .map((child) => child.getAttribute('data-feature-id') || child.getAttribute('data-plant-id'))
    .filter(Boolean);
  assert.deepEqual(ids, ['far', 'mid', 'house', 'near']);
});

test('no features is the normal case and changes nothing', () => {
  const doc = resetDocument();
  const withOut = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const withEmpty = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  renderElevationView(withOut, PLANTS, elevationView('west'), {});
  renderElevationView(withEmpty, PLANTS, elevationView('west'), { features: [] });
  assert.equal(withOut.children.length, withEmpty.children.length);
  assert.equal(withOut.querySelectorAll('g[data-feature-id]').length, 0);
});
