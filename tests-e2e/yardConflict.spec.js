import { test, expect } from '@playwright/test';
import { openScratchProject, readScratchLayout } from './helpers.js';

/**
 * Shrinking a yard below what is standing in it is the one way the declared
 * yard can still strand a plant. Nothing on the canvas says so — an out-of-
 * bounds plant draws in the margin or not at all — and `resolveYardBounds`
 * clamps only new drags, so it cannot be dragged back either. The panel is
 * therefore the only place it can be noticed, which is what these pin.
 */
const PROJECT = 'yard-conflict';
const YARD = { width: 12, depth: 9 };

test.describe.configure({ mode: 'serial' });

const strays = (rows) =>
  rows.filter((row) => row.x < 0 || row.x > YARD.width || row.y < 0 || row.y > YARD.depth);

test('the panel names every plant the yard no longer contains', async ({ page }) => {
  const expected = strays(await readScratchLayout(PROJECT));
  expect(expected.length).toBeGreaterThan(0);

  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();

  const conflicts = page.locator('.setup-panel__conflicts');
  await expect(conflicts.locator('.setup-panel__heading')).toHaveText(
    `${expected.length} outside the yard`
  );
  await expect(conflicts.locator('.setup-panel__strays li')).toHaveCount(expected.length);
  // Position and direction, not just a count: the point is to be able to find
  // the plant being complained about.
  await expect(conflicts.locator('.setup-panel__stray-at').first()).toContainText('ft');

  // Plants are forced visible while anything is stranded — they are the
  // subject — and the switch says so rather than pretending to turn them off.
  const toggle = page.locator('.setup-panel__checkbox', { hasText: 'Show plants' }).locator('input');
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(page.locator('#topSvg g[data-plant-id]').first()).toBeVisible();
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
});
