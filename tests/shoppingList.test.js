import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShoppingList, plannedCounts, shoppingListText } from '../src/sourcing/shoppingList.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import { insertProject } from '../server/db/projectStore.js';
import { setFavorite } from '../server/db/favoritesStore.js';
import { handleShoppingListRoutes } from '../server/routes/shoppingList.js';

const species = [
  { speciesId: 'yarrow', commonName: 'Western yarrow', botanicalName: 'Achillea millefolium', nativity: 'native' },
  { speciesId: 'cypress', commonName: 'Standing cypress', botanicalName: 'Ipomopsis rubra', nativity: 'native' },
  { speciesId: 'bluebonnet', commonName: 'Texas bluebonnet', botanicalName: 'Lupinus texensis', nativity: 'native' },
  { speciesId: 'redbud', commonName: 'Oklahoma redbud', botanicalName: "Cercis canadensis 'Oklahoma'", nativity: 'native' },
];

test('plannedCounts counts only planned plants, by species', () => {
  assert.deepEqual(
    plannedCounts([
      { id: 'a', speciesId: 'yarrow' },
      { id: 'b', speciesId: 'yarrow', status: 'planted' },
      { id: 'c', speciesId: 'yarrow', localEcotype: true },
      { id: 'd', speciesId: 'cypress', status: 'removed' }, // not a status: reads as planned
      { id: 'e' },
    ]),
    { yarrow: 2, cypress: 1 }
  );
  assert.deepEqual(plannedCounts(undefined), {});
});

const yards = [
  { id: 'back', name: 'Backyard', planned: { cypress: 5, yarrow: 2 } },
  { id: 'front', name: 'Front yard', planned: { cypress: 2, gone: 1 } },
];

test('rows total across yards with a per-yard breakdown, favorites first, then by common name', () => {
  const { rows, totalPlants } = buildShoppingList({ yards, species, favorites: ['yarrow'] });
  assert.deepEqual(
    rows.map((r) => [r.speciesId, r.total, r.favorite]),
    [
      ['yarrow', 2, true],
      ['gone', 1, false], // not in the catalog any more: still listed, under its id
      ['cypress', 7, false],
    ]
  );
  assert.deepEqual(rows[2].byYard, [
    { id: 'back', name: 'Backyard', count: 5 },
    { id: 'front', name: 'Front yard', count: 2 },
  ]);
  assert.equal(rows[2].standing, 'native');
  assert.equal(totalPlants, 10);
});

test('only the included yards count', () => {
  const { rows } = buildShoppingList({ yards, species, includedYardIds: ['front'] });
  assert.deepEqual(rows.map((r) => [r.speciesId, r.total]), [['gone', 1], ['cypress', 2]]);
  assert.deepEqual(buildShoppingList({ yards, species, includedYardIds: [] }).rows, []);
});

test('a favorite planned nowhere is wanted, not yet placed; one not in the catalog is dropped', () => {
  const { wanted } = buildShoppingList({ yards, species, favorites: ['bluebonnet', 'redbud', 'cypress', 'no-such'] });
  assert.deepEqual(wanted.map((r) => [r.speciesId, r.standing]), [['redbud', 'cultivar'], ['bluebonnet', 'native']]);
});

test('the text version lists counts, names, yards and stars', () => {
  const list = buildShoppingList({ yards, species, favorites: ['yarrow', 'bluebonnet'], includedYardIds: ['back'] });
  assert.equal(
    shoppingListText(list),
    [
      '★ 2 × Western yarrow (Achillea millefolium) — Backyard 2',
      '5 × Standing cypress (Ipomopsis rubra) — Backyard 5',
      '',
      'Wanted, not yet placed:',
      '★ Texas bluebonnet (Lupinus texensis)',
    ].join('\n')
  );
});

// --- GET /api/shopping-list --------------------------------------------------

async function get(db, user, method = 'GET') {
  const req = Readable.from([]);
  req.method = method;
  req.headers = {};
  const res = {
    statusCode: null,
    body: null,
    writeHead(status) {
      this.statusCode = status;
    },
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  const pathname = '/api/shopping-list';
  await handleShoppingListRoutes(req, res, { url: new URL(`http://localhost${pathname}`), pathname, db: { app: db }, user });
  return { status: res.statusCode, body: res.body ? JSON.parse(String(res.body)) : null };
}

test('GET /api/shopping-list: the caller’s own yards at their current revision, planned only, and their favorites', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'shopping-list-test-'));
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  try {
    const alice = upsertUser(db, 'alice@example.com');
    const bob = upsertUser(db, 'bob@example.com');
    const config = JSON.stringify({ name: 'Yard', views: [{ id: 'plan', type: 'plan' }] });
    const entry = (id, plants) => ({ id, timestamp: 't', description: id, plants });
    insertProject(db, {
      ownerId: alice.id,
      slug: 'back',
      name: 'Backyard',
      configJson: config,
      // Two revisions with the cursor on the first: the list follows the cursor.
      entries: [
        entry('e0', [{ id: 'a', speciesId: 'cypress', x: 0, y: 0 }, { id: 'b', speciesId: 'winecup', x: 0, y: 0, status: 'planted' }]),
        entry('e1', [{ id: 'c', speciesId: 'yarrow', x: 0, y: 0 }]),
      ],
      cursor: 0,
    });
    insertProject(db, { ownerId: bob.id, slug: 'bobs', name: 'Bob’s', configJson: config, entries: [entry('e0', [{ id: 'z', speciesId: 'yarrow', x: 0, y: 0 }])] });
    setFavorite(db, { userId: alice.id, speciesId: 'bluebonnet', favorite: true });

    assert.equal((await get(db, null)).status, 401);
    assert.equal((await get(db, alice, 'POST')).status, 405);
    const { status, body } = await get(db, alice);
    assert.equal(status, 200);
    assert.deepEqual(body, { yards: [{ id: 'back', name: 'Backyard', planned: { cypress: 1 } }], favorites: ['bluebonnet'] });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
