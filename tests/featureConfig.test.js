import test from 'node:test';
import assert from 'node:assert/strict';
import {
  geometryKeyFor,
  isValidFeatureId,
  normalizeFeatures,
  serializeFeatures,
} from '../src/data/featureConfig.js';

// Fixtures are inlined on purpose: every shipped project is editable in the
// running app, so a test that read projects/<slug>/ would break on a save that
// has nothing to do with it.
const DRIVEWAY = {
  id: 'driveway',
  type: 'surface',
  label: 'Driveway',
  footprintFt: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 24 },
    { x: 0, y: 24 },
  ],
};

const FENCE = {
  id: 'fence',
  type: 'wall',
  pathFt: [
    { x: 0, y: 30 },
    { x: 40, y: 30 },
  ],
  heightFt: 6,
  style: { fill: '#8b6f4e', strokeWidthFt: 0.25 },
};

const TRELLIS = {
  id: 'trellis',
  type: 'trellis',
  pathFt: [
    { x: 4, y: 10 },
    { x: 6, y: 10 },
  ],
  heightFt: 7,
};

const HOUSE = {
  id: 'house',
  type: 'box',
  label: 'House',
  footprintFt: [
    { x: 0, y: 28 },
    { x: 32, y: 28 },
    { x: 32, y: 52 },
    { x: 0, y: 52 },
  ],
  baseFt: 1.5,
  heightFt: 22,
};

function feature(overrides = {}) {
  return { ...HOUSE, ...overrides };
}

test('feature ids take the same slug shape as view and project ids', () => {
  assert.equal(isValidFeatureId('house'), true);
  assert.equal(isValidFeatureId('raised_bed-2'), true);
  assert.equal(isValidFeatureId('../etc'), false);
  assert.equal(isValidFeatureId('House'), false);
  assert.equal(isValidFeatureId(''), false);
});

test('a project with no features is normal, not malformed', () => {
  assert.deepEqual(normalizeFeatures(null, 'backyard'), { features: [] });
  assert.deepEqual(normalizeFeatures(undefined, 'backyard'), { features: [] });
  assert.deepEqual(normalizeFeatures({}, 'backyard'), { features: [] });
  assert.deepEqual(normalizeFeatures({ features: [] }, 'backyard'), { features: [] });

  assert.throws(() => normalizeFeatures([], 'backyard'), /features array/);
  assert.throws(() => normalizeFeatures({ features: {} }, 'backyard'), /must be an array/);
  assert.throws(() => normalizeFeatures({}, 'Bad Id'), /Invalid project id/);
});

test('a surface is a flat polygon with a supplied style', () => {
  const { features } = normalizeFeatures({ features: [DRIVEWAY] }, 'backyard');
  assert.equal(features.length, 1);
  assert.deepEqual(features[0], {
    id: 'driveway',
    type: 'surface',
    label: 'Driveway',
    footprintFt: DRIVEWAY.footprintFt,
    baseFt: 0,
    heightFt: 0,
    style: { fill: '#e8e4dc', stroke: '#cfc8bb', strokeWidthFt: 0.1 },
  });
  assert.equal(geometryKeyFor('surface'), 'footprintFt');

  // Flatness is the definition, so a height on one is a mistake worth naming.
  assert.throws(
    () => normalizeFeatures({ features: [{ ...DRIVEWAY, heightFt: 3 }] }, 'backyard'),
    /flat/
  );
});

test('a wall is an extruded path and keeps its authored style over the defaults', () => {
  const { features } = normalizeFeatures({ features: [FENCE] }, 'backyard');
  assert.deepEqual(features[0], {
    id: 'fence',
    type: 'wall',
    // No label was authored, so the id stands in for one.
    label: 'fence',
    pathFt: FENCE.pathFt,
    baseFt: 0,
    heightFt: 6,
    style: { fill: '#8b6f4e', stroke: '#b3aa99', strokeWidthFt: 0.25 },
  });
  assert.equal(geometryKeyFor('wall'), 'pathFt');
  // The polygon key is never carried on a path primitive; nl-avt.2 projects
  // exactly one of the two.
  assert.equal('footprintFt' in features[0], false);
});

test('a trellis is an extruded path, like a wall, with its own default style', () => {
  const { features } = normalizeFeatures({ features: [TRELLIS] }, 'backyard');
  assert.equal(features[0].type, 'trellis');
  assert.equal(geometryKeyFor('trellis'), 'pathFt');
  assert.equal('footprintFt' in features[0], false);
  assert.equal(features[0].heightFt, 7);
  assert.notDeepEqual(features[0].style, normalizeFeatures({ features: [FENCE] }, 'b').features[0].style);
});

test('a box is an extruded polygon that can sit on a step', () => {
  const { features } = normalizeFeatures({ features: [HOUSE] }, 'backyard');
  assert.equal(features[0].baseFt, 1.5);
  assert.equal(features[0].heightFt, 22);
  assert.equal(features[0].style.strokeWidthFt, 0.15);
  assert.equal('pathFt' in features[0], false);
});

test('serializeFeatures drops defaults and round-trips through normalizeFeatures', () => {
  const raw = { features: [DRIVEWAY, FENCE, HOUSE] };
  const normalized = normalizeFeatures(raw, 'backyard');
  const serialized = serializeFeatures(normalized);

  // Nothing normalizeFeatures would have supplied is written back.
  assert.deepEqual(serialized.features[0], {
    id: 'driveway',
    type: 'surface',
    label: 'Driveway',
    footprintFt: DRIVEWAY.footprintFt,
  });
  assert.deepEqual(serialized.features[1], {
    id: 'fence',
    type: 'wall',
    pathFt: FENCE.pathFt,
    heightFt: 6,
    style: { fill: '#8b6f4e', strokeWidthFt: 0.25 },
  });
  assert.equal('label' in serialized.features[1], false);
  assert.equal('baseFt' in serialized.features[1], false);

  assert.deepEqual(normalizeFeatures(serialized, 'backyard'), normalized);
});

test('a file that spells out the defaults still round-trips', () => {
  const verbose = {
    features: [
      {
        ...DRIVEWAY,
        baseFt: 0,
        heightFt: 0,
        style: { fill: '#E8E4DC', stroke: '#cfc8bb', strokeWidthFt: 0.1 },
      },
    ],
  };
  const normalized = normalizeFeatures(verbose, 'backyard');
  assert.deepEqual(serializeFeatures(normalized).features[0], {
    id: 'driveway',
    type: 'surface',
    label: 'Driveway',
    footprintFt: DRIVEWAY.footprintFt,
  });
  assert.deepEqual(normalizeFeatures(serializeFeatures(normalized), 'backyard'), normalized);
});

test('malformed features are rejected loudly rather than dropped', () => {
  const bad = (value, pattern) =>
    assert.throws(() => normalizeFeatures({ features: [value] }, 'backyard'), pattern);

  bad(null, /is not an object/);
  bad(feature({ id: 'Bad Id' }), /needs an id/);
  bad(feature({ id: undefined }), /needs an id/);
  bad(feature({ type: 'sphere' }), /unknown type/);
  bad(feature({ baseFt: 'ground' }), /baseFt must be a number/);
  bad(feature({ heightFt: 0 }), /positive heightFt/);
  bad(feature({ heightFt: undefined }), /positive heightFt/);
  bad(feature({ heightFt: Number.POSITIVE_INFINITY }), /positive heightFt/);
  bad(feature({ style: { fill: 'url(#x)' } }), /not a hex colour/);
  bad(feature({ style: { strokeWidthFt: -1 } }), /non-negative/);
  bad(feature({ style: [] }), /style must be an object/);

  assert.throws(
    () => normalizeFeatures({ features: [DRIVEWAY, { ...FENCE, id: 'driveway' }] }, 'backyard'),
    /two features with the id "driveway"/
  );
});

test('coordinates must be finite and enclose something', () => {
  const bad = (value, pattern) =>
    assert.throws(() => normalizeFeatures({ features: [value] }, 'backyard'), pattern);

  bad(feature({ footprintFt: HOUSE.footprintFt.slice(0, 2) }), /at least 3 points/);
  bad(feature({ footprintFt: undefined }), /at least 3 points/);
  bad({ ...FENCE, pathFt: [{ x: 0, y: 0 }] }, /at least 2 points/);
  bad(
    feature({ footprintFt: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: NaN }] }),
    /point 3 is not a finite/
  );
  bad(feature({ footprintFt: [{ x: 0, y: 0 }, { x: 1 }, { x: 1, y: 2 }] }), /point 2 is not a finite/);
  // Numeric strings are coerced the way the rest of the loaders coerce them.
  const coerced = normalizeFeatures(
    { features: [feature({ footprintFt: [{ x: '0', y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }] })] },
    'backyard'
  );
  assert.deepEqual(coerced.features[0].footprintFt[0], { x: 0, y: 0 });
});
