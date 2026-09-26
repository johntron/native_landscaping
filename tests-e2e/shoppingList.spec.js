import { test, expect } from '@playwright/test';
import { SCRATCH_BASE } from './helpers.js';

// "Your shopping list" on sourcing.html (nl-46b). Starring writes
// /api/favorites, so this runs on the scratch server's throwaway app.db. The
// scratch yards are seeded with plants that are all planned, so the list is
// never empty; no count is asserted, because the seed may change.

test('the signed-in shopping list shows planned plants, narrows by yard, and stars a favorite to the top', async ({ page }) => {
  await page.goto(`${SCRATCH_BASE}/sourcing.html`);
  const section = page.locator('#shoppingListSection');
  await expect(section).toBeVisible();
  const rows = page.locator('#shoppingRows .shopping-row[data-species-id]');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('#shoppingSummary')).toContainText('plant');

  // Star the last row: favorites sort first, so it moves to the top.
  const last = rows.last();
  const speciesId = await last.getAttribute('data-species-id');
  await last.locator('.shopping-star').click();
  await expect(rows.first()).toHaveAttribute('data-species-id', speciesId);
  await expect(rows.first().locator('.shopping-star')).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(rows.first()).toHaveAttribute('data-species-id', speciesId);
  await rows.first().locator('.shopping-star').click(); // leave it as found
  await expect(page.locator(`#shoppingRows [data-species-id="${speciesId}"] .shopping-star`)).toHaveAttribute('aria-pressed', 'false');

  // Leaving every yard out empties the list; putting them back restores it.
  const boxes = page.locator('#shoppingYards input[type="checkbox"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i += 1) await boxes.nth(i).uncheck();
  await expect(page.locator('#shoppingRows')).toContainText('Choose a yard above.');
  for (let i = 0; i < n; i += 1) await boxes.nth(i).check();
  await expect(rows.first()).toBeVisible();
});
