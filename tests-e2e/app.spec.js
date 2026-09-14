import { test, expect } from '@playwright/test';
import { openProject, openScratchProject, readLayoutRows } from './helpers.js';

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
    // 29.63 x 22.22 ft of yard plus 2 ft of margin all round, at 27 px/ft.
    await expect(page.locator('#topSvg')).toHaveAttribute('viewBox', '0 0 908 708');
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
    // Features shipped with the same gap, so this loop covers every button in
    // the switch rather than a list written out beside it.
    const paint = (mode) =>
      page.locator(`[data-mode="${mode}"]`).evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.backgroundImage}|${style.color}`;
      });

    const inactive = await paint('setup');
    const modes = await page.locator('.mode-switch__btn').evaluateAll((els) =>
      els.map((el) => el.dataset.mode)
    );
    expect(modes).toContain('features');
    for (const mode of modes) {
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

  test('the yard drives every view, and an invalid edit is refused', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    // ONE yard, typed once. Every view's drawing follows from it — which is
    // what makes the panels line up, and what nothing per-view can undo.
    const eastWest = page
      .locator('.setup-panel__field', { hasText: 'East–west (ft)' })
      .locator('input');
    const northSouth = page
      .locator('.setup-panel__field', { hasText: 'North–south (ft)' })
      .locator('input');
    await eastWest.fill('30');
    await eastWest.press('Enter');
    await northSouth.fill('10');
    await northSouth.press('Enter');
    await expect(eastWest).toHaveValue('30'); // one axis never rewrites the other

    // Read outside Setup, which widens the SHOWN view's window to leave room
    // for positioning its photo.
    await page.locator('[data-mode="view"]').click();
    // 30 x 10 ft plus 2 ft of margin all round, at 27 px/ft.
    await expect(page.locator('#topSvg')).toHaveAttribute('viewBox', '0 0 918 378');
    // A view from the south looks along the yard's 30 ft width; one from the
    // east looks along its 10 ft depth. Both are derived, so both changed.
    await expect(page.locator('#southSvg')).toHaveAttribute('viewBox', /^0 0 918 /);
    await expect(page.locator('#eastSvg')).toHaveAttribute('viewBox', /^0 0 378 /);
    await page.locator('[data-mode="setup"]').click();

    // Resolution rescales the drawing without changing the yard it covers.
    const resolution = page
      .locator('.setup-panel__field', { hasText: 'Resolution (px per ft)' })
      .locator('input');
    await resolution.fill('40');
    await resolution.press('Enter');
    await page.locator('[data-mode="view"]').click();
    await expect(page.locator('#topSvg')).toHaveAttribute('viewBox', '0 0 1360 560');
    await page.locator('[data-mode="setup"]').click();
    await expect(eastWest).toHaveValue('30');

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

// Camera drags edit the view in memory; only the Save button writes, so these
// stay on the read-only server like the rest of the suite.
test.describe('setup overlay', () => {
  /** Where a camera's line sits in the plan drawing, in viewBox pixels. */
  const cameraAt = (page, id) =>
    page.locator(`#topSvg line[data-setup-camera="${id}"]`).evaluate((node) => ({
      x: Number(node.getAttribute('x1')),
      y: Number(node.getAttribute('y1')),
    }));

  /** Viewport coordinates of a point in the plan's own drawing units. */
  async function planPoint(page, x, y) {
    await page.evaluate(() => document.getElementById('topSvg').scrollIntoView({ block: 'center' }));
    return page.evaluate(
      ([px, py]) => {
        const svg = document.getElementById('topSvg');
        const rect = svg.getBoundingClientRect();
        const box = svg.viewBox.baseVal;
        // Setup widens the window and starts it at a negative origin, so the
        // offset counts as much as the scale.
        return {
          x: rect.left + ((px - box.x) * rect.width) / box.width,
          y: rect.top + ((py - box.y) * rect.height) / box.height,
        };
      },
      [x, y]
    );
  }

  test('setup shows one view at a time, with the yard drawn on it', async ({ page }) => {
    await openProject(page, 'backyard');
    const overlays = page.locator('[data-setup-overlay]');
    await expect(overlays).toHaveCount(0);

    await page.locator('[data-mode="edit"]').click();
    await expect(overlays).toHaveCount(0);

    // One panel, one overlay. Every panel used to draw guides so the foot grid
    // could be compared across views; the yard is declared now, so there is
    // nothing to align and the page's whole width goes to one drawing.
    await page.locator('[data-mode="setup"]').click();
    expect(await page.locator('.view-panel').count()).toBeGreaterThan(1);
    await expect(page.locator('.view-panel:visible')).toHaveCount(1);
    await expect(overlays).toHaveCount(1);
    await expect(page.locator('#topSvg circle[data-setup-guide="origin"]')).toHaveCount(1);
    await expect(page.locator('#topSvg rect[data-setup-guide="yard"]')).toHaveCount(1);

    // Selecting another view swaps which one is shown.
    await page.locator('.setup-panel__item', { hasText: 'East elevation' }).locator('.setup-panel__pick').click();
    await expect(page.locator('.view-panel:visible')).toHaveCount(1);
    await expect(page.locator('#eastSvg')).toBeVisible();
    await expect(page.locator('#topSvg')).toBeHidden();

    await page.locator('[data-mode="view"]').click();
    await expect(overlays).toHaveCount(0);
    await expect(page.locator('#topSvg')).toBeVisible();
  });

  test('the plan draws every elevation camera as one draggable object', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    // Both elevations, and each is a line plus an arrow grown off it — one
    // object, so the position and the direction cannot disagree.
    for (const id of ['south', 'east']) {
      await expect(page.locator(`#topSvg line[data-setup-camera="${id}"]`)).toHaveCount(1);
      await expect(page.locator(`#topSvg line[data-setup-camera-arrow="${id}"]`)).toHaveCount(1);
      await expect(page.locator(`#topSvg polygon[data-setup-camera-head="${id}"]`)).toHaveCount(1);
      await expect(page.locator(`#topSvg circle[data-setup-camera-grip="${id}"]`)).toHaveCount(1);
    }
  });

  test('dragging a camera moves that elevation, and only that one', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const before = { south: await cameraAt(page, 'south'), east: await cameraAt(page, 'east') };
    // South's camera runs across the drawing, so grab it anywhere along its line.
    const grip = await planPoint(page, 400, before.south.y);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x, grip.y - 60, { steps: 8 });
    await page.mouse.up();

    const after = { south: await cameraAt(page, 'south'), east: await cameraAt(page, 'east') };
    expect(after.south.y).toBeLessThan(before.south.y);
    // The arrow came with it — it is part of the same object.
    const shaftY = await page
      .locator('#topSvg line[data-setup-camera-arrow="south"]')
      .evaluate((n) => Number(n.getAttribute('y1')));
    expect(shaftY).toBeCloseTo(after.south.y, 6);
    // And nothing else moved.
    expect(after.east).toEqual(before.east);
  });

  test('a camera drag keeps following the pointer across many frames', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const start = await planPoint(page, 400, (await cameraAt(page, 'south')).y);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();

    // Re-rendering the panels used to re-append every one of them, and moving
    // an element in the DOM drops its pointer capture — so the drag died on the
    // first repaint. Step slowly enough to cross several frames.
    const seen = [];
    for (let step = 1; step <= 5; step += 1) {
      await page.mouse.move(start.x, start.y - step * 10, { steps: 2 });
      await page.waitForTimeout(120);
      seen.push((await cameraAt(page, 'south')).y);
    }
    await page.mouse.up();

    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i], `step ${i + 1} kept tracking (saw ${seen.join(', ')})`).toBeLessThan(
        seen[i - 1]
      );
    }
  });

  /** The photo's own rectangle in the drawing, as Setup renders it. */
  const photoRect = (page) =>
    page.locator('#topSvg image[data-setup-photo]').evaluate((node) => ({
      x: Number(node.getAttribute('x')),
      y: Number(node.getAttribute('y')),
      width: Number(node.getAttribute('width')),
      height: Number(node.getAttribute('height')),
    }));

  test('setup widens the drawing so the whole photo can be reached', async ({ page }) => {
    await openProject(page, 'backyard');
    const svg = page.locator('#topSvg');
    const narrow = await svg.getAttribute('viewBox');

    await page.locator('[data-mode="setup"]').click();
    const [x, y, w, h] = (await svg.getAttribute('viewBox')).split(' ').map(Number);
    // Same units and origin, a larger window: a photograph is routinely bigger
    // than the yard it covers, and one you can only see the middle of cannot be
    // positioned.
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
    expect(w).toBeGreaterThan(Number(narrow.split(' ')[2]));
    // And what falls outside the view — cropped everywhere else — is dimmed.
    await expect(page.locator('#topSvg [data-setup-crop]')).toHaveCount(1);

    await page.locator('[data-mode="view"]').click();
    expect(await svg.getAttribute('viewBox')).toBe(narrow);
  });

  test('dragging the photo moves it and leaves the drawing where it was', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const before = await photoRect(page);
    const groundBefore = await page.locator('#topSvg rect[data-setup-guide="yard"]').getAttribute('x');
    const start = await planPoint(page, before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y - 40, { steps: 8 });
    await page.mouse.up();

    const after = await photoRect(page);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeLessThan(before.y);
    // Moved, never rescaled — and the yard it is being lined up with did not budge.
    expect(after.width).toBeCloseTo(before.width, 6);
    expect(after.height).toBeCloseTo(before.height, 6);
    expect(await page.locator('#topSvg rect[data-setup-guide="yard"]').getAttribute('x')).toBe(
      groundBefore
    );
  });

  test('a corner keeps the photo\'s own proportions, whichever way it is pulled', async ({
    page,
  }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const before = await photoRect(page);
    const aspect = before.width / before.height;
    // Pull the bottom-right corner out, further on one axis than the other:
    // honouring both independently is what stretching IS.
    const grip = await planPoint(page, before.x + before.width, before.y + before.height);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 120, grip.y + 20, { steps: 8 });
    await page.mouse.up();

    const after = await photoRect(page);
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.width / after.height).toBeCloseTo(aspect, 3);
    // The opposite corner is pinned, so growth is away from it. Within a pixel:
    // a placement is stored to a hundredth of a foot, which at 27 px/ft is a
    // quarter of one.
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });

  test('the photo can be centred again, and the placement reaches the other views', async ({
    page,
  }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const before = await photoRect(page);
    const start = await planPoint(page, before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 90, start.y, { steps: 6 });
    await page.mouse.up();
    expect((await photoRect(page)).x).toBeGreaterThan(before.x);

    // Elsewhere the same placement is a CSS background, cropped to the view.
    await page.locator('[data-mode="view"]').click();
    const moved = await page
      .locator('[data-view-panel="plan"] .view')
      .evaluate((el) => el.style.backgroundPosition);
    expect(moved).not.toBe('');

    await page.locator('[data-mode="setup"]').click();
    await page.getByRole('button', { name: 'Centre the photo in the view' }).click();
    const centred = await photoRect(page);
    // Centred means centred: equal margins on each axis inside the view.
    const box = await page.locator('#topSvg').evaluate((node) => ({
      w: node.viewBox.baseVal.width,
      h: node.viewBox.baseVal.height,
      x: node.viewBox.baseVal.x,
      y: node.viewBox.baseVal.y,
    }));
    const viewW = box.w + 2 * box.x;
    expect(centred.x).toBeCloseTo(viewW - (centred.x + centred.width), 3);
  });

  test('plants and features are hidden in setup until asked for', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    // Setup is about the yard, not the planting; a full layout over a photo
    // being framed is noise.
    const plants = page.locator('#topSvg g[data-plant-id]').first();
    await expect(plants).toBeHidden();

    await page.locator('.setup-panel__checkbox', { hasText: 'Show plants' }).locator('input').check();
    await expect(plants).toBeVisible();

    // And every other mode is unaffected — they are hidden, not unrendered.
    await page.locator('[data-mode="view"]').click();
    await expect(plants).toBeVisible();
  });
});

test.describe('project switching', () => {
  test('example-frontyard loads its own layout and elevations', async ({ page }) => {
    await openProject(page, 'example-frontyard');

    const rows = await readLayoutRows('example-frontyard');
    await expect(page.locator('#topSvg g[data-plant-id]')).toHaveCount(rows.length);
    await expect(page.locator('#projectSelect')).toHaveValue('example-frontyard');
  });

  test('a photo that covers part of the yard is placed, not stretched to fit', async ({ page }) => {
    // The scratch fixture's own project, not example-frontyard: that one is
    // editable in the app, and a Setup Save dropping a view broke this test
    // twice (nl-2p3). The geometry asserted below is owned by
    // tests-e2e/scratch-fixture.mjs.
    await openScratchProject(page, 'placed-photo');

    await expect(page.locator('.view-panel')).toHaveCount(2);

    const style = await page
      .locator('[data-view-panel="plan"] .view')
      .evaluate((el) => ({
        image: el.style.backgroundImage,
        size: el.style.backgroundSize,
        position: el.style.backgroundPosition,
      }));
    expect(style.image).toContain('img/top.webp');

    // The panel is the 20 x 15 ft yard plus 2 ft of margin all round; the photo
    // covers 10 x 7.5 ft of it, starting 5 ft in from the origin.
    const PANEL = { width: 24, height: 19 };
    const PHOTO = { x: 5, y: 5, width: 10, height: 7.5 };
    const percents = (value) => value.split(' ').map((part) => Number.parseFloat(part));
    const [sizeX, sizeY] = percents(style.size);
    expect(sizeX).toBeCloseTo((PHOTO.width / PANEL.width) * 100, 2);
    expect(sizeY).toBeCloseTo((PHOTO.height / PANEL.height) * 100, 2);

    // Position divides by the leftover travel — panel minus photo — and the
    // photo's offset is measured from the panel's corner, 2 ft before the yard.
    const [posX, posY] = percents(style.position);
    expect(posX).toBeCloseTo(((PHOTO.x + 2) / (PANEL.width - PHOTO.width)) * 100, 2);
    // Plan y grows north while CSS y grows down, so the photo's TOP edge is its
    // north one: 19 - (5 + 7.5 + 2) = 4.5 ft down from the panel's top.
    expect(posY).toBeCloseTo((4.5 / (PANEL.height - PHOTO.height)) * 100, 2);

    // An unplaced photo still falls back to the stylesheet's `contain`.
    const elevationSize = await page
      .locator('[data-view-panel="south"] .view')
      .evaluate((el) => el.style.backgroundSize);
    expect(elevationSize).toBe('');
  });

  test('an unknown project falls back to the default and says so', async ({ page }) => {
    await page.goto('/design.html?project=does-not-exist');
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

    await page.goto('/design.html?project=example-frontyard');

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
