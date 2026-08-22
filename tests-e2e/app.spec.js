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

    // 30 x 10 ft plus 2 ft of margin all round, at 27 px/ft.
    await expect(page.locator('#topSvg')).toHaveAttribute('viewBox', '0 0 918 378');
    // A view from the south looks along the yard's 30 ft width; one from the
    // east looks along its 10 ft depth. Both are derived, so both changed.
    await expect(page.locator('#southSvg')).toHaveAttribute('viewBox', /^0 0 918 /);
    await expect(page.locator('#eastSvg')).toHaveAttribute('viewBox', /^0 0 378 /);

    // Resolution rescales the drawing without changing the yard it covers.
    const resolution = page
      .locator('.setup-panel__field', { hasText: 'Resolution (px per ft)' })
      .locator('input');
    await resolution.fill('40');
    await resolution.press('Enter');
    await expect(page.locator('#topSvg')).toHaveAttribute('viewBox', '0 0 1360 560');
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

// Photo drags edit the view in memory; only the Save button writes, so these
// stay on the read-only server like the rest of the suite.
test.describe('setup overlay', () => {
  /** Centre of a panel, in viewport coordinates. */
  async function panelCentre(page, svgId) {
    // page.mouse works in viewport coordinates, and a panel sitting below the
    // fold is out of reach.
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'center' }), svgId);
    return page.evaluate((id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, svgId);
  }

  /** The photo's outline, in the drawing's own pixels. */
  const photoRect = (page, svgId) =>
    page.locator(`#${svgId} rect[data-setup-photo]`).evaluate((node) => ({
      x: Number(node.getAttribute('x')),
      y: Number(node.getAttribute('y')),
      width: Number(node.getAttribute('width')),
    }));

  const fieldValue = (page, label) =>
    page.locator('.setup-panel__field', { hasText: label }).locator('input').inputValue();

  test('guides appear only in setup mode, and only one view is live', async ({ page }) => {
    await openProject(page, 'backyard');
    const overlays = page.locator('[data-setup-overlay]');
    const live = page.locator('[data-setup-interactive="true"]');
    await expect(overlays).toHaveCount(0);

    await page.locator('[data-mode="edit"]').click();
    await expect(overlays).toHaveCount(0);

    // Every view draws the guides — the foot grid and the yard outline are
    // cross-view references and are useless in one panel alone — but exactly
    // one is live, so there is only ever one answer to which view is being set
    // up.
    await page.locator('[data-mode="setup"]').click();
    const viewCount = await page.locator('.view svg').count();
    expect(viewCount).toBeGreaterThan(1);
    await expect(overlays).toHaveCount(viewCount);
    await expect(live).toHaveCount(1);
    await expect(page.locator('#topSvg [data-setup-interactive="true"]')).toHaveCount(1);
    // The photo outline marks the one panel whose picture can be dragged.
    await expect(page.locator('#topSvg rect[data-setup-photo]')).toHaveCount(1);
    // And the yard's own corner is drawn, so there is something to line up to.
    await expect(page.locator('#topSvg circle[data-setup-guide="origin"]')).toHaveCount(1);

    // Selecting another view moves the live overlay rather than adding a second.
    await page.locator('.setup-panel__item', { hasText: 'East elevation' }).locator('.setup-panel__pick').click();
    await expect(page.locator('#eastSvg [data-setup-interactive="true"]')).toHaveCount(1);
    await expect(live).toHaveCount(1);
    await expect(page.locator('#topSvg rect[data-setup-photo]')).toHaveCount(0);

    await page.locator('[data-mode="view"]').click();
    await expect(overlays).toHaveCount(0);
  });

  test('dragging moves the photo and leaves the drawing exactly where it was', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();
    await page.locator('.setup-panel__item', { hasText: 'East elevation' }).locator('.setup-panel__pick').click();

    const groundY = () =>
      page.locator('#eastSvg line[data-setup-guide="ground"]').getAttribute('y1');
    const plantPath = () =>
      page.locator('#eastSvg g[data-plant-id]').first().locator('path').first().getAttribute('d');

    const before = {
      ground: await groundY(),
      plant: await plantPath(),
      photo: await photoRect(page, 'eastSvg'),
      viewBox: await page.locator('#eastSvg').getAttribute('viewBox'),
    };

    const start = await panelCentre(page, 'eastSvg');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 50, start.y - 40, { steps: 8 });
    await page.mouse.up();

    // This is the inversion the whole redesign turns on. The yard is fixed, so
    // the ground line, the plants standing on it, and the drawing's own size
    // are all untouched; the photograph is what moved.
    expect(await groundY()).toBe(before.ground);
    expect(await plantPath()).toBe(before.plant);
    expect(await page.locator('#eastSvg').getAttribute('viewBox')).toBe(before.viewBox);
    const after = await photoRect(page, 'eastSvg');
    expect(after.x).toBeGreaterThan(before.photo.x);
    expect(after.y).toBeLessThan(before.photo.y);
    expect(after.width).toBeCloseTo(before.photo.width, 6); // moved, never rescaled
  });

  test('a photo drag keeps following the pointer across many frames', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const start = await panelCentre(page, 'topSvg');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();

    // Re-rendering the panels used to re-append every one of them, and moving an
    // element in the DOM drops its pointer capture — so the drag died on the
    // first repaint. Step slowly enough to cross several frames.
    const offsets = [];
    for (let step = 1; step <= 5; step += 1) {
      await page.mouse.move(start.x + step * 12, start.y, { steps: 2 });
      await page.waitForTimeout(120);
      offsets.push((await photoRect(page, 'topSvg')).x);
    }
    await page.mouse.up();

    // Every step must have carried the photo further east; a dropped capture
    // shows up as the value freezing after the first move.
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i], `step ${i + 1} kept tracking (saw ${offsets.join(', ')})`).toBeGreaterThan(
        offsets[i - 1]
      );
    }
  });

  test('measuring a known length rescales the photo, not the yard', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    // Arming the ruler suspends photo dragging on the selected view.
    await page.locator('[data-ruler-toggle]').click();
    await expect(page.locator('[data-ruler-toggle]')).toHaveAttribute('aria-pressed', 'true');

    const beforeYard = await fieldValue(page, 'East–west (ft)');
    const beforeViewBox = await page.locator('#topSvg').getAttribute('viewBox');
    const beforePhoto = await photoRect(page, 'topSvg');

    // Drag across exactly half the panel. Two round-trips on purpose: the
    // scroll has to land before the rect is read, or the drag starts at
    // coordinates the page has since moved.
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

    // Half the panel is far more than 10 ft, so the photo shrinks — and the
    // yard, which was never what was wrong, does not move at all.
    await expect(page.locator('.setup-panel__status')).toContainText("photo to");
    expect((await photoRect(page, 'topSvg')).width).toBeLessThan(beforePhoto.width);
    expect(await fieldValue(page, 'East–west (ft)')).toBe(beforeYard);
    expect(await page.locator('#topSvg').getAttribute('viewBox')).toBe(beforeViewBox);
    // The segment belongs to the photo's old scale, so it must not survive.
    await expect(page.locator('#topSvg line[data-setup-ruler]')).toHaveCount(0);
  });

  test('a yard edit invalidates a standing measurement', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();
    await page.locator('[data-ruler-toggle]').click();

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
    await page.mouse.move(span.to, span.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('#topSvg line[data-setup-ruler]')).toHaveCount(1);

    // Resizing the yard rescales every drawing, so a segment measured at 600 px
    // would be drawn outside a view that has since shrunk past it.
    const eastWest = page
      .locator('.setup-panel__field', { hasText: 'East–west (ft)' })
      .locator('input');
    await eastWest.fill('12');
    await eastWest.press('Enter');
    await expect(page.locator('#topSvg line[data-setup-ruler]')).toHaveCount(0);
  });

  test('the photo can be put back to filling its panel', async ({ page }) => {
    await openProject(page, 'backyard');
    await page.locator('[data-mode="setup"]').click();

    const start = await panelCentre(page, 'topSvg');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y, { steps: 6 });
    await page.mouse.up();
    expect((await photoRect(page, 'topSvg')).x).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Reset photo to fill the panel' }).click();
    expect((await photoRect(page, 'topSvg')).x).toBe(0);
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
