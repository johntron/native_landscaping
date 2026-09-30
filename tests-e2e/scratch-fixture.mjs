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
  'plant-drift', // the Add plant sheet's "How many?", count > 1 (nl-o47.6.3)
  'plant-drift-one', // same sheet, count 1: still no driftId (nl-o47.6.3)
  'touch-plan',
  'touch-hold',
  'touch-elevation',
  'touch-tap-select', // tap-to-select and tap-on-empty-clears (nl-o47.2)
  'touch-nudge', // the selection action bar's nudge arrows and undo (nl-o47.2)
  'touch-undo-in-bar', // the primary row's own Undo, reachable with no Done, selection survives it (nl-o47.4)
  'touch-maximize', // maximized-panel drag scale (nl-o47.1), its own yard so a concurrent touch-plan drag cannot race it
  'touch-letterbox', // same bug, with the pre-fix CSS shear forced back on to isolate the JS mapping fix
  'touch-editor', // the phone editor itself: scroll lock, tabs, Plants sheet, month buttons, Fit, Done (nl-o47.4)
  'touch-editor-zoom', // pinch-zoom then tap-select + drag, undo, and a one-finger pan with nothing selected (nl-o47.4)
  'touch-editor-zoom-drift', // same, but a drift: tap/outline/group-drag still resolve correctly once zoomed in (nl-o47.4)
  // Select/isolate/resize a pre-seeded drift (nl-o47.6.2): each gets DRIFT_LAYOUT_CSV
  // (see below), a 4-member winecup drift with a wide gap between members so a
  // "between members" tap/click cannot also land within any one member's own
  // hit radius, plus one unrelated plant far away. One project per test that
  // WRITES (drag/count/spread save through POST /api/layout); the
  // read-only selection assertions share their own 'select' project.
  'touch-drift-select',
  'touch-drift-drag',
  'touch-drift-count',
  'touch-drift-spread',
  'desktop-drift-select',
  'desktop-drift-drag',
  'desktop-drift-count',
  'desktop-drift-spread',
  // A single lone plant (SINGLE_PLANT_LAYOUT_CSV, below): "+" on it makes a
  // drift of 2, "-" brings it back (nl-o47.6.9). One project per test that
  // writes.
  'desktop-drift-convert',
  'touch-drift-convert',
  // One planting status per drift (nl-o47.6.10): DRIFT_LAYOUT_CSV's own
  // 4-member winecup drift, writable.
  'desktop-drift-lifecycle',
  'touch-drift-lifecycle',
  // The species table's per-drift entries and the plan's single grouped
  // label (nl-o47.6.7): each gets SPECIES_DRIFT_LAYOUT_CSV, below. Read-only
  // (clicking a drift entry selects/highlights but never writes), but the
  // custom layout only exists on the scratch server, so these still open
  // through openScratchProject like every other drift fixture here.
  'desktop-drift-species',
  'touch-drift-species',
  // Suggest drifts from an existing yard (nl-o47.6.5): DRIFT_SUGGEST_LAYOUT_CSV
  // (two undrifted same-species masses, writable) and
  // DRIFT_SUGGEST_MIXED_LAYOUT_CSV (one mass whose members disagree in
  // lifecycle, its own project so that test needs no Skip to reach it).
  'desktop-drift-suggest',
  'touch-drift-suggest',
  'desktop-drift-suggest-mixed',
  // Group selected plants into a drift by hand (nl-o47.6.4): DRIFT_GROUP_LAYOUT_CSV
  // (one lone plant, two more same-species undrifted, one different species)
  // and DRIFT_GROUP_MOVE_LAYOUT_CSV (a member of an existing 2-plant drift a
  // tap can pull in, with a mixed lifecycle), below.
  'desktop-drift-group',
  'touch-drift-group',
  'desktop-drift-group-move',
  'touch-drift-group-move',
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
  'location-set',
  'habitat-nearby', // seeded with fake per-yard anchors by habitatNearby.spec.js (nl-3s5.31)
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
/**
 * A pre-seeded drift for nl-o47.6.2's selection/isolation/resize specs: 4
 * winecup plants at the corners of a 6x6 ft square (12,8)-(18,8)-(18,14)-
 * (12,14), so the centroid (15,11) and every corner-to-corner gap are 6 ft
 * apart — comfortably clear of MIN_HITBOX_RADIUS_PX's few feet even at a
 * phone's smaller page scale, so a tap/click "between members" cannot also
 * land inside any one member's own hit radius. One unrelated horseherb plant
 * sits far off in a corner, for "outside the outline" and "this plant is not
 * in the drift" cases. Written over each DRIFT_PROJECTS id's copied
 * planting_layout.csv (backyard's own yard shape, 29.63 x 22.22 ft, is
 * plenty of room around a drift this size).
 */
const DRIFT_LAYOUT_CSV = [
  'id,species_id,x_ft,y_ft,drift_id',
  'drift-a,winecup,12,8,winecup-drift',
  'drift-b,winecup,18,8,winecup-drift',
  'drift-c,winecup,12,14,winecup-drift',
  'drift-d,winecup,18,14,winecup-drift',
  'lone-plant,horseherb,4,4,',
].join('\n');

/** Every scratch project seeded with DRIFT_LAYOUT_CSV instead of backyard's own planting. */
const DRIFT_PROJECTS = [
  'touch-drift-select',
  'touch-drift-drag',
  'touch-drift-count',
  'touch-drift-spread',
  'desktop-drift-select',
  'desktop-drift-drag',
  'desktop-drift-count',
  'desktop-drift-spread',
  'touch-editor-zoom-drift',
  'desktop-drift-lifecycle',
  'touch-drift-lifecycle',
];

/**
 * One lone plant, well clear of the yard's edges, for "+" on a single plant
 * (nl-o47.6.9's count conversion): plain enough that the count stepper's
 * default 1-member fallback (driftGeometry.js's nextMemberPosition, tried in
 * all four cardinal directions) always finds room for a second member.
 */
const SINGLE_PLANT_LAYOUT_CSV = ['id,species_id,x_ft,y_ft', 'solo,winecup,10,10'].join('\n');

/** Every scratch project seeded with SINGLE_PLANT_LAYOUT_CSV instead of backyard's own planting. */
const SINGLE_PLANT_PROJECTS = ['desktop-drift-convert', 'touch-drift-convert'];

/**
 * The species table's per-drift entries and the plan's single grouped label
 * (nl-o47.6.7): winecup gets TWO drifts (4 members at the same square
 * DRIFT_LAYOUT_CSV uses, so its centroid/spacing/label math is already
 * proven by nl-o47.6.2's own specs, plus 3 more well clear of it and of
 * everything else) and one winecup planted in no drift at all, so the
 * species table has both "2 drifts, 8 plants" and "1 single" to assert on in
 * the same row. horseherb gets one lone plant and NO drift, so its own row's
 * Drifts cell stays empty — "keep the table's existing behaviour for
 * species rows" with nothing to show. Every group sits far enough from every
 * other (see DRIFT_LAYOUT_CSV's own comment on MIN_HITBOX_RADIUS_PX) that a
 * click aimed at one drift's member or gap cannot land near another's.
 */
const SPECIES_DRIFT_LAYOUT_CSV = [
  'id,species_id,x_ft,y_ft,drift_id',
  'wa,winecup,12,8,winecup-drift',
  'wb,winecup,18,8,winecup-drift',
  'wc,winecup,12,14,winecup-drift',
  'wd,winecup,18,14,winecup-drift',
  'wx,winecup,3,3,winecup-2',
  'wy,winecup,3,7,winecup-2',
  'wz,winecup,7,5,winecup-2',
  'single-winecup,winecup,25,18,',
  'lone-horseherb,horseherb,25,3,',
].join('\n');

/** Every scratch project seeded with SPECIES_DRIFT_LAYOUT_CSV instead of backyard's own planting. */
const SPECIES_DRIFT_PROJECTS = ['desktop-drift-species', 'touch-drift-species'];

/**
 * Two undrifted masses for "suggest drifts from an existing yard"
 * (nl-o47.6.5): winecup's 4 members sit within SUGGEST_K (1.25) x its own
 * width (3 ft) = 3.75 ft of each other, so suggestClusters proposes them as
 * one cluster — the largest of the two, reviewed first (largest-first).
 * horseherb's 3 do the same, at the same spacing (also 3 ft wide), well clear
 * of winecup's square (14+ ft away) so neither cluster's own candidates ever
 * brush the other's. `sug-wa-loner` is a fifth winecup plant, in no drift,
 * but 6-8 ft from every corner of winecup's own square — outside its
 * clustering distance, so suggestClusters leaves it out, but it is still a
 * same-species, undrifted candidate a manual tap can add to the suggestion
 * (nl-o47.6.5's "Adjust"). Kept at the same y as the square's own row (not
 * pushed toward the panel's far edge) so it renders well clear of the
 * toolbar/scale controls above the plan panel on a desktop layout.
 */
const DRIFT_SUGGEST_LAYOUT_CSV = [
  'id,species_id,x_ft,y_ft',
  'sug-wa1,winecup,4,4',
  'sug-wa2,winecup,6,4',
  'sug-wa3,winecup,4,6',
  'sug-wa4,winecup,6,6',
  'sug-wa-loner,winecup,12,4',
  'sug-hb1,horseherb,20,4',
  'sug-hb2,horseherb,22,4',
  'sug-hb3,horseherb,20,6',
].join('\n');

/** Every scratch project seeded with DRIFT_SUGGEST_LAYOUT_CSV. */
const DRIFT_SUGGEST_PROJECTS = ['desktop-drift-suggest', 'touch-drift-suggest'];

/**
 * One mass whose members DISAGREE in lifecycle (nl-o47.6.5's own review of
 * "one planting status per drift," nl-o47.6.10): carex blanda, width 1.5 ft,
 * so SUGGEST_K x width = 1.875 ft comfortably covers this 1 ft square while
 * still clustering the three as one suggestion. Its own project, with
 * nothing else to suggest, so the "requires a choice" test needs no Skip to
 * reach it.
 */
const DRIFT_SUGGEST_MIXED_LAYOUT_CSV = [
  'id,species_id,x_ft,y_ft,status,planted_on',
  'sug-cb1,carex-blanda,4,4,,',
  'sug-cb2,carex-blanda,5,4,planted,2026-03-01',
  'sug-cb3,carex-blanda,4,5,,',
].join('\n');

/** Every scratch project seeded with DRIFT_SUGGEST_MIXED_LAYOUT_CSV. */
const DRIFT_SUGGEST_MIXED_PROJECTS = ['desktop-drift-suggest-mixed'];

/**
 * Group selected plants into a drift by hand (nl-o47.6.4, making method 2):
 * one lone winecup ("Make drift" is only ever offered for a single plant not
 * already in a drift), two more same-species undrifted plants a tap can pull
 * in, and one horseherb well clear of them all for "a different-species tap
 * does nothing." Positions well apart (same spirit as DRIFT_SUGGEST_LAYOUT_CSV,
 * above) so a tap/click aimed at one plant cannot also land near another's.
 */
const DRIFT_GROUP_LAYOUT_CSV = [
  'id,species_id,x_ft,y_ft',
  'mk-seed,winecup,4,4',
  'mk-2,winecup,10,4',
  'mk-3,winecup,4,10',
  'mk-other,horseherb,10,10',
].join('\n');

/** Every scratch project seeded with DRIFT_GROUP_LAYOUT_CSV. */
const DRIFT_GROUP_PROJECTS = ['desktop-drift-group', 'touch-drift-group'];

/**
 * Group selected plants, including a member of another real drift (nl-o47.6.4):
 * mv-seed/mv-third are two undrifted, PLANNED winecup a hand-made proposal
 * starts from; mv-a/mv-b are an existing 2-member drift ('mv-existing'), both
 * PLANTED — so tapping mv-a into the proposal both exercises "a member of
 * another drift moves" (mv-b, left alone, drops mv-existing's label once it
 * is down to one member) AND "mixed lifecycles require a choice" (mv-seed/
 * mv-third are planned, mv-a is planted) in the same flow. planted_on is a
 * PAST date (today is well past 2026-09-30 in this suite's fixtures) —
 * validateLifecycle refuses a future one.
 */
const DRIFT_GROUP_MOVE_LAYOUT_CSV = [
  'id,species_id,x_ft,y_ft,drift_id,status,planted_on',
  'mv-seed,winecup,4,4,,,',
  'mv-third,winecup,10,4,,,',
  'mv-a,winecup,4,10,mv-existing,planted,2026-03-01',
  'mv-b,winecup,10,10,mv-existing,planted,2026-03-01',
].join('\n');

/** Every scratch project seeded with DRIFT_GROUP_MOVE_LAYOUT_CSV. */
const DRIFT_GROUP_MOVE_PROJECTS = ['desktop-drift-group-move', 'touch-drift-group-move'];

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
  'ecosystem.html', // habitatNearby.spec.js reads a seeded scratch yard's anchors (nl-3s5.31)
  'sourcing.html', // shoppingList.spec.js stars favorites on the scratch app.db (nl-46b)
  'sourcing.css',
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

  DRIFT_PROJECTS.forEach((id) => {
    writeFileSync(path.join(SCRATCH_DIR, 'projects', id, 'planting_layout.csv'), `${DRIFT_LAYOUT_CSV}\n`);
  });

  SINGLE_PLANT_PROJECTS.forEach((id) => {
    writeFileSync(path.join(SCRATCH_DIR, 'projects', id, 'planting_layout.csv'), `${SINGLE_PLANT_LAYOUT_CSV}\n`);
  });

  SPECIES_DRIFT_PROJECTS.forEach((id) => {
    writeFileSync(path.join(SCRATCH_DIR, 'projects', id, 'planting_layout.csv'), `${SPECIES_DRIFT_LAYOUT_CSV}\n`);
  });

  DRIFT_SUGGEST_PROJECTS.forEach((id) => {
    writeFileSync(path.join(SCRATCH_DIR, 'projects', id, 'planting_layout.csv'), `${DRIFT_SUGGEST_LAYOUT_CSV}\n`);
  });

  DRIFT_SUGGEST_MIXED_PROJECTS.forEach((id) => {
    writeFileSync(
      path.join(SCRATCH_DIR, 'projects', id, 'planting_layout.csv'),
      `${DRIFT_SUGGEST_MIXED_LAYOUT_CSV}\n`
    );
  });

  DRIFT_GROUP_PROJECTS.forEach((id) => {
    writeFileSync(path.join(SCRATCH_DIR, 'projects', id, 'planting_layout.csv'), `${DRIFT_GROUP_LAYOUT_CSV}\n`);
  });

  DRIFT_GROUP_MOVE_PROJECTS.forEach((id) => {
    writeFileSync(
      path.join(SCRATCH_DIR, 'projects', id, 'planting_layout.csv'),
      `${DRIFT_GROUP_MOVE_LAYOUT_CSV}\n`
    );
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
