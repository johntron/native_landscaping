import { test, expect } from '@playwright/test';

// The landing page (index.html) is the front door and needs no project, so this
// is read-only and runs against the default server. It loads its tables from
// catalog/ and ecology/ at runtime; a moved or renamed file shows up here as an
// empty table and a failed request, not as a unit-test failure.

test.describe('the landing page', () => {
  test('loads its tables and offers a yard to open', async ({ page }) => {
    const failed = [];
    page.on('response', (res) => {
      if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
    });
    page.on('pageerror', (err) => failed.push(`pageerror ${err.message}`));

    await page.goto('/index.html');

    // "What belongs here": the keystone screen fills from
    // catalog/blackland-prairie-natives.csv and the ecology tables.
    await expect(page.locator('#pnRows tr').first()).toBeVisible();
    expect(await page.locator('#pnRows tr').count()).toBeGreaterThan(5);

    // "No invasives": filled from catalog/dfw-avoid-non-natives.csv.
    await expect(page.locator('#pnAvoidList li').first()).toBeVisible();

    // The handoff lists the projects and hands off to design.html.
    const picker = page.locator('#handoffProject');
    await expect(picker).toBeEnabled();
    expect(await picker.locator('option').count()).toBeGreaterThan(0);
    await expect(page.locator('#handoffOpen')).toBeEnabled();

    expect(failed).toEqual([]);
  });

  // nl-3s5.31: the screen's local evidence is a county's public records, never
  // one person's yard. It used to read the owner's site's nearby fauna.
  test('says its local evidence is the county, and reads no yard to get it', async ({ page }) => {
    const requested = [];
    page.on('request', (req) => requested.push(new URL(req.url()).pathname));
    await page.goto('/index.html');
    await expect(page.locator('#pnRows tr').first()).toBeVisible();

    expect(requested).toContain('/ecology/region-fauna.csv');
    expect(requested.filter((p) => /nearby-fauna|anchors\.csv|^\/api\/ecosystem/.test(p))).toEqual([]);

    await expect(page.locator('#pnHeadline')).toContainText('recorded in Dallas County, TX');
    await expect(page.locator('#pnHeadline')).not.toContainText('near this site');
    await expect(page.locator('#pnRegionNote')).toContainText('Dallas County, TX');
    await expect(page.locator('.pn-table thead')).toContainText('In county');
  });
});
