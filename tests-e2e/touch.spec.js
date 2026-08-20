import { test, expect } from '@playwright/test';
import {
  openScratchProject,
  plantPointerTarget,
  plantPosition,
  readScratchLayout,
  touchGesture,
} from './helpers.js';

// Real touch, on a phone-sized viewport. These specs complete drags, which
// auto-save through POST /api/layout, so they run against the throwaway
// document root — never the repo's own projects/.

/** The plant's saved position, once the POST lands. */
async function savedPosition(projectId, plantId) {
  const rows = await readScratchLayout(projectId);
  return rows.find((row) => row.id === plantId) || null;
}

test.describe('dragging by touch', () => {
  test('a mostly-vertical drag moves the plant instead of scrolling the page', async ({ page }) => {
    await openScratchProject(page, 'touch-plan');
    await page.locator('[data-mode="edit"]').click();

    const target = await plantPointerTarget(page, 'topSvg');
    const before = await plantPosition(page, target.id);
    const scrollBefore = await page.evaluate(() => window.scrollY);

    // Vertical is the interesting direction: it is the axis the page scroller
    // wants, and in plan view it is the yard's north/south axis.
    await touchGesture(page, { x: target.x, y: target.y, dy: 60 });

    const after = await plantPosition(page, target.id);
    expect(after, 'the plant is still on the drawing').not.toBeNull();
    expect(
      Math.abs(after.y - before.y),
      'the drag moved the plant rather than scrolling the page'
    ).toBeGreaterThan(1);
    expect(await page.evaluate(() => window.scrollY), 'the page did not scroll').toBe(scrollBefore);

    await expect
      .poll(async () => (await savedPosition('touch-plan', target.id))?.y, { timeout: 5000 })
      .not.toBe(undefined);
  });

  test('an elevation drag works by touch too', async ({ page }) => {
    // The elevation controller hit-tests through the DOM rather than
    // geometrically, so its touchstart target is a different element than the
    // plan view's — worth pinning separately even though both controllers get
    // is-drag-enabled from the same setLocked.
    await openScratchProject(page, 'touch-elevation');
    await page.locator('[data-mode="edit"]').click();

    const target = await plantPointerTarget(page, 'southSvg', 'elevation');
    // This controller picks the plant off the DOM, so the one that moves is
    // whichever silhouette is painted on top at the point — not necessarily the
    // group the helper measured. Ask the document, the way the app does.
    const plantId = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-plant-id]')?.getAttribute('data-plant-id'),
      target
    );
    expect(plantId, 'the point lands on a plant').toBeTruthy();
    const was = (await readScratchLayout('touch-elevation')).find((row) => row.id === plantId);

    // The south elevation runs the yard's x axis across the drawing, so drag
    // sideways — but with a vertical component, which is what used to be stolen.
    await touchGesture(page, { x: target.x, y: target.y, dx: 50, dy: 30 });

    await expect
      .poll(async () => (await savedPosition('touch-elevation', plantId))?.x, { timeout: 5000 })
      .not.toBe(was.x);
  });

  test('a touch that lands on empty canvas still scrolls the page', async ({ page }) => {
    await openScratchProject(page, 'touch-hold');
    await page.locator('[data-mode="edit"]').click();

    // The top-left corner of the plan view: inside the SVG, away from plants.
    const spot = await page.evaluate(() => {
      const rect = document.getElementById('topSvg').getBoundingClientRect();
      return { x: rect.left + 6, y: rect.top + 6 };
    });
    const scrollBefore = await page.evaluate(() => window.scrollY);

    await touchGesture(page, { x: spot.x, y: spot.y, dy: -120 });

    expect(
      await page.evaluate(() => window.scrollY),
      'a finger on empty canvas still pans the page'
    ).toBeGreaterThan(scrollBefore);
  });

  test('a tap on a plant opens its detail sheet, so clone and remove are reachable', async ({
    page,
  }) => {
    // The right-click menu is a desktop affordance; long-press cannot be driven
    // faithfully here (CDP delivers no contextmenu), so this pins the touch
    // route to the same two actions instead. View mode, because in Edit mode
    // the drag controller captures the pointer before a click lands.
    await openScratchProject(page, 'touch-hold');

    const target = await plantPointerTarget(page, 'topSvg');
    await touchGesture(page, { x: target.x, y: target.y, steps: 0 });

    await expect(page.locator('#detailSheetCloneBtn')).toBeVisible();
    await expect(page.locator('#detailSheetRemoveBtn')).toBeVisible();
  });
});
