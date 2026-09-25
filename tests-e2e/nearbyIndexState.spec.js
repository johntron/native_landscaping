import { test, expect } from '@playwright/test';

// Read-only. The nearby-species index is per yard and built in the background
// once the yard has a location (nl-3s5.6). The e2e yards are seeded without a
// location (scratch-fixture.mjs leaves location.json out), so the page and the
// drawer must say so plainly, never show an empty table or a manual command.

test('a yard with no location says so in the species table and the plant matches', async ({ page }) => {
  await page.goto('/ecosystem.html?project=backyard');
  const state = page.locator('#ecosystemRows td[data-index-state]');
  await expect(state).toHaveAttribute('data-index-state', 'no-location');
  await expect(state).toContainText('has no location set');
  await expect(page.locator('#plantMatchesNote')).toContainText('has no location set');
  await expect(page.locator('#ecosystemRows')).not.toContainText('npm run ecosystem:fetch');
});

test('the drawer says the same, and asks again on the next open', async ({ page }) => {
  await page.goto('/ecosystem.html?project=backyard');
  const tab = page.locator('#ecoDrawerTab');
  const body = page.locator('#ecoDrawerBody');
  await tab.click();
  await expect(body).toContainText('has no location set');

  // A waiting state is not cached: reopening fetches the index again.
  await page.locator('#ecoDrawerClose').click();
  const refetch = page.waitForRequest((request) => request.url().includes('/api/ecosystem?project=backyard'));
  await tab.click();
  await refetch;
  await expect(body).toContainText('has no location set');
});
