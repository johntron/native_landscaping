// The shared, read-only example yard (nl-3s5.24): how it is built, refreshed
// and copied. Where it is looked up and who may read it is
// server/db/projectStore.js (findExampleProject) and server/http.js
// (loadReadableProject / loadWritableProject).
//
// The example is a SEPARATE yard, never the owner's own: a system user
// (EXAMPLE_OWNER_EMAIL) owns it under the slug 'example', with
// location_json NULL and one revision, the source's state at its cursor. It
// comes from one of two places:
//
// - the startup seed (seedExampleYardIfMissing, called by server.js): when no
//   example exists yet, from the tracked projects/backyard files in the code's
//   own tree. A fresh checkout, the e2e servers and a first deploy all get an
//   example without anyone running anything. It never overwrites one.
// - tools/refresh-example-yard.mjs (snapshotFromOwnerYard + writeExampleYard):
//   re-copies from the owner's live backyard in app.db, when the owner wants.
//
// Either way the copy is stripped of location: the projects row's
// location_json is never read, and every key that names a place on the earth
// (lat/lng/address/..., at any depth, in the config, the features and the
// placements) is dropped, then checked for again before anything is written.
// Foot coordinates (x/y, originFt, viewerAtFt) are positions in the yard and
// are kept.
//
// Photos: only the ones the copied config names are copied (the owner's img/
// also holds .xcf working files), staged beside the target and swapped in
// after the database commit, so a failed write leaves the old example whole.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProjectConfig, serializeProjectConfig } from '../../src/data/projectConfig.js';
import { normalizeFeatures, serializeFeatures } from '../../src/data/featureConfig.js';
import { resolveProjectPhoto } from '../../src/data/projectPaths.js';
import { toPlacements } from '../../src/data/placements.js';
import { findOwner } from './legacyImport.js';
import { readLegacyProject } from './projectImport.js';
import {
  EXAMPLE_OWNER_EMAIL,
  EXAMPLE_SLUG,
  RESERVED_SLUGS,
  findExampleProject,
  findOwnedProject,
  insertProject,
  projectDataDir,
  readRevision,
  readRevisions,
  withTransaction,
} from './projectStore.js';

/** app_meta key recording when the example was last written, and from what. */
export const EXAMPLE_META_KEY = 'example_yard';

/** The example's picker label and config name. */
export const EXAMPLE_NAME = 'Example yard';

/** The tracked seed, resolved from this file so it is the running code's own copy. */
export const DEFAULT_SEED_DIR = fileURLToPath(new URL('../../projects/backyard', import.meta.url));

/** The one revision the example holds, and a copy's first revision. */
export const EXAMPLE_REVISION_DESCRIPTION = 'Copied from the owner’s yard';
export const COPIED_REVISION_DESCRIPTION = 'Copied from the example yard';

/** A copy's name, so the picker never shows two entries both called EXAMPLE_NAME. */
export const COPY_NAME = 'My copy of the example yard';

/**
 * Keys that name a place on the earth rather than a spot in the yard. Matched
 * case-insensitively against every object key at any depth.
 */
const GEO_KEY = /^(lat|lng|lon|long|latitude|longitude|address|location|coords?|coordinates|geo[a-z_]*|gps[a-z_]*|position_?geo)$/i;

/** Every path at which `value` holds a geo key (see GEO_KEY). Empty means none. */
export function findGeoKeys(value, at = '$') {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((inner, i) => found.push(...findGeoKeys(inner, `${at}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (GEO_KEY.test(key)) found.push(`${at}.${key}`);
      found.push(...findGeoKeys(inner, `${at}.${key}`));
    }
  }
  return found;
}

/** A deep copy of `value` with every geo key dropped. */
export function stripGeo(value) {
  if (Array.isArray(value)) return value.map(stripGeo);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!GEO_KEY.test(key)) out[key] = stripGeo(inner);
    }
    return out;
  }
  return value;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** The `background` paths a serialized config names (views[].background). */
function backgroundPaths(config) {
  return [...new Set((config.views || []).map((view) => view.background).filter(Boolean))];
}

/**
 * Normalize, strip and verify one yard's state as the example (or a copy of
 * it) will store it. Throws if anything location-like survives, rather than
 * writing it.
 *
 * @param {{ slug: string, name: string, configJson: string, featuresJson: string | null,
 *   plants: object[], imgDir: string }} source
 * @returns {{ configJson: string, featuresJson: string | null, plantsJson: string,
 *   photos: Array<{ name: string, file: string, sha256: string }>, missingPhotos: string[] }}
 */
export function buildYardSnapshot({ slug, name, configJson, featuresJson, plants, imgDir }) {
  const config = serializeProjectConfig(
    normalizeProjectConfig({ ...stripGeo(JSON.parse(configJson)), id: slug, name }, slug)
  );
  const features =
    featuresJson === null || featuresJson === undefined
      ? null
      : serializeFeatures(normalizeFeatures(stripGeo(JSON.parse(featuresJson)), slug));
  const placements = stripGeo(toPlacements(plants));

  const leaks = [
    ...findGeoKeys(config).map((p) => `config ${p}`),
    ...findGeoKeys(features).map((p) => `features ${p}`),
    ...findGeoKeys(placements).map((p) => `plants ${p}`),
  ];
  if (leaks.length) throw new Error(`Refusing to write a yard that still names a location: ${leaks.join(', ')}`);

  const photos = [];
  const missingPhotos = [];
  for (const relative of backgroundPaths(config)) {
    const file = resolveProjectPhoto(imgDir ? path.dirname(imgDir) : '', relative);
    if (!file || !existsSync(file)) {
      missingPhotos.push(relative);
      continue;
    }
    photos.push({ name: path.basename(file), file, sha256: sha256(readFileSync(file)) });
  }

  return {
    configJson: `${JSON.stringify(config, null, 2)}\n`,
    featuresJson: features === null ? null : `${JSON.stringify(features, null, 2)}\n`,
    plantsJson: JSON.stringify(placements),
    photos,
    missingPhotos,
  };
}

/** The revision a yard shows now, as { plants, configJson, featuresJson }. */
function stateAtCursor(db, project) {
  const revision = project.historyCursor >= 0 ? readRevision(db, project.id, project.historyCursor) : null;
  return revision
    ? { plants: revision.plants, configJson: revision.configJson, featuresJson: revision.featuresJson, revision }
    : { plants: [], configJson: project.configJson, featuresJson: project.featuresJson, revision: null };
}

/**
 * The owner's live yard, read (never written) and turned into the example's
 * snapshot, with where it came from.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dataDir: string, ownerEmail?: string, slug?: string }} options
 */
export function snapshotFromOwnerYard(db, { dataDir, ownerEmail, slug = 'backyard' }) {
  const owner = findOwner(db, ownerEmail);
  if (!owner) {
    throw new Error(
      ownerEmail
        ? `No user ${ownerEmail} in app.db`
        : 'Whose yard? Pass --owner <email> or set OWNER_EMAIL (app.db does not have exactly one admin)'
    );
  }
  if (owner.email === EXAMPLE_OWNER_EMAIL) throw new Error('The example cannot be refreshed from itself');
  const source = findOwnedProject(db, owner.id, slug);
  if (!source) throw new Error(`No yard "${slug}" for ${owner.email} in app.db`);
  const state = stateAtCursor(db, source);
  const snapshot = buildYardSnapshot({
    slug: EXAMPLE_SLUG,
    name: EXAMPLE_NAME,
    configJson: state.configJson,
    featuresJson: state.featuresJson,
    plants: state.plants,
    imgDir: path.join(projectDataDir(dataDir, source.id), 'img'),
  });
  return {
    snapshot,
    // No owner email here: app_meta is read by anyone with the database, and
    // the owner's row id is all a later refresh needs to say "the same yard".
    provenance: {
      from: 'app.db',
      ownerId: owner.id,
      projectId: source.id,
      slug: source.slug,
      revision: state.revision ? { seq: source.historyCursor, id: state.revision.id, timestamp: state.revision.timestamp } : null,
    },
    revisionTimestamp: state.revision?.timestamp ?? source.updatedAt,
  };
}

/** The tracked projects/backyard files, turned into the example's snapshot. */
export function snapshotFromSeedFiles(seedDir = DEFAULT_SEED_DIR) {
  const legacy = readLegacyProject(path.dirname(seedDir), path.basename(seedDir));
  // readLegacyProject parses a location.json if the directory has one (a dev
  // tree's gitignored copy); its text is never used here.
  const entry = legacy.cursor >= 0 ? legacy.entries[legacy.cursor] : null;
  const snapshot = buildYardSnapshot({
    slug: EXAMPLE_SLUG,
    name: EXAMPLE_NAME,
    configJson: legacy.configText,
    featuresJson: legacy.featuresText,
    plants: entry ? entry.plants : [],
    imgDir: path.join(seedDir, 'img'),
  });
  return {
    snapshot,
    provenance: { from: 'seed', path: path.relative(path.resolve(seedDir, '../..'), seedDir) },
    revisionTimestamp: entry?.timestamp ?? new Date(0).toISOString(),
  };
}

/** What the example holds now, in the snapshot's shape, for the unchanged check. */
function currentExampleState(db, dataDir, example) {
  const revisions = readRevisions(db, example.id);
  const photos = {};
  const imgDir = path.join(projectDataDir(dataDir, example.id), 'img');
  if (existsSync(imgDir)) {
    for (const name of readdirSync(imgDir)) photos[name] = sha256(readFileSync(path.join(imgDir, name)));
  }
  return {
    revisions: revisions.length,
    cursor: example.historyCursor,
    name: example.name,
    configJson: example.configJson,
    featuresJson: example.featuresJson,
    locationJson: example.locationJson,
    plantsJson: revisions[0] ? JSON.stringify(revisions[0].plants) : null,
    revisionConfigJson: revisions[0]?.configJson ?? null,
    revisionFeaturesJson: revisions[0]?.featuresJson ?? null,
    photos,
  };
}

function isUnchanged(current, snapshot) {
  const wantPhotos = Object.fromEntries(snapshot.photos.map((p) => [p.name, p.sha256]));
  return (
    current.revisions === 1 &&
    current.cursor === 0 &&
    current.name === EXAMPLE_NAME &&
    current.locationJson === null &&
    current.configJson === snapshot.configJson &&
    current.featuresJson === snapshot.featuresJson &&
    current.revisionConfigJson === snapshot.configJson &&
    current.revisionFeaturesJson === snapshot.featuresJson &&
    current.plantsJson === snapshot.plantsJson &&
    JSON.stringify(Object.entries(current.photos).sort()) === JSON.stringify(Object.entries(wantPhotos).sort())
  );
}

/** The system owner's user id, created (never an admin) if missing. The caller holds the transaction. */
function ensureExampleOwner(db) {
  db.prepare(
    `INSERT INTO users (email, is_admin, created_at) VALUES (?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET is_admin = 0`
  ).run(EXAMPLE_OWNER_EMAIL, new Date().toISOString());
  return Number(db.prepare('SELECT id FROM users WHERE email = ?').get(EXAMPLE_OWNER_EMAIL).id);
}

/** Copy `photos` into a fresh directory and check every byte. */
function stagePhotos(photos, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const photo of photos) {
    const dest = path.join(dir, photo.name);
    copyFileSync(photo.file, dest);
    if (sha256(readFileSync(dest)) !== photo.sha256) throw new Error(`Photo ${photo.name} did not copy byte for byte`);
  }
}

/**
 * Write `snapshot` as the example: create it (and its system owner) if
 * missing, otherwise update the SAME row in place, so its id, and with it its
 * photo directory and any open tab's ?project=example, never change. One
 * transaction for the rows (the projects row, its one revision, the app_meta
 * record); photos staged before it and swapped in after it.
 *
 * Idempotent: when the example already holds exactly this snapshot, nothing
 * is written at all (status 'unchanged', updated_at untouched).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dataDir: string, snapshot: ReturnType<typeof buildYardSnapshot>, provenance: object,
 *   revisionTimestamp: string, dryRun?: boolean, now?: string }} options
 * @returns {{ status: 'created' | 'updated' | 'unchanged' | 'would-create' | 'would-update',
 *   projectId: number | null, photos: string[], missingPhotos: string[], plants: number }}
 */
export function writeExampleYard(db, { dataDir, snapshot, provenance, revisionTimestamp, dryRun = false, now = new Date().toISOString() }) {
  const existing = findExampleProject(db);
  const summary = {
    photos: snapshot.photos.map((p) => p.name),
    missingPhotos: snapshot.missingPhotos,
    plants: JSON.parse(snapshot.plantsJson).length,
  };
  if (existing && isUnchanged(currentExampleState(db, dataDir, existing), snapshot)) {
    return { status: 'unchanged', projectId: existing.id, ...summary };
  }
  if (dryRun) return { status: existing ? 'would-update' : 'would-create', projectId: existing?.id ?? null, ...summary };

  const staging = path.join(dataDir, 'projects', `.example-staging-${process.pid}`);
  stagePhotos(snapshot.photos, staging);
  let projectId;
  try {
    projectId = withTransaction(db, () => {
      const ownerId = ensureExampleOwner(db);
      let id = findOwnedProject(db, ownerId, EXAMPLE_SLUG)?.id;
      if (!id) {
        id = insertProject(db, {
          ownerId,
          slug: EXAMPLE_SLUG,
          name: EXAMPLE_NAME,
          configJson: snapshot.configJson,
          featuresJson: snapshot.featuresJson,
          now,
        });
      }
      db.prepare('DELETE FROM history_entries WHERE project_id = ?').run(id);
      db.prepare(
        `INSERT INTO history_entries
           (project_id, seq, entry_id, description, plants_json, created_at, kind, config_json, features_json)
         VALUES (?, 0, ?, ?, ?, ?, 'planting', ?, ?)`
      ).run(
        id,
        `example-${sha256(Buffer.from(snapshot.plantsJson + snapshot.configJson + (snapshot.featuresJson ?? ''))).slice(0, 12)}`,
        EXAMPLE_REVISION_DESCRIPTION,
        snapshot.plantsJson,
        revisionTimestamp,
        snapshot.configJson,
        snapshot.featuresJson
      );
      db.prepare(
        `UPDATE projects SET name = ?, visibility = 'private', config_json = ?, features_json = ?,
           location_json = NULL, history_cursor = 0, updated_at = ? WHERE id = ?`
      ).run(EXAMPLE_NAME, snapshot.configJson, snapshot.featuresJson, now, id);
      db.prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(EXAMPLE_META_KEY, JSON.stringify({ refreshedAt: now, ...provenance, photos: summary.photos }), now);
      return id;
    });
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  // Swap the staged photos in. The old directory is moved aside first and
  // only removed once the new one is in place.
  const imgDir = path.join(projectDataDir(dataDir, projectId), 'img');
  mkdirSync(path.dirname(imgDir), { recursive: true });
  const old = `${imgDir}.old-${process.pid}`;
  if (existsSync(imgDir)) renameSync(imgDir, old);
  renameSync(staging, imgDir);
  rmSync(old, { recursive: true, force: true });

  return { status: existing ? 'updated' : 'created', projectId, ...summary };
}

/**
 * Server startup: seed the example from the tracked files when there is none
 * yet. Never overwrites an existing example (that is the refresh tool's job),
 * and never throws: a missing or unreadable seed costs the example, not the
 * server.
 *
 * @returns {{ status: string, error?: string }}
 */
export function seedExampleYardIfMissing(db, { dataDir, seedDir = DEFAULT_SEED_DIR } = {}) {
  try {
    if (findExampleProject(db)) return { status: 'present' };
    if (!existsSync(path.join(seedDir, 'project.json'))) return { status: 'no-seed' };
    const { snapshot, provenance, revisionTimestamp } = snapshotFromSeedFiles(seedDir);
    return writeExampleYard(db, { dataDir, snapshot, provenance, revisionTimestamp });
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

/** A slug for a copy, free in the owner's namespace and never a reserved one. */
function freeCopySlug(db, ownerId, base = 'example-yard') {
  for (let n = 1; n < 1000; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!RESERVED_SLUGS.includes(slug) && !findOwnedProject(db, ownerId, slug)) return slug;
  }
  throw new Error('No free name for the copy');
}

/**
 * "Copy to my yards": the example, as a new private yard of `ownerId`'s with
 * a fresh slug and one revision, plus its photos. Rolled back (row and
 * directory) if the photos fail to copy.
 *
 * @returns {{ slug: string, projectId: number }}
 */
export function copyExampleToOwner(db, { dataDir, ownerId, now = new Date().toISOString() }) {
  const example = findExampleProject(db);
  if (!example) {
    const err = new Error('There is no example yard to copy');
    err.code = 'NO_EXAMPLE';
    throw err;
  }
  const state = stateAtCursor(db, example);
  const exampleImg = path.join(projectDataDir(dataDir, example.id), 'img');

  const { slug, projectId, snapshot } = withTransaction(db, () => {
    const slug = freeCopySlug(db, ownerId);
    const snapshot = buildYardSnapshot({
      slug,
      name: COPY_NAME,
      configJson: state.configJson,
      featuresJson: state.featuresJson,
      plants: state.plants,
      imgDir: exampleImg,
    });
    const projectId = insertProject(db, {
      ownerId,
      slug,
      name: COPY_NAME,
      configJson: snapshot.configJson,
      featuresJson: snapshot.featuresJson,
      entries: [
        {
          id: `copied-example-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          timestamp: now,
          description: COPIED_REVISION_DESCRIPTION,
          plants: JSON.parse(snapshot.plantsJson),
        },
      ],
      cursor: 0,
      now,
    });
    return { slug, projectId, snapshot };
  });

  const target = path.join(projectDataDir(dataDir, projectId), 'img');
  try {
    stagePhotos(snapshot.photos, target);
  } catch (err) {
    rmSync(projectDataDir(dataDir, projectId), { recursive: true, force: true });
    withTransaction(db, () => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId));
    throw err;
  }
  return { slug, projectId };
}
