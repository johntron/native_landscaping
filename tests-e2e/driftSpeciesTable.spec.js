import { test, expect } from '@playwright/test';
import { openScratchProject } from './helpers.js';

/**
 * The species table's per-drift entries and the plan's single grouped drift
 * label (nl-o47.6.7), desktop/mouse coverage. Seeded by
 * tests-e2e/scratch-fixture.mjs's SPECIES_DRIFT_LAYOUT_CSV: winecup has two
 * drifts ("winecup-drift", 4 members; "winecup-2", 3 members) plus one
 * winecup planted in no drift at all, and horseherb has one lone plant and
 * no drift.
 *
 * Read-only throughout — clicking a drift entry selects it (Edit mode) or
 * highlights it (View mode), and neither writes anything — but the custom
 * layout only exists on the scratch server, so this still opens through
 * openScratchProject rather than openProject.
 */

const winecupRow = (page) => page.locator('#speciesTable tr[data-species-key="winecup"]');
const horseherbRow = (page) => page.locator('#speciesTable tr[data-species-key="horseherb"]');
const driftChip = (page, driftId) =>
  page.locator(`#speciesTable button.species-table__drift-chip[data-drift-id="${driftId}"]`);
const rings = (page) => page.locator('#topSvg circle[stroke-dasharray="7 6"]');

test.describe('species table drift entries (nl-o47.6.7)', () => {
  test('a species with drifts shows a summary, one entry per drift, and a single count; a species with none is unaffected', async ({
    page,
  }) => {
    await openScratchProject(page, 'desktop-drift-species');

    const summary = winecupRow(page).locator('.species-table__drifts-summary');
    await expect(summary).toHaveText(/2 drifts, 8 plants/);

    await expect(driftChip(page, 'winecup-drift')).toHaveText('Winecup drift · 4 plants');
    await expect(driftChip(page, 'winecup-2')).toHaveText('Winecup 2 · 3 plants');
    await expect(winecupRow(page).locator('.species-table__drift-single')).toHaveText('1 single');

    // horseherb has one plant and no drift at all: nothing new to show.
    await expect(horseherbRow(page).locator('.species-table__drifts-summary')).toHaveCount(0);
    await expect(horseherbRow(page).locator('.species-table__drift-chip')).toHaveCount(0);
    await expect(horseherbRow(page).locator('.species-table__drift-single')).toHaveCount(0);
  });

  test('clicking a drift entry in Edit mode selects the whole drift', async ({ page }) => {
    await openScratchProject(page, 'desktop-drift-species');
    await page.locator('[data-mode="edit"]').click();

    await driftChip(page, 'winecup-drift').click();

    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();
    await expect(page.locator('#selectionDriftCountLabel')).toContainText('4 plants');
    await expect(page.locator('#topSvg [data-drift-outline]')).toBeVisible();
    expect(await page.locator('#topSvg [data-selection-ring]').count()).toBe(4);
  });

  test('clicking a drift entry in View mode rings exactly that drift’s members, not the whole species; clicking again clears it', async ({
    page,
  }) => {
    await openScratchProject(page, 'desktop-drift-species');

    await driftChip(page, 'winecup-2').click();
    await expect(rings(page)).toHaveCount(3);
    await expect(driftChip(page, 'winecup-2')).toHaveClass(/is-highlighted/);

    await driftChip(page, 'winecup-2').click(); // a second click toggles it off
    await expect(rings(page)).toHaveCount(0);
    await expect(driftChip(page, 'winecup-2')).not.toHaveClass(/is-highlighted/);
  });

  test('picking a different drift in View mode swaps the highlight rather than adding to it', async ({ page }) => {
    await openScratchProject(page, 'desktop-drift-species');

    await driftChip(page, 'winecup-drift').click();
    await expect(rings(page)).toHaveCount(4);

    await driftChip(page, 'winecup-2').click();
    await expect(rings(page)).toHaveCount(3);
    await expect(driftChip(page, 'winecup-drift')).not.toHaveClass(/is-highlighted/);
  });
});

test.describe('the plan’s single grouped drift label (nl-o47.6.7)', () => {
  test('with labels on, each drift gets one label at its own centroid; a plant in no drift keeps its own', async ({
    page,
  }) => {
    await openScratchProject(page, 'desktop-drift-species');

    await expect(page.locator('#topSvg text[data-drift-label="winecup-drift"]')).toHaveText('Winecup drift ×4');
    await expect(page.locator('#topSvg text[data-drift-label="winecup-2"]')).toHaveText('Winecup 2 ×3');

    // No member of either drift draws a label of its own.
    for (const id of ['wa', 'wb', 'wc', 'wd', 'wx', 'wy', 'wz']) {
      await expect(page.locator(`#topSvg g[data-plant-id="${id}"] text`)).toHaveCount(0);
    }
    // The ungrouped single, and the unrelated lone horseherb, are unaffected.
    await expect(page.locator('#topSvg g[data-plant-id="single-winecup"] text')).toHaveCount(1);
    await expect(page.locator('#topSvg g[data-plant-id="lone-horseherb"] text')).toHaveCount(1);
  });

  test('selecting a drift in Edit mode swaps its own group label for individual member labels; other drifts keep theirs', async ({
    page,
  }) => {
    await openScratchProject(page, 'desktop-drift-species');
    await page.locator('[data-mode="edit"]').click();

    await driftChip(page, 'winecup-drift').click();
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();

    await expect(page.locator('#topSvg text[data-drift-label="winecup-drift"]')).toHaveCount(0);
    for (const id of ['wa', 'wb', 'wc', 'wd']) {
      await expect(page.locator(`#topSvg g[data-plant-id="${id}"] text`)).toHaveCount(1);
    }
    // The OTHER drift is untouched: still one grouped label, no member labels.
    await expect(page.locator('#topSvg text[data-drift-label="winecup-2"]')).toHaveText('Winecup 2 ×3');
    for (const id of ['wx', 'wy', 'wz']) {
      await expect(page.locator(`#topSvg g[data-plant-id="${id}"] text`)).toHaveCount(0);
    }
  });
});
