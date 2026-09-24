import { test, expect } from '@playwright/test';
import { SCRATCH_BASE, openScratchProject, readScratchLayout } from './helpers.js';

/**
 * nl-3s5.20: a Save views is a revision in the same history as the planting,
 * so Undo takes it back (the previous setup, on screen and on the server)
 * without moving a plant, and Redo puts it back. Undo and Redo show in Setup
 * mode for exactly this.
 *
 * Writes, so it runs on the scratch server against its own yard.
 */
const PROJECT = 'setup-undo';

async function savedName() {
  const response = await fetch(`${SCRATCH_BASE}/api/project?project=${PROJECT}`);
  return (await response.json()).name;
}

test('a setup save is undone and redone from Setup mode, and the planting stays put', async ({ page }) => {
  const original = await savedName();
  const layout = await readScratchLayout(PROJECT);
  expect(layout.length).toBeGreaterThan(0);

  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();
  const undo = page.locator('#undoLayoutBtn');
  const redo = page.locator('#redoLayoutBtn');
  await expect(undo).toBeVisible();

  const name = page
    .locator('#setupRow .setup-panel__section', { has: page.locator('h3', { hasText: 'Project' }) })
    .locator('.setup-panel__field', { hasText: 'Name' })
    .locator('input')
    .first();
  await name.fill('Undo me');
  await name.press('Enter');
  await page.locator('#setupRow button', { hasText: 'Save views' }).click();
  await expect(page.locator('#setupRow .setup-panel__status')).toHaveText('Views saved');
  await expect.poll(savedName).toBe('Undo me');
  await expect(undo).toBeEnabled();
  await expect(undo).toHaveAttribute('title', 'Undo: Saved views');

  await undo.click();
  await expect(page.locator('#projectTitle')).toHaveText(`Your yard: ${original}`);
  await expect(name).toHaveValue(original);
  await expect.poll(savedName).toBe(original);
  expect(await readScratchLayout(PROJECT)).toEqual(layout);
  await expect(redo).toBeEnabled();

  await redo.click();
  await expect(page.locator('#projectTitle')).toHaveText('Your yard: Undo me');
  await expect.poll(savedName).toBe('Undo me');
  expect(await readScratchLayout(PROJECT)).toEqual(layout);

  // A reload lands on the redone setup, with the save still undoable.
  // The page reopens in Setup mode (the mode is remembered), which hides the
  // plants, so wait for them to be drawn rather than shown.
  await page.reload();
  await page.locator('#topSvg g[data-plant-id]').first().waitFor({ state: 'attached' });
  await expect(page.locator('#projectTitle')).toHaveText('Your yard: Undo me');
  await page.locator('[data-mode="edit"]').click();
  await expect(page.locator('#undoLayoutBtn')).toBeEnabled();
});
