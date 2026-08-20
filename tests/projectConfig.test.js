import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidProjectId,
  normalizeProjectConfig,
  normalizeProjectIndex,
  serializeProjectConfig,
  projectLayoutPath,
  resolveActiveProjectId,
} from '../src/data/projectConfig.js';
import { ELEVATION_VIEWBOX, INCHES_PER_FOOT, PLAN_VIEWBOX } from '../src/constants.js';
import { createViewTransform } from '../src/render/viewTransform.js';

function makeConfig(overrides = {}) {
  return {
    name: 'Backyard',
    plan: { viewBox: { width: 800, height: 600 }, background: 'img/top.webp' },
    elevations: [
      { id: 'south', viewFrom: 'south', background: 'img/south.webp' },
      { id: 'east', viewFrom: 'east', background: 'img/east.webp' },
    ],
    ...overrides,
  };
}

test('project ids are restricted to a path-safe slug', () => {
  assert.equal(isValidProjectId('backyard'), true);
  assert.equal(isValidProjectId('front-yard_2'), true);
  assert.equal(isValidProjectId('../etc'), false);
  assert.equal(isValidProjectId('Backyard'), false);
  assert.equal(isValidProjectId('-leading'), false);
  assert.equal(isValidProjectId(''), false);
  assert.equal(isValidProjectId(undefined), false);
});

test('normalizeProjectIndex keeps valid entries and picks a sane default', () => {
  const index = normalizeProjectIndex({
    defaultProject: 'missing',
    projects: [{ id: 'backyard', name: 'Backyard' }, { id: 'bad id' }, 'frontyard'],
  });
  assert.deepEqual(index.projects, [
    { id: 'backyard', name: 'Backyard' },
    { id: 'frontyard', name: 'frontyard' },
  ]);
  // The declared default does not exist, so the first listed project wins.
  assert.equal(index.defaultProject, 'backyard');

  assert.throws(() => normalizeProjectIndex({ projects: [] }), /no valid projects/);
});

test('resolveActiveProjectId falls back and reports that it did', () => {
  const index = { defaultProject: 'backyard', projects: [{ id: 'backyard' }, { id: 'frontyard' }] };
  assert.deepEqual(resolveActiveProjectId('frontyard', index), {
    id: 'frontyard',
    fellBack: false,
    requestedId: 'frontyard',
  });
  assert.deepEqual(resolveActiveProjectId('', index), {
    id: 'backyard',
    fellBack: false,
    requestedId: '',
  });
  assert.deepEqual(resolveActiveProjectId('nope', index), {
    id: 'backyard',
    fellBack: true,
    requestedId: 'nope',
  });
});

test('normalizeProjectConfig fills gaps from the global defaults', () => {
  const config = normalizeProjectConfig(makeConfig(), 'backyard');
  const [plan, south, east] = config.views;
  assert.equal(config.id, 'backyard');
  assert.deepEqual(plan.viewBox, { width: 800, height: 600 });
  // The elevations declared no viewBox, so constants supply one.
  assert.deepEqual(south.viewBox, {
    width: ELEVATION_VIEWBOX.width,
    height: ELEVATION_VIEWBOX.height,
  });
  assert.equal(south.label, 'South elevation');
  assert.equal(south.sublabel, 'Looking North');
  assert.equal(east.sublabel, 'Looking West');
});

test('normalizeProjectConfig rejects malformed configs', () => {
  assert.throws(() => normalizeProjectConfig(makeConfig(), 'Bad Id'), /Invalid project id/);
  assert.throws(() => normalizeProjectConfig(null, 'backyard'), /no configuration object/);
  assert.throws(
    () =>
      normalizeProjectConfig(
        makeConfig({
          elevations: [
            { viewFrom: 'sideways', background: 'a.webp' },
            { viewFrom: 'east', background: 'b.webp' },
          ],
        }),
        'backyard'
      ),
    /unknown viewFrom/
  );
});

test('background paths may not escape the project directory', () => {
  const escapes = ['../../secret.webp', '/etc/passwd', 'https://example.com/x.webp'];
  escapes.forEach((background) => {
    assert.throws(
      () => normalizeProjectConfig(makeConfig({ plan: { background } }), 'backyard'),
      /relative to the project directory/,
      background
    );
  });
  // A view with no background at all is valid — it is how a freshly added view starts.
  assert.equal(normalizeProjectConfig(makeConfig({ plan: {} }), 'backyard').views[0].background, null);
});

test('invalid numbers fall back rather than producing a broken viewBox', () => {
  const config = normalizeProjectConfig(
    makeConfig({ plan: { viewBox: { width: -5, height: 'wide' }, background: 'img/top.webp' } }),
    'backyard'
  );
  assert.deepEqual(config.views[0].viewBox, {
    width: PLAN_VIEWBOX.width,
    height: PLAN_VIEWBOX.height,
  });
});

test('layout path is scoped to the project directory', () => {
  assert.equal(projectLayoutPath('backyard'), 'projects/backyard/planting_layout.csv');
});

// --- views[] schema, migration, and serialization ---

const BACKYARD_LEGACY = {
  name: 'Backyard',
  defaultPixelsPerInch: 2.25,
  plan: { viewBox: { width: 800, height: 600 }, background: 'img/top.webp' },
  elevations: [
    { id: 'east', viewFrom: 'east', background: 'img/east.webp', bottomOffsetPx: 100, leftOffsetPx: 80 },
  ],
};

function makeViewsConfig(overrides = {}) {
  return {
    name: 'Backyard',
    views: [
      {
        id: 'plan',
        type: 'plan',
        viewBox: { width: 800, height: 600 },
        extentFt: { width: 40, height: 30 },
        background: 'img/top.webp',
      },
      {
        id: 'east',
        type: 'elevation',
        viewFrom: 'east',
        viewBox: { width: 800, height: 600 },
        originFt: { x: -3, y: -2.5 },
        extentFt: { width: 40, height: 30 },
        background: 'img/east.webp',
      },
    ],
    ...overrides,
  };
}

test('the legacy shape migrates to feet-authored views', () => {
  const config = normalizeProjectConfig(BACKYARD_LEGACY, 'backyard');
  const pxPerFt = 2.25 * INCHES_PER_FOOT; // 27
  const [plan, east] = config.views;

  assert.equal(plan.type, 'plan');
  assert.deepEqual(plan.originFt, { x: 0, y: 0 });
  assert.deepEqual(plan.extentFt, { width: 800 / pxPerFt, height: 600 / pxPerFt });
  assert.equal(plan.label, 'Plan');

  // Pixel insets become negative origins: the drawing starts before the yard's zero.
  assert.equal(east.type, 'elevation');
  assert.equal(east.viewFrom, 'east');
  assert.ok(Math.abs(east.originFt.x - -80 / pxPerFt) < 1e-12);
  assert.ok(Math.abs(east.originFt.y - -100 / pxPerFt) < 1e-12);
  assert.equal(east.sublabel, 'Looking West');
});

test('migration round-trips back to the pixel offsets it came from', () => {
  const [plan, east] = normalizeProjectConfig(BACKYARD_LEGACY, 'backyard').views;
  const planTransform = createViewTransform(plan);
  const eastTransform = createViewTransform(east);
  assert.equal(planTransform.pxPerFt / INCHES_PER_FOOT, 2.25);
  assert.deepEqual(plan.viewBox, { width: 800, height: 600 });
  // groundY and the near-edge inset land back on the pixels the legacy file named.
  assert.ok(Math.abs(eastTransform.groundY - (600 - 100)) < 1e-9);
  assert.ok(Math.abs(eastTransform.axisToX(0) - 80) < 1e-9);
});

test('serializeProjectConfig omits everything normalize would have supplied', () => {
  const config = normalizeProjectConfig(makeViewsConfig(), 'backyard');
  const serialized = serializeProjectConfig(config);

  assert.deepEqual(serialized.views[0], {
    id: 'plan',
    type: 'plan',
    extentFt: { width: 40, height: 30 },
    background: 'img/top.webp',
  });
  // The plan's viewBox, labels and zero origin are all defaults, so none are written.
  assert.deepEqual(serialized.views[1], {
    id: 'east',
    type: 'elevation',
    viewFrom: 'east',
    originFt: { x: -3, y: -2.5 },
    extentFt: { width: 40, height: 30 },
    background: 'img/east.webp',
  });
  assert.equal('defaultPixelsPerInch' in serialized, false);
});

test('serialize then normalize is a fixed point', () => {
  const config = normalizeProjectConfig(makeViewsConfig(), 'backyard');
  const reloaded = normalizeProjectConfig(serializeProjectConfig(config), 'backyard');
  assert.deepEqual(reloaded.views, config.views);
});

test('a non-default label or viewBox survives the round trip', () => {
  const config = normalizeProjectConfig(
    makeViewsConfig({
      views: [
        {
          id: 'shade-bed',
          type: 'plan',
          label: 'Shade bed',
          sublabel: 'Detail',
          viewBox: { width: 600, height: 450 },
          originFt: { x: 4, y: 9 },
          extentFt: { width: 8, height: 6 },
          backgroundFrom: 'shade-bed',
        },
      ],
    }),
    'backyard'
  );
  const serialized = serializeProjectConfig(config);
  assert.deepEqual(serialized.views[0], {
    id: 'shade-bed',
    type: 'plan',
    label: 'Shade bed',
    sublabel: 'Detail',
    viewBox: { width: 600, height: 450 },
    originFt: { x: 4, y: 9 },
    extentFt: { width: 8, height: 6 },
    backgroundFrom: 'shade-bed',
  });
});

test('views[] validation rejects the ways a view can be unusable', () => {
  const bad = (views, pattern) =>
    assert.throws(() => normalizeProjectConfig(makeViewsConfig({ views }), 'backyard'), pattern);

  bad([], /declares no views/);
  bad([{ id: 'x', type: 'oblique', extentFt: { width: 1, height: 1 } }], /unknown type/);
  bad([{ id: 'x', type: 'elevation', viewFrom: 'up', extentFt: { width: 40, height: 30 } }], /unknown viewFrom/);
  bad([{ id: 'x', type: 'plan' }], /needs a positive extentFt/);
  // 800x600 px over 40x20 ft is 20 px/ft across and 30 px/ft down.
  bad(
    [{ id: 'x', type: 'plan', viewBox: { width: 800, height: 600 }, extentFt: { width: 40, height: 20 } }],
    /non-uniformly scaled/
  );
  bad(
    [
      { id: 'twin', type: 'plan', extentFt: { width: 40, height: 30 } },
      { id: 'twin', type: 'plan', extentFt: { width: 40, height: 30 } },
    ],
    /two views with the id "twin"/
  );
  bad(
    [{ id: 'x', type: 'plan', extentFt: { width: 40, height: 30 }, backgroundFrom: 'ghost' }],
    /borrows a background from unknown view "ghost"/
  );
  bad(
    [{ id: 'x', type: 'plan', extentFt: { width: 40, height: 30 }, background: '../../secret.webp' }],
    /relative to the project directory/
  );
});
