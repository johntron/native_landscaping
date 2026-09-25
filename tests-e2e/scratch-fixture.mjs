import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openAppDb } from '../server/db/appDb.js';
import { upsertUser } from '../server/identity.js';
import { importLegacyProjects } from '../server/db/projectImport.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Throwaway yards for the e2e servers (nl-3s5.3).
 *
 * Yards live in app.db, owned by whoever made them, so each e2e server gets
 * its own app.db under its own DATA_DIR, seeded here with yards owned by the
 * one identity both servers run as (E2E_USER_EMAIL, DEV_USER_EMAIL in
 * playwright.config.js). The seeding goes through the same import the real
 * migration uses (server/db/projectImport.js), from project directories laid
 * out the old way:
 *
 * - the main (read-only) server gets the repo's tracked projects/backyard;
 * - the scratch server, for the specs that WRITE, gets one copy of backyard
 *   per spec (SCRATCH_PROJECTS), some with their own project.json, built in
 *   SCRATCH_DIR/projects. Dragging a plant saves through POST /api/layout, so
 *   each writing spec takes its own yard, and a drag in one cannot move the
 *   plants another is aiming at.
 *
 * Both live in the system temp directory rather than under test-results/,
 * which Playwright wipes at the start of every run, and are keyed by checkout
 * so two clones cannot collide.
 */
const CHECKOUT_KEY = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12);
export const SCRATCH_DIR = path.join(os.tmpdir(), `native-landscaping-e2e-${CHECKOUT_KEY}`);
// A throwaway home for app.db, so neither e2e server (playwright.config.js
// points both at a subdirectory of this, via DATA_DIR) ever opens the real
// data/app.db. Separate from SCRATCH_DIR because DATA_DIR and PUBLIC_DIR are
// independent knobs on server.js — this is not part of the served document root.
export const SCRATCH_DATA_DIR = path.join(os.tmpdir(), `native-landscaping-e2e-data-${CHECKOUT_KEY}`);
/** DATA_DIR of each e2e server; playwright.config.js passes these. */
export const MAIN_SERVER_DATA_DIR = path.join(SCRATCH_DATA_DIR, 'main');
export const SCRATCH_SERVER_DATA_DIR = path.join(SCRATCH_DATA_DIR, 'scratch');
/** The one identity both e2e servers run as, and the owner of every seeded yard. */
export const E2E_USER_EMAIL = 'e2e@example.com';
export const SCRATCH_PROJECTS = [
  'drag-plan',
  'drag-elevation',
  'drag-locked',
  'plant-add',
  'plant-remove',
  'plant-undo',
  'plant-redo',
  'touch-plan',
  'touch-hold',
  'touch-elevation',
  'background-upload',
  'placed-photo',
  'features-save',
  'features-edit',
  'features-derived',
  'yard-conflict',
  'frontyard-save',
  'ecology-check',
  'second-yard',
  'setup-undo',
  'plant-lifecycle',
];

/**
 * `placed-photo` is a backyard copy whose plan photograph covers only PART of
 * the yard, and sits off its origin.
 *
 * That is the case a view can no longer be reshaped to hide. A view's rectangle
 * comes from the yard, so a photo that does not cover the yard is drawn at
 * whatever size it does cover, wherever it was placed — which the CSS has to
 * express as a background-size under 100% with a position outside 0–100%.
 * Exercised in a browser because that is the only place the CSS runs.
 *
 * Kept out of projects/example-frontyard on purpose: that one is editable in
 * the app, and one Setup Save rewrote it and broke the suite (nl-2p3).
 */
const PLACED_PHOTO = {
  id: 'placed-photo',
  name: 'placed-photo',
  yardFt: { width: 20, depth: 15 },
  paddingFt: 2,
  elevationFt: { above: 10, below: 2 },
  pxPerFt: 27,
  views: [
    {
      id: 'plan',
      type: 'plan',
      background: 'img/top.webp',
      // 10 x 7.5 ft of a 20 x 15 ft yard, its corner 5 ft in from the origin.
      photoFt: { originFt: { x: 5, y: 5 }, extentFt: { width: 10, height: 7.5 } },
    },
    { id: 'south', type: 'elevation', viewFrom: 'south' },
  ],
};

/**
 * `features-derived` is a backyard copy at its own yard size, used to check
 * that a newly added feature lands inside EVERY view.
 *
 * The bug it was written for — elevations framed on a narrower slice of yard
 * than the plan, so a shape placed by the plan was off-canvas in every
 * elevation — is no longer expressible: the views are derived from one yard.
 * The test stays as the guard that the derivation actually holds.
 */
const FEATURES_DERIVED = {
  id: 'features-derived',
  name: 'features-derived',
  yardFt: { width: 20, depth: 15 },
  paddingFt: 2,
  elevationFt: { above: 8, below: 1 },
  pxPerFt: 27,
  views: [
    { id: 'plan', type: 'plan', background: 'img/top.webp' },
    { id: 'south', type: 'elevation', viewFrom: 'south' },
    { id: 'east', type: 'elevation', viewFrom: 'east' },
  ],
};

/**
 * `yard-conflict` is a backyard copy declaring a yard far smaller than the one
 * its planting was drawn in — 12 x 9 ft against plants spread over roughly
 * 29 x 22 — so several of them are off the property the moment it loads.
 *
 * That is the one way a declared yard can still strand something: no VIEW can
 * miss the yard, but the yard is a number a person can type below what is
 * standing in it, and a plant already outside cannot be dragged back. Its own
 * project because resolving the conflict WRITES the layout.
 */
const YARD_CONFLICT = {
  id: 'yard-conflict',
  name: 'yard-conflict',
  yardFt: { width: 12, depth: 9 },
  paddingFt: 2,
  elevationFt: { above: 10, below: 2 },
  pxPerFt: 27,
  views: [
    { id: 'plan', type: 'plan', background: 'img/top.webp' },
    { id: 'south', type: 'elevation', viewFrom: 'south' },
  ],
};

/**
 * `frontyard-save` carries example-frontyard's shape — a tall narrow yard, four
 * views, and photographs placed rather than fitted — because that is what a
 * Setup-mode Save was found to flatten (nl-jqd). Copied here rather than tested
 * in place: the real project is live data the running app writes to.
 *
 * It declares an ecoregion and a site for the same reason it declares photo
 * placements: both are optional fields that two separate whitelists (the client
 * serializer and the server's own re-serialization) could drop on save, and this
 * project is where a Save is put under the microscope.
 */
const FRONTYARD_SAVE_VIEWS = {
  id: 'frontyard-save',
  name: 'frontyard-save',
  ecoregion: '9',
  site: { sun: 'part-sun', water: 'medium', soil: 'clay' },
  yardFt: { width: 10, depth: 30 },
  paddingFt: 2,
  elevationFt: { above: 12, below: 2 },
  pxPerFt: 20,
  views: [
    {
      id: 'plan',
      type: 'plan',
      photoFt: { originFt: { x: 0, y: 0 }, extentFt: { width: 10, height: 30 } },
      background: 'img/top.webp',
    },
    {
      id: 'north',
      type: 'elevation',
      viewFrom: 'north',
      photoFt: { originFt: { x: 0, y: -7.14 }, extentFt: { width: 10.63, height: 15.94 } },
      background: 'img/south.webp',
    },
    {
      id: 'west',
      type: 'elevation',
      viewFrom: 'east',
      sublabel: 'Looking west',
      photoFt: { originFt: { x: 0, y: -3.2 }, extentFt: { width: 14.35, height: 10.33 } },
      background: 'img/east.webp',
    },
    { id: 'view', type: 'elevation', viewFrom: 'south' },
  ],
};

/**
 * Seed a fresh app.db under `dataDir` with `slugs` from `projectsDir`, owned
 * by E2E_USER_EMAIL. The import records its marker, so nothing re-imports.
 */
function seedAppDb(dataDir, projectsDir, slugs) {
  mkdirSync(dataDir, { recursive: true });
  const db = openAppDb({ dataDir, ownerEmail: '', importLegacy: false });
  try {
    upsertUser(db, E2E_USER_EMAIL);
    importLegacyProjects(db, { projectsDir, dataDir, ownerEmail: E2E_USER_EMAIL, slugs });
  } finally {
    db.close();
  }
}

/** A yard's copy of backyard, without anything that is not seed data. */
function copyBackyard(target) {
  cpSync(path.join(REPO_ROOT, 'projects', 'backyard'), target, {
    recursive: true,
    // A dev tree's backyard also holds its gitignored live history, backups
    // and exact location; none of that belongs in a test yard.
    filter: (src) => !/(?:location\.json|layout-history\.json(?:\.bak-.*)?|\.bak-[^/]*)$/.test(src),
  });
}

/**
 * Read a seeded yard's row straight from a server's app.db (read-only), for
 * the specs that assert on exactly what was stored: the config text, the
 * photo directory. Everything else goes through the API.
 *
 * @param {string} dataDir MAIN_SERVER_DATA_DIR or SCRATCH_SERVER_DATA_DIR
 * @param {string} slug
 */
export function readSeededProject(dataDir, slug) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT p.id, p.config_json, p.features_json FROM projects p JOIN users u ON u.id = p.owner_id
         WHERE u.email = ? AND p.slug = ?`
      )
      .get(E2E_USER_EMAIL, slug);
    if (!row) throw new Error(`No seeded yard "${slug}" in ${dataDir}`);
    return {
      id: Number(row.id),
      config: JSON.parse(row.config_json),
      features: row.features_json ? JSON.parse(row.features_json) : null,
      imgDir: path.join(dataDir, 'projects', String(row.id), 'img'),
    };
  } finally {
    db.close();
  }
}

/** Files the app is served from; symlinked so the specs test the real source. */
// `ecology` carries host-genera.csv. Without it the scratch root 404s that
// fetch and the three genus-dependent checks silently report "not declared" —
// a spec asserting on them would fail for the wrong reason. `catalog` carries
// species-synonyms.csv, which design.html fetches on boot (nl-3s5.18); without
// it every scratch page logs a 404 and fails the "boots clean" assertions.
const LINKED = [
  'index.html',
  'design.html',
  'styles.css',
  'patch-network.css',
  'ecosystem.css',
  'favicon.svg',
  'src',
  'plants.csv',
  'plant-drawing.csv', // how each species is drawn (nl-3s5.21); design.html refuses to boot without it
  'ecology',
  'catalog',
  'sourcing', // nurseries and plant sales, offered as a plant's source in the detail sheet (nl-3s5.22)
  'node_modules',
];

export function buildScratchPublicDir() {
  // Playwright loads the config once per worker as well as in the main process.
  // Only the main process — the one that starts the servers — builds the fixture;
  // eight workers racing on the same rm/mkdir/symlink is a fixture that tears
  // itself apart mid-run.
  if (process.env.TEST_WORKER_INDEX !== undefined) return SCRATCH_DIR;

  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  mkdirSync(path.join(SCRATCH_DIR, 'projects'), { recursive: true });

  rmSync(SCRATCH_DATA_DIR, { recursive: true, force: true });
  mkdirSync(SCRATCH_DATA_DIR, { recursive: true });

  LINKED.forEach((entry) => {
    const target = path.join(REPO_ROOT, entry);
    if (existsSync(target)) symlinkSync(target, path.join(SCRATCH_DIR, entry));
  });

  SCRATCH_PROJECTS.forEach((id) => copyBackyard(path.join(SCRATCH_DIR, 'projects', id)));

  // backyard now carries a real features.json (the passionflower trellis), but
  // features.spec.js relies on drag-plan — a plain backyard copy — to still be a
  // project that has never drawn a feature, so its copy loses that file.
  rmSync(path.join(SCRATCH_DIR, 'projects', 'drag-plan', 'features.json'), { force: true });

  // Written after the copy so it replaces the backyard project.json cpSync laid down.
  writeFileSync(
    path.join(SCRATCH_DIR, 'projects', 'placed-photo', 'project.json'),
    `${JSON.stringify(PLACED_PHOTO, null, 2)}\n`
  );

  writeFileSync(
    path.join(SCRATCH_DIR, 'projects', 'features-derived', 'project.json'),
    `${JSON.stringify(FEATURES_DERIVED, null, 2)}\n`
  );

  writeFileSync(
    path.join(SCRATCH_DIR, 'projects', 'yard-conflict', 'project.json'),
    `${JSON.stringify(YARD_CONFLICT, null, 2)}\n`
  );

  writeFileSync(
    path.join(SCRATCH_DIR, 'projects', 'frontyard-save', 'project.json'),
    `${JSON.stringify(FRONTYARD_SAVE_VIEWS, null, 2)}\n`
  );

  // Read, never written, by the project-switching spec: a yard shaped unlike
  // backyard (four views, a tall narrow yard), under its own name so a Setup
  // save in setupSave.spec.js cannot change what it asserts on.
  writeFileSync(
    path.join(SCRATCH_DIR, 'projects', 'second-yard', 'project.json'),
    `${JSON.stringify({ ...FRONTYARD_SAVE_VIEWS, id: 'second-yard', name: 'second-yard' }, null, 2)}\n`
  );

  // The main server's yards: the repo's tracked example, backyard, copied
  // first so the seed never reads anything else the dev tree holds.
  const mainProjects = path.join(SCRATCH_DATA_DIR, 'main-projects');
  copyBackyard(path.join(mainProjects, 'backyard'));
  seedAppDb(MAIN_SERVER_DATA_DIR, mainProjects, ['backyard']);
  seedAppDb(SCRATCH_SERVER_DATA_DIR, path.join(SCRATCH_DIR, 'projects'), SCRATCH_PROJECTS);

  return SCRATCH_DIR;
}
