import { test, expect } from '@playwright/test';
import { openScratchProject, plantPointerTarget, readScratchHistory, readScratchLayout } from './helpers.js';

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

    // Pick a species by its plants.csv id (the select's value), so the
    // assertion below names a plant the catalog actually carries.
    const value = await page.locator('#addPlantSelect option').first().getAttribute('value');
    await page.locator('#addPlantSelect').selectOption(value);
    await page.locator('#addPlantBtn').click();

    await expect(planPlants(page)).toHaveCount(before + 1);

    // The add reached disk, not just the DOM. The save is a POST, so poll.
    await expect
      .poll(async () => (await readScratchLayout('plant-add')).length, { timeout: 5000 })
      .toBe(savedBefore + 1);

    // And the saved row reloads. The select's value is the species id and the
    // CSV's species_id column carries it back, so this is the assertion that
    // proves the write and the read agree on a real catalog row.
    await openScratchProject(page, 'plant-add');
    await expect(planPlants(page)).toHaveCount(before + 1);
  });

  test('the picker narrows by a partial name and sorts by either name', async ({ page }) => {
    // Read-only: nothing is added, so no layout is written.
    await openScratchProject(page, 'plant-add');
    await page.locator('[data-mode="edit"]').click();
    const options = page.locator('#addPlantSelect option');
    const total = await options.count();

    await page.locator('#addPlantSearch').fill('YARR');
    const narrowed = await options.allTextContents();
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.length).toBeLessThan(total);
    for (const text of narrowed) expect(text.toLowerCase()).toContain('yarr');

    // Sorted by scientific name, each option leads with it: "Achillea ... (Western yarrow)".
    await page.locator('#addPlantSort').selectOption('botanical');
    expect((await options.first().textContent()).startsWith('Achillea')).toBe(true);

    await page.locator('#addPlantSearch').fill('zzzz no such plant');
    await expect(options).toHaveText(['No plants match']);
    await expect(page.locator('#addPlantBtn')).toBeDisabled();

    await page.locator('#addPlantSearch').fill('');
    await expect(options).toHaveCount(total);
    await expect(page.locator('#addPlantBtn')).toBeEnabled();

    // Native only keeps just the options labelled native (a cultivar is labelled "cultivar").
    await page.locator('#addPlantNativeOnly').check();
    const natives = await options.allTextContents();
    expect(natives.length).toBeGreaterThan(0);
    expect(natives.length).toBeLessThan(total);
    for (const text of natives) expect(text).toContain('✓ native to North Central Texas');
    await page.locator('#addPlantNativeOnly').uncheck();
    await expect(options).toHaveCount(total);
  });

  test('the star marks the selected species favorite, and it survives a reload', async ({ page }) => {
    // Writes /api/favorites, so the scratch server (its own throwaway app.db).
    await openScratchProject(page, 'plant-add');
    await page.locator('[data-mode="edit"]').click();
    const star = page.locator('#addPlantFavoriteBtn');
    await expect(star).toBeVisible();
    await page.locator('#addPlantSearch').fill('yarrow');
    const option = page.locator('#addPlantSelect option').first();
    if ((await star.getAttribute('aria-pressed')) === 'true') await star.click(); // start from not-favorite
    await expect(star).toHaveAttribute('aria-pressed', 'false');

    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(option).toContainText('★ favorite');

    await openScratchProject(page, 'plant-add');
    await page.locator('[data-mode="edit"]').click();
    await page.locator('#addPlantSearch').fill('yarrow');
    await expect(page.locator('#addPlantSelect option').first()).toContainText('★ favorite');

    await star.click(); // leave it as found
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#addPlantSelect option').first()).not.toContainText('★');
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

  test('undo and redo both move the saved layout, and the buttons track what is possible', async ({ page }) => {
    await openScratchProject(page, 'plant-redo');
    // The scratch copy may carry the source project's own history, in any shape.
    const historyBefore = (await readScratchHistory('plant-redo'))?.entries.length ?? 0;
    const saved = async () => (await readScratchLayout('plant-redo')).map((row) => row.id);
    const before = await planPlants(page).count();

    const victimId = await openDetailSheetOnAPlant(page);
    await page.locator('#detailSheetRemoveBtn').click();
    await expect(planPlants(page)).toHaveCount(before - 1);
    await expect.poll(saved, { timeout: 5000 }).not.toContain(victimId);

    await page.locator('[data-mode="edit"]').click();
    const undo = page.locator('#undoLayoutBtn');
    const redo = page.locator('#redoLayoutBtn');
    await expect(redo).toBeDisabled();

    await undo.click();
    await expect(planPlants(page)).toHaveCount(before);
    await expect(redo).toBeEnabled();
    await expect.poll(saved, { timeout: 5000 }).toContain(victimId);

    await redo.click();
    await expect(planPlants(page)).toHaveCount(before - 1);
    await expect(redo).toBeDisabled();
    await expect.poll(saved, { timeout: 5000 }).not.toContain(victimId);

    // What this test wrote to history is placements only (nl-3s5.19): no
    // species attributes on disk. The remove is the last entry; with no history
    // before it, the server also wrote an "Initial layout" entry.
    const history = await readScratchHistory('plant-redo');
    const written = history.entries.slice(Math.min(historyBefore, history.entries.length - 1));
    expect(written.length).toBeGreaterThanOrEqual(1);
    for (const entry of written) {
      for (const plant of entry.plants) {
        expect(Object.keys(plant).sort()).toEqual(['id', 'speciesId', 'x', 'y']);
      }
    }
  });
});
