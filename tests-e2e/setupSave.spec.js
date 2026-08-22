import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCRATCH_DIR } from './scratch-fixture.mjs';
import { openScratchProject } from './helpers.js';

/**
 * projects/example-frontyard/project.json was once found with every originFt
 * gone, including the negative values positioning each elevation's ground line
 * (nl-jqd). A Setup Save had rebuilt each view and dropped a field on the way,
 * and because the serializer omits a default there was no trace of it ever
 * having been there — the kind of damage nothing notices until a drawing looks
 * wrong.
 *
 * A view no longer carries an origin, so that exact field cannot be lost. The
 * same loss is now available one level down: `photoFt` is the only per-view
 * geometry left, it is likewise omitted when absent, and losing it silently
 * snaps a carefully placed photograph back to filling its panel. So the spec
 * follows the field.
 *
 * Its own copy of the project, per the fixture's convention, and emphatically
 * not the real one: that is live data the running app writes to.
 */
const PROJECT = 'frontyard-save';

test.describe.configure({ mode: 'serial' });

async function placements() {
  const cfg = JSON.parse(
    await readFile(path.join(SCRATCH_DIR, 'projects', PROJECT, 'project.json'), 'utf8')
  );
  return Object.fromEntries(cfg.views.map((view) => [view.id, view.photoFt ?? null]));
}

async function saveViews(page) {
  await page.locator('#setupRow button', { hasText: 'Save views' }).click();
  await expect(page.locator('#setupRow .setup-panel__status')).toHaveText('Views saved');
}

/** The yard's own fields come first in the panel. */
const yardField = (page, label) =>
  page.locator('#setupRow .setup-panel__field', { hasText: label }).locator('input');

test('a save carries every photo placement through untouched', async ({ page }) => {
  const before = await placements();
  // The fixture's whole point: two elevations sit on a photo lifted above the
  // ground line, and one view has no placement at all.
  expect(before.north.originFt.y).toBeLessThan(0);
  expect(before.west.originFt.y).toBeLessThan(0);
  expect(before.view).toBe(null);

  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();
  await saveViews(page);
  expect(await placements()).toEqual(before);

  // Resizing the yard reshapes every panel — and must not touch a single
  // photograph, which is measured in yard feet and did not move.
  await yardField(page, 'East–west (ft)').fill('14');
  await yardField(page, 'East–west (ft)').blur();
  await saveViews(page);
  expect(await placements()).toEqual(before);

  // Nor may renaming one view disturb another's placement — the damage found in
  // the real project was every view at once, so isolation is the property worth
  // pinning.
  await page.locator('#setupRow .setup-panel__pick').nth(1).click();
  const name = page.locator('#setupRow .setup-panel__field', { hasText: 'Name' }).locator('input');
  await name.fill('North side');
  await name.blur();
  await saveViews(page);
  expect(await placements()).toEqual(before);
});

test("dragging one view's photo moves that placement and no other", async ({ page }) => {
  const before = await placements();
  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();

  // Select the north elevation and drag its photo upward.
  await page.locator('#setupRow .setup-panel__pick').nth(1).click();
  const svg = page.locator('#northSvg');
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y - 40, { steps: 8 });
  await page.mouse.up();
  await saveViews(page);

  const after = await placements();
  expect(after.north.originFt.y, 'the dragged photo moved').toBeGreaterThan(
    before.north.originFt.y
  );
  // Everything else is exactly where it was.
  expect(after.plan).toEqual(before.plan);
  expect(after.west).toEqual(before.west);
  expect(after.view).toEqual(before.view);
});
