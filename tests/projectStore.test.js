// nl-3s5.3: yards in app.db. The store (server/db/projectStore.js) and the
// project routes over it (server/routes/project.js): every route resolves
// ?project=<slug> among the CALLER's yards, a save is one transaction, and a
// photo is served only to its yard's owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import {
  findOwnedProject,
  insertProject,
  moveHistoryCursor,
  projectDataDir,
  projectIndexFor,
  readHistory,
  recordLayout,
  currentPlacements,
} from '../server/db/projectStore.js';
import { handleProjectRoutes } from '../server/routes/project.js';
import { handleEcosystemRoutes } from '../server/routes/ecosystem.js';

const CONFIG = { name: 'Yard', yardFt: { width: 20, depth: 15 }, views: [{ id: 'plan', type: 'plan', background: 'img/top.webp' }] };
const placement = (id, x) => ({ id, speciesId: 'yaupon-holly', x, y: 1 });

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'project-store-test-'));
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  const alice = upsertUser(db, 'alice@example.com');
  const bob = upsertUser(db, 'bob@example.com');
  const cleanup = () => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, db, alice, bob, cleanup };
}

function addYard(db, owner, slug, extra = {}) {
  return insertProject(db, { ownerId: owner.id, slug, name: slug, configJson: JSON.stringify(CONFIG), ...extra });
}

/** A request the route handlers can read a body from. */
function makeReq(method, body, headers = { 'content-type': 'application/json' }) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = headers;
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers || {});
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body, cb) {
      this.body = body;
      if (typeof cb === 'function') cb();
    },
    json() {
      return JSON.parse(String(this.body));
    },
  };
}

async function call(env, user, method, pathAndQuery, body, headers) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const ctx = { url, pathname: url.pathname, dataDir: env.dataDir, db: { app: env.db }, user };
  const res = makeRes();
  const handled = await handleProjectRoutes(makeReq(method, body, headers), res, ctx);
  assert.equal(handled, true, `${method} ${pathAndQuery} was handled`);
  return res;
}

// --- the store ---------------------------------------------------------------

test('slugs are unique per owner, not globally', () => {
  const env = setup();
  try {
    addYard(env.db, env.alice, 'backyard');
    addYard(env.db, env.bob, 'backyard');
    assert.throws(() => addYard(env.db, env.alice, 'backyard'), /UNIQUE/);
    assert.notEqual(findOwnedProject(env.db, env.alice.id, 'backyard').id, findOwnedProject(env.db, env.bob.id, 'backyard').id);
    assert.deepEqual(projectIndexFor(env.db, env.alice.id), { defaultProject: 'backyard', projects: [{ id: 'backyard', name: 'backyard' }] });
    assert.deepEqual(projectIndexFor(env.db, 999), { defaultProject: null, projects: [] });
  } finally {
    env.cleanup();
  }
});

test('recordLayout drops the redo tail and appends, and the layout is the entry at the cursor', () => {
  const env = setup();
  try {
    const id = addYard(env.db, env.alice, 'y');
    assert.deepEqual(readHistory(env.db, id), { entries: [], cursor: -1 });
    assert.deepEqual(currentPlacements(env.db, id), []);

    // A new yard's first save carries previousPlants: [] and gets an Initial entry.
    const first = recordLayout(env.db, id, { id: 'a', timestamp: 't1', description: 'add', plants: [placement('p', 1)] }, []);
    assert.equal(first.cursor, 1);
    recordLayout(env.db, id, { id: 'b', timestamp: 't2', description: 'move', plants: [placement('p', 2)] }, undefined);
    assert.equal(readHistory(env.db, id).entries.length, 3);

    moveHistoryCursor(env.db, id, 1);
    assert.deepEqual(currentPlacements(env.db, id), [placement('p', 1)]);
    const after = recordLayout(env.db, id, { id: 'c', timestamp: 't3', description: 'other', plants: [placement('p', 9)] }, undefined);
    assert.equal(after.cursor, 2);
    const history = readHistory(env.db, id);
    assert.deepEqual(history.entries.map((e) => e.id), ['a-initial', 'a', 'c'], 'the redo tail is gone');
    assert.equal(history.entries[1].timestamp, 't1');
    assert.throws(() => moveHistoryCursor(env.db, id, 3), /Invalid cursor/);
    assert.throws(() => moveHistoryCursor(env.db, id, -1), /Invalid cursor/);
  } finally {
    env.cleanup();
  }
});

test('two saves from two tabs both land, in order, with no torn write', () => {
  const env = setup();
  try {
    const id = addYard(env.db, env.alice, 'y', { entries: [{ id: 'e0', timestamp: 't', description: 'x', plants: [] }] });
    // Two tabs at the same cursor: each save is its own transaction, so both are kept.
    recordLayout(env.db, id, { id: 'tab-a', timestamp: 't', description: 'a', plants: [placement('a', 1)] }, undefined);
    recordLayout(env.db, id, { id: 'tab-b', timestamp: 't', description: 'b', plants: [placement('b', 1)] }, undefined);
    const history = readHistory(env.db, id);
    assert.deepEqual(history.entries.map((e) => e.id), ['e0', 'tab-a', 'tab-b']);
    assert.equal(history.cursor, 2);
  } finally {
    env.cleanup();
  }
});

test('a failed write leaves nothing behind', () => {
  const env = setup();
  try {
    const id = addYard(env.db, env.alice, 'y');
    // entry_id is NOT NULL: this insert fails after the DELETE and the Initial insert ran.
    assert.throws(() => recordLayout(env.db, id, { id: null, timestamp: 't', description: 'd', plants: [] }, []));
    assert.deepEqual(readHistory(env.db, id), { entries: [], cursor: -1 });
    // And the connection is usable afterwards (no transaction left open).
    recordLayout(env.db, id, { id: 'ok', timestamp: 't', description: 'd', plants: [] }, undefined);
    assert.equal(readHistory(env.db, id).entries.length, 1);
  } finally {
    env.cleanup();
  }
});

// --- the routes: ownership ---------------------------------------------------

test('every project route is 401 anonymous and the same 404 for a missing yard and someone else\'s', async () => {
  const env = setup();
  try {
    addYard(env.db, env.bob, 'bobs-yard');
    const routes = [
      ['GET', '/api/project'],
      ['POST', '/api/project', { views: [] }],
      ['GET', '/api/history'],
      ['GET', '/api/layout'],
      ['POST', '/api/layout', { plants: [] }],
      ['POST', '/api/history/cursor', { cursor: 0 }],
      ['GET', '/api/features'],
      ['POST', '/api/features', { features: [] }],
      ['GET', '/api/project-photo', undefined, '&path=img/top.webp'],
      ['POST', '/api/view-background', Buffer.from('x'), '&view=plan', { 'content-type': 'image/webp' }],
    ];
    for (const [method, route, body, extra = '', headers] of routes) {
      const anon = await call(env, null, method, `${route}?project=bobs-yard${extra}`, body, headers);
      assert.equal(anon.statusCode, 401, `${method} ${route} anonymous`);
      const theirs = await call(env, env.alice, method, `${route}?project=bobs-yard${extra}`, body, headers);
      const missing = await call(env, env.alice, method, `${route}?project=no-such-yard${extra}`, body, headers);
      assert.equal(theirs.statusCode, 404, `${method} ${route} someone else's`);
      assert.equal(missing.statusCode, 404, `${method} ${route} missing`);
      assert.equal(theirs.body, missing.body, `${method} ${route}: the two 404s are indistinguishable`);
    }
    const list = await call(env, null, 'GET', '/api/projects');
    assert.equal(list.statusCode, 401);
    assert.deepEqual((await call(env, env.alice, 'GET', '/api/projects')).json(), { defaultProject: null, projects: [] });
  } finally {
    env.cleanup();
  }
});

test('the owner reads and saves through the routes', async () => {
  const env = setup();
  try {
    const created = await call(env, env.alice, 'POST', '/api/projects', { id: 'new-yard', name: 'New yard' });
    assert.equal(created.statusCode, 200);
    assert.deepEqual(created.json().index.projects, [{ id: 'new-yard', name: 'New yard' }]);
    assert.equal((await call(env, env.alice, 'POST', '/api/projects', { id: 'new-yard' })).statusCode, 400);
    // Bob can make his own yard with the same slug.
    assert.equal((await call(env, env.bob, 'POST', '/api/projects', { id: 'new-yard' })).statusCode, 200);

    const config = (await call(env, env.alice, 'GET', '/api/project?project=new-yard')).json();
    assert.equal(config.name, 'New yard');
    const renamed = await call(env, env.alice, 'POST', '/api/project?project=new-yard', { ...config, name: 'Renamed' });
    assert.equal(renamed.statusCode, 200);
    assert.deepEqual(renamed.json().index.projects, [{ id: 'new-yard', name: 'Renamed' }], 'the picker label moves with the config');

    const saved = await call(env, env.alice, 'POST', '/api/layout?project=new-yard', {
      plants: [{ ...placement('h1', 1.23456), commonName: 'stripped' }],
      previousPlants: [],
      description: 'add',
    });
    // The rename was the yard's first save: it seeded revision 0 (the yard as
    // created) and became revision 1, so the layout is revision 2 (nl-3s5.20).
    assert.equal(saved.json().cursor, 2);
    const history = (await call(env, env.alice, 'GET', '/api/history?project=new-yard')).json();
    assert.deepEqual(history.entries.map((e) => e.kind), ['planting', 'setup', 'planting']);
    assert.deepEqual(history.entries[2].plants, [placement('h1', 1.23456)]);
    const csv = await call(env, env.alice, 'GET', '/api/layout?project=new-yard');
    assert.match(csv.headers['Content-Type'], /text\/csv/);
    assert.equal(csv.body, 'id,species_id,x_ft,y_ft\nh1,yaupon-holly,1.235,1.000\n');
    const rewound = await call(env, env.alice, 'POST', '/api/history/cursor?project=new-yard', { cursor: 0 });
    assert.deepEqual(rewound.json().entry.plants, []);
    assert.equal(rewound.json().entry.config.name, 'New yard', 'revision 0 is the yard before the rename');
    assert.deepEqual(
      (await call(env, env.alice, 'GET', '/api/projects')).json().projects,
      [{ id: 'new-yard', name: 'New yard' }],
      'undoing the rename restores the picker label too'
    );

    assert.deepEqual((await call(env, env.alice, 'GET', '/api/features?project=new-yard')).json(), { features: [] });
    assert.equal((await call(env, env.alice, 'POST', '/api/features?project=new-yard', {})).statusCode, 400);
    // Bob's same-slug yard is untouched by all of that.
    const bobs = findOwnedProject(env.db, env.bob.id, 'new-yard');
    assert.deepEqual(readHistory(env.db, bobs.id), { entries: [], cursor: -1 });
    assert.equal(bobs.name, 'new-yard');
  } finally {
    env.cleanup();
  }
});

test('photos are served from DATA_DIR to the owner only, with only photo paths allowed', async () => {
  const env = setup();
  try {
    const id = addYard(env.db, env.alice, 'y');
    const img = join(projectDataDir(env.dataDir, id), 'img');
    mkdirSync(img, { recursive: true });
    writeFileSync(join(img, 'top.webp'), 'RIFF....WEBPdata');
    writeFileSync(join(img, 'top.xcf'), 'gimp');
    const ok = await call(env, env.alice, 'GET', '/api/project-photo?project=y&path=img/top.webp');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['Content-Type'], 'image/webp');
    assert.equal(ok.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(ok.headers['Content-Security-Policy'], /sandbox/);
    for (const bad of ['img/top.xcf', '../1/img/top.webp', 'img/missing.webp', '']) {
      const res = await call(env, env.alice, 'GET', `/api/project-photo?project=y&path=${encodeURIComponent(bad)}`);
      assert.equal(res.statusCode, 404, bad);
    }
    assert.equal((await call(env, env.bob, 'GET', '/api/project-photo?project=y&path=img/top.webp')).statusCode, 404);
  } finally {
    env.cleanup();
  }
});

test('an upload lands in the yard\'s photo directory under DATA_DIR', async () => {
  const env = setup();
  try {
    const id = addYard(env.db, env.alice, 'y');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);
    const res = await call(env, env.alice, 'POST', '/api/view-background?project=y&view=plan', webp, { 'content-type': 'image/webp' });
    assert.equal(res.statusCode, 200, res.body);
    const { background } = res.json();
    assert.match(background, /^img\/plan-[0-9a-f]{12}\.webp$/);
    assert.deepEqual(readdirSync(join(projectDataDir(env.dataDir, id), 'img')), [background.slice(4)]);
  } finally {
    env.cleanup();
  }
});

test('/api/ecosystem gives a yard\'s coordinates to its owner only', async () => {
  const env = setup();
  try {
    addYard(env.db, env.alice, 'y', { locationJson: JSON.stringify({ lat: 32.5, lng: -96.5, address: 'somewhere' }) });
    const ecosystemDb = { prepare: () => ({ all: () => [] }) };
    const ask = async (user) => {
      const url = new URL('http://localhost/api/ecosystem?place=home&project=y');
      const res = makeRes();
      await handleEcosystemRoutes(makeReq('GET'), res, {
        url,
        pathname: url.pathname,
        db: { app: env.db, ecosystem: ecosystemDb },
        user,
      });
      return res;
    };
    assert.deepEqual((await ask(env.alice)).json().location, { lat: 32.5, lng: -96.5 }, 'no address, ever');
    // Someone else's yard, or no caller: the project routes' 404 and 401 (nl-3s5.4).
    assert.equal((await ask(env.bob)).statusCode, 404);
    assert.equal((await ask(null)).statusCode, 401);
  } finally {
    env.cleanup();
  }
});
