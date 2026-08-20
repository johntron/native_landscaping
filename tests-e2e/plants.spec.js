import { test, expect } from '@playwright/test';
import { openScratchProject, plantPointerTarget, readScratchLayout } from './helpers.js';

// Adding and removing both auto-save through POST /api/layout, so these run
// against the throwaway document root built by scratch-fixture.mjs — never the
// repo's own projects/. Each spec owns a project, because a change in one would
// alter the count the other asserts on.

const planPlants = (page) => page.locator('#topSvg g[data-plant-id]');

/**
 * Click a plant so its detail sheet opens, and report which plant that was.
 * The id is read back off the sheet rather than assumed: canopies overlap, so
 * the group under a given point is not necessarily the one aimed at.
 */
async function openDetailSheetOnAPlant(page) {
  const target = await plantPointerTarget(page, 'topSvg');
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('#detailSheetRemoveBtn')).toBeVisible();
  return page.locator('#detailSheet').getAttribute('data-plant-id');
}

test.describe('adding and removing plants', () => {
  test('adding a plant from the catalog draws it and saves it', async ({ page }) => {
    await openScratchProject(page, 'plant-add');
    await page.locator('[data-mode="edit"]').click();

    const before = await planPlants(page).count();
    const savedBefore = (await readScratchLayout('plant-add')).length;

    // Pick a species by its botanical name, so the assertion below names a
    // plant the catalog actually carries.
    const value = await page.locator('#addPlantSelect option').first().getAttribute('value');
    await page.locator('#addPlantSelect').selectOption(value);
    await page.locator('#addPlantBtn').click();

    await expect(planPlants(page)).toHaveCount(before + 1);

    // The add reached disk, not just the DOM. The save is a POST, so poll.
    await expect
      .poll(async () => (await readScratchLayout('plant-add')).length, { timeout: 5000 })
      .toBe(savedBefore + 1);

    // And the saved row reloads. The select's value is the normalized botanical
    // key while the CSV carries the display name, so this is the assertion that
    // proves the write and the read agree on a real catalog row.
    await openScratchProject(page, 'plant-add');
    await expect(planPlants(page)).toHaveCount(before + 1);
  });

  test('removing a plant drops it from the drawing and from the saved layout', async ({ page }) => {
    // View mode, not Edit: the detail sheet opens on a plain click, and in Edit
    // mode the drag controller captures the pointer so no click reaches a plant.
    await openScratchProject(page, 'plant-remove');

    const before = await planPlants(page).count();
    const savedBefore = (await readScratchLayout('plant-remove')).length;

    const victimId = await openDetailSheetOnAPlant(page);
    await page.locator('#detailSheetRemoveBtn').click();

    await expect(planPlants(page)).toHaveCount(before - 1);
    await expect(page.locator(`#topSvg g[data-plant-id="${victimId}"]`)).toHaveCount(0);

    await expect
      .poll(async () => (await readScratchLayout('plant-remove')).map((row) => row.id), {
        timeout: 5000,
      })
      .not.toContain(victimId);
    expect((await readScratchLayout('plant-remove')).length).toBe(savedBefore - 1);
  });

  test('undo puts a removed plant back', async ({ page }) => {
    await openScratchProject(page, 'plant-undo');

    const before = await planPlants(page).count();
    await openDetailSheetOnAPlant(page);
    await page.locator('#detailSheetRemoveBtn').click();
    await expect(planPlants(page)).toHaveCount(before - 1);

    // Undo lives in the Edit row, so the button is only reachable from there.
    await page.locator('[data-mode="edit"]').click();
    await page.locator('#undoLayoutBtn').click();
    await expect(planPlants(page)).toHaveCount(before);
  });
});
