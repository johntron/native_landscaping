import { test, expect } from '@playwright/test';
import { openScratchProject, readScratchLayout, readScratchFeatures } from './helpers.js';

/**
 * Shrinking a yard below what is standing in it is the one way the declared
 * yard can still strand a plant — or a feature (nl-1ug): yard-conflict is a
 * copy of backyard, which carries a passionflower trellis at y=9.776, past
 * this project's declared 9 ft depth. Nothing on the canvas says so — an
 * out-of-bounds plant or feature draws in the margin or not at all — and
 * `resolveYardBounds` clamps only new drags, so neither can be dragged back
 * either. The panel is therefore the only place it can be noticed, which is
 * what these pin.
 */
const PROJECT = 'yard-conflict';
const YARD = { width: 12, depth: 9 };

test.describe.configure({ mode: 'serial' });

const strays = (rows) =>
  rows.filter((row) => row.x < 0 || row.x > YARD.width || row.y < 0 || row.y > YARD.depth);

const strayFeatures = (features) =>
  features.filter((feature) =>
    (feature.footprintFt || feature.pathFt || []).some(
      (point) => point.x < 0 || point.x > YARD.width || point.y < 0 || point.y > YARD.depth
    )
  );

test('the panel names every plant and feature the yard no longer contains', async ({ page }) => {
  const expectedPlants = strays(await readScratchLayout(PROJECT));
  const expectedFeatures = strayFeatures(await readScratchFeatures(PROJECT));
  expect(expectedPlants.length).toBeGreaterThan(0);
  expect(expectedFeatures.length).toBeGreaterThan(0);
  const expectedTotal = expectedPlants.length + expectedFeatures.length;

  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();

  const conflicts = page.locator('.setup-panel__conflicts');
  await expect(conflicts.locator('.setup-panel__heading')).toHaveText(
    `${expectedTotal} outside the yard`
  );
  await expect(conflicts.locator('.setup-panel__strays li')).toHaveCount(expectedTotal);
  // Position and direction, not just a count: the point is to be able to find
  // the plant being complained about.
  await expect(conflicts.locator('.setup-panel__stray-at').first()).toContainText('ft');
  // The feature is named too, not silently folded into the plant count.
  await expect(conflicts.locator('.setup-panel__strays')).toContainText('Passionflower trellis');

  // Plants and features are forced visible while anything is stranded — they
  // are the subject — and the switches say so rather than pretending to turn
  // them off.
  const plantsToggle = page.locator('.setup-panel__checkbox', { hasText: 'Show plants' }).locator('input');
  await expect(plantsToggle).toBeChecked();
  await expect(plantsToggle).toBeDisabled();
  await expect(page.locator('#topSvg g[data-plant-id]').first()).toBeVisible();

  const featuresToggle = page
    .locator('.setup-panel__checkbox', { hasText: 'Show features' })
    .locator('input');
  await expect(featuresToggle).toBeChecked();
  await expect(featuresToggle).toBeDisabled();
});

test('nothing moves until a button is pressed', async ({ page }) => {
  const before = await readScratchLayout(PROJECT);
  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();

  // Resizing is exploratory — type 6, look, type 8 — so a yard edit redraws and
  // reports and touches no coordinate.
  const eastWest = page
    .locator('.setup-panel__field', { hasText: 'East–west (ft)' })
    .locator('input');
  await eastWest.fill('8');
  await eastWest.press('Enter');
  await expect(page.locator('.setup-panel__conflicts .setup-panel__heading')).toBeVisible();
  expect(await readScratchLayout(PROJECT)).toEqual(before);
});

test('moving them inside empties the list and writes the layout', async ({ page }) => {
  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();
  await expect(page.locator('.setup-panel__strays li').first()).toBeVisible();

  await page.getByRole('button', { name: 'Move all inside the boundary' }).click();
  await expect(page.locator('.setup-panel__conflicts .setup-panel__heading')).toHaveCount(0);

  await expect(async () => {
    expect(strays(await readScratchLayout(PROJECT))).toEqual([]);
  }).toPass();

  // Clamped, not deleted: every plant is still there, just inside the boundary.
  const rows = await readScratchLayout(PROJECT);
  expect(rows.length).toBeGreaterThan(0);
  rows.forEach((row) => {
    expect(row.x).toBeGreaterThanOrEqual(0);
    expect(row.x).toBeLessThanOrEqual(YARD.width);
  });

  // The trellis moved as a whole rather than being clamped point-by-point,
  // which would have collapsed its two-point path into one.
  const features = await readScratchFeatures(PROJECT);
  const trellis = features.find((f) => f.id === 'trellis');
  expect(trellis).toBeTruthy();
  expect(strayFeatures([trellis])).toEqual([]);
  expect(trellis.pathFt[1].x - trellis.pathFt[0].x).toBeCloseTo(1.5, 5);
});
