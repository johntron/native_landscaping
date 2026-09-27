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

  test('opening the Add plant sheet on touch does not raise the keyboard over the list', async ({
    page,
  }) => {
    // The device this project emulates (Pixel 5) is what src/ui/addPlantSheet.js's
    // own coarse-pointer check is judging; confirm the emulation actually flips
    // it before trusting the assertion below. Read-only: the sheet is opened but
    // nothing is picked, so this can share 'touch-hold' with the specs above.
    await openScratchProject(page, 'touch-hold');
    expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);

    await page.locator('[data-mode="edit"]').click();
    await page.locator('#addPlantBtn').click();
    await expect(page.locator('#addPlantSheet')).toBeVisible();

    // Autofocusing the search field here would raise the on-screen keyboard
    // over the very list it is meant to filter (nl-o47.3); the panel itself
    // takes focus instead, which still satisfies aria-modal.
    await expect(page.locator('#addPlantSearch')).not.toBeFocused();
    await expect(page.locator('#addPlantSheetPanel')).toBeFocused();
  });
});

test.describe('dragging a maximized view (nl-o47.1)', () => {
  /**
   * A plant's on-screen centre, mapped through the SVG's own screenCTM rather
   * than `rect.width / viewBox.width`: that ratio is only right when the box
   * happens to share the viewBox's own aspect, which a maximized panel need
   * not (it is exactly the letterboxing this bug was about). getScreenCTM is
   * the same matrix the browser itself hit-tests with, so this checks the
   * fix against ground truth rather than against this app's own math.
   */
  async function plantScreenPosition(page, svgId, plantId) {
    return page.evaluate(
      ({ svgId, plantId }) => {
        const svg = document.getElementById(svgId);
        const group = svg.querySelector(`g[data-plant-id="${plantId}"]`);
        const label = group?.querySelector('text');
        if (!label) return null;
        const point = new DOMPoint(Number(label.getAttribute('x')), Number(label.getAttribute('y')));
        const screen = point.matrixTransform(svg.getScreenCTM());
        return { x: screen.x, y: screen.y };
      },
      { svgId, plantId }
    );
  }

  /**
   * Drag the plant D screen px north/south, then D more east/west, and check
   * the on-screen movement matches the finger on the axis that moved and
   * stays flat on the other — the two symptoms independent scaleX/scaleY (off
   * `getBoundingClientRect`) produced whenever the panel didn't share the
   * viewBox's own shape. Measured through `plantScreenPosition` (the
   * browser's own screenCTM), never through this app's own scaleFactor, so
   * this checks the fix against ground truth rather than against itself.
   */
  async function assertDragTracksFinger(page, projectId, plantId) {
    const D = 60; // screen px moved by the finger
    const TOLERANCE = 12;
    const savedBefore = (await readScratchLayout(projectId)).find((row) => row.id === plantId)?.y;

    let before = await plantScreenPosition(page, 'topSvg', plantId);
    await touchGesture(page, { x: before.x, y: before.y, dy: D });
    let after = await plantScreenPosition(page, 'topSvg', plantId);
    expect(Math.abs(after.y - before.y), 'vertical screen movement matches the finger').toBeGreaterThan(
      D - TOLERANCE
    );
    expect(Math.abs(after.y - before.y), 'vertical screen movement matches the finger').toBeLessThan(
      D + TOLERANCE
    );
    expect(Math.abs(after.x - before.x), 'no sideways drift from a straight-down drag').toBeLessThan(6);

    // East/west, from wherever the first drag left the plant.
    before = after;
    await touchGesture(page, { x: before.x, y: before.y, dx: D });
    after = await plantScreenPosition(page, 'topSvg', plantId);
    expect(Math.abs(after.x - before.x), 'horizontal screen movement matches the finger').toBeGreaterThan(
      D - TOLERANCE
    );
    expect(Math.abs(after.x - before.x), 'horizontal screen movement matches the finger').toBeLessThan(
      D + TOLERANCE
    );
    expect(Math.abs(after.y - before.y), 'no vertical drift from a straight-sideways drag').toBeLessThan(6);

    // Both drags actually reached the server, not just the DOM — compared
    // against the value from before either drag, so this fails if the save
    // never lands (a vacuous `.not.toBe(undefined)` would pass even then,
    // since the yard already has a real saved y from the moment it was seeded).
    await expect
      .poll(async () => (await savedPosition(projectId, plantId))?.y, { timeout: 5000 })
      .not.toBe(savedBefore);
  }

  test('a maximized panel keeps the viewBox shape, and a drag moves the plant as far as the finger on both axes', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-maximize');
    await page.locator('[data-mode="edit"]').click();

    // project.json's own view id ("plan"), not the SVG's historical "topSvg" id.
    await page.locator('[data-maximize-target="plan"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

    // The Restore button must still be visible and reachable once maximized,
    // not pushed off screen by whatever the panel's new size came out to.
    const maximizeToggle = page.locator('[data-maximize-target="plan"]');
    await expect(maximizeToggle).toHaveText(/Restore/);
    await expect(maximizeToggle).toBeInViewport();

    // Fault (a): the old `aspect-ratio: auto; height: calc(100vh - 3.5rem)`
    // rule sheared the box away from the viewBox's own shape. The fixed rule
    // keeps `aspect-ratio` in charge, so the two must still match.
    const { boxRatio, viewBoxRatio } = await page.evaluate(() => {
      const view = document.querySelector('.view-panel.is-maximized .view');
      const svg = view.querySelector('svg');
      const rect = view.getBoundingClientRect();
      const box = svg.viewBox.baseVal;
      return { boxRatio: rect.width / rect.height, viewBoxRatio: box.width / box.height };
    });
    expect(boxRatio, 'the maximized box keeps the viewBox aspect ratio').toBeCloseTo(viewBoxRatio, 1);

    const plantId = await page.evaluate(
      () => document.querySelector('#topSvg g[data-plant-id]')?.getAttribute('data-plant-id')
    );
    expect(plantId, 'a plant is on the drawing').toBeTruthy();

    await assertDragTracksFinger(page, 'touch-maximize', plantId);
  });

  test('the pointer mapping stays exact even while the panel IS letterboxed, not only once the CSS fix removes the letterbox', async ({
    page,
  }) => {
    // With the CSS fix in place, a maximized box always shares the viewBox's
    // shape, so the old rect-based scaleX/scaleY math would happen to pass
    // the test above too — it is only ever wrong under a letterbox. This test
    // forces the pre-fix shear back on with a page-level override, so it
    // exercises buildPointerContext's mapping (fault b) on its own, the way a
    // future CSS zoom transform (also letterboxed relative to its own
    // pre-transform layout) will.
    await openScratchProject(page, 'touch-letterbox');
    await page.locator('[data-mode="edit"]').click();
    await page.locator('[data-maximize-target="plan"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

    await page.addStyleTag({
      content:
        '.views[data-maximized] .view { aspect-ratio: auto !important; width: 100% !important; height: calc(100dvh - 3.5rem) !important; }',
    });

    // The precondition: the forced style actually letterboxes the drawing,
    // not merely resizes it.
    const { boxRatio, viewBoxRatio } = await page.evaluate(() => {
      const svg = document.getElementById('topSvg');
      const rect = svg.getBoundingClientRect();
      const box = svg.viewBox.baseVal;
      return { boxRatio: rect.width / rect.height, viewBoxRatio: box.width / box.height };
    });
    expect(
      Math.abs(boxRatio - viewBoxRatio),
      'the forced style actually letterboxes the drawing'
    ).toBeGreaterThan(0.2);

    const plantId = await page.evaluate(
      () => document.querySelector('#topSvg g[data-plant-id]')?.getAttribute('data-plant-id')
    );
    expect(plantId, 'a plant is on the drawing').toBeTruthy();

    await assertDragTracksFinger(page, 'touch-letterbox', plantId);
  });
});
