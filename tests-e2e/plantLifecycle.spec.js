import { test, expect } from '@playwright/test';
import { openScratchProject, plantPointerTarget, readScratchHistory } from './helpers.js';

/**
 * nl-3s5.22: the detail sheet sets a plant's status, planting date and source;
 * the drawing marks planned (dashed) and planted (solid); each edit is one
 * revision, saved and undoable.
 *
 * Writes, so it runs on the scratch server against its own yard.
 */
const PROJECT = 'plant-lifecycle';

async function savedPlacement(plantId) {
  const history = await readScratchHistory(PROJECT);
  const entry = history?.entries[history.cursor];
  return entry?.plants.find((plant) => plant.id === plantId) ?? null;
}

test('mark a plant planted, date it, link a source, and undo', async ({ page }) => {
  await openScratchProject(page, PROJECT);
  // A click opens the sheet in View mode; in Edit mode it starts a drag.
  await page.locator('[data-mode="view"]').click();
  const target = await plantPointerTarget(page, 'topSvg');
  await page.mouse.click(target.x, target.y);

  const sheet = page.locator('#detailSheet');
  await expect(sheet).toBeVisible();
  const plantId = await sheet.getAttribute('data-plant-id');
  const group = page.locator(`#topSvg g[data-plant-id="${plantId}"]`);
  const section = sheet.locator('.plant-lifecycle');
  await expect(section).toBeVisible();
  await expect(group).toHaveAttribute('data-status', 'planned');
  await expect(section.locator('[data-lifecycle-status="planned"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(section.locator('input[name="plantedOn"]')).toBeHidden();
  expect(await group.locator('[stroke-dasharray]').count()).toBe(1);

  await section.locator('[data-lifecycle-status="planted"]').click();
  await expect(group).toHaveAttribute('data-status', 'planted');
  expect(await group.locator('[stroke-dasharray]').count()).toBe(0);
  await expect.poll(async () => (await savedPlacement(plantId))?.status).toBe('planted');

  // A future date is refused with a message and nothing is saved.
  const date = section.locator('input[name="plantedOn"]');
  await expect(date).toBeVisible();
  await date.fill('2999-01-01');
  await expect(section.locator('.plant-lifecycle__message')).toContainText('future');
  await expect(date).toHaveValue('');
  await date.fill('2026-04-18');
  await expect.poll(async () => (await savedPlacement(plantId))?.plantedOn).toBe('2026-04-18');

  // Free text is saved as typed; a suggestion is only offered, then linked on a click.
  const source = section.locator('input[name="source"]');
  await source.fill('<b>Big Box</b> #123');
  await source.press('Enter');
  await expect.poll(async () => (await savedPlacement(plantId))?.source).toEqual({ name: '<b>Big Box</b> #123' });
  await expect(section.locator('.plant-lifecycle__linked')).toBeHidden();

  await source.fill('Native Gard');
  const suggestion = section.locator('.plant-lifecycle__suggestion', { hasText: 'Native Gardeners' });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect.poll(async () => (await savedPlacement(plantId))?.source).toEqual({
    name: 'Native Gardeners',
    ref: { table: 'nurseries', name: 'Native Gardeners' },
  });
  await expect(section.locator('.plant-lifecycle__linked')).toContainText('Linked: Native Gardeners');
  // One revision for the link, not a second for the blur that came with the click.
  const descriptions = (await readScratchHistory(PROJECT)).entries.map((entry) => entry.description);
  expect(descriptions.slice(-4)).toEqual(['Marked plant planted', 'Set planting date', 'Set plant source', 'Linked plant source']);

  // Undo takes back one edit at a time, and the open sheet follows.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.locator('[data-mode="edit"]').click();
  await page.locator('#undoLayoutBtn').click();
  await expect.poll(async () => (await savedPlacement(plantId))?.source).toEqual({ name: '<b>Big Box</b> #123' });
  await page.locator('#undoLayoutBtn').click();
  await page.locator('#undoLayoutBtn').click();
  await page.locator('#undoLayoutBtn').click();
  await expect(group).toHaveAttribute('data-status', 'planned');
  await expect.poll(async () => (await savedPlacement(plantId))?.status ?? 'planned').toBe('planned');
});
