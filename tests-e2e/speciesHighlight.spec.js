import { test, expect } from '@playwright/test';
import { openProject, plantPointerTarget } from './helpers.js';

// Read-only: hovering saves nothing. Which species is used is read off the
// page, never named (see docs/testing.md).

const rings = (page) => page.locator('#topSvg circle[stroke-dasharray="7 6"]');

test.describe('species highlighting between the table and the drawing', () => {
  test('hovering a table row rings exactly that species in the plan, and leaving clears it', async ({ page }) => {
    await openProject(page, 'backyard');
    const row = page.locator('#speciesTable tr[data-species-key]').first();
    const key = await row.getAttribute('data-species-key');
    const plantsOfSpecies = await page.locator(`#topSvg g[data-species-key="${key}"]`).count();
    expect(plantsOfSpecies).toBeGreaterThan(0);

    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await expect(row).toHaveClass(/is-highlighted/);
    await expect(rings(page)).toHaveCount(plantsOfSpecies);

    await page.locator('h1').hover();
    await expect(row).not.toHaveClass(/is-highlighted/);
    await expect(rings(page)).toHaveCount(0);
  });

  test('hovering a plant in Edit mode highlights its species row', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="edit"]').click();
    const target = await plantPointerTarget(page, 'topSvg');
    await page.mouse.move(target.x, target.y);

    const highlighted = page.locator('#speciesTable tr.is-highlighted');
    await expect(highlighted).toHaveCount(1);
    const key = await highlighted.getAttribute('data-species-key');
    await expect(rings(page).first()).toBeVisible();
    expect(await page.locator(`#topSvg g[data-species-key="${key}"]`).count()).toBeGreaterThan(0);
  });
});
