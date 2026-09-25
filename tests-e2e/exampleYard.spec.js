import { test, expect } from '@playwright/test';
import { SCRATCH_BASE, openProject, openScratchProject, plantPointerTarget } from './helpers.js';

// The shared, read-only example yard (nl-3s5.24). Both e2e servers seed it at
// startup from the tracked projects/backyard (server/db/exampleYard.js). The
// first test only reads, so it runs on the main server; copying writes, so it
// runs on the scratch server.

const MODE_KEY = 'native-landscaping-mode';

test('the example opens read-only: View only, no plant actions, and the viewer\'s own mode is kept', async ({ page }) => {
  // A viewer whose own yards open in Edit.
  await page.addInitScript((key) => localStorage.setItem(key, 'edit'), MODE_KEY);
  // The page must never try to write: not on load, not on a click.
  const writes = [];
  page.on('request', (req) => {
    if (req.method() !== 'GET' && new URL(req.url()).pathname.startsWith('/api/')) writes.push(`${req.method()} ${req.url()}`);
  });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await openProject(page, 'example');
  expect(await page.evaluate(() => document.body.dataset.readOnly)).toBe('true');

  await expect(page.locator('#exampleBanner')).toBeVisible();
  await expect(page.locator('#exampleBanner')).toContainText('read only');
  await expect(page.locator('#copyExampleBtn')).toBeVisible();
  await expect(page.locator('#projectTitle')).toContainText('read only');

  await expect(page.locator('[data-mode="view"]')).toBeVisible();
  await expect(page.locator('[data-mode="view"]')).toHaveAttribute('aria-pressed', 'true');
  for (const mode of ['edit', 'setup', 'features']) {
    await expect(page.locator(`[data-mode="${mode}"]`)).toBeHidden();
  }
  await expect(page.locator('#historyRow')).toBeHidden();
  await expect(page.locator('#editRow')).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), MODE_KEY)).toBe('edit');

  // The picker offers it beside the viewer's own yards.
  await expect(page.locator('#projectSelect option[value="example"]')).toHaveCount(1);
  await expect(page.locator('#projectSelect option[value="backyard"]')).toHaveCount(1);

  const target = await plantPointerTarget(page, 'topSvg');
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('#detailSheet')).toBeVisible();
  await expect(page.locator('#detailSheetCloneBtn')).toBeHidden();
  await expect(page.locator('#detailSheetRemoveBtn')).toBeHidden();
  await page.keyboard.press('Escape');

  await page.mouse.click(target.x, target.y, { button: 'right' });
  await expect(page.locator('.context-menu.is-open')).toHaveCount(0);

  expect(writes).toEqual([]);
  expect(errors).toEqual([]);

  // A background photo of the example is served to this (non-owner) viewer.
  const photo = await page.request.get('/api/project-photo?project=example&path=img/top.webp');
  expect(photo.status()).toBe(200);
});

test('Copy to my yards makes an editable private copy and opens it', async ({ page, request }) => {
  // The server refuses a write to the example itself, whatever the page does.
  const refused = await request.post(`${SCRATCH_BASE}/api/layout?project=example`, { data: { plants: [] } });
  expect(refused.status()).toBe(403);

  await openScratchProject(page, 'example');
  await page.locator('#copyExampleBtn').click();
  await page.waitForURL(/[?&]project=example-yard(?:-\d+)?(?:&|$)/);
  await page.locator('#topSvg g[data-plant-id]').first().waitFor();

  await expect(page.locator('#exampleBanner')).toBeHidden();
  await expect(page.locator('#projectTitle')).toHaveText('Your yard: My copy of the example yard');
  for (const mode of ['view', 'edit', 'setup', 'features']) {
    await expect(page.locator(`[data-mode="${mode}"]`)).toBeVisible();
  }
  const copyId = new URL(page.url()).searchParams.get('project');
  await expect(page.locator(`#projectSelect option[value="${copyId}"]`)).toHaveCount(1);
  await expect(page.locator('#projectSelect option[value="example"]')).toHaveCount(1);

  const history = await (await request.get(`${SCRATCH_BASE}/api/history?project=${copyId}`)).json();
  expect(history.entries).toHaveLength(1);
  expect(history.entries[0].description).toBe('Copied from the example yard');
});
