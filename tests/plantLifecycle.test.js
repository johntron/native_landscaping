// nl-3s5.22: a placement's lifecycle (planned or planted, the planting date,
// and a free-text source that may be linked to a sourcing/ row), through every
// path it travels: the editing setter, a clone, the layout CSV both ways, the
// client's rebuild from history, the drawings, the HOA letter, and the server's
// POST /api/layout -> app.db -> GET /api/history and GET /api/layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  describeSourceRef,
  isIsoDate,
  lifecycleOf,
  localIsoDate,
  resolveSourceRef,
  suggestSources,
  validateLifecycle,
} from '../src/data/plantLifecycle.js';
import { parseCsv } from '../src/data/csvLoader.js';
import { buildLayoutCsv } from '../src/data/layoutExporter.js';
import { toPlacements } from '../src/data/placements.js';
import {
  buildPlantsFromCsv,
  createPlantFromSpecies,
  parseSpeciesCsv,
  plantsFromPlacements,
} from '../src/data/plantParser.js';
import { clonePlantById, setPlantLifecycle } from '../src/state/plantEdits.js';
import { buildHoaCoverLetter, summarizePlacedSpecies } from '../src/export/hoaPacket.js';
import { renderTopView } from '../src/render/topView.js';
import { renderElevationView } from '../src/render/elevationViews.js';
import { resetDocument } from './helpers/fakeDom.js';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import { insertProject } from '../server/db/projectStore.js';
import { handleProjectRoutes } from '../server/routes/project.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PLANTS_CSV = read('plants.csv');
const DRAWING_CSV = read('plant-drawing.csv');
const species = parseSpeciesCsv(PLANTS_CSV, DRAWING_CSV);
const holly = species.find((entry) => entry.speciesId === 'yaupon-holly');
const REAL_TABLES = { nurseries: parseCsv(read('sourcing/nurseries.csv')), sales: parseCsv(read('sourcing/plant-sales.csv')) };
// Fixture rows in the sourcing/ tables' own columns: the real sale rows are
// pruned every season, so no assertion here may depend on which are listed.
const TABLES = {
  nurseries: parseCsv(
    'name,program,tier,chapter,address,city,website,notes,checked_on,source\n' +
      'Native Gardeners,NICE,premier,North Central,1 Main St,Arlington,https://native-gardeners.example/,,2026-09-23,https://example.org/\n' +
      'Eco Blossom Nursery,NICE,premier,North Central,2 Main St,Fort Worth,https://eco.example/,,2026-09-23,https://example.org/'
  ),
  sales: parseCsv(
    'organizer,event,kind,start_date,end_date,hours,access,venue,city,offers,url,notes,checked_on,source\n' +
      'NPSOT North Central Chapter,Fall Native Plant Sale,sale,2026-10-17,2026-10-17,,public,,Fort Worth,,https://example.org/sale,,2026-09-23,https://example.org/\n' +
      'Texas Discovery Gardens,Fall Plant Sale,sale,2026-09-18,2026-09-18,,members,,Dallas,,https://example.org/tdg,,2026-09-23,https://example.org/\n' +
      'Texas Discovery Gardens,Fall Plant Sale,sale,2026-09-19,2026-09-20,,public,,Dallas,,https://example.org/tdg,,2026-09-23,https://example.org/'
  ),
};

const NURSERY_REF = { table: 'nurseries', name: 'Native Gardeners' };
const SALE_REF = {
  table: 'plant-sales',
  organizer: 'NPSOT North Central Chapter',
  event: 'Fall Native Plant Sale',
  startDate: '2026-10-17',
};

test('validateLifecycle: two statuses, a real past-or-today date only when planted, a capped source', () => {
  const today = '2026-09-23';
  assert.deepEqual(validateLifecycle({}, { today }), []);
  assert.deepEqual(validateLifecycle({ status: 'planted', plantedOn: today }, { today }), []);
  assert.deepEqual(validateLifecycle({ status: 'planted', plantedOn: '' }, { today }), [], 'the date is optional');
  const refused = (fields) => validateLifecycle(fields, { today });
  assert.match(refused({ status: 'removed' }).join(), /planned or planted/);
  assert.match(refused({ status: 'planted', plantedOn: '2026-09-24' }).join(), /future/);
  assert.match(refused({ status: 'planted', plantedOn: '2026-02-29' }).join(), /real date/);
  assert.match(refused({ status: 'planned', plantedOn: '2026-09-01' }).join(), /only to a planted/);
  assert.match(refused({ source: { name: 'x'.repeat(121) } }).join(), /120/);
  assert.match(refused({ source: { name: 'x', ref: { table: 'shops', name: 'x' } } }).join(), /not one/);
  assert.equal(isIsoDate('2028-02-29'), true);
});

test('localIsoDate is the local calendar day, not the UTC one', () => {
  // 8 pm on the 23rd, local time: toISOString() would already say the 24th in Texas.
  const evening = new Date(2026, 8, 23, 20, 0, 0);
  assert.equal(localIsoDate(evening), '2026-09-23');
});

test('setPlantLifecycle: canonical, new array and plant, refusals change nothing, planned drops the date', () => {
  const plant = createPlantFromSpecies(holly, { id: 'h', x: 1, y: 2 });
  const state = { plants: [plant] };
  const today = '2026-09-23';

  const refused = setPlantLifecycle(state, 'h', { status: 'planted', plantedOn: '2027-01-01' }, { today });
  assert.equal(refused.plant, null);
  assert.match(refused.problems.join(), /future/);
  assert.equal(state.plants[0], plant, 'a refused edit leaves the plant alone');

  const planted = setPlantLifecycle(state, 'h', { status: 'planted', plantedOn: '2026-04-18' }, { today });
  assert.deepEqual(planted.problems, []);
  assert.notEqual(state.plants[0], plant);
  assert.equal(plant.status, undefined, 'the old plant object is not mutated');
  assert.deepEqual(lifecycleOf(state.plants[0]), { status: 'planted', plantedOn: '2026-04-18', source: null });
  assert.equal(state.plants[0].width, plant.width, 'species attributes are kept');

  setPlantLifecycle(state, 'h', { source: { name: ' Native  Gardeners ', ref: NURSERY_REF } }, { today });
  assert.deepEqual(state.plants[0].source, { name: 'Native Gardeners', ref: NURSERY_REF });
  assert.equal(state.plants[0].plantedOn, '2026-04-18', 'a partial edit keeps the other fields');

  const same = setPlantLifecycle(state, 'h', { status: 'planted' }, { today });
  assert.equal(same.plant, null, 'nothing changed, so nothing to commit');

  setPlantLifecycle(state, 'h', { status: 'planned' }, { today });
  assert.equal('status' in state.plants[0], false);
  assert.equal('plantedOn' in state.plants[0], false, 'planned drops the date');
  assert.equal(state.plants[0].source.name, 'Native Gardeners', 'and keeps the source');

  setPlantLifecycle(state, 'h', { source: null }, { today });
  assert.equal('source' in state.plants[0], false);
  assert.deepEqual(setPlantLifecycle(state, 'nope', { status: 'planted' }), { plant: null, problems: [] });
});

test('a clone is a new planned plant with no source, whatever it was copied from', () => {
  const plan = { id: 'plan', type: 'plan', viewBox: { width: 200, height: 100 }, extentFt: { width: 20, height: 10 }, originFt: { x: 0, y: 0 } };
  const source = { ...createPlantFromSpecies(holly, { id: 'h', x: 1, y: 1 }), status: 'planted', plantedOn: '2026-04-18', source: { name: 'Big Box #123' } };
  const state = { plants: [source], project: { views: [plan] } };
  const clone = clonePlantById(state, 'h');
  assert.deepEqual(lifecycleOf(clone), { status: 'planned', plantedOn: '', source: null });
  assert.equal(state.plants[0].status, 'planted', 'the original keeps its own');
});

test('suggestions come from sourcing/ rows, only for typed text, and never link on their own', () => {
  assert.deepEqual(suggestSources('', TABLES), []);
  assert.deepEqual(suggestSources('n', TABLES), [], 'one letter offers nothing');
  assert.deepEqual(suggestSources("neighbour's division", TABLES), [], 'text that matches nothing is fine');
  const nurseries = suggestSources('native gard', TABLES);
  assert.equal(nurseries[0].label, 'Native Gardeners');
  assert.deepEqual(nurseries[0].ref, NURSERY_REF);
  assert.match(nurseries[0].detail, /nursery, Arlington/);
  const sales = suggestSources('plant sale', TABLES);
  assert.equal(sales.length, 3);
  sales.forEach((suggestion) => {
    assert.equal(suggestion.ref.table, 'plant-sales');
    assert.ok(isIsoDate(suggestion.ref.startDate), 'a sale is named with its date');
    assert.match(suggestion.detail, /^sale, \d{4}-\d{2}-\d{2}/);
  });
  // Two rows that share organizer and event are told apart by the date.
  assert.deepEqual(suggestSources('Texas Discovery', TABLES).map((s) => s.ref.startDate), ['2026-09-18', '2026-09-19']);
});

test('every row of the real sourcing/ tables can be suggested, and resolves back to itself', () => {
  const rows = [...REAL_TABLES.nurseries.map((row) => [row, row.name]), ...REAL_TABLES.sales.map((row) => [row, row.event])];
  assert.ok(rows.length > 0);
  rows.forEach(([row, text]) => {
    const match = suggestSources(text, REAL_TABLES, { limit: Infinity }).find((s) => resolveSourceRef(s.ref, REAL_TABLES) === row);
    assert.ok(match, `no suggestion resolves to ${JSON.stringify(text)}`);
  });
});

test('a ref resolves to its row while the row is listed, and to nothing once it is pruned', () => {
  assert.equal(resolveSourceRef(NURSERY_REF, TABLES)?.city, 'Arlington');
  assert.equal(resolveSourceRef(SALE_REF, TABLES)?.event, 'Fall Native Plant Sale');
  assert.equal(resolveSourceRef({ ...SALE_REF, startDate: '2019-10-17' }, TABLES), null);
  assert.equal(resolveSourceRef(NURSERY_REF, { nurseries: [], sales: [] }), null);
  assert.equal(describeSourceRef(SALE_REF), 'NPSOT North Central Chapter: Fall Native Plant Sale (2026-10-17)');
});

test('the layout CSV carries the lifecycle out and back, and a four-column file still loads as planned', () => {
  const plants = [
    createPlantFromSpecies(holly, { id: 'a', x: 1, y: 1, status: 'planted', plantedOn: '2026-04-18', source: { name: 'Big Box #123, aisle 7' } }),
    createPlantFromSpecies(holly, { id: 'b', x: 2, y: 2, status: 'planted', source: { name: 'Native Gardeners', ref: NURSERY_REF } }),
    createPlantFromSpecies(holly, { id: 'c', x: 3, y: 3, source: { name: 'the fall sale', ref: SALE_REF } }),
    createPlantFromSpecies(holly, { id: 'd', x: 4, y: 4 }),
  ];
  const back = buildPlantsFromCsv(PLANTS_CSV, buildLayoutCsv(plants), { drawingCsv: DRAWING_CSV });
  assert.deepEqual(toPlacements(back), toPlacements(plants));

  const old = buildPlantsFromCsv(PLANTS_CSV, 'id,species_id,x_ft,y_ft\nq,yaupon-holly,1,1\n', { drawingCsv: DRAWING_CSV });
  assert.deepEqual(toPlacements(old), [{ id: 'q', speciesId: 'yaupon-holly', x: 1, y: 1 }]);
  assert.equal(lifecycleOf(old[0]).status, 'planned');
});

test('the client rebuild from history (boot, undo, redo) keeps the lifecycle', () => {
  const placements = [{ id: 'a', speciesId: 'yaupon-holly', x: 1, y: 1, status: 'planted', plantedOn: '2026-04-18', source: { name: 'n', ref: NURSERY_REF } }];
  const plants = plantsFromPlacements(placements, species);
  assert.equal(plants[0].commonName, holly.commonName);
  assert.deepEqual(toPlacements(plants), placements);
});

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  node.children.forEach((child) => findAll(child, predicate, out));
  return out;
}

const STATE = { foliageColor: '#5b8c3a', flowerColor: null, fruitColor: null, isGrowing: true, isFlowering: false, isFruiting: false };
const DORMANT = { ...STATE, foliageColor: '#9a8a6a', isGrowing: false };

test('the plan and every elevation draw a planned plant dashed and a planted one solid, with the same elements', () => {
  const plan = { id: 'plan', type: 'plan', viewBox: { width: 600, height: 600 }, originFt: { x: 0, y: 0 }, extentFt: { width: 20, height: 20 } };
  const south = { id: 'south', type: 'elevation', viewFrom: 'south', viewBox: { width: 480, height: 360 }, originFt: { x: 0, y: -4 }, extentFt: { width: 20, height: 15 } };
  const shrub = { id: 'p', commonName: 'Shrub', botanicalName: 'Ilex vomitoria', botanicalKey: 'ilex vomitoria', width: 4, height: 5, x: 5, y: 5, growthShape: 'mound' };
  const tree = { ...shrub, id: 't', growthShape: 'tree', width: 12, height: 20 };

  const shapesOf = (render, view, plant, state) => {
    const doc = resetDocument();
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    render(svg, [{ plant, state }], view);
    const group = findAll(svg, (node) => node.getAttribute?.('data-plant-id') === plant.id)[0];
    return { group, dashed: findAll(group, (node) => node.getAttribute?.('stroke-dasharray') !== null) };
  };

  for (const [render, view] of [[renderTopView, plan], [renderElevationView, south]]) {
    for (const base of [shrub, tree]) {
      for (const state of [STATE, DORMANT]) {
        const planned = shapesOf(render, view, base, state);
        const planted = shapesOf(render, view, { ...base, status: 'planted' }, state);
        const label = `${view.id} ${base.growthShape} ${state.isGrowing ? 'growing' : 'dormant'}`;
        assert.equal(planned.group.getAttribute('data-status'), 'planned', label);
        assert.equal(planted.group.getAttribute('data-status'), 'planted', label);
        assert.equal(planned.dashed.length, 1, `${label}: one dashed outline`);
        assert.equal(planted.dashed.length, 0, `${label}: none when planted`);
        assert.equal(planned.group.children.length, planted.group.children.length, `${label}: same elements either way`);
        assert.equal(planned.dashed[0].getAttribute('fill'), 'none', `${label}: the dash is on the outline, not a fill`);
      }
    }
  }
});

test('the HOA letter counts what is already planted, and keys the drawings only when something is', () => {
  const plants = [
    { ...createPlantFromSpecies(holly, { id: 'a', x: 0, y: 0 }), status: 'planted' },
    createPlantFromSpecies(holly, { id: 'b', x: 0, y: 0 }),
    createPlantFromSpecies(species.find((s) => s.speciesId === 'fragrant-sumac'), { id: 'c', x: 0, y: 0 }),
  ];
  const summary = summarizePlacedSpecies(plants);
  const byName = Object.fromEntries(summary.map((s) => [s.botanicalName, [s.count, s.plantedCount]]));
  assert.deepEqual(byName, { 'Ilex vomitoria': [2, 1], 'Rhus aromatica': [1, 0] });
  const letter = buildHoaCoverLetter({ projectName: 'Yard', species: summary, preparedOn: '2026-09-23' });
  assert.match(letter, /Ilex vomitoria\) × 2 \(1 already planted\)/);
  assert.match(letter, /outlined solid and a proposed plant is outlined dashed/);
  const none = buildHoaCoverLetter({ projectName: 'Yard', species: summarizePlacedSpecies(plants.slice(1)), preparedOn: '2026-09-23' });
  assert.doesNotMatch(none, /already planted|outlined dashed/);
});

// ---- The server round trip, through the same route handler server.js uses. ----

function makeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
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
  };
}

async function call(env, method, pathAndQuery, body) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const ctx = { url, pathname: url.pathname, dataDir: env.dataDir, db: { app: env.db }, user: env.user };
  const res = makeRes();
  const handled = await handleProjectRoutes(makeReq(method, body), res, ctx);
  assert.ok(handled, `${method} ${url.pathname} was not handled`);
  return res;
}

test('status, plantedOn and source round-trip through POST /api/layout -> app.db -> GET /api/history and GET /api/layout', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plant-lifecycle-test-'));
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  try {
    const user = upsertUser(db, 'alice@example.com');
    insertProject(db, {
      ownerId: user.id,
      slug: 'yard',
      name: 'Yard',
      configJson: JSON.stringify({ name: 'Yard', yardFt: { width: 20, depth: 15 }, views: [{ id: 'plan', type: 'plan' }] }),
      featuresJson: null,
      locationJson: null,
      entries: [],
    });
    const env = { dataDir, db, user };
    const sent = [
      { id: 'a', speciesId: 'yaupon-holly', x: 1, y: 2, status: 'planted', plantedOn: '2026-04-18', source: { name: 'Native Gardeners', ref: NURSERY_REF } },
      { id: 'b', speciesId: 'yaupon-holly', x: 3, y: 4, source: { name: 'the fall sale', ref: SALE_REF } },
      { id: 'c', speciesId: 'yaupon-holly', x: 5, y: 6, status: 'planted', source: { name: '<b>Big Box</b> #123, "aisle 7"' } },
      { id: 'd', speciesId: 'yaupon-holly', x: 7, y: 8 },
    ];
    const saved = await call(env, 'POST', '/api/layout?project=yard', { plants: sent, description: 'Marked plant planted', id: 'e1' });
    assert.equal(saved.statusCode, 200, String(saved.body));
    assert.deepEqual(JSON.parse(saved.body).entry.plants, sent);

    // What app.db itself holds, not just what the route answers.
    const row = db.prepare("SELECT plants_json FROM history_entries WHERE entry_id = 'e1'").get();
    assert.deepEqual(JSON.parse(row.plants_json), sent);

    const history = JSON.parse((await call(env, 'GET', '/api/history?project=yard')).body);
    assert.deepEqual(history.entries.at(-1).plants, sent);

    const csv = (await call(env, 'GET', '/api/layout?project=yard')).body;
    const back = buildPlantsFromCsv(PLANTS_CSV, csv, { drawingCsv: DRAWING_CSV });
    // The CSV reader drops the doubled quotes of an escaped cell (src/data/csvLoader.js),
    // so only the source with quotes in it comes back without them.
    assert.deepEqual(toPlacements(back), sent.map((p) => (p.id === 'c' ? { ...p, source: { name: '<b>Big Box</b> #123, aisle 7' } } : p)));

    // A client that posts nonsense cannot store it: the server's reduction
    // (toPlacements in makeEntry) keeps only canonical lifecycle fields.
    const junk = [{ id: 'j', speciesId: 'yaupon-holly', x: 0, y: 0, status: 'removed', plantedOn: 'tomorrow', source: { name: 'x'.repeat(300), ref: { table: 'shops' } } }];
    const cleaned = await call(env, 'POST', '/api/layout?project=yard', { plants: junk, id: 'e2' });
    assert.equal(cleaned.statusCode, 200);
    const stored = JSON.parse(db.prepare("SELECT plants_json FROM history_entries WHERE entry_id = 'e2'").get().plants_json);
    assert.deepEqual(stored, [{ id: 'j', speciesId: 'yaupon-holly', x: 0, y: 0, source: { name: 'x'.repeat(120) } }]);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
