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

    for (const svgId of ['#topSvg', '#southSvg', '#eastSvg']) {
      await expect(page.locator(`${svgId} g[data-plant-id]`)).toHaveCount(rows.length);
    }

    await expect(page.locator('#projectTitle')).toHaveText('Backyard Visualization');
    await expect(page.locator('#projectNotice')).toBeHidden();
    expect(consoleErrors).toEqual([]);
  });

  test('panel labels and elevations come from project.json', async ({ page }) => {
    await openProject(page, 'backyard');

    await expect(
      page.locator('[data-view-panel="south"] [data-view-label]')
    ).toHaveText('South elevation');
    await expect(
      page.locator('[data-view-panel="east"] [data-view-label]')
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

  test('layer visibility select hides plants', async ({ page }) => {
    await openProject(page, 'backyard');

    const plants = page.locator('#topSvg g[data-plant-id]');
    const total = await plants.count();

    await page.locator('#layerVisibilitySelect').selectOption('4');
    expect(await plants.count()).toBeLessThan(total);

    await page.locator('#layerVisibilitySelect').selectOption('0');
    await expect(plants).toHaveCount(total);
  });

  test('positions are locked on a fresh visit, in view mode', async ({ page }) => {
    await openProject(page, 'backyard');

    await expect(page.locator('[data-mode="view"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-mode="edit"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#editRow')).toBeHidden();
  });

  test('switching to edit mode unlocks positions and reveals edit controls', async ({ page }) => {
    await openProject(page, 'backyard');

    await page.locator('[data-mode="edit"]').click();
    await expect(page.locator('[data-mode="edit"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#editRow')).toBeVisible();
    await expect(page.locator('#labelToggle')).toBeVisible();
    await expect(page.locator('#scaleSlider')).toBeVisible();
    await expect(page.locator('#setupRow')).toBeHidden();
  });
});

// Setup mode edits the project's views[] in memory; only its Save button writes.
// Nothing here saves, so these run against the repo like every other spec.
test.describe('setup mode', () => {
  test('the third mode shows the view list and hides the edit controls', async ({ page }) => {
    await openProject(page, 'backyard');

    await page.locator('[data-mode="setup"]').click();
    await expect(page.locator('[data-mode="setup"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-mode="edit"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#setupRow')).toBeVisible();
    await expect(page.locator('#editRow')).toBeHidden();

    // One row per view, in the order the project declares them.
    const items = page.locator('.setup-panel__item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Plan');
    await expect(items.nth(1)).toContainText('South elevation');
    await expect(items.nth(2)).toContainText('East elevation');
  });

  test('every mode button looks active when it is', async ({ page }) => {
    await openProject(page, 'backyard');

    // The pill's active styling used to enumerate view and edit by name, so a
    // third mode read as pressed to a screen reader but looked unselected.
    const paint = (mode) =>
      page.locator(`[data-mode="${mode}"]`).evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.backgroundImage}|${style.color}`;
      });

    const inactive = await paint('setup');
    for (const mode of ['edit', 'setup', 'view']) {
      await page.locator(`[data-mode="${mode}"]`).click();
      await expect(page.locator(`[data-mode="${mode}"]`)).toHaveAttribute('aria-pressed', 'true');
      expect(await paint(mode), `${mode} is painted as the active mode`).not.toBe(inactive);
    }
  });

  test('mode survives a reload, and the old locked/unlocked flag migrates', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();
    await page.reload();
    await expect(page.locator('[data-mode="setup"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#setupRow')).toBeVisible();

    // A visitor from before Setup mode existed: unlocked meant Edit.
    await page.evaluate(() => {
      localStorage.removeItem('native-landscaping-mode');
      localStorage.setItem('native-landscaping-positions-locked', 'false');
    });
    await page.reload();
    await expect(page.locator('[data-mode="edit"]')).toHaveAttribute('aria-pressed', 'true');
    // Reading it migrates it, so the legacy key does not linger.
    expect(await page.evaluate(() => localStorage.getItem('native-landscaping-mode'))).toBe('edit');
    expect(
      await page.evaluate(() => localStorage.getItem('native-landscaping-positions-locked'))
    ).toBe(null);
  });

  test('adding and removing a view changes the panels with no reload', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    await page.locator('.setup-panel__add').click();
    await expect(page.locator('.view-panel')).toHaveCount(4);
    await expect(page.locator('[data-view-panel="view"] [data-view-label]')).toHaveText('New view');

    await page
      .locator('.setup-panel__item', { hasText: 'New view' })
      .locator('[aria-label="Remove"]')
      .click();
    await expect(page.locator('.view-panel')).toHaveCount(3);
  });

  test('form edits reach the drawing, and an invalid one is refused', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    // Feet are authored freely in both directions: a view can be 30 ft by 10 ft.
    // The drawing is derived, so the two never drift into a non-uniform scale.
    const width = page.locator('.setup-panel__field', { hasText: 'Width (ft)' }).locator('input');
    const height = page.locator('.setup-panel__field', { hasText: 'Height (ft)' }).locator('input');
    await width.fill('30');
    await width.press('Enter');
    await height.fill('10');
    await height.press('Enter');
    await expect(width).toHaveValue('30'); // setting height must not rewrite width
    await expect(page.locator('#topSvg')).toHaveAttribute('viewBox', '0 0 810 270');

    // Resolution rescales the drawing without changing the yard it covers.
    const resolution = page
      .locator('.setup-panel__field', { hasText: 'Resolution (px per ft)' })
      .locator('input');
    await resolution.fill('40');
    await resolution.press('Enter');
    await expect(page.locator('#topSvg')).toHaveAttribute('viewBox', '0 0 1200 400');
    await expect(width).toHaveValue('30');
    await expect(page.locator('[data-view-panel="plan"] [data-scale-summary]')).toHaveText(
      '1 ft ≈ 40 px'
    );

    const name = page.locator('.setup-panel__field', { hasText: 'Name' }).locator('input');
    await name.fill('Overhead');
    await name.press('Enter');
    await expect(page.locator('[data-view-panel="plan"] [data-view-label]')).toHaveText('Overhead');

    // A background that climbs out of the project directory is rejected, and the
    // drawing stays on the last good state rather than half-applying the edit.
    const panelCount = await page.locator('.view-panel').count();
    const background = page
      .locator('.setup-panel__field', { hasText: 'Background image' })
      .locator('input');
    await background.fill('../../etc/passwd');
    await background.press('Enter');
    await expect(page.locator('.setup-panel__status')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('.setup-panel__status')).toContainText(
      'relative to the project directory'
    );
    await expect(page.locator('.view-panel')).toHaveCount(panelCount);
    await expect(page.locator('[data-view-panel="plan"] [data-view-label]')).toHaveText('Overhead');
  });
});

// Handle drags edit the view in memory; only the Save button writes, so these
// stay on the read-only server like the rest of the suite.
test.describe('setup overlay', () => {
  /** Centre of an overlay handle, in viewport coordinates. */
  async function handlePoint(page, svgId, handleId) {
    // Centre the panel: page.mouse works in viewport coordinates, and a panel
    // sitting below the fold puts its handles out of reach.
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'center' }), svgId);
    return page.evaluate(
      ([id, handle]) => {
        const svg = document.getElementById(id);
        const rect = svg.getBoundingClientRect();
        const box = svg.viewBox.baseVal;
        const node = svg.querySelector(`circle[data-setup-handle="${handle}"]`);
        return {
          x: rect.left + (Number(node.getAttribute('cx')) * rect.width) / box.width,
          y: rect.top + (Number(node.getAttribute('cy')) * rect.height) / box.height,
        };
      },
      [svgId, handleId]
    );
  }

  const fieldValue = (page, label) =>
    page.locator('.setup-panel__field', { hasText: label }).locator('input').inputValue();

  test('guides appear only in setup mode, and only on the selected view', async ({ page }) => {
    await openProject(page, 'backyard');
    await expect(page.locator('[data-setup-overlay]')).toHaveCount(0);

    await page.locator('[data-mode="edit"]').click();
    await expect(page.locator('[data-setup-overlay]')).toHaveCount(0);

    await page.locator('[data-mode="setup"]').click();
    await expect(page.locator('#topSvg [data-setup-overlay]')).toHaveCount(1);
    await expect(page.locator('[data-setup-overlay]')).toHaveCount(1);

    // Selecting another view moves the guides rather than adding a second set.
    await page.locator('.setup-panel__item', { hasText: 'East elevation' }).locator('.setup-panel__pick').click();
    await expect(page.locator('#eastSvg [data-setup-overlay]')).toHaveCount(1);
    await expect(page.locator('[data-setup-overlay]')).toHaveCount(1);

    await page.locator('[data-mode="view"]').click();
    await expect(page.locator('[data-setup-overlay]')).toHaveCount(0);
  });

  test('dragging the east elevation ground line moves it and the plants on it', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();
    await page.locator('.setup-panel__item', { hasText: 'East elevation' }).locator('.setup-panel__pick').click();

    const groundY = () =>
      page.locator('#eastSvg line[data-setup-guide="ground"]').getAttribute('y1');
    const plantPath = () =>
      page.locator('#eastSvg g[data-plant-id]').first().locator('path').first().getAttribute('d');

    const beforeGround = Number(await groundY());
    const beforePlant = await plantPath();
    const beforeField = await fieldValue(page, 'Ground height (ft)');

    const start = await handlePoint(page, 'eastSvg', 'ground');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y - 40, { steps: 8 });
    await page.mouse.up();

    // The line moved up, the plants standing on it followed, and the numeric
    // field agrees — all without a reload.
    expect(Number(await groundY())).toBeLessThan(beforeGround);
    expect(await plantPath()).not.toBe(beforePlant);
    expect(await fieldValue(page, 'Ground height (ft)')).not.toBe(beforeField);
  });

  test('a handle drag keeps following the pointer across many frames', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const width = () => fieldValue(page, 'Width (ft)');
    const start = await handlePoint(page, 'topSvg', 'min-mid');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();

    // Re-rendering the panels used to re-append every one of them, and moving an
    // element in the DOM drops its pointer capture — so the drag died on the
    // first repaint. Step slowly enough to cross several frames.
    const widths = [];
    for (let step = 1; step <= 5; step += 1) {
      await page.mouse.move(start.x + step * 12, start.y, { steps: 2 });
      await page.waitForTimeout(120);
      widths.push(Number(await width()));
    }
    await page.mouse.up();

    // Every step must have narrowed the view further; a dropped capture shows up
    // as the value freezing after the first move.
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i], `step ${i + 1} kept tracking (saw ${widths.join(', ')})`).toBeLessThan(
        widths[i - 1]
      );
    }
  });

  test('measuring a known length in the photo rescales the view to match', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    // Arming the ruler suspends handle dragging on the selected view.
    await page.locator('[data-ruler-toggle]').click();
    await expect(page.locator('[data-ruler-toggle]')).toHaveAttribute('aria-pressed', 'true');

    // Drag across exactly half the panel, so the arithmetic is exact: whatever
    // that span is said to be, the whole view is twice it.
    // Two round-trips on purpose: the scroll has to land before the rect is
    // read, or the drag starts at coordinates the page has since moved.
    await page.evaluate(() => document.getElementById('topSvg').scrollIntoView({ block: 'center' }));
    const span = await page.evaluate(() => {
      const rect = document.getElementById('topSvg').getBoundingClientRect();
      return {
        y: rect.top + rect.height / 2,
        from: rect.left + rect.width * 0.25,
        to: rect.left + rect.width * 0.75,
      };
    });
    await page.mouse.move(span.from, span.y);
    await page.mouse.down();
    await page.mouse.move(span.to, span.y, { steps: 8 });
    // The segment is drawn while the drag is live, not only once it ends.
    await expect(page.locator('#topSvg line[data-setup-ruler]')).toHaveCount(1);
    await page.mouse.up();

    await expect(page.locator('.setup-panel__ruler-readout')).toContainText('px');
    await page.locator('[data-ruler-length]').fill('10');
    await page.locator('[data-ruler-length]').press('Enter');

    expect(Number(await fieldValue(page, 'Width (ft)'))).toBeCloseTo(20, 1);
    // The segment belongs to the old scale, so it must not survive the rescale.
    await expect(page.locator('#topSvg line[data-setup-ruler]')).toHaveCount(0);
    await expect(page.locator('.setup-panel__status')).toContainText('20 ft across');
  });

  test('dragging a plan edge handle resizes the view and the form together', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const beforeWidth = Number(await fieldValue(page, 'Width (ft)'));
    const beforeLeft = Number(await fieldValue(page, 'Left edge (ft)'));

    // Pull the left edge inward: the view covers less yard, starting further east.
    const start = await handlePoint(page, 'topSvg', 'min-mid');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y, { steps: 8 });
    await page.mouse.up();

    expect(Number(await fieldValue(page, 'Left edge (ft)'))).toBeGreaterThan(beforeLeft);
    expect(Number(await fieldValue(page, 'Width (ft)'))).toBeLessThan(beforeWidth);
    // The right-hand edge of the yard the view covers has not moved.
    const left = Number(await fieldValue(page, 'Left edge (ft)'));
    const width = Number(await fieldValue(page, 'Width (ft)'));
    expect(left + width).toBeCloseTo(beforeLeft + beforeWidth, 1);
  });
});

test.describe('project switching', () => {
  test('example-frontyard loads its own layout and elevations', async ({ page }) => {
    await openProject(page, 'example-frontyard');

    const rows = await readLayoutRows('example-frontyard');
    await expect(page.locator('#topSvg g[data-plant-id]')).toHaveCount(rows.length);
    await expect(page.locator('#projectSelect')).toHaveValue('example-frontyard');
  });

  test('a detail view borrows the plan photo and shows only its rectangle', async ({ page }) => {
    await openProject(page, 'example-frontyard');

    // Four panels: the multi-view path is only exercised in the browser here.
    await expect(page.locator('.view-panel')).toHaveCount(4);
    await expect(page.locator('[data-view-panel="street-bed"] [data-view-label]')).toHaveText(
      'Street bed'
    );

    const style = await page
      .locator('[data-view-panel="street-bed"] .view')
      .evaluate((el) => ({
        image: el.style.backgroundImage,
        size: el.style.backgroundSize,
        position: el.style.backgroundPosition,
      }));
    // The detail declares no background of its own; it crops the plan's photo to
    // its 9x6 ft rectangle at (3, 3). See src/render/backgroundCrop.js.
    expect(style.image).toContain('img/plan.svg');
    // Chrome re-serializes inline percentages, so compare the numbers.
    const percents = (value) => value.split(' ').map((part) => Number.parseFloat(part));
    const [sizeX, sizeY] = percents(style.size);
    expect(sizeX).toBeCloseTo((12 / 9) * 100, 2); // full width over crop width
    expect(sizeY).toBeCloseTo((25 / 6) * 100, 2);
    const [posX, posY] = percents(style.position);
    // The denominator is the leftover travel, not the full extent.
    expect(posX).toBeCloseTo(((3 - 2) / (12 - 9)) * 100, 2);
    // …and plan y grows north while CSS y grows down.
    expect(posY).toBeCloseTo(100 - ((3 - 2) / (25 - 6)) * 100, 2);

    // The stylesheet's 100% 100% stretch must still apply to the uncropped plan.
    const planSize = await page
      .locator('[data-view-panel="plan"] .view')
      .evaluate((el) => el.style.backgroundSize);
    expect(planSize).toBe('');

    // Plants inside the rectangle are drawn over the cropped photo. The set is
    // derived from the CSV rather than named, so curating the layout in the app
    // cannot turn this into a false failure.
    const inside = (await readLayoutRows('example-frontyard')).filter(
      (row) => row.xFt >= 3 && row.xFt <= 12 && row.yFt >= 3 && row.yFt <= 9
    );
    expect(inside.length).toBeGreaterThan(0);
    for (const row of inside) {
      await expect(page.locator(`#street-bedSvg g[data-plant-id="${row.id}"]`)).toHaveCount(1);
    }
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
