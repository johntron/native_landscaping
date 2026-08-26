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

test('dragging a camera moves that elevation and saves it alone', async ({ page }) => {
  const cameras = async () => {
    const cfg = JSON.parse(
      await readFile(path.join(SCRATCH_DIR, 'projects', PROJECT, 'project.json'), 'utf8')
    );
    return Object.fromEntries(cfg.views.map((view) => [view.id, view.viewerAtFt ?? null]));
  };
  const before = { placements: await placements(), cameras: await cameras() };

  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();

  // The plan is what carries the cameras, and it is the first view.
  await page.locator('#setupRow .setup-panel__pick').first().click();
  const svg = page.locator('#topSvg');
  await svg.scrollIntoViewIfNeeded();
  const line = svg.locator('line[data-setup-camera="north"]');
  await expect(line).toHaveCount(1);
  const at = await page.evaluate(() => {
    const node = document.getElementById('topSvg');
    const rect = node.getBoundingClientRect();
    const box = node.viewBox.baseVal;
    const y = Number(
      document.querySelector('#topSvg line[data-setup-camera="north"]').getAttribute('y1')
    );
    // Setup widens the window and starts it at a negative origin, so the offset
    // counts as much as the scale.
    return { x: rect.left + rect.width / 2, y: rect.top + ((y - box.y) * rect.height) / box.height };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y + 50, { steps: 8 });
  await page.mouse.up();
  await saveViews(page);

  const after = await cameras();
  expect(after.north, 'the dragged camera moved').not.toEqual(before.cameras.north);
  // A camera lives on the elevation it belongs to, not on the plan it is
  // dragged in, and no other view's is touched.
  expect(after.plan ?? null).toBe(null);
  expect(after.west).toEqual(before.cameras.west);
  // Photographs are a different concern and stayed exactly where they were.
  expect(await placements()).toEqual(before.placements);
});

test('a save keeps the ecoregion and site declarations', async ({ page }) => {
  // Same class of loss as the photo placements above, one field over: the
  // client serializer whitelists, and so does the server, which re-normalizes
  // and re-serializes the posted body before writing (server.js:97). Two
  // whitelists means two places a declaration can quietly die on save, and the
  // symptom — the ecology check going "not declared" — looks like a rule bug.
  const declared = async () => {
    const cfg = JSON.parse(
      await readFile(path.join(SCRATCH_DIR, 'projects', PROJECT, 'project.json'), 'utf8')
    );
    return { ecoregion: cfg.ecoregion ?? null, site: cfg.site ?? null };
  };

  const before = await declared();
  expect(before.ecoregion).toBe('9');
  expect(before.site).toEqual({ sun: 'part-sun', water: 'medium', soil: 'clay' });

  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();
  await saveViews(page);
  expect(await declared()).toEqual(before);

  // And a save that actually changes something still carries them. This resizes
  // the yard, so the test runs LAST in this serial file — the camera spec above
  // asserts on positions that a resize would move.
  await yardField(page, 'East–west (ft)').fill('16');
  await yardField(page, 'East–west (ft)').blur();
  await saveViews(page);
  expect(await declared()).toEqual(before);
});
