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
  'detail-crop',
  'features-save',
  'features-edit',
  'features-narrow',
  'frontyard-save',
];

/**
 * `detail-crop` is a backyard copy plus a fourth view: a detail callout that
 * borrows and crops the plan's photo. The crop assertions used to run against
 * projects/example-frontyard, which the user also edits in the app — one Setup
 * Save dropped its fourth view and broke the suite (nl-2p3). The fixture owns
 * this geometry now, so ordinary use of the app cannot fail the test.
 *
 * 27 px/ft throughout, matching backyard, so every view stays uniformly scaled.
 */
const DETAIL_CROP_VIEWS = {
  id: 'detail-crop',
  name: 'detail-crop',
  views: [
    {
      id: 'plan',
      type: 'plan',
      viewBox: { width: 800, height: 600 },
      extentFt: { width: 800 / 27, height: 600 / 27 },
      background: 'img/top.webp',
    },
    {
      id: 'street-bed',
      type: 'plan',
      label: 'Street bed',
      sublabel: 'Detail',
      viewBox: { width: 270, height: 180 },
      originFt: { x: 5, y: 5 },
      extentFt: { width: 10, height: 180 / 27 },
      backgroundFrom: 'plan',
    },
  ],
};

/**
 * `features-narrow` is a backyard copy whose elevations show a NARROW slice of
 * the yard rather than all of it — the plan covers 20 x 15 ft, the elevations
 * reach only x 5..15 and y 5..12. That mismatch is what made a newly added
 * feature land wholly off-canvas in every elevation while looking fine in the
 * plan, so the fixture owns the geometry that reproduces it.
 *
 * 27 px/ft throughout, matching backyard, so every view stays uniformly scaled.
 */
const NARROW_VIEWS = {
  id: 'features-narrow',
  name: 'features-narrow',
  views: [
    {
      id: 'plan',
      type: 'plan',
      viewBox: { width: 540, height: 405 },
      extentFt: { width: 20, height: 15 },
      background: 'img/top.webp',
    },
    {
      id: 'south',
      type: 'elevation',
      viewFrom: 'south',
      viewBox: { width: 270, height: 216 },
      originFt: { x: 5, y: 0 },
      extentFt: { width: 10, height: 8 },
    },
    {
      id: 'east',
      type: 'elevation',
      viewFrom: 'east',
      viewBox: { width: 189, height: 216 },
      originFt: { x: 5, y: 0 },
      extentFt: { width: 7, height: 8 },
    },
  ],
};

/**
 * `frontyard-save` carries example-frontyard's geometry — negative originFt.y on
 * two elevations, a non-zero origin on the plan — because that is the shape a
 * Setup-mode Save was found to flatten (nl-jqd). Copied here rather than tested
 * in place: the real project is live data the running app writes to.
 */
const FRONTYARD_SAVE_VIEWS = {
  "id": "frontyard-save",
  "name": "frontyard-save",
  "views": [
    {
      "id": "plan",
      "type": "plan",
      "viewBox": {
        "width": 597.8492882559476,
        "height": 606.153576354689
      },
      "originFt": {
        "x": 2,
        "y": 14.833316758684116
      },
      "extentFt": {
        "width": 29.89246441279738,
        "height": 30.30767881773445
      }
    },
    {
      "id": "north",
      "type": "elevation",
      "viewFrom": "north",
      "viewBox": {
        "width": 212.54018979232524,
        "height": 318.81028468848785
      },
      "originFt": {
        "x": 0,
        "y": -7.1365343829237
      },
      "extentFt": {
        "width": 10.627009489616261,
        "height": 15.940514234424391
      }
    },
    {
      "id": "west",
      "type": "elevation",
      "viewFrom": "east",
      "sublabel": "Looking west",
      "viewBox": {
        "width": 286.97952432851844,
        "height": 206.62525751653328
      },
      "originFt": {
        "x": 0,
        "y": -3.196864496043244
      },
      "extentFt": {
        "width": 14.348976216425921,
        "height": 10.331262875826663
      }
    },
    {
      "id": "view",
      "type": "elevation",
      "viewBox": {
        "width": 249.92136631408937,
        "height": 187.44102473556703
      },
      "extentFt": {
        "width": 9.37205123677835,
        "height": 7.029038427583763
      },
      "viewFrom": "south",
      "originFt": {
        "x": 0,
        "y": 0
      }
    }
  ]
};

/** Files the app is served from; symlinked so the specs test the real source. */
const LINKED = ['index.html', 'styles.css', 'favicon.svg', 'src', 'plants.csv', 'node_modules'];

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
    path.join(SCRATCH_DIR, 'projects', 'detail-crop', 'project.json'),
    `${JSON.stringify(DETAIL_CROP_VIEWS, null, 2)}\n`
  );

  writeFileSync(
    path.join(SCRATCH_DIR, 'projects', 'features-narrow', 'project.json'),
    `${JSON.stringify(NARROW_VIEWS, null, 2)}\n`
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
