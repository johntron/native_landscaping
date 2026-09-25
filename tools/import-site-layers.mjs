#!/usr/bin/env node
/**
 * One-time move (nl-3s5.31) of the owner's site rows out of the public repo
 * and into the per-yard cache: the `place` rows of the retired committed
 * tables ecology/anchors.csv and ecology/nearby-fauna.csv become the
 * 'streams', 'greenspace' and 'fauna' layers (tools/ecosystemIndexDb.js) of
 * every yard of one owner that is at the same site: the same location
 * fingerprint and the same place label as the --project yard. That is how
 * the nl-3s5.6 rekey treated the yards sharing the backyard's location.
 *
 * The CSVs are gone from HEAD, so the rows are read from git (`--from <rev>`,
 * default the last commit that still had them) or from files given
 * explicitly. Each layer is recorded 'ready' for the yard's CURRENT location
 * with the CSV's own fetched_on, so the queue does not refetch what was just
 * moved, and a yard that later moves drops them like any other layer.
 *
 * Idempotent: a layer already ready at this location with exactly these rows
 * is left alone; a layer ready at this location with DIFFERENT rows (a real
 * fetch since) is left alone too unless --force, since the fetch is newer.
 * Never prints a location.
 *
 * Usage (DATA_DIR picks the data directory, as for every tool):
 *   node tools/import-site-layers.mjs --project backyard [--owner <email>] --dry-run
 *   node tools/import-site-layers.mjs --project backyard [--owner <email>]
 *   node tools/import-site-layers.mjs --project backyard [--owner <email>] --verify
 * Options:
 *   --place <label>        CSV rows to move (default: the --project yard's place label)
 *   --from <git rev>       where to read the CSVs (default: DEFAULT_FROM_REV)
 *   --anchors-csv <path>   read anchors from this file instead of git
 *   --fauna-csv <path>     read nearby fauna from this file instead of git
 *   --force                replace a layer that differs even if it is already ready
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';
import { openAppDbReadOnly, findYard, ownerFromArgs } from './projectSite.mjs';
import { parseLocation } from '../server/db/projectStore.js';
import { exampleIndexSource, listOwnerProjectSites } from '../server/db/projectSites.js';
import {
  anchorLayerOf,
  importLayer,
  layerStatus,
  listProjectAnchors,
  listProjectFauna,
  locationKey,
  openEcosystemDb,
} from './ecosystemIndexDb.js';
import { argAfter, isEntryPoint } from './siteLayerShared.mjs';
import { handleEcosystemRoutes } from '../server/routes/ecosystem.js';
import { EXAMPLE_SLUG } from '../server/db/projectStore.js';
import { groupAnchors } from '../src/analysis/anchors.js';
import { buildNearbyFaunaIndex } from '../src/analysis/faunaMatches.js';

/** The last commit on main whose tree still holds the committed site rows (nl-3s5.31's parent). */
export const DEFAULT_FROM_REV = '341283c41b3d1b7926eb655e46c2c98b253069fa';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAYERS = ['streams', 'greenspace', 'fauna'];

/** Read a file at a git revision of this repository. */
function gitShow(rev, path) {
  return execFileSync('git', ['show', `${rev}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The CSV rows for one place, split into the three layers, in the shape
 * replaceLayerRows takes.
 *
 * @param {{ anchorsCsv: string, faunaCsv: string, place: string }} input
 * @returns {Record<'streams'|'greenspace'|'fauna', object[]>}
 */
export function layersFromCsv({ anchorsCsv, faunaCsv, place }) {
  const wanted = String(place || '').trim();
  if (!wanted) throw new Error('A place label is required to pick the rows to move');
  const layers = { streams: [], greenspace: [], fauna: [] };
  for (const row of parseCsv(anchorsCsv || '')) {
    if (String(row.place || '').trim() !== wanted) continue;
    layers[anchorLayerOf(row.kind)].push({
      kind: row.kind,
      name: row.name,
      status: row.status,
      distance_mi: Number(row.distance_mi),
      detail: row.detail || '',
      fetched_on: row.fetched_on,
      source: row.source,
    });
  }
  for (const row of parseCsv(faunaCsv || '')) {
    if (String(row.place || '').trim() !== wanted) continue;
    layers.fauna.push({
      iconic_taxon: row.iconic_taxon,
      animal_species: row.animal_species,
      animal_common: row.animal_common || '',
      nearest_radius_mi: Number(row.nearest_radius_mi),
      observation_count: Number(row.observation_count) || 0,
      establishment_means: row.establishment_means || '',
      fetched_on: row.fetched_on,
      source: row.source,
    });
  }
  return layers;
}

/** A stable, comparable form of one layer's rows, whichever side they came from. */
export function canonicalLayer(layer, rows) {
  const pick =
    layer === 'fauna'
      ? (r) => [r.iconic_taxon, r.animal_species, r.animal_common || '', Number(r.nearest_radius_mi), Number(r.observation_count) || 0, r.establishment_means || '', r.fetched_on, r.source]
      : (r) => [r.kind, r.name, r.status, Number(r.distance_mi), r.detail || '', r.fetched_on, r.source];
  return rows.map((r) => JSON.stringify(pick(r))).sort();
}

function storedLayer(db, projectId, layer) {
  if (layer === 'fauna') return listProjectFauna(db, projectId);
  return listProjectAnchors(db, projectId).filter((row) => row.layer === layer);
}

function sameRows(layer, a, b) {
  const x = canonicalLayer(layer, a);
  const y = canonicalLayer(layer, b);
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

/**
 * The yards the rows go to: every yard of the source yard's owner with the
 * same location fingerprint and the same place label as the source yard.
 *
 * @returns {{ place: string, key: string, targets: Array<{ id: number, slug: string }> }}
 */
export function resolveTargets(appDb, slug, { ownerEmail, place } = {}) {
  const source = findYard(appDb, slug, { ownerEmail });
  const key = locationKey(parseLocation(source));
  if (!key) throw new Error(`Yard "${slug}" has no location; set one before importing its site rows`);
  let label = place;
  if (!label) {
    try {
      label = String(JSON.parse(source.configJson)?.place || '').trim();
    } catch {
      label = '';
    }
  }
  if (!label) throw new Error(`Yard "${slug}" declares no place label; pass --place`);
  const targets = listOwnerProjectSites(appDb, source.ownerId)
    .filter((site) => site.place === label && locationKey(site.location) === key)
    .map((site) => ({ id: site.id, slug: site.slug }));
  return { place: label, key, targets };
}

/**
 * Plan (and unless dryRun, apply) the import for every target and layer.
 *
 * @returns {Array<{ projectId: number, slug: string, layer: string, rows: number, action: 'import'|'unchanged'|'kept-newer'|'replace'|'no-rows' }>}
 */
export function importSiteLayers({ ecosystemDb, targets, key, layers, dryRun = false, force = false }) {
  const plan = [];
  for (const target of targets) {
    for (const layer of LAYERS) {
      const rows = layers[layer];
      const fetchedOn = rows.map((row) => row.fetched_on).filter(Boolean).sort().pop() || null;
      const status = layerStatus(ecosystemDb, target.id, layer, key);
      const stored = status.rowsApply ? storedLayer(ecosystemDb, target.id, layer) : [];
      let action = 'import';
      // No rows for a layer is not "fetched and found nothing": leave that
      // layer to the queue rather than record an empty build it never ran.
      if (!rows.length) action = 'no-rows';
      else if (status.rowsApply && status.state === 'ready') {
        if (sameRows(layer, stored, rows)) action = 'unchanged';
        else action = force ? 'replace' : 'kept-newer';
      }
      plan.push({ projectId: target.id, slug: target.slug, layer, rows: rows.length, action });
      if (dryRun || action !== 'import' && action !== 'replace') continue;
      importLayer(ecosystemDb, target.id, layer, key, rows, { fetchedOn });
    }
  }
  return plan;
}

/**
 * Read back what each target serves and compare it with the CSV rows.
 * @returns {Array<{ projectId: number, slug: string, layer: string, state: string, identical: boolean, stored: number, expected: number }>}
 */
export function verifySiteLayers({ ecosystemDb, targets, key, layers }) {
  const out = [];
  for (const target of targets) {
    for (const layer of LAYERS) {
      const status = layerStatus(ecosystemDb, target.id, layer, key);
      const stored = status.rowsApply ? storedLayer(ecosystemDb, target.id, layer) : [];
      out.push({
        projectId: target.id,
        slug: target.slug,
        layer,
        state: status.state,
        identical: status.rowsApply && sameRows(layer, stored, layers[layer]),
        stored: stored.length,
        expected: layers[layer].length,
      });
    }
  }
  return out;
}

/** One GET through the real route handler, as `user`, with no server and no network. */
async function routeGet(appDb, ecosystemDb, user, pathAndQuery) {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const res = {
    statusCode: null,
    body: '',
    headersSent: false,
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  const req = { method: 'GET', headers: {} };
  const ctx = { url, pathname: url.pathname, db: { app: appDb, ecosystem: ecosystemDb }, user };
  await handleEcosystemRoutes(req, res, ctx);
  return { status: res.statusCode, body: res.statusCode === 200 ? JSON.parse(String(res.body)) : null };
}

/**
 * The before/after check, through the same route and the same pure readers the
 * pages use: for each target yard as its owner, and for the example as a
 * signed-in stranger, /api/ecosystem/site must serve exactly the CSV rows, and
 * what the "Habitat nearby" section and the design tool's fauna index build from
 * them must match what they built from the CSV. The stranger must get 404 for
 * the owner's own yards.
 *
 * @returns {Promise<Array<{ who: string, project: string, status: number, anchors: string, fauna: string, sameAsCsv: boolean }>>}
 */
export async function verifyThroughRoute({ appDb, ecosystemDb, ownerId, targets, layers, exampleSourceId }) {
  const csvAnchors = [...layers.streams, ...layers.greenspace];
  const expected = {
    anchors: canonicalLayer('streams', csvAnchors),
    fauna: canonicalLayer('fauna', layers.fauna),
    groups: groupAnchors(csvAnchors),
    faunaSize: buildNearbyFaunaIndex(layers.fauna).size,
  };
  const check = (who, project, { status, body }) => {
    if (status !== 200) return { who, project, status, anchors: '-', fauna: '-', sameAsCsv: false };
    const groups = groupAnchors(body.anchors);
    const sameAnchors = JSON.stringify(canonicalLayer('streams', body.anchors)) === JSON.stringify(expected.anchors);
    const sameFauna = JSON.stringify(canonicalLayer('fauna', body.fauna)) === JSON.stringify(expected.fauna);
    const sameView =
      groups.anchors.length === expected.groups.anchors.length &&
      groups.candidates.length === expected.groups.candidates.length &&
      groups.fetchedOn === expected.groups.fetchedOn &&
      buildNearbyFaunaIndex(body.fauna).size === expected.faunaSize;
    return {
      who,
      project,
      status,
      anchors: `${groups.anchors.length} streams + ${groups.candidates.length} green space`,
      fauna: `${body.fauna.length} rows`,
      sameAsCsv: sameAnchors && sameFauna && sameView && !('location' in body),
    };
  };
  const owner = { id: ownerId, email: 'owner@verify.invalid', isAdmin: false };
  const stranger = { id: -1, email: 'stranger@verify.invalid', isAdmin: false };
  const out = [];
  for (const target of targets) {
    const q = `/api/ecosystem/site?project=${encodeURIComponent(target.slug)}`;
    out.push(check('owner', target.slug, await routeGet(appDb, ecosystemDb, owner, q)));
    const refused = await routeGet(appDb, ecosystemDb, stranger, q);
    out.push({ who: 'stranger', project: target.slug, status: refused.status, anchors: '-', fauna: '-', sameAsCsv: refused.status === 404 });
  }
  if (exampleSourceId && targets.some((t) => t.id === exampleSourceId)) {
    out.push(check('stranger', EXAMPLE_SLUG, await routeGet(appDb, ecosystemDb, stranger, `/api/ecosystem/site?project=${EXAMPLE_SLUG}`)));
  }
  return out;
}

function readInputs(args) {
  const rev = argAfter(args, '--from') || DEFAULT_FROM_REV;
  const anchorsPath = argAfter(args, '--anchors-csv');
  const faunaPath = argAfter(args, '--fauna-csv');
  return {
    rev,
    anchorsCsv: anchorsPath ? readFileSync(anchorsPath, 'utf8') : gitShow(rev, 'ecology/anchors.csv'),
    faunaCsv: faunaPath ? readFileSync(faunaPath, 'utf8') : gitShow(rev, 'ecology/nearby-fauna.csv'),
    from: anchorsPath || faunaPath ? 'files' : `git ${rev}`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const slug = argAfter(args, '--project');
  if (!slug) {
    console.error(
      'Usage: node tools/import-site-layers.mjs --project <slug> [--owner <email>] [--place <label>] [--from <rev>] ' +
        '[--anchors-csv <path>] [--fauna-csv <path>] [--dry-run | --verify] [--force]'
    );
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');
  const force = args.includes('--force');

  const appDb = openAppDbReadOnly();
  let resolved;
  let exampleSource;
  let ownerId;
  try {
    resolved = resolveTargets(appDb, slug, { ownerEmail: ownerFromArgs(args), place: argAfter(args, '--place') || undefined });
    exampleSource = exampleIndexSource(appDb);
    ownerId = findYard(appDb, slug, { ownerEmail: ownerFromArgs(args) }).ownerId;
  } catch (err) {
    appDb.close();
    throw err;
  }
  const { place, key, targets } = resolved;
  const inputs = readInputs(args);
  const layers = layersFromCsv({ anchorsCsv: inputs.anchorsCsv, faunaCsv: inputs.faunaCsv, place });
  console.log(
    `Rows for place "${place}" from ${inputs.from}: ${layers.streams.length} stream(s), ` +
      `${layers.greenspace.length} green space, ${layers.fauna.length} fauna`
  );
  console.log(`Yards at the same site: ${targets.map((t) => `${t.slug} (#${t.id})`).join(', ') || 'none'}`);
  if (exampleSource) {
    const shared = targets.some((t) => t.id === exampleSource.id);
    console.log(
      `The example yard reads yard #${exampleSource.id}'s rows${shared ? ', which is one of these' : ', which is NOT one of these'}.`
    );
  }

  const ecosystemDb = openEcosystemDb();
  try {
    if (verify) {
      const stored = verifySiteLayers({ ecosystemDb, targets, key, layers });
      console.log('Stored rows against the CSV:');
      console.table(stored);
      const served = await verifyThroughRoute({
        appDb,
        ecosystemDb,
        ownerId,
        targets,
        layers,
        exampleSourceId: exampleSource?.id,
      });
      console.log('What /api/ecosystem/site serves, and what the pages build from it, against the CSV:');
      console.table(served);
      const ok = stored.every((r) => r.identical) && served.every((r) => r.sameAsCsv);
      console.log(ok ? 'VERIFIED: identical before and after.' : 'NOT VERIFIED: see the rows marked false.');
      if (!ok) process.exitCode = 1;
      return;
    }
    const plan = importSiteLayers({ ecosystemDb, targets, key, layers, dryRun, force });
    console.table(plan);
    console.log(dryRun ? 'Dry run: nothing written.' : 'Done. Check with --verify.');
  } finally {
    ecosystemDb.close();
    appDb.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
