import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCRATCH_DIR } from './scratch-fixture.mjs';
import { openScratchProject } from './helpers.js';

/**
 * projects/example-frontyard/project.json was found with every originFt gone,
 * including the negative originFt.y that positions each elevation's ground
 * line. serializeProjectConfig omits an origin of {0,0}, so a view that lost
 * its origin in memory leaves no trace of ever having had one — which makes
 * this the kind of damage nothing notices until a drawing looks wrong.
 *
 * This project carries that geometry so a save can be watched over it. Its own
 * copy, per the fixture's convention, and emphatically not the real project:
 * that one is live data the running app writes to.
 */
const PROJECT = 'frontyard-save';

test.describe.configure({ mode: 'serial' });

async function origins() {
  const cfg = JSON.parse(
    await readFile(path.join(SCRATCH_DIR, 'projects', PROJECT, 'project.json'), 'utf8')
  );
  return Object.fromEntries(
    cfg.views.map((view) => [view.id, view.originFt ? { ...view.originFt } : { x: 0, y: 0 }])
  );
}

async function saveViews(page) {
  await page.locator('#setupRow button', { hasText: 'Save views' }).click();
  await expect(page.locator('#setupRow .setup-panel__status')).toHaveText('Views saved');
}

test('a save carries every view origin through untouched', async ({ page }) => {
  const before = await origins();
  // The fixture's whole point: two elevations sit on a lifted ground line.
  expect(before.north.y).toBeLessThan(0);
  expect(before.west.y).toBeLessThan(0);
  expect(before.plan).toEqual({ x: 2, y: 14.833316758684116 });

  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();
  await saveViews(page);
  expect(await origins()).toEqual(before);

  // Editing one view must not disturb another's origin — the damage found in
  // the real project was every view at once, so per-view isolation is the
  // property worth pinning.
  const width = page.locator('#setupRow input[type="number"]').first();
  await width.fill('28');
  await width.blur();
  await saveViews(page);
  expect(await origins()).toEqual(before);

  await page.locator('#setupRow .setup-panel__pick').nth(1).click();
  const elevationWidth = page.locator('#setupRow input[type="number"]').first();
  await elevationWidth.fill('11');
  await elevationWidth.blur();
  await saveViews(page);
  expect(await origins()).toEqual(before);
});

test('dragging one view\'s ground line moves that origin and no other', async ({ page }) => {
  const before = await origins();
  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();

  // Select the north elevation and drag its ground line upward.
  await page.locator('#setupRow .setup-panel__pick').nth(1).click();
  const svg = page.locator('#northSvg');
  await svg.scrollIntoViewIfNeeded();
  // Aim at where the overlay actually drew the handle rather than guessing:
  // the ground line's position depends on the view's origin and extent, which
  // is the very thing under test.
  const handle = svg.locator('[data-setup-handle="ground"]');
  await expect(handle).toHaveCount(1);
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 40, { steps: 8 });
  await page.mouse.up();
  await saveViews(page);

  const after = await origins();
  expect(after.north.y, 'the dragged ground line moved').not.toBe(before.north.y);
  // Everything else is exactly where it was.
  expect(after.plan).toEqual(before.plan);
  expect(after.west).toEqual(before.west);
  expect(after.view).toEqual(before.view);
});
