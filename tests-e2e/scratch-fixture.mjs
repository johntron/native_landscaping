import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A throwaway document root for the specs that WRITE.
 *
 * Dragging a plant saves through POST /api/layout, so a drag spec pointed at
 * the repo would rewrite projects/backyard/planting_layout.csv on every run.
 * These specs get their own copy of the yard instead. It lives in the system
 * temp directory rather than under test-results/, which Playwright wipes at the
 * start of every run, and is keyed by checkout so two clones cannot collide.
 *
 * Each writing spec takes its own project so a drag in one cannot move the
 * plants another is aiming at.
 */
const CHECKOUT_KEY = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12);
export const SCRATCH_DIR = path.join(os.tmpdir(), `native-landscaping-e2e-${CHECKOUT_KEY}`);
export const SCRATCH_PROJECTS = [
  'drag-plan',
  'drag-elevation',
  'drag-locked',
  'plant-add',
  'plant-remove',
  'plant-undo',
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

/** Files the app is served from; symlinked so the specs test the real source. */
// `ecology` carries host-genera.csv. Without it the scratch root 404s that
// fetch and the three genus-dependent checks silently report "not declared" —
// a spec asserting on them would fail for the wrong reason.
const LINKED = [
  'index.html',
  'design.html',
  'styles.css',
  'favicon.svg',
  'src',
  'plants.csv',
  'ecology',
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

  LINKED.forEach((entry) => {
    const target = path.join(REPO_ROOT, entry);
    if (existsSync(target)) symlinkSync(target, path.join(SCRATCH_DIR, entry));
  });

  SCRATCH_PROJECTS.forEach((id) => {
    cpSync(path.join(REPO_ROOT, 'projects', 'backyard'), path.join(SCRATCH_DIR, 'projects', id), {
      recursive: true,
    });
  });

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

  writeFileSync(
    path.join(SCRATCH_DIR, 'projects', 'index.json'),
    `${JSON.stringify(
      {
        defaultProject: SCRATCH_PROJECTS[0],
        projects: SCRATCH_PROJECTS.map((id) => ({ id, name: id })),
      },
      null,
      2
    )}\n`
  );

  return SCRATCH_DIR;
}
