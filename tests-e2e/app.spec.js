import { test, expect } from '@playwright/test';
import { openProject, readLayoutRows } from './helpers.js';

// These specs assert on DOM structure rather than screenshots: the point is a
// cheap, readable signal that the real page boots and renders the real CSV.

test.describe('backyard project', () => {
  test('boots and renders every layout row in all three views', async ({ page }) => {
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await openProject(page, 'backyard');

    const rows = await readLayoutRows('backyard');
    expect(rows.length).toBeGreaterThan(0);

    for (const svgId of ['#topSvg', '#frontSvg', '#sideSvg']) {
      await expect(page.locator(`${svgId} g[data-plant-id]`)).toHaveCount(rows.length);
    }

    await expect(page.locator('#projectTitle')).toHaveText('Backyard Visualization');
    await expect(page.locator('#projectNotice')).toBeHidden();
    expect(consoleErrors).toEqual([]);
  });

  test('panel labels and elevations come from project.json', async ({ page }) => {
    await openProject(page, 'backyard');

    await expect(
      page.locator('[data-view-panel="frontView"] [data-view-label]')
    ).toHaveText('South elevation');
    await expect(
      page.locator('[data-view-panel="sideView"] [data-view-label]')
    ).toHaveText('East elevation');
    await expect(page.locator('#topSvg')).toHaveAttribute('viewBox', '0 0 800 600');
  });

  test('changing the month re-renders the plan view', async ({ page }) => {
    await openProject(page, 'backyard');

    // The first <path> in each group is the foliage dome, filled with
    // state.foliageColor. Compare the whole yard rather than one plant so the
    // spec does not depend on CSV row order or on one species' winter palette.
    const foliageFills = () =>
      page
        .locator('#topSvg g[data-plant-id]')
        .evaluateAll((groups) =>
          groups.map((group) => group.querySelector('path')?.getAttribute('fill') || '')
        );

    await page.locator('#monthSlider').fill('1');
    await expect(page.locator('#monthReadout')).toHaveText('January');
    const january = await foliageFills();

    await page.locator('#monthSlider').fill('6');
    await expect(page.locator('#monthReadout')).toHaveText('June');
    const june = await foliageFills();

    expect(january).toHaveLength(june.length);
    // Winter dormancy and summer foliage must not paint the yard identically.
    expect(january).not.toEqual(june);
  });

  test('layer visibility chips hide plants', async ({ page }) => {
    await openProject(page, 'backyard');

    const plants = page.locator('#topSvg g[data-plant-id]');
    const total = await plants.count();

    await page.locator('[data-layer-visibility="4"]').click();
    await expect(page.locator('[data-layer-visibility="4"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(await plants.count()).toBeLessThan(total);

    await page.locator('[data-layer-visibility="0"]').click();
    await expect(plants).toHaveCount(total);
  });

  test('positions are locked on a fresh visit', async ({ page }) => {
    await openProject(page, 'backyard');

    await expect(page.locator('#lockToggle')).toBeChecked();
    await expect(page.locator('#lockStatusText')).toHaveText(/locked/i);
  });
});

test.describe('project switching', () => {
  test('example-frontyard loads its own layout and elevations', async ({ page }) => {
    await openProject(page, 'example-frontyard');

    const rows = await readLayoutRows('example-frontyard');
    await expect(page.locator('#topSvg g[data-plant-id]')).toHaveCount(rows.length);
    await expect(page.locator('#projectSelect')).toHaveValue('example-frontyard');
  });

  test('an unknown project falls back to the default and says so', async ({ page }) => {
    await page.goto('/index.html?project=does-not-exist');
    await expect(page.locator('#projectNotice')).toBeVisible();
    await expect(page.locator('#projectNotice')).toContainText('does-not-exist');
    await expect(page.locator('#topSvg g[data-plant-id]').first()).toBeVisible();
  });
});

test.describe('hand-edited layout mistakes', () => {
  // planting_layout.csv is edited by hand, so a repeated id is a realistic
  // mistake. It must surface as an actionable banner naming the id and rows,
  // not the generic "couldn't load" advice about serving over HTTP. The bad CSV
  // is injected per-page rather than written to disk, so this cannot race the
  // other specs that read the same project.
  const badLayoutCsv = 'id,botanical_name,x_ft,y_ft\n'
    + 'holly-corner,Ilex vomitoria,9.849,25.278\n'
    + 'horseherb-fill,Calyptocarpus vialis,8.000,3.500\n'
    + 'holly-corner,Ilex vomitoria,11.000,26.000';

  test('a duplicate plant id explains itself in the page', async ({ page }) => {
    await page.route('**/projects/example-frontyard/planting_layout.csv*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/csv', body: badLayoutCsv })
    );

    await page.goto('/index.html?project=example-frontyard');

    const banner = page.locator('.error-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Duplicate plant id "holly-corner"');
    await expect(banner).toContainText('data rows 1 and 3');
    await expect(banner).toContainText('Fix the layout CSV');
    // The generic serving advice would send the user down the wrong path.
    await expect(banner).not.toContainText('npx serve');
  });

  test('a layout with distinct ids still boots clean', async ({ page }) => {
    await openProject(page, 'example-frontyard');

    await expect(page.locator('.error-banner')).toHaveCount(0);
  });
});
