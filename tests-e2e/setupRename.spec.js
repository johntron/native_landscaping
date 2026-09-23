import { test, expect } from '@playwright/test';
import { openProject } from './helpers.js';

// Read-only: a Setup edit is applied in memory and only written by "Save
// views", which this never presses, so the default server and a shipped
// project are safe.

test('renaming the project in Setup retitles the page and the picker at once', async ({ page }) => {
  await openProject(page, 'backyard');
  await page.locator('[data-mode="setup"]').click();

  const name = page
    .locator('#setupRow .setup-panel__section', { has: page.locator('h3', { hasText: 'Project' }) })
    .locator('.setup-panel__field', { hasText: 'Name' })
    .locator('input')
    .first();
  await name.fill('Renamed yard');
  await name.press('Enter');

  await expect(page.locator('#projectTitle')).toHaveText('Your yard: Renamed yard');
  await expect(page).toHaveTitle('Your yard: Renamed yard · Rewilder');
  await expect(page.locator('#projectSelect option[value="backyard"]')).toHaveText('Renamed yard');
});
