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
];

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
