import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { openProject } from './helpers.js';

// Read-only: both exports build a zip in the browser and download it; nothing
// is posted, so the default server and a shipped project are safe here. The
// assertions stay off the project's own geometry and ids (see docs/testing.md);
// they check the zip's shape and that the page is put back afterwards.

async function downloadZip(page, buttonId) {
  const button = page.locator(buttonId);
  await expect(button).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  return { name: download.suggestedFilename(), files: Object.keys(zip.files).sort(), zip };
}

async function viewIds(page) {
  return page.locator('[data-view-panel]').evaluateAll((panels) =>
    panels.map((panel) => panel.getAttribute('data-view-panel'))
  );
}

test.describe('the design tool downloads', () => {
  test.beforeEach(async ({ page }) => {
    await openProject(page, 'backyard');
    // Leave the page somewhere other than the export month, so a failed
    // restore is visible.
    await page.locator('#monthSlider').fill('10');
    await expect(page.locator('#monthReadout')).toHaveText('October');
  });

  test('the plan bundle holds the catalog, the layout, and one PNG per view', async ({ page }) => {
    const { name, files, zip } = await downloadZip(page, '#exportBundleBtn');
    expect(name).toBe('backyard-plan.zip');
    const pngs = (await viewIds(page)).map((id) => `images/${id}-view.png`);
    for (const file of ['plants.csv', 'plant-drawing.csv', 'planting_layout.csv', ...pngs]) {
      expect(files).toContain(file);
    }
    expect(await zip.file('planting_layout.csv').async('string')).toMatch(/^id,species_id,x_ft,y_ft/);
    // Both halves of the catalog, so the bundle reproduces the plants as drawn (nl-3s5.21).
    expect(await zip.file('plant-drawing.csv').async('string')).toMatch(/^id,flower_color,.*,source\r?\n/);

    await expect(page.locator('#monthReadout')).toHaveText('October');
    await expect(page.locator('#monthSlider')).toHaveValue('10');
    await expect(page.locator('#exportBundleBtn')).toBeEnabled();
    await expect(page.locator('#exportBundleBtn')).toHaveText('Download plan bundle (zip)');
  });

  test('the HOA packet holds a cover letter and one PNG per view', async ({ page }) => {
    const { name, files, zip } = await downloadZip(page, '#exportHoaBtn');
    expect(name).toBe('backyard-hoa-packet.zip');
    const pngs = (await viewIds(page)).map((id) => `images/${id}-view.png`);
    for (const file of ['cover-letter.txt', ...pngs]) {
      expect(files).toContain(file);
    }
    expect(files).not.toContain('plants.csv');
    expect(files).not.toContain('plant-drawing.csv');
    expect((await zip.file('cover-letter.txt').async('string')).length).toBeGreaterThan(100);

    await expect(page.locator('#monthReadout')).toHaveText('October');
    await expect(page.locator('#exportHoaBtn')).toBeEnabled();
    await expect(page.locator('#exportHoaBtn')).toHaveText('Download HOA submission packet (zip)');
  });
});
