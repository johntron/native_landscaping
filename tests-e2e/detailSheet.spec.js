import { test, expect } from '@playwright/test';
import { openProject, plantPointerTarget } from './helpers.js';

// Read-only: opening and closing the sheet saves nothing, so the default server
// and a shipped project are safe. Nothing here names a plant; which one is
// under the pointer is read back off the sheet (canopies overlap).

test.describe('the plant detail sheet', () => {
  test('opens on a plant with its facts, and the close button dismisses it', async ({ page }) => {
    await openProject(page, 'backyard');
    const target = await plantPointerTarget(page, 'topSvg');
    await page.mouse.click(target.x, target.y);

    const sheet = page.locator('#detailSheet');
    await expect(sheet).toBeVisible();
    const plantId = await sheet.getAttribute('data-plant-id');
    expect(plantId).toBeTruthy();
    await expect(page.locator('#detailSheetTitle')).not.toBeEmpty();
    expect(await page.locator('#detailSheetLines li').count()).toBeGreaterThan(0);

    await page.locator('.detail-sheet__close').click();
    await expect(sheet).toBeHidden();
    expect(await sheet.getAttribute('data-plant-id')).toBeNull();
  });

  test('Escape dismisses it too', async ({ page }) => {
    await openProject(page, 'backyard');
    const target = await plantPointerTarget(page, 'topSvg');
    await page.mouse.click(target.x, target.y);
    await expect(page.locator('#detailSheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#detailSheet')).toBeHidden();
  });
});
