import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { parseCsv } from '../src/data/csvLoader.js';
import { searchSpecies } from '../src/data/speciesSearch.js';
import { openScratchProject, plantPointerTarget, readScratchHistory, readScratchLayout } from './helpers.js';

// Adding and removing both auto-save through POST /api/layout, so these run
// against the throwaway document root built by scratch-fixture.mjs — never the
// repo's own projects/. Each spec owns a project, because a change in one would
// alter the count the other asserts on.

const planPlants = (page) => page.locator('#topSvg g[data-plant-id]');

/**
 * The same catalog the Add plant sheet reads, shaped the way it shapes it
 * (src/ui/addPlantSheet.js / src/sourcing/shoppingListPage.js). Read directly
 * from the repo's own plants.csv (the scratch server's public dir is a copy of
 * it) so the search/sort/native-chip assertions below check the sheet against
 * the real catalog's own searchSpecies() output, rather than a hand-picked
 * species name that could go stale.
 */
function catalogSpecies() {
  const csv = readFileSync(new URL('../plants.csv', import.meta.url), 'utf8');
  return parseCsv(csv).map((row) => ({
    speciesId: row.id,
    commonName: row.common_name,
    botanicalName: row.botanical_name,
    nativity: row.nativity_nctx,
  }));
}

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

/** Open the Add plant sheet from Edit mode. */
async function openAddPlantSheet(page) {
  await page.locator('[data-mode="edit"]').click();
  await page.locator('#addPlantBtn').click();
  await expect(page.locator('#addPlantSheet')).toBeVisible();
}

test.describe('adding and removing plants', () => {
  test('adding a plant from the catalog draws it, targets it, and saves it', async ({ page }) => {
    await openScratchProject(page, 'plant-add');
    await openAddPlantSheet(page);

    const before = await planPlants(page).count();
    const savedBefore = (await readScratchLayout('plant-add')).length;

    // Pick the first row off the list.
    const firstRow = page.locator('#addPlantList .add-plant-sheet__row').first();
    await firstRow.locator('.add-plant-sheet__pick').click();

    // The sheet closes itself and focus returns to the button that opened it.
    await expect(page.locator('#addPlantSheet')).toBeHidden();
    await expect(page.locator('#addPlantBtn')).toBeFocused();

    await expect(planPlants(page)).toHaveCount(before + 1);
    // Targeted the way a click on the plant would (setTargetedPlant, nl-o47.3):
    // renderTopView draws exactly one target ring, in its own fixed colour,
    // for whichever plant is targeted or hovered — nothing else here is hovered.
    await expect(page.locator('#topSvg circle[stroke="#1b74d8"]')).toHaveCount(1);

    // The add reached disk, not just the DOM. The save is a POST, so poll.
    await expect
      .poll(async () => (await readScratchLayout('plant-add')).length, { timeout: 5000 })
      .toBe(savedBefore + 1);

    // And the saved row reloads.
    await openScratchProject(page, 'plant-add');
    await expect(planPlants(page)).toHaveCount(before + 1);
  });

  test('search, sort and the native chip narrow the list the way searchSpecies() does', async ({ page }) => {
    // Read-only: nothing is added, so no layout is written.
    await openScratchProject(page, 'plant-add');
    await openAddPlantSheet(page);
    const rows = page.locator('#addPlantList .add-plant-sheet__row');
    const species = catalogSpecies();
    const total = await rows.count();
    expect(total).toBe(searchSpecies(species).length);

    await page.locator('#addPlantSearch').fill('YARR');
    const narrowed = searchSpecies(species, { query: 'YARR' });
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.length).toBeLessThan(total);
    await expect(rows).toHaveCount(narrowed.length);

    // Sorting by scientific name reorders the rows; compare the rendered
    // order (each row carries its species id) against searchSpecies() itself,
    // rather than a hand-picked plant name that could go stale.
    await page.locator('#addPlantSearch').fill('');
    await page.locator('#addPlantSort').selectOption('botanical');
    const botanicalOrder = searchSpecies(species, { sortBy: 'botanical' }).map((entry) => entry.speciesId);
    expect(botanicalOrder.length).toBeGreaterThan(1); // otherwise reordering proves nothing
    await expect(rows).toHaveCount(botanicalOrder.length);
    expect(await rows.evaluateAll((els) => els.map((el) => el.dataset.speciesId))).toEqual(botanicalOrder);

    await page.locator('#addPlantSearch').fill('zzzz no such plant');
    await expect(rows).toHaveCount(0);
    await expect(page.locator('#addPlantStatus')).toHaveText('No plants match.');

    await page.locator('#addPlantSearch').fill('');
    await expect(rows).toHaveCount(total);

    // The native chip keeps just the rows badged native (a cultivar is badged "Cultivar").
    await page.locator('#addPlantNativeChip').click();
    await expect(page.locator('#addPlantNativeChip')).toHaveAttribute('aria-pressed', 'true');
    const natives = searchSpecies(species, { sortBy: 'botanical', nativeOnly: true });
    expect(natives.length).toBeGreaterThan(0);
    expect(natives.length).toBeLessThan(total);
    await expect(rows).toHaveCount(natives.length);
    for (const text of await rows.locator('.add-plant-sheet__badge').allTextContents()) {
      expect(text).toBe('Native NCTX');
    }
    await page.locator('#addPlantNativeChip').click();
    await expect(rows).toHaveCount(total);
  });

  test('the star favorites a species from its row, filterable by the Favorites chip, and it survives a reload', async ({
    page,
  }) => {
    // Writes /api/favorites, so the scratch server (its own throwaway app.db).
    await openScratchProject(page, 'plant-add');
    await openAddPlantSheet(page);
    await page.locator('#addPlantSearch').fill('yarrow');
    const row = page.locator('#addPlantList .add-plant-sheet__row').first();
    const star = row.locator('.add-plant-sheet__star');
    await expect(star).toBeVisible();
    if ((await star.getAttribute('aria-pressed')) === 'true') await star.click(); // start from not-favorite
    await expect(star).toHaveAttribute('aria-pressed', 'false');

    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#addPlantFavoritesChip')).toBeVisible();

    // Filtering by Favorites still shows it.
    await page.locator('#addPlantFavoritesChip').click();
    await expect(page.locator('#addPlantList .add-plant-sheet__row')).toHaveCount(1);
    await page.locator('#addPlantFavoritesChip').click();

    await openScratchProject(page, 'plant-add');
    await openAddPlantSheet(page);
    await page.locator('#addPlantSearch').fill('yarrow');
    await expect(page.locator('#addPlantList .add-plant-sheet__row').first().locator('.add-plant-sheet__star')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await page.locator('#addPlantList .add-plant-sheet__row').first().locator('.add-plant-sheet__star').click(); // leave it as found
    await expect(page.locator('#addPlantList .add-plant-sheet__row').first().locator('.add-plant-sheet__star')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  test('Escape and the backdrop both dismiss the sheet without adding anything', async ({ page }) => {
    await openScratchProject(page, 'plant-add');
    const before = await planPlants(page).count();

    await openAddPlantSheet(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#addPlantSheet')).toBeHidden();
    await expect(page.locator('#addPlantBtn')).toBeFocused();

    await openAddPlantSheet(page);
    await page.locator('.add-plant-sheet__backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#addPlantSheet')).toBeHidden();

    await expect(planPlants(page)).toHaveCount(before);
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
