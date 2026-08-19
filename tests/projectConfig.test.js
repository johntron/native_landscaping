import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidProjectId,
  normalizeProjectConfig,
  normalizeProjectIndex,
  projectLayoutPath,
  resolveActiveProjectId,
} from '../src/data/projectConfig.js';
import { ELEVATION_VIEWBOX, PLAN_VIEWBOX } from '../src/constants.js';

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
  assert.equal(config.id, 'backyard');
  assert.deepEqual(config.plan.viewBox, { width: 800, height: 600 });
  // The elevations declared no viewBox or offsets, so constants supply them.
  assert.deepEqual(config.elevations[0].viewBox, {
    width: ELEVATION_VIEWBOX.width,
    height: ELEVATION_VIEWBOX.height,
  });
  assert.equal(config.elevations[0].label, 'South elevation');
  assert.equal(config.elevations[0].sublabel, 'Looking North');
  assert.equal(config.elevations[1].sublabel, 'Looking West');
  assert.equal(typeof config.elevations[0].bottomOffsetPx, 'number');
});

test('normalizeProjectConfig rejects malformed configs', () => {
  assert.throws(() => normalizeProjectConfig(makeConfig(), 'Bad Id'), /Invalid project id/);
  assert.throws(() => normalizeProjectConfig(null, 'backyard'), /no configuration object/);
  assert.throws(
    () => normalizeProjectConfig(makeConfig({ elevations: [] }), 'backyard'),
    /exactly 2 elevations/
  );
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
  assert.throws(
    () => normalizeProjectConfig(makeConfig({ plan: {} }), 'backyard'),
    /missing a background image/
  );
});

test('invalid numbers fall back rather than producing a broken viewBox', () => {
  const config = normalizeProjectConfig(
    makeConfig({ plan: { viewBox: { width: -5, height: 'wide' }, background: 'img/top.webp' } }),
    'backyard'
  );
  assert.deepEqual(config.plan.viewBox, { width: PLAN_VIEWBOX.width, height: PLAN_VIEWBOX.height });
});

test('layout path is scoped to the project directory', () => {
  assert.equal(projectLayoutPath('backyard'), 'projects/backyard/planting_layout.csv');
});
