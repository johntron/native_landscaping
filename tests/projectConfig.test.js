import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defaultViewerAt,
  isValidProjectId,
  normalizeProjectConfig,
  normalizeProjectIndex,
  serializeProjectConfig,
  projectAssetPath,
  projectConfigPath,
  resolveActiveProjectId,
} from '../src/data/projectConfig.js';
import { INCHES_PER_FOOT, PLAN_VIEWBOX } from '../src/constants.js';
import { createViewTransform } from '../src/render/viewTransform.js';
import { resolvePhotoPlacement } from '../src/render/photoPlacement.js';

const close = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} !== ${expected}`);

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

  // A person with no yards yet is a normal state, not a broken index (nl-3s5.3).
  assert.deepEqual(normalizeProjectIndex({ projects: [] }), { defaultProject: null, projects: [] });
  assert.deepEqual(normalizeProjectIndex({}), { defaultProject: null, projects: [] });
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

test('every view is derived from the one declared yard', () => {
  const config = normalizeProjectConfig(makeConfig(), 'backyard');
  const [plan, south, east] = config.views;
  assert.equal(config.id, 'backyard');

  // The old plan rectangle — 800 px at 27 px/ft — becomes the yard itself.
  close(config.yardFt.width, 800 / 27, 'yard width');
  close(config.yardFt.depth, 600 / 27, 'yard depth');
  const pad = config.paddingFt;

  // The plan shows the yard plus its margin on all four sides.
  assert.deepEqual(plan.originFt, { x: -pad, y: -pad });
  close(plan.extentFt.width, config.yardFt.width + 2 * pad, 'plan width');

  // A view from the south looks along x, one from the east along y, so the two
  // elevations are as wide as the yard is in THAT direction — and no wider.
  close(south.extentFt.width, config.yardFt.width + 2 * pad, 'south width');
  close(east.extentFt.width, config.yardFt.depth + 2 * pad, 'east width');
  // Their heights are shared, which is what puts their ground lines on one row.
  assert.deepEqual(south.extentFt.height, east.extentFt.height);
  close(south.originFt.y, -config.elevationFt.below, 'ground');

  // One scale for the whole project: a foot is the same size in every drawing.
  config.views.forEach((view) => {
    close(view.viewBox.width / view.extentFt.width, config.pxPerFt, `${view.id} px/ft`);
    close(view.viewBox.height / view.extentFt.height, config.pxPerFt, `${view.id} px/ft down`);
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
  // The unusable viewBox falls back to the constant, which then describes the
  // yard; the drawing is derived from that and is positive either way.
  close(config.yardFt.width, PLAN_VIEWBOX.width / 27, 'yard width');
  close(config.views[0].viewBox.width, config.views[0].extentFt.width * config.pxPerFt, 'viewBox');
  assert.ok(config.views[0].viewBox.height > 0);
});

test('a yard and its photos load through the owner-checked API, never as static files', () => {
  assert.equal(projectConfigPath('backyard'), 'api/project?project=backyard');
  assert.equal(
    projectAssetPath('backyard', 'img/top.webp'),
    'api/project-photo?project=backyard&path=img/top.webp'
  );
  // Anything that could break out of the query value is encoded.
  assert.equal(
    projectAssetPath('backyard', 'img/a&b=c#d.webp'),
    'api/project-photo?project=backyard&path=img/a%26b%3Dc%23d.webp'
  );
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

test('the legacy shape migrates to a yard, and its pixel insets to the photos', () => {
  const config = normalizeProjectConfig(BACKYARD_LEGACY, 'backyard');
  const pxPerFt = 2.25 * INCHES_PER_FOOT; // 27
  const [plan, east] = config.views;

  assert.equal(plan.type, 'plan');
  assert.equal(plan.label, 'Plan');
  close(config.pxPerFt, pxPerFt, 'px/ft');
  close(config.yardFt.width, 800 / pxPerFt, 'yard width');

  // The view no longer carries the insets — its rectangle comes from the yard.
  // They describe where the PHOTOGRAPH sits, which is what they always meant:
  // a pixel inset from the near edge is a negative origin in feet.
  assert.equal(east.type, 'elevation');
  assert.equal(east.viewFrom, 'east');
  close(east.photoFt.originFt.x, -80 / pxPerFt, 'photo x');
  close(east.photoFt.originFt.y, -100 / pxPerFt, 'photo y');
  assert.equal(east.sublabel, 'Looking West');
});

test('a migrated photo keeps the size it was drawn at, and only moves', () => {
  // The panels change shape — that is the point — but the photograph must not
  // be rescaled by the conversion, or every yard would silently resize itself
  // against its own picture. An 800 x 600 px background stays 800 x 600 px.
  const [, east] = normalizeProjectConfig(BACKYARD_LEGACY, 'backyard').views;
  const { rect } = resolvePhotoPlacement(east);
  close(rect.width, 800, 'photo width');
  close(rect.height, 600, 'photo height');
});

test('serializeProjectConfig writes the yard, never a view rectangle', () => {
  const config = normalizeProjectConfig(makeViewsConfig(), 'backyard');
  const serialized = serializeProjectConfig(config);

  assert.deepEqual(serialized.yardFt, { width: 40, depth: 30 });
  assert.equal(serialized.paddingFt, config.paddingFt);
  assert.equal(serialized.pxPerFt, config.pxPerFt);

  // A view says what it is and where its photo sits. Its rectangle is derived,
  // so writing one back is how the views would drift apart again.
  assert.deepEqual(serialized.views[0], {
    id: 'plan',
    type: 'plan',
    background: 'img/top.webp',
    photoFt: { originFt: { x: 0, y: 0 }, extentFt: { width: 40, height: 30 } },
  });
  assert.deepEqual(serialized.views[1], {
    id: 'east',
    type: 'elevation',
    viewFrom: 'east',
    background: 'img/east.webp',
    photoFt: { originFt: { x: -3, y: -2.5 }, extentFt: { width: 40, height: 30 } },
  });
  assert.equal('defaultPixelsPerInch' in serialized, false);
});

test('serialize then normalize is a fixed point', () => {
  const config = normalizeProjectConfig(makeViewsConfig(), 'backyard');
  const reloaded = normalizeProjectConfig(serializeProjectConfig(config), 'backyard');
  assert.deepEqual(reloaded.views, config.views);
});

test('a custom label and a placed photo survive the round trip', () => {
  const config = normalizeProjectConfig(
    {
      name: 'Fixture',
      yardFt: { width: 20, depth: 16 },
      views: [
        {
          id: 'plan',
          type: 'plan',
          label: 'Whole yard',
          sublabel: 'From the drone',
          background: 'img/plan.webp',
          photoFt: { originFt: { x: 4, y: 9 }, extentFt: { width: 8, height: 6 } },
        },
      ],
    },
    'backyard'
  );
  const serialized = serializeProjectConfig(config);
  assert.deepEqual(serialized.views[0], {
    id: 'plan',
    type: 'plan',
    label: 'Whole yard',
    sublabel: 'From the drone',
    background: 'img/plan.webp',
    photoFt: { originFt: { x: 4, y: 9 }, extentFt: { width: 8, height: 6 } },
  });
  assert.deepEqual(serialized.yardFt, { width: 20, depth: 16 });
});

test('photoHidden survives the round trip, and is absent by default', () => {
  const config = normalizeProjectConfig(
    {
      name: 'Fixture',
      yardFt: { width: 20, depth: 16 },
      views: [
        {
          id: 'plan',
          type: 'plan',
          background: 'img/plan.webp',
          photoHidden: true,
        },
      ],
    },
    'backyard'
  );
  assert.equal(config.views[0].photoHidden, true);
  const serialized = serializeProjectConfig(config);
  assert.equal(serialized.views[0].photoHidden, true);

  const shown = normalizeProjectConfig(
    {
      name: 'Fixture',
      yardFt: { width: 20, depth: 16 },
      views: [{ id: 'plan', type: 'plan', background: 'img/plan.webp' }],
    },
    'backyard'
  );
  assert.equal(shown.views[0].photoHidden, undefined);
  assert.equal('photoHidden' in serializeProjectConfig(shown).views[0], false);
});

test('skyColor/groundColor survive the round trip, and a view that declares neither has none', () => {
  const config = normalizeProjectConfig(
    {
      name: 'Fixture',
      yardFt: { width: 20, depth: 16 },
      views: [
        {
          id: 'south',
          type: 'elevation',
          viewFrom: 'south',
          skyColor: '#BFE3FF',
          groundColor: 'saddlebrown',
        },
      ],
    },
    'backyard'
  );
  assert.equal(config.views[0].skyColor, '#bfe3ff');
  assert.equal(config.views[0].groundColor, 'saddlebrown');
  const serialized = serializeProjectConfig(config);
  assert.equal(serialized.views[0].skyColor, '#bfe3ff');
  assert.equal(serialized.views[0].groundColor, 'saddlebrown');

  const neither = normalizeProjectConfig(
    {
      name: 'Fixture',
      yardFt: { width: 20, depth: 16 },
      views: [{ id: 'south', type: 'elevation', viewFrom: 'south' }],
    },
    'backyard'
  );
  assert.equal(neither.views[0].skyColor, undefined);
  assert.equal(neither.views[0].groundColor, undefined);
  const serializedNeither = serializeProjectConfig(neither);
  assert.equal('skyColor' in serializedNeither.views[0], false);
  assert.equal('groundColor' in serializedNeither.views[0], false);

  assert.throws(
    () =>
      normalizeProjectConfig(
        {
          name: 'Fixture',
          yardFt: { width: 20, depth: 16 },
          views: [{ id: 'south', type: 'elevation', viewFrom: 'south', skyColor: 'not a colour!' }],
        },
        'backyard'
      ),
    /skyColor/
  );
});

test('views[] validation rejects the ways a view can be unusable', () => {
  const bad = (views, pattern) =>
    assert.throws(() => normalizeProjectConfig(makeViewsConfig({ views }), 'backyard'), pattern);

  bad([], /declares no views/);
  bad([{ id: 'x', type: 'oblique' }], /unknown type/);
  bad([{ id: 'x', type: 'elevation', viewFrom: 'up' }], /unknown viewFrom/);
  bad([{ id: 'twin', type: 'plan' }, { id: 'twin', type: 'plan' }], /two views with the id "twin"/);
  bad([{ id: 'x', type: 'plan', background: '../../secret.webp' }], /relative to the project directory/);

  // A view carrying no rectangle at all is no longer an error — it is the
  // normal case, because the yard supplies one.
  const bare = normalizeProjectConfig(makeViewsConfig({ views: [{ id: 'x', type: 'plan' }] }), 'backyard');
  assert.ok(bare.views[0].extentFt.width > 0);
});

test('a stale backgroundFrom is ignored rather than honoured', () => {
  // Detail callouts are gone: a view shows the yard, and a photo is placed in
  // it. A file left over from the crop era must not resurrect the behaviour,
  // and must not fail to load either.
  const config = normalizeProjectConfig(
    {
      name: 'Fixture',
      yardFt: { width: 20, depth: 16 },
      views: [
        { id: 'plan', type: 'plan', background: 'img/plan.webp' },
        { id: 'street-bed', type: 'plan', backgroundFrom: 'plan' },
      ],
    },
    'fixture'
  );
  assert.equal('backgroundFrom' in config.views[1], false);
  assert.equal(config.views[1].background, null);
  // Both plans cover the same yard, because there is only one yard.
  assert.deepEqual(config.views[0].extentFt, config.views[1].extentFt);
  assert.equal('backgroundFrom' in serializeProjectConfig(config).views[1], false);
});


// --- the project.json files this repo actually ships ---

/**
 * These fixtures are inline on purpose.
 *
 * They used to read projects/<id>/project.json, but every shipped project is
 * also editable in the running app: one Setup-mode Save rewrites the file and
 * fails a test that has nothing to do with the change being made. It happened
 * twice in two days — see nl-2p3. What is actually under test here is
 * normalizeProjectConfig, so the input belongs next to the assertions.
 */

/** The pixel-authored shape backyard was converted from. */
const LEGACY_BACKYARD = {
  name: 'Backyard',
  defaultPixelsPerInch: 2.25,
  plan: { viewBox: { width: 800, height: 600 }, background: 'img/top.webp' },
  elevations: [
    {
      id: 'south',
      viewFrom: 'south',
      viewBox: { width: 800, height: 600 },
      bottomOffsetPx: 100,
      leftOffsetPx: 0,
      background: 'img/south.webp',
    },
    {
      id: 'east',
      viewFrom: 'east',
      viewBox: { width: 800, height: 600 },
      bottomOffsetPx: 100,
      leftOffsetPx: 80,
      background: 'img/east.webp',
    },
  ],
};

test('the legacy pixel-authored shape keeps every photo where it was', () => {
  // backyard was converted from {plan, elevations[]}, and converted again to a
  // declared yard. Through both conversions the photographs must not move
  // relative to the yard drawn over them: the 80 and 100 px insets the legacy
  // file named still separate each photo's edges from the yard's zero.
  const config = normalizeProjectConfig(LEGACY_BACKYARD, 'backyard');
  const byId = Object.fromEntries(config.views.map((view) => [view.id, view]));
  assert.deepEqual(Object.keys(byId), ['plan', 'south', 'east']);
  close(config.pxPerFt / INCHES_PER_FOOT, 2.25, 'px/inch');

  // The yard's zero, measured from each photo's own left and bottom edges.
  const insetOf = (view) => {
    const { rect } = resolvePhotoPlacement(view);
    const transform = createViewTransform(view);
    return {
      left: transform.axisToX(0) - rect.x,
      bottom: rect.y + rect.height - transform.groundY,
    };
  };
  const south = insetOf(byId.south);
  close(south.left, 0, 'south left inset');
  close(south.bottom, 100, 'south ground inset');

  const east = insetOf(byId.east);
  close(east.left, 80, 'east left inset');
  close(east.bottom, 100, 'east ground inset');
});

test("an elevation's camera position round-trips, and only an elevation has one", () => {
  const config = normalizeProjectConfig(
    makeViewsConfig({
      views: [
        {
          id: 'plan',
          type: 'plan',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          // A plan has no depth axis to stand on, so this is not a field it has.
          viewerAtFt: 12,
        },
        {
          id: 'north',
          type: 'elevation',
          viewFrom: 'north',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          viewerAtFt: 0,
        },
      ],
    }),
    'backyard'
  );
  assert.equal(config.views[0].viewerAtFt, undefined);
  // Zero is a real position — a truthiness test would drop it.
  assert.equal(config.views[1].viewerAtFt, 0);

  const serialized = serializeProjectConfig(config);
  assert.equal('viewerAtFt' in serialized.views[0], false);
  assert.equal(serialized.views[1].viewerAtFt, 0);
  assert.deepEqual(normalizeProjectConfig(serialized, 'backyard').views, config.views);
});

test('an absent or unparseable camera position is simply absent', () => {
  // Absent means cull nothing, which is the permissive default a project that
  // never mentioned a camera relies on. Filling it in was tried: a default half
  // a margin outside the yard culls no PLANT, because plants are clamped to the
  // yard — but it culls FEATURES, which are not, and example-frontyard's west
  // elevation lost a bed to a camera it had never declared.
  const withoutIt = normalizeProjectConfig(makeViewsConfig(), 'backyard');
  assert.equal('viewerAtFt' in withoutIt.views[1], false);
  const serialized = serializeProjectConfig(withoutIt);
  assert.equal('viewerAtFt' in serialized.views[1], false);

  const garbage = normalizeProjectConfig(
    makeViewsConfig({
      views: [
        ...makeViewsConfig().views.slice(0, 1),
        { ...makeViewsConfig().views[1], viewerAtFt: 'over there' },
      ],
    }),
    'backyard'
  );
  assert.equal('viewerAtFt' in garbage.views[1], false);
});

test('the camera a drag starts from stands half a margin outside its own edge', () => {
  // Drawing only — see normalizeViewerAt. The pairing follows farIsHigh, not
  // the compass name: south and WEST stand at the low end of their depth axis
  // (south of the yard, west of it), north and EAST past its far side.
  const layout = { yardFt: { width: 20, depth: 16 }, paddingFt: 3 };
  assert.equal(defaultViewerAt('south', layout), -1.5);
  assert.equal(defaultViewerAt('west', layout), -1.5);
  assert.equal(defaultViewerAt('north', layout), 16 + 1.5);
  assert.equal(defaultViewerAt('east', layout), 20 + 1.5);
});

test("an elevation's camera position round-trips, and only an elevation has one", () => {
  const config = normalizeProjectConfig(
    makeViewsConfig({
      views: [
        {
          id: 'plan',
          type: 'plan',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          // A plan has no depth axis to stand on, so this is not a field it has.
          viewerAtFt: 12,
        },
        {
          id: 'north',
          type: 'elevation',
          viewFrom: 'north',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          viewerAtFt: 0,
        },
      ],
    }),
    'backyard'
  );
  assert.equal(config.views[0].viewerAtFt, undefined);
  // Zero is a real position — a truthiness test would drop it.
  assert.equal(config.views[1].viewerAtFt, 0);

  const serialized = serializeProjectConfig(config);
  assert.equal('viewerAtFt' in serialized.views[0], false);
  assert.equal(serialized.views[1].viewerAtFt, 0);
  assert.deepEqual(normalizeProjectConfig(serialized, 'backyard').views, config.views);
});

test("an elevation's camera position round-trips, and only an elevation has one", () => {
  const config = normalizeProjectConfig(
    makeViewsConfig({
      views: [
        {
          id: 'plan',
          type: 'plan',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          // A plan has no depth axis to stand on, so this is not a field it has.
          viewerAtFt: 12,
        },
        {
          id: 'north',
          type: 'elevation',
          viewFrom: 'north',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          viewerAtFt: 0,
        },
      ],
    }),
    'backyard'
  );
  assert.equal(config.views[0].viewerAtFt, undefined);
  // Zero is a real position — a truthiness test would drop it.
  assert.equal(config.views[1].viewerAtFt, 0);

  const serialized = serializeProjectConfig(config);
  assert.equal('viewerAtFt' in serialized.views[0], false);
  assert.equal(serialized.views[1].viewerAtFt, 0);
  assert.deepEqual(normalizeProjectConfig(serialized, 'backyard').views, config.views);
});

test('an absent or unparseable camera position is simply absent', () => {
  // Absent means cull nothing, which is the permissive default a project that
  // never mentioned a camera relies on. Filling it in was tried: a default half
  // a margin outside the yard culls no PLANT, because plants are clamped to the
  // yard — but it culls FEATURES, which are not, and example-frontyard's west
  // elevation lost a bed to a camera it had never declared.
  const withoutIt = normalizeProjectConfig(makeViewsConfig(), 'backyard');
  assert.equal('viewerAtFt' in withoutIt.views[1], false);
  const serialized = serializeProjectConfig(withoutIt);
  assert.equal('viewerAtFt' in serialized.views[1], false);

  const garbage = normalizeProjectConfig(
    makeViewsConfig({
      views: [
        ...makeViewsConfig().views.slice(0, 1),
        { ...makeViewsConfig().views[1], viewerAtFt: 'over there' },
      ],
    }),
    'backyard'
  );
  assert.equal('viewerAtFt' in garbage.views[1], false);
});

test('the camera a drag starts from stands half a margin outside its own edge', () => {
  // Drawing only — see normalizeViewerAt. The pairing follows farIsHigh, not
  // the compass name: south and WEST stand at the low end of their depth axis
  // (south of the yard, west of it), north and EAST past its far side.
  const layout = { yardFt: { width: 20, depth: 16 }, paddingFt: 3 };
  assert.equal(defaultViewerAt('south', layout), -1.5);
  assert.equal(defaultViewerAt('west', layout), -1.5);
  assert.equal(defaultViewerAt('north', layout), 16 + 1.5);
  assert.equal(defaultViewerAt('east', layout), 20 + 1.5);
});

test("an elevation's camera position round-trips, and only an elevation has one", () => {
  const config = normalizeProjectConfig(
    makeViewsConfig({
      views: [
        {
          id: 'plan',
          type: 'plan',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          // A plan has no depth axis to stand on, so this is not a field it has.
          viewerAtFt: 12,
        },
        {
          id: 'north',
          type: 'elevation',
          viewFrom: 'north',
          viewBox: { width: 800, height: 600 },
          extentFt: { width: 40, height: 30 },
          viewerAtFt: 0,
        },
      ],
    }),
    'backyard'
  );
  assert.equal(config.views[0].viewerAtFt, undefined);
  // Zero is a real position — a truthiness test would drop it.
  assert.equal(config.views[1].viewerAtFt, 0);

  const serialized = serializeProjectConfig(config);
  assert.equal('viewerAtFt' in serialized.views[0], false);
  assert.equal(serialized.views[1].viewerAtFt, 0);
  assert.deepEqual(normalizeProjectConfig(serialized, 'backyard').views, config.views);
});

test('ecoregion and site survive the normalize -> serialize round trip', () => {
  // serializeProjectConfig whitelists fields, so a field added to the normalizer
  // alone lives in memory and vanishes the first time Setup mode saves — the
  // user's declaration gone with no error. This is the assertion that catches it.
  const raw = {
    name: 'Yard',
    yardFt: { width: 20, depth: 30 },
    ecoregion: '9',
    site: { sun: 'part-sun', water: 'medium', soil: 'clay' },
    views: [{ id: 'plan', type: 'plan' }],
  };
  const config = normalizeProjectConfig(raw, 'yard');
  assert.equal(config.ecoregion, '9');
  assert.deepEqual(config.site, { sun: 'part-sun', water: 'medium', soil: 'clay' });

  const serialized = serializeProjectConfig(config);
  assert.equal(serialized.ecoregion, '9');
  assert.deepEqual(serialized.site, { sun: 'part-sun', water: 'medium', soil: 'clay' });
  // And a second pass is stable, which is what an edit-save-edit cycle does.
  assert.deepEqual(serializeProjectConfig(normalizeProjectConfig(serialized, 'yard')), serialized);
});

test('a project with neither ecoregion nor site still loads, and writes neither back', () => {
  const config = normalizeProjectConfig(
    { name: 'Yard', yardFt: { width: 20, depth: 30 }, views: [{ id: 'plan', type: 'plan' }] },
    'yard'
  );
  assert.equal(config.ecoregion, undefined);
  assert.equal(config.site, undefined);
  const serialized = serializeProjectConfig(config);
  assert.equal('ecoregion' in serialized, false);
  assert.equal('site' in serialized, false);
});

test('place survives the normalize -> serialize round trip, same whitelist trap as ecoregion/site', () => {
  const raw = {
    name: 'Yard',
    yardFt: { width: 20, depth: 30 },
    place: 'home',
    views: [{ id: 'plan', type: 'plan' }],
  };
  const config = normalizeProjectConfig(raw, 'yard');
  assert.equal(config.place, 'home');

  const serialized = serializeProjectConfig(config);
  assert.equal(serialized.place, 'home');
  assert.deepEqual(serializeProjectConfig(normalizeProjectConfig(serialized, 'yard')), serialized);
});

test('a project with no place still loads, and writes none back', () => {
  const config = normalizeProjectConfig(
    { name: 'Yard', yardFt: { width: 20, depth: 30 }, views: [{ id: 'plan', type: 'plan' }] },
    'yard'
  );
  assert.equal(config.place, undefined);
  assert.equal('place' in serializeProjectConfig(config), false);
});

test('a partial site declares only what it knows', () => {
  const config = normalizeProjectConfig(
    {
      yardFt: { width: 20, depth: 30 },
      site: { soil: 'CLAY-LOAM', sun: '' },
      views: [{ id: 'plan', type: 'plan' }],
    },
    'yard'
  );
  assert.deepEqual(config.site, { soil: 'clay-loam' }, 'case-folded, blanks dropped');
});

test('an unknown site value is a hand-edit mistake and fails loudly', () => {
  assert.throws(
    () =>
      normalizeProjectConfig(
        {
          yardFt: { width: 20, depth: 30 },
          site: { sun: 'dappled' },
          views: [{ id: 'plan', type: 'plan' }],
        },
        'yard'
      ),
    /site\.sun "dappled"/
  );
});

test('the shipped example yard declares an ecoregion and a site', () => {
  // backyard is the one yard still tracked (nl-3s5.3), as the seed for the
  // shared example (nl-3s5.24); the others are private and live in app.db.
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../projects/backyard/project.json', import.meta.url)), 'utf8')
  );
  const config = normalizeProjectConfig(raw, 'backyard');
  assert.equal(config.ecoregion, '9', 'backyard ecoregion');
  assert.ok(config.site?.sun && config.site?.water && config.site?.soil, 'backyard site');
});
