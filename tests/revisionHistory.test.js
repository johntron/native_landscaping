// nl-3s5.20: one revision stream per yard, across the planting, the setup and
// the features. The store (server/db/projectStore.js), and the page's history
// controller (src/history/layoutHistoryController.js) driven against the real
// routes over a throwaway app.db, so the local stack and the stored stream are
// checked against each other, not against a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import {
  currentPlacements,
  findOwnedProject,
  insertProject,
  moveHistoryCursor,
  projectDataDir,
  readRevision,
  readRevisions,
  recordLayout,
  referencedBackgroundNames,
  saveProjectConfig,
  saveProjectFeatures,
} from '../server/db/projectStore.js';
import { handleProjectRoutes } from '../server/routes/project.js';
import { createLayoutHistoryController, DESYNC_MESSAGE } from '../src/history/layoutHistoryController.js';
import { loadLayoutHistory } from '../src/data/persistence.js';
import { normalizeProjectConfig, serializeProjectConfig } from '../src/data/projectConfig.js';
import { normalizeFeatures } from '../src/data/featureConfig.js';
import { createPlantFromSpecies, parseSpeciesCsv } from '../src/data/plantParser.js';

const PLANTS_CSV = readFileSync(new URL('../plants.csv', import.meta.url), 'utf8');
const SPECIES = parseSpeciesCsv(PLANTS_CSV);
const HOLLY = SPECIES.find((entry) => entry.speciesId === 'yaupon-holly');

const CONFIG = { name: 'Yard', yardFt: { width: 20, depth: 15 }, views: [{ id: 'plan', type: 'plan' }] };
const FEATURES = { features: [] };
const BED = {
  id: 'bed',
  type: 'surface',
  footprintFt: [
    { x: 1, y: 1 },
    { x: 4, y: 1 },
    { x: 4, y: 3 },
  ],
};
const placement = (id, x) => ({ id, speciesId: 'yaupon-holly', x, y: 1 });
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'revision-history-test-'));
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  const alice = upsertUser(db, 'alice@example.com');
  const cleanup = () => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, db, alice, cleanup };
}

function addYard(env, slug, extra = {}) {
  return insertProject(env.db, {
    ownerId: env.alice.id,
    slug,
    name: slug,
    configJson: JSON.stringify(CONFIG),
    featuresJson: JSON.stringify(FEATURES),
    ...extra,
  });
}

const projectRow = (env, id) => env.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);

// --- the store ------------------------------------------------------------------

test('one stream: planting, setup and features saves share one seq, each a full snapshot', () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', {
      entries: [{ id: 'e0', timestamp: 't0', description: 'first', plants: [placement('p', 1)] }],
    });
    const renamed = JSON.stringify({ ...CONFIG, name: 'Renamed' });
    const setupSave = saveProjectConfig(env.db, id, { name: 'Renamed', configJson: renamed });
    assert.equal(setupSave.cursor, 1);
    assert.equal(setupSave.entry.kind, 'setup');
    const withBed = JSON.stringify({ features: [BED] });
    assert.equal(saveProjectFeatures(env.db, id, withBed).cursor, 2);
    assert.equal(recordLayout(env.db, id, { id: 'e3', timestamp: 't3', description: 'moved', plants: [placement('p', 2)] }).cursor, 3);

    const revisions = readRevisions(env.db, id);
    assert.deepEqual(revisions.map((r) => r.kind), ['planting', 'setup', 'features', 'planting']);
    // Every revision holds all three parts: what the save did not change is carried.
    assert.deepEqual(revisions.map((r) => JSON.parse(r.configJson).name), ['Yard', 'Renamed', 'Renamed', 'Renamed']);
    assert.deepEqual(revisions.map((r) => JSON.parse(r.featuresJson).features.length), [0, 0, 1, 1]);
    assert.deepEqual(revisions.map((r) => r.plants[0].x), [1, 1, 1, 2]);

    // The projects row is the current copy.
    const row = projectRow(env, id);
    assert.equal(row.history_cursor, 3);
    assert.equal(row.config_json, renamed);
    assert.equal(row.features_json, withBed);
    assert.equal(row.name, 'Renamed');
  } finally {
    env.cleanup();
  }
});

test('restoring any revision is one row: setup, features, name and plants come back, and the row matches the revision', () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', {
      entries: [{ id: 'e0', timestamp: 't0', description: 'first', plants: [placement('p', 1)] }],
    });
    saveProjectConfig(env.db, id, { name: 'Renamed', configJson: JSON.stringify({ ...CONFIG, name: 'Renamed' }) });
    saveProjectFeatures(env.db, id, JSON.stringify({ features: [BED] }));
    recordLayout(env.db, id, { id: 'e3', timestamp: 't3', description: 'moved', plants: [placement('p', 2)] });

    // Count the statements a restore runs: one SELECT of the revision, one of
    // the name, one UPDATE, however far the cursor jumps.
    for (const target of [0, 3, 1, 2]) {
      const statements = [];
      const prepare = env.db.prepare.bind(env.db);
      env.db.prepare = (sql) => {
        statements.push(sql.trim().split(/\s+/)[0]);
        return prepare(sql);
      };
      try {
        moveHistoryCursor(env.db, id, target);
      } finally {
        env.db.prepare = prepare;
      }
      assert.deepEqual(statements, ['SELECT', 'SELECT', 'UPDATE'], `restore ${target} is O(1)`);
      const row = projectRow(env, id);
      const revision = readRevision(env.db, id, target);
      assert.equal(row.history_cursor, target);
      assert.equal(row.config_json, revision.configJson, `config at ${target}`);
      assert.equal(row.features_json, revision.featuresJson, `features at ${target}`);
      assert.equal(row.name, JSON.parse(revision.configJson).name);
      assert.deepEqual(currentPlacements(env.db, id), revision.plants);
    }
  } finally {
    env.cleanup();
  }
});

test('a save after an undo truncates the redo tail, whatever kinds it held', () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', {
      entries: [{ id: 'e0', timestamp: 't0', description: 'first', plants: [placement('p', 1)] }],
    });
    saveProjectConfig(env.db, id, { name: 'A', configJson: JSON.stringify({ ...CONFIG, name: 'A' }) });
    saveProjectFeatures(env.db, id, JSON.stringify({ features: [BED] }));
    moveHistoryCursor(env.db, id, 0);
    // A planting save at revision 0 drops the setup and features revisions after it.
    const after = recordLayout(env.db, id, { id: 'e1', timestamp: 't', description: 'moved', plants: [placement('p', 5)] });
    assert.equal(after.cursor, 1);
    const revisions = readRevisions(env.db, id);
    assert.deepEqual(revisions.map((r) => r.id), ['e0', 'e1']);
    assert.equal(JSON.parse(revisions[1].configJson).name, 'Yard', 'carries revision 0\'s setup, not the undone one');
    // The name followed the cursor back to revision 0's setup; the planting save kept it.
    assert.equal(projectRow(env, id).name, 'Yard');
    assert.equal(projectRow(env, id).config_json, revisions[1].configJson);
  } finally {
    env.cleanup();
  }
});

test('the first setup or features save of a yard with no history seeds revision 0 from the stored state', () => {
  const env = setup();
  try {
    const setupYard = addYard(env, 'a');
    const result = saveProjectConfig(env.db, setupYard, { name: 'A', configJson: JSON.stringify({ ...CONFIG, name: 'A' }) });
    assert.equal(result.cursor, 1);
    const [seed, saved] = readRevisions(env.db, setupYard);
    assert.deepEqual(seed.plants, []);
    assert.equal(JSON.parse(seed.configJson).name, 'Yard', 'the seed is the yard before the save');
    assert.equal(JSON.parse(saved.configJson).name, 'A');

    const featuresYard = addYard(env, 'b', { featuresJson: null });
    assert.equal(saveProjectFeatures(env.db, featuresYard, JSON.stringify({ features: [BED] })).cursor, 1);
    assert.deepEqual(readRevisions(env.db, featuresYard).map((r) => r.featuresJson === null), [true, false]);
  } finally {
    env.cleanup();
  }
});

test('an old-shape insert (pre-5.20 code after a rollback) is filled from the yard; config_json can never be cleared; a bad kind is refused', () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', { featuresJson: JSON.stringify({ features: [BED] }) });
    // Exactly what the pre-5.20 recordLayout wrote: six columns.
    env.db
      .prepare('INSERT INTO history_entries (project_id, seq, entry_id, description, plants_json, created_at) VALUES (?, 0, ?, ?, ?, ?)')
      .run(id, 'old', 'moved', '[]', 't');
    const [filled] = readRevisions(env.db, id);
    assert.equal(filled.kind, 'planting');
    assert.equal(filled.configJson, projectRow(env, id).config_json);
    assert.equal(filled.featuresJson, projectRow(env, id).features_json);

    // A new-code row with no features keeps its NULL.
    const insert = env.db.prepare(
      'INSERT INTO history_entries (project_id, seq, entry_id, description, plants_json, created_at, kind, config_json, features_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insert.run(id, 1, 'new', 'd', '[]', 't', 'setup', '{}', null);
    assert.equal(readRevision(env.db, id, 1).featuresJson, null);

    assert.throws(() => insert.run(id, 2, 'x', 'd', '[]', 't', 'layout', '{}', null), /CHECK/);
    assert.throws(() => env.db.prepare('UPDATE history_entries SET config_json = NULL').run(), /config_json is required/);
  } finally {
    env.cleanup();
  }
});

// --- photos -----------------------------------------------------------------------

async function call(env, method, pathAndQuery, body, headers = { 'content-type': 'application/json' }) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = headers;
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(status, h) {
      this.statusCode = status;
      Object.assign(this.headers, h || {});
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload, cb) {
      this.body = payload;
      if (typeof cb === 'function') cb();
    },
  };
  const ctx = { url, pathname: url.pathname, dataDir: env.dataDir, db: { app: env.db }, user: env.alice };
  assert.equal(await handleProjectRoutes(req, res, ctx), true);
  return res;
}

test('photos stay while any revision names them: a replaced background survives until nothing can undo back to it', async () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', {
      entries: [{ id: 'e0', timestamp: 't', description: 'first', plants: [] }],
    });
    const img = join(projectDataDir(env.dataDir, id), 'img');
    const upload = async (bytes) => {
      const res = await call(env, 'POST', '/api/view-background?project=y&view=plan', bytes, { 'content-type': 'image/webp' });
      assert.equal(res.statusCode, 200, res.body);
      return JSON.parse(res.body).background;
    };
    const saveWith = async (background) => {
      const config = { ...CONFIG, views: [{ id: 'plan', type: 'plan', background }] };
      const res = await call(env, 'POST', '/api/project?project=y', config);
      assert.equal(res.statusCode, 200, res.body);
      return JSON.parse(res.body);
    };

    const first = await upload(WEBP);
    const saved = await saveWith(first);
    assert.equal(saved.revision.cursor, 1);
    assert.equal(saved.revision.entry.kind, 'setup');

    // A second photo for the same view: the first is superseded but revision 1 still shows it.
    const second = await upload(Buffer.concat([WEBP, Buffer.from('other')]));
    assert.deepEqual(readdirSync(img).sort(), [first, second].map((p) => p.slice(4)).sort());
    await saveWith(second);
    assert.deepEqual(readdirSync(img).sort(), [first, second].map((p) => p.slice(4)).sort(), 'the config sweep keeps it too');
    assert.deepEqual([...referencedBackgroundNames(env.db, id)].sort(), [first, second].map((p) => p.slice(4)).sort());

    // An abandoned upload (never saved) is still swept.
    const abandoned = await upload(Buffer.concat([WEBP, Buffer.from('abandoned')]));
    await saveWith(second);
    assert.equal(readdirSync(img).includes(abandoned.slice(4)), false);

    // Undo to revision 1: its photo is on disk.
    const rewound = await call(env, 'POST', '/api/history/cursor?project=y', { cursor: 1 });
    assert.equal(JSON.parse(rewound.body).entry.config.views[0].background, first);
    assert.equal((await call(env, 'GET', `/api/project-photo?project=y&path=${encodeURIComponent(first)}`)).statusCode, 200);

    // Truncate everything after revision 0: the next sweep may take both.
    await call(env, 'POST', '/api/history/cursor?project=y', { cursor: 0 });
    recordLayout(env.db, id, { id: 'e9', timestamp: 't', description: 'moved', plants: [] });
    await call(env, 'POST', '/api/project?project=y', CONFIG);
    assert.deepEqual(readdirSync(img), []);
  } finally {
    env.cleanup();
  }
});

test('GET /api/history sends config and features only where they change', async () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', {
      entries: [
        { id: 'e0', timestamp: 't', description: 'a', plants: [placement('p', 1)] },
        { id: 'e1', timestamp: 't', description: 'b', plants: [placement('p', 2)] },
      ],
      featuresJson: null,
    });
    saveProjectConfig(env.db, id, { name: 'R', configJson: JSON.stringify({ ...CONFIG, name: 'R' }) });
    recordLayout(env.db, id, { id: 'e3', timestamp: 't', description: 'c', plants: [placement('p', 3)] });
    const body = JSON.parse((await call(env, 'GET', '/api/history?project=y')).body);
    assert.equal(body.cursor, 3);
    assert.deepEqual(
      body.entries.map((e) => [e.kind, 'config' in e, 'features' in e]),
      [
        ['planting', true, true],
        ['planting', false, false],
        ['setup', true, false],
        ['planting', false, false],
      ]
    );
    assert.equal(body.entries[0].features, null, 'null is sent, meaning none drawn');
    assert.equal(body.entries[2].config.name, 'R');
  } finally {
    env.cleanup();
  }
});

// --- the controller, against the real routes ------------------------------------------

function button() {
  return {
    disabled: false,
    title: '',
    handler: null,
    addEventListener(type, fn) {
      this.handler = fn;
    },
    click() {
      this.handler();
    },
  };
}

/** A page: the controller wired to the routes through fetch, as app.js wires it. */
async function openPage(env, slug) {
  const requests = [];
  globalThis.fetch = async (url, opts = {}) => {
    requests.push(`${opts.method || 'GET'} ${url.split('?')[0]}`);
    // A request can be held, as a slow network would, while the page moves on.
    if (env.gate) await env.gate;
    if (env.failNext) {
      env.failNext = false;
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    }
    const res = await call(env, opts.method || 'GET', url, opts.body ? JSON.parse(opts.body) : undefined);
    return { ok: res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(res.body) };
  };
  const record = findOwnedProject(env.db, env.alice.id, slug);
  const project = normalizeProjectConfig(JSON.parse(record.configJson), slug);
  const appState = { species: SPECIES, speciesSynonyms: new Map(), project, plants: [], features: [] };
  const restored = { config: [], features: [] };
  const undoButton = button();
  const redoButton = button();
  const status = { textContent: '', dataset: {}, removeAttribute() {} };
  const controller = createLayoutHistoryController({
    appState,
    undoButton,
    redoButton,
    historyStatus: status,
    render() {},
    refreshSpeciesTable() {},
    onRestoreConfig: (config) => {
      restored.config.push(config);
      Object.assign(project, normalizeProjectConfig(config, slug));
    },
    onRestoreFeatures: (features) => {
      restored.features.push(features);
      appState.features = normalizeFeatures(features ?? null, slug).features;
    },
  });
  const history = await loadLayoutHistory(undefined, { projectId: slug });
  appState.features = normalizeFeatures(record.featuresJson ? JSON.parse(record.featuresJson) : null, slug).features;
  appState.plants = controller.start(history, {
    config: serializeProjectConfig(project),
    features: { features: appState.features },
  });
  requests.length = 0;
  return { controller, appState, project, restored, undoButton, redoButton, status, requests };
}

const plantsAt = (xs) => xs.map((x, i) => createPlantFromSpecies(HOLLY, { id: `h${i}`, x, y: 1 }));

test('undo and redo step across plantings, setup and features, restoring only what each revision changed', async () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', {
      entries: [{ id: 'e0', timestamp: 't', description: 'first', plants: [placement('h0', 1)] }],
    });
    const page = await openPage(env, 'y');
    const { controller, appState, project, restored, undoButton, redoButton } = page;

    appState.plants = plantsAt([2]);
    controller.commit('Moved plant');
    await controller.commitSetup({ ...project, name: 'Renamed', yardFt: { width: 30, depth: 15 } });
    await controller.commitFeatures(normalizeFeatures({ features: [BED] }, 'y').features);
    await controller.idle();
    assert.deepEqual(readRevisions(env.db, id).map((r) => r.kind), ['planting', 'planting', 'setup', 'features']);
    assert.equal(projectRow(env, id).history_cursor, 3);
    assert.equal(controller.isDesynced(), false);
    assert.equal(undoButton.title, 'Undo: Saved features');

    // Undo the features save: the features come back, nothing else is touched.
    undoButton.click();
    await controller.idle();
    assert.deepEqual(restored.features, [{ features: [] }]);
    assert.equal(restored.config.length, 0);
    assert.equal(appState.plants[0].x, 2);
    assert.equal(projectRow(env, id).history_cursor, 2);
    assert.equal(JSON.parse(projectRow(env, id).features_json).features.length, 0);

    // Undo the setup save: the previous setup, and the planting stays as it was.
    undoButton.click();
    await controller.idle();
    assert.equal(restored.config.length, 1);
    assert.equal(project.name, 'Yard');
    assert.equal(project.yardFt.width, 20);
    assert.equal(appState.plants[0].x, 2, 'the planting is untouched by a setup undo');
    assert.equal(projectRow(env, id).name, 'Yard', 'the server restored the setup, name included');

    // Undo the planting: plants move, setup and features do not.
    undoButton.click();
    await controller.idle();
    assert.equal(appState.plants[0].x, 1);
    assert.equal(restored.config.length, 1);
    assert.equal(undoButton.disabled, true);

    // Redo all three.
    redoButton.click();
    redoButton.click();
    await controller.idle();
    assert.equal(project.name, 'Renamed');
    assert.equal(projectRow(env, id).history_cursor, 2);
    redoButton.click();
    await controller.idle();
    assert.equal(appState.features.length, 1);
    assert.equal(projectRow(env, id).history_cursor, 3);
    assert.equal(redoButton.disabled, true);

    // A reload sees exactly this state.
    const reloaded = await openPage(env, 'y');
    assert.equal(reloaded.project.name, 'Renamed');
    assert.equal(reloaded.appState.plants[0].x, 2);
    assert.equal(reloaded.undoButton.disabled, false);
  } finally {
    env.cleanup();
  }
});

test('a save after an undo truncates redo on both sides, and they stay aligned', async () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', {
      entries: [{ id: 'e0', timestamp: 't', description: 'first', plants: [placement('h0', 1)] }],
    });
    const { controller, appState, project, redoButton, undoButton } = await openPage(env, 'y');
    await controller.commitSetup({ ...project, name: 'One' });
    await controller.commitSetup({ ...project, name: 'Two' });
    undoButton.click();
    appState.plants = plantsAt([7]);
    controller.commit('Moved plant');
    await controller.idle();
    assert.equal(redoButton.disabled, true);
    const revisions = readRevisions(env.db, id);
    assert.deepEqual(revisions.map((r) => r.kind), ['planting', 'setup', 'planting']);
    assert.equal(JSON.parse(revisions[2].configJson).name, 'One');
    assert.equal(projectRow(env, id).history_cursor, 2);
    assert.equal(controller.isDesynced(), false);
  } finally {
    env.cleanup();
  }
});

test('an unchanged setup or features save sends nothing and records nothing', async () => {
  const env = setup();
  try {
    addYard(env, 'y', { entries: [{ id: 'e0', timestamp: 't', description: 'first', plants: [] }] });
    const { controller, project, appState, requests, undoButton } = await openPage(env, 'y');
    assert.deepEqual(await controller.commitSetup(project), { unchanged: true });
    assert.deepEqual(await controller.commitFeatures(appState.features), { unchanged: true });
    assert.deepEqual(requests, []);
    assert.equal(undoButton.disabled, true);
  } finally {
    env.cleanup();
  }
});

test('a yard with no history: the first setup save seeds revision 0 and both sides agree', async () => {
  const env = setup();
  try {
    const id = addYard(env, 'fresh');
    const { controller, project, undoButton } = await openPage(env, 'fresh');
    await controller.commitSetup({ ...project, name: 'Named' });
    await controller.idle();
    assert.equal(controller.isDesynced(), false);
    assert.equal(projectRow(env, id).history_cursor, 1);
    undoButton.click();
    await controller.idle();
    assert.equal(project.name, 'Yard');
    assert.equal(projectRow(env, id).history_cursor, 0);
  } finally {
    env.cleanup();
  }
});

test('another tab\'s save puts this one out of step: it says reload and stops offering undo', async () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', { entries: [{ id: 'e0', timestamp: 't', description: 'first', plants: [] }] });
    const { controller, appState, undoButton, status } = await openPage(env, 'y');
    // Another tab saves first.
    recordLayout(env.db, id, { id: 'other-tab', timestamp: 't', description: 'elsewhere', plants: [] });
    appState.plants = plantsAt([3]);
    controller.commit('Moved plant');
    await controller.idle();
    assert.equal(controller.isDesynced(), true);
    assert.equal(status.textContent, DESYNC_MESSAGE);
    assert.equal(undoButton.disabled, true);
    // Nothing was lost: both saves are revisions.
    assert.deepEqual(readRevisions(env.db, id).map((r) => r.id).slice(0, 2), ['e0', 'other-tab']);

    // Saves keep reaching the server while out of step; only undo is withheld.
    appState.plants = plantsAt([8]);
    controller.commit('Moved plant again');
    await controller.idle();
    assert.equal(currentPlacements(env.db, id)[0].x, 8);
    assert.equal(status.textContent, DESYNC_MESSAGE, 'the reload notice stays up');
    undoButton.click();
    await controller.idle();
    assert.equal(currentPlacements(env.db, id)[0].x, 8, 'undo does nothing while out of step');
  } finally {
    env.cleanup();
  }
});

test('a refused save is taken back off the local stack, so later saves keep their indices', async () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', { entries: [{ id: 'e0', timestamp: 't', description: 'first', plants: [] }] });
    const { controller, appState, project, undoButton } = await openPage(env, 'y');
    env.failNext = true;
    appState.plants = plantsAt([3]);
    controller.commit('Moved plant');
    await controller.idle();
    assert.equal(undoButton.disabled, true, 'the refused save is gone from the stack');
    await controller.commitSetup({ ...project, name: 'After' });
    await controller.idle();
    assert.equal(controller.isDesynced(), false);
    assert.equal(projectRow(env, id).history_cursor, 1);
  } finally {
    env.cleanup();
  }
});

test('a queued save sends what was recorded, not what the objects hold by the time it goes', async () => {
  const env = setup();
  try {
    const id = addYard(env, 'y', { entries: [{ id: 'e0', timestamp: 't', description: 'first', plants: [] }] });
    const { controller, appState, project } = await openPage(env, 'y');
    let release;
    env.gate = new Promise((resolve) => {
      release = resolve;
    });
    appState.plants = plantsAt([3]);
    controller.commit('Moved plant');
    // The page passes its one live project object, and Setup edits mutate it.
    project.name = 'Saved name';
    const setupSave = controller.commitSetup(project);
    // The next drag moves the same plant object, and a Setup edit changes the
    // project, while both requests are still waiting.
    appState.plants[0].x = 99;
    project.name = 'Unsaved name';
    release();
    env.gate = null;
    await setupSave;
    await controller.idle();
    const revisions = readRevisions(env.db, id);
    assert.equal(revisions[1].plants[0].x, 3);
    assert.equal(JSON.parse(revisions[2].configJson).name, 'Saved name');
    assert.equal(controller.isDesynced(), false);
  } finally {
    env.cleanup();
  }
});
