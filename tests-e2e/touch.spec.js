import { test, expect } from '@playwright/test';
import {
  openScratchProject,
  pinchGesture,
  plantPointerTarget,
  plantPosition,
  plantScreenPosition,
  readScratchHistory,
  readScratchLayout,
  readScratchLayoutWithDrift,
  tap,
  touchGesture,
} from './helpers.js';

// Real touch, on a phone-sized viewport. Since nl-o47.2, touch no longer
// grabs a plant on a bare drag: a TAP selects it first (see tests below), and
// only then does a one-finger drag — starting anywhere on the drawing, not
// necessarily on the plant — move the selection. These specs complete drags
// and nudges, which auto-save through POST /api/layout, so they run against
// the throwaway document root — never the repo's own projects/.

/** The plant's saved position, once the POST lands. */
async function savedPosition(projectId, plantId) {
  const rows = await readScratchLayout(projectId);
  return rows.find((row) => row.id === plantId) || null;
}

/** A point inside an SVG panel that is not on any plant: its top-left corner
 * with a small margin, well clear of the fixed selection bar at the bottom. */
async function emptySpotIn(page, svgId) {
  return page.evaluate((id) => {
    const rect = document.getElementById(id).getBoundingClientRect();
    return { x: rect.left + 10, y: rect.top + 10 };
  }, svgId);
}

test.describe('tap to select (nl-o47.2)', () => {
  test('a tap on a plant selects it: the action bar appears with its name', async ({ page }) => {
    await openScratchProject(page, 'touch-tap-select');
    await page.locator('[data-mode="edit"]').click();
    await expect(page.locator('#selectionBar')).toBeHidden();

    const target = await plantPointerTarget(page, 'topSvg');
    await tap(page, target);

    await expect(page.locator('#selectionBar')).toBeVisible();
    await expect(page.locator('#selectionBarName')).not.toBeEmpty();
  });

  test('a tap on empty drawing clears the selection', async ({ page }) => {
    await openScratchProject(page, 'touch-tap-select');
    await page.locator('[data-mode="edit"]').click();

    const target = await plantPointerTarget(page, 'topSvg');
    await tap(page, target);
    await expect(page.locator('#selectionBar')).toBeVisible();

    await tap(page, await emptySpotIn(page, 'topSvg'));
    await expect(page.locator('#selectionBar')).toBeHidden();
  });
});

test.describe('dragging by touch', () => {
  test('tap then drag: a mostly-vertical drag moves the selected plant instead of scrolling the page', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-plan');
    await page.locator('[data-mode="edit"]').click();

    const target = await plantPointerTarget(page, 'topSvg');
    await tap(page, target); // select it first — a bare drag no longer grabs anything
    await expect(page.locator('#selectionBar')).toBeVisible();
    const before = await plantPosition(page, target.id);
    const scrollBefore = await page.evaluate(() => window.scrollY);

    // Vertical is the interesting direction: it is the axis the page scroller
    // wants, and in plan view it is the yard's north/south axis. Started away
    // from the plant, on purpose: with a selection, a drag may start ANYWHERE
    // on the drawing, and it must still move the selected plant, not whatever
    // is under the finger.
    const away = await emptySpotIn(page, 'topSvg');
    await touchGesture(page, { x: away.x, y: away.y, dy: 60 });

    const after = await plantPosition(page, target.id);
    expect(after, 'the plant is still on the drawing').not.toBeNull();
    expect(
      Math.abs(after.y - before.y),
      'the drag moved the selected plant rather than scrolling the page'
    ).toBeGreaterThan(1);
    expect(await page.evaluate(() => window.scrollY), 'the page did not scroll').toBe(scrollBefore);

    await expect
      .poll(async () => (await savedPosition('touch-plan', target.id))?.y, { timeout: 5000 })
      .not.toBe(undefined);
  });

  test('tap then drag: an elevation drag works by touch too', async ({ page }) => {
    // The elevation controller hit-tests through the DOM rather than
    // geometrically, and records the tapped id AT pointerdown — once it
    // captures the pointer, later events target the svg itself.
    await openScratchProject(page, 'touch-elevation');
    await page.locator('[data-mode="edit"]').click();
    // Edit mode on a phone auto-maximizes the plan (nl-o47.4); south is
    // reached through the editor's own tab strip now, not by scrolling.
    await page.locator('[data-view-tab="south"]').click();
    await page.locator('.views[data-maximized="south"]').waitFor();

    const target = await plantPointerTarget(page, 'southSvg', 'elevation');
    // This controller picks the plant off the DOM, so the one selected is
    // whichever silhouette is painted on top at the point — not necessarily
    // the group the helper measured. Ask the document, the way the app does.
    const plantId = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-plant-id]')?.getAttribute('data-plant-id'),
      target
    );
    expect(plantId, 'the point lands on a plant').toBeTruthy();
    const was = (await readScratchLayout('touch-elevation')).find((row) => row.id === plantId);

    await tap(page, target);
    await expect(page.locator('#selectionBar')).toBeVisible();

    // Drag from elsewhere on the elevation, with a vertical component (which
    // is what used to be stolen by the page scroller under the old model).
    const away = await emptySpotIn(page, 'southSvg');
    await touchGesture(page, { x: away.x, y: away.y, dx: 50, dy: 30 });

    await expect
      .poll(async () => (await savedPosition('touch-elevation', plantId))?.x, { timeout: 5000 })
      .not.toBe(was.x);
  });

  test('with nothing selected, a vertical swipe at fit zoom scrolls no page and moves no plant', async ({
    page,
  }) => {
    // Superseded by the phone editor (nl-o47.4): there is no page left to
    // scroll behind a `position: fixed; inset: 0` panel. A one-finger move
    // with nothing selected is src/interaction/canvasGesture.js's pan, but
    // AT FIT (scale 1) neither axis has anywhere to go — canvasZoom.js's own
    // clamp centers whenever the content does not exceed its container,
    // which at fit is true on both axes by construction — so this keeps only
    // the original test's still-true half (no plant moves, no page scrolls);
    // the "phone editor: pinch-zoom then pan" test below covers a pan that
    // actually has somewhere to go, once zoomed in.
    await openScratchProject(page, 'touch-hold');
    await page.locator('[data-mode="edit"]').click();
    await expect(page.locator('#selectionBar')).toBeHidden();

    const before = await readScratchLayout('touch-hold');
    const spot = await emptySpotIn(page, 'topSvg');
    const scrollBefore = await page.evaluate(() => window.scrollY);

    await touchGesture(page, { x: spot.x, y: spot.y, dy: -120 });

    expect(await page.evaluate(() => window.scrollY), 'the page behind the editor does not scroll').toBe(
      scrollBefore
    );
    expect(await readScratchLayout('touch-hold'), 'no plant moved').toEqual(before);
  });

  test('a tap on a plant opens its detail sheet, so clone and remove are reachable', async ({
    page,
  }) => {
    // The right-click menu is a desktop affordance; long-press cannot be driven
    // faithfully here (CDP delivers no contextmenu), so this pins the touch
    // route to the same two actions instead. View mode, because in Edit mode
    // a tap selects instead (nl-o47.2).
    await openScratchProject(page, 'touch-hold');

    const target = await plantPointerTarget(page, 'topSvg');
    await tap(page, target);

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

  test('the "How many?" stepper sits ahead of the list and answers a real tap (nl-o47.6.3)', async ({
    page,
  }) => {
    // Read-only (never taps a row), so this can share 'touch-hold' too.
    await openScratchProject(page, 'touch-hold');
    await page.locator('[data-mode="edit"]').click();
    await page.locator('#addPlantBtn').click();
    await expect(page.locator('#addPlantSheet')).toBeVisible();

    const countField = page.locator('#addPlantCount');
    await expect(countField).toHaveValue('1');

    const tapCenterOf = async (locator) => {
      const box = await locator.boundingBox();
      await tap(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    };

    // "+"/"-" are real tap targets (min 44px, styles.css), not mouse-only
    // buttons: a bare CDP touch event, the same tap() every other gesture in
    // this file uses, has to move the count.
    await tapCenterOf(page.locator('#addPlantCountPlus'));
    await expect(countField).toHaveValue('2');
    await tapCenterOf(page.locator('#addPlantCountMinus'));
    await expect(countField).toHaveValue('1');
  });
});

test.describe('the selection action bar (nl-o47.2)', () => {
  test('a nudge moves the selection by the step, saves it, and undo reverts it', async ({ page }) => {
    await openScratchProject(page, 'touch-nudge');
    await page.locator('[data-mode="edit"]').click();

    const target = await plantPointerTarget(page, 'topSvg');
    await tap(page, target);
    await expect(page.locator('#selectionBar')).toBeVisible();

    const before = (await readScratchLayout('touch-nudge')).find((row) => row.id === target.id);
    expect(before, 'the tapped plant is in the saved layout').toBeTruthy();

    // The nudge arrows sit behind the bar's "More" popover on a phone
    // (nl-o47.4 restructures #selectionBar for width; see the review note on
    // nl-o47.4's own bead).
    await page.locator('#selectionBarMoreBtn').click();
    await page.locator('#selectionNudgeE').click();

    await expect
      .poll(async () => (await savedPosition('touch-nudge', target.id))?.x, { timeout: 5000 })
      .not.toBe(before.x);
    const afterNudge = await savedPosition('touch-nudge', target.id);
    // East is +x, by exactly the nudge step (0.5 ft, src/state/nudgeSelection.js).
    expect(afterNudge.x - before.x).toBeCloseTo(0.5, 5);
    expect(afterNudge.y, 'nudging east leaves y alone').toBeCloseTo(before.y, 5);

    // Undo lives in the primary row itself now (nl-o47.4): reachable without
    // Done, and Done stays untouched by it.
    await page.locator('#selectionUndoBtn').click();
    await expect
      .poll(async () => (await savedPosition('touch-nudge', target.id))?.x, { timeout: 5000 })
      .toBeCloseTo(before.x, 5);
  });

  test('Undo in the primary row reverts a drag while the plant stays selected (nl-o47.4)', async ({ page }) => {
    // The orchestrator's own review of this bead: Undo has to be reachable
    // WHILE something is selected (undoing a mistaken drag/nudge is the
    // first thing anyone reaches for right after making it), and "Done,
    // then Undo" would throw the selection away first. This is the one
    // thing worth its own test rather than folding into the nudge test
    // above: that the selection SURVIVES the undo, not just that the undo
    // itself works.
    await openScratchProject(page, 'touch-undo-in-bar');
    await page.locator('[data-mode="edit"]').click();

    const target = await plantPointerTarget(page, 'topSvg');
    await tap(page, target);
    await expect(page.locator('#selectionBar')).toBeVisible();
    const nameBefore = await page.locator('#selectionBarName').textContent();
    // Two different units on purpose: plantPosition reads viewBox pixels
    // (data-cx/data-cy, nl-o47.6.7) for the immediate on-screen check below;
    // the saved layout is yard feet, for the round-trip check after undo.
    const before = await plantPosition(page, target.id);
    const savedBefore = (await readScratchLayout('touch-undo-in-bar')).find((row) => row.id === target.id);
    expect(savedBefore, 'the tapped plant is in the saved layout').toBeTruthy();

    const away = await emptySpotIn(page, 'topSvg');
    await touchGesture(page, { x: away.x, y: away.y, dy: 60 });
    await expect
      .poll(async () => (await savedPosition('touch-undo-in-bar', target.id))?.y, { timeout: 5000 })
      .not.toBe(savedBefore.y);
    const afterDrag = await plantPosition(page, target.id);
    expect(Math.abs(afterDrag.y - before.y), 'the drag actually moved the plant').toBeGreaterThan(1);
    await expect(page.locator('#selectionUndoBtn')).toBeEnabled();

    // No Done first — the whole point of the primary-row button.
    await page.locator('#selectionUndoBtn').click();

    await expect
      .poll(async () => (await savedPosition('touch-undo-in-bar', target.id))?.y, { timeout: 5000 })
      .toBeCloseTo(savedBefore.y, 5);
    // The selection survived (src/state/selection.js's pruneSelectionIds keeps
    // an id that still exists — an undo that only moved the plant never
    // touched its id), not narrowed, not cleared.
    await expect(page.locator('#selectionBar')).toBeVisible();
    await expect(page.locator('#selectionBarName')).toHaveText(nameBefore);
  });
});

test.describe('dragging a maximized view (nl-o47.1, adapted for the phone editor by nl-o47.4)', () => {
  // Edit mode on a phone now opens the full-screen editor (nl-o47.4), which
  // auto-maximizes a view and hides the per-panel Maximize/Restore toggle
  // (replaced by the editor's own tab strip) — so these specs no longer
  // click it themselves, and the aspect-ratio assertion that used to run
  // right after clicking it is split out below into its own View-mode test,
  // where that toggle still exists and still works exactly as nl-o47.1 left
  // it. The drag-tracks-the-finger assertions instead run INSIDE the editor,
  // which is maximized (at FIT_STATE — scale 1, no pinch/pan translate) by
  // the time Edit mode finishes opening, so the geometry under test is
  // identical to what the manual toggle used to produce.

  test('View mode: maximizing a view on a phone keeps the viewBox aspect ratio', async ({ page }) => {
    await openScratchProject(page, 'touch-maximize');
    // View mode (the default): the per-panel toggle is untouched by the
    // editor, which only ever opens in Edit mode.
    await page.locator('[data-maximize-target="plan"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

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
  });
});

test.describe('dragging inside the phone editor (nl-o47.1 fix, exercised through nl-o47.4)', () => {
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
   * Tap the plant to select it (nl-o47.2), then drag D screen px north/south,
   * then D more east/west, and check the on-screen movement matches the
   * finger on the axis that moved and stays flat on the other — the two
   * symptoms independent scaleX/scaleY (off `getBoundingClientRect`) produced
   * whenever the panel didn't share the viewBox's own shape. Measured through
   * `plantScreenPosition` (the browser's own screenCTM), never through this
   * app's own scaleFactor, so this checks the fix against ground truth rather
   * than against itself.
   *
   * Both drag legs start from a fixed anchor point away from the plant, not
   * from the plant's own (possibly bar-covered, in a maximized panel) screen
   * position: since nl-o47.2, a drag with a selection may start anywhere on
   * the drawing and still moves the same amount as the finger.
   */
  async function assertDragTracksFinger(page, projectId, plantId) {
    const D = 60; // screen px moved by the finger
    const TOLERANCE = 12;
    const savedBefore = (await readScratchLayout(projectId)).find((row) => row.id === plantId)?.y;

    const plantPoint = await plantScreenPosition(page, 'topSvg', plantId);
    await tap(page, plantPoint);
    await expect(page.locator('#selectionBar')).toBeVisible();

    const anchor = await page.evaluate(() => {
      const view = document.querySelector('.view-panel.is-maximized .view') || document.getElementById('topSvg');
      const rect = view.getBoundingClientRect();
      // Dead center, not near an edge: the editor's own chrome (nl-o47.4) —
      // #phoneEditorTabs at the top, the bottom bar — floats OVER the full-
      // bleed drawing rather than displacing its rect the way the old
      // in-flow header used to, so a point too close to either edge would
      // land the synthetic touch on that chrome instead of the drawing.
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

    let before = await plantScreenPosition(page, 'topSvg', plantId);
    await touchGesture(page, { x: anchor.x, y: anchor.y, dy: D });
    let after = await plantScreenPosition(page, 'topSvg', plantId);
    expect(Math.abs(after.y - before.y), 'vertical screen movement matches the finger').toBeGreaterThan(
      D - TOLERANCE
    );
    expect(Math.abs(after.y - before.y), 'vertical screen movement matches the finger').toBeLessThan(
      D + TOLERANCE
    );
    expect(Math.abs(after.x - before.x), 'no sideways drift from a straight-down drag').toBeLessThan(6);

    // East/west, from the same anchor point again.
    before = after;
    await touchGesture(page, { x: anchor.x, y: anchor.y, dx: D });
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

  test('the editor keeps the viewBox shape, and a drag moves the plant as far as the finger on both axes', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-maximize');
    // Edit mode on a phone auto-maximizes the plan (nl-o47.4) — no toggle to
    // click; the editor's own tab strip is what the phone shows instead.
    await page.locator('[data-mode="edit"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();
    await expect(page.locator('#phoneEditorTabs')).toBeVisible();

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
    // pre-transform layout, and now a real one — src/render/canvasZoom.js's
    // own translate+scale — atop it) will.
    await openScratchProject(page, 'touch-letterbox');
    await page.locator('[data-mode="edit"]').click();
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

test.describe('drifts (nl-o47.6.2)', () => {
  // Seeded by tests-e2e/scratch-fixture.mjs's DRIFT_LAYOUT_CSV: a 6x6 ft
  // square of 4 winecups (their own centroid is (15, 11)), plus one
  // unrelated horseherb ('lone-plant') far off in a corner.
  const DRIFT_MEMBERS = ['drift-a', 'drift-b', 'drift-c', 'drift-d'];
  const SEEDED_POSITIONS = {
    'drift-a': { x: 12, y: 8 },
    'drift-b': { x: 18, y: 8 },
    'drift-c': { x: 12, y: 14 },
    'drift-d': { x: 18, y: 14 },
  };

  /** A drift member's on-screen centre — same screenCTM mapping as
   * plantPointerTarget, but for a specific known id rather than "the first
   * plant on the drawing". Reads data-cx/data-cy (renderTopView, nl-o47.6.7)
   * rather than a label's x/y: a grouped, unselected drift member draws no
   * label of its own any more. */
  async function driftMemberScreen(page, plantId) {
    // page.mouse/CDP touch coordinates are viewport-relative and do not
    // scroll — see plantPointerTarget's own identical guard in helpers.js.
    await page.locator('#topSvg').scrollIntoViewIfNeeded();
    return page.evaluate((id) => {
      const svg = document.getElementById('topSvg');
      const group = svg.querySelector(`g[data-plant-id="${id}"]`);
      const point = new DOMPoint(Number(group.getAttribute('data-cx')), Number(group.getAttribute('data-cy')));
      const screen = point.matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, plantId);
  }

  /** The midpoint between two members' own screen positions — a point
   * strictly between them in yard feet too, since the plan's feet<->viewBox
   * mapping is affine (planToViewBox(midpoint(A,B)) === midpoint(screen(A),
   * screen(B))). drift-a/drift-d are diagonal corners, so this lands on the
   * drift's own centroid without needing to replicate the app's transform
   * math in the test. */
  async function midpointOf(page, idA, idB) {
    const a = await driftMemberScreen(page, idA);
    const b = await driftMemberScreen(page, idB);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  async function driftMemberIds(projectId) {
    return (await readScratchLayoutWithDrift(projectId))
      .filter((row) => row.driftId === 'winecup-drift')
      .map((row) => row.id);
  }

  test('a tap on a member selects the whole drift; a tap between members does too; a second tap drills in; a tap outside leaves', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-drift-select');
    await page.locator('[data-mode="edit"]').click();

    const target = await driftMemberScreen(page, 'drift-a');
    await tap(page, target);

    await expect(page.locator('#selectionBar')).toBeVisible();
    // nl-o47.6.11: the primary row shows the drift's label as plain,
    // ellipsized text — driftLabel's species initials plus count, "CI (4x)"
    // for four winecup. There is no rename field: a drift has no name of its
    // own to give one.
    await expect(page.locator('#selectionBarName')).toHaveText('CI (4x)');
    await expect(page.locator('#topSvg [data-drift-outline]')).toBeVisible();
    // Every member gets a selection ring; the unrelated plant is dimmed, not ringed.
    expect(await page.locator('#topSvg [data-selection-ring]').count()).toBe(4);
    await expect(page.locator('#topSvg g[data-plant-id="lone-plant"]')).toHaveAttribute('data-dimmed', 'true');

    // The bar never exceeds two rows with a whole drift selected (nl-o47.4;
    // the nl-o47.6.2 review found it at 4). Only the primary row is visible
    // by default (the "More" popover is closed) — its own height is the
    // whole bar.
    const barBox = await page.locator('#selectionBar').boundingBox();
    const rowHeight = await page.locator('#selectionDoneBtn').boundingBox();
    expect(barBox.height, 'closed by default, the bar is at most two button-rows tall').toBeLessThan(
      rowHeight.height * 2 + 40 // + padding/gaps, not a third row's worth
    );

    // The count stepper is behind "More".
    await page.locator('#selectionBarMoreBtn').click();
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('4');
    // Close it again before tapping the canvas — the open popover can cover
    // part of the drawing near the bottom of a phone screen.
    await page.locator('#selectionBarMoreBtn').click();

    // A tap in the gap between members, well inside the outline (the drift's
    // own centroid — see midpointOf), also selects the whole drift.
    await tap(page, await midpointOf(page, 'drift-a', 'drift-d'));
    await expect(page.locator('#selectionBarName')).toHaveText('CI (4x)');

    // A further tap on a member drills into it: the plain single-plant bar
    // returns, with the two drift-member extras — behind "More" on a phone
    // (nl-o47.4).
    await tap(page, target);
    await expect(page.locator('#selectionBarName')).toHaveText('Winecup');
    await page.locator('#selectionBarMoreBtn').click();
    await expect(page.locator('#selectionBackToDriftBtn')).toBeVisible();
    await expect(page.locator('#selectionRemoveFromDriftBtn')).toBeVisible();

    // A tap outside the (still isolated, now drilled-into) drift's own
    // outline leaves it — the bar hides, same as tapping empty ground always has.
    await tap(page, await emptySpotIn(page, 'topSvg'));
    await expect(page.locator('#selectionBar')).toBeHidden();
  });

  test('a drag moves the whole drift by the finger delta, as one undo step, leaving the unrelated plant alone', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-drift-drag');
    await page.locator('[data-mode="edit"]').click();

    await tap(page, await driftMemberScreen(page, 'drift-a'));
    await expect(page.locator('#selectionBarName')).toHaveText('CI (4x)');

    const away = await emptySpotIn(page, 'topSvg');
    await touchGesture(page, { x: away.x, y: away.y, dx: 40, dy: -30 });

    await expect
      .poll(
        async () => (await readScratchLayoutWithDrift('touch-drift-drag')).find((r) => r.id === 'drift-a')?.x,
        { timeout: 5000 }
      )
      .not.toBeCloseTo(SEEDED_POSITIONS['drift-a'].x, 3);

    const after = await readScratchLayoutWithDrift('touch-drift-drag');
    const deltas = DRIFT_MEMBERS.map((id) => {
      const row = after.find((r) => r.id === id);
      const seeded = SEEDED_POSITIONS[id];
      return { dx: row.x - seeded.x, dy: row.y - seeded.y };
    });
    deltas.forEach((d) => {
      expect(d.dx).toBeCloseTo(deltas[0].dx, 2);
      expect(d.dy).toBeCloseTo(deltas[0].dy, 2);
    });
    expect(Math.abs(deltas[0].dx) + Math.abs(deltas[0].dy), 'the group actually moved').toBeGreaterThan(0.2);
    const lone = after.find((r) => r.id === 'lone-plant');
    expect(lone.x, 'the unrelated plant did not move').toBeCloseTo(4, 5);
    expect(lone.y).toBeCloseTo(4, 5);

    // Undo lives in the primary row itself (nl-o47.4), reachable without
    // Done — the drift stays selected throughout.
    await page.locator('#selectionUndoBtn').click();
    await expect
      .poll(
        async () => (await readScratchLayoutWithDrift('touch-drift-drag')).find((r) => r.id === 'drift-a')?.x,
        { timeout: 5000 }
      )
      .toBeCloseTo(SEEDED_POSITIONS['drift-a'].x, 2);
  });

  test('+ adds a member and - removes one, each its own undo step', async ({ page }) => {
    await openScratchProject(page, 'touch-drift-count');
    await page.locator('[data-mode="edit"]').click();
    await tap(page, await driftMemberScreen(page, 'drift-a'));
    // The count stepper sits behind "More" on a phone (nl-o47.4).
    await page.locator('#selectionBarMoreBtn').click();
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('4');

    await page.locator('#selectionDriftCountIncBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('touch-drift-count')).length, { timeout: 5000 })
      .toBe(5);
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('5');

    // Undo lives in the primary row (nl-o47.4), reachable without Done —
    // and the whole drift stays selected (its membership re-syncs to
    // whatever the drift's CURRENT members are, nl-o47.6.2's own
    // pruneSelection), so the count stepper (still behind More, already
    // open) answers the very next click with no re-tap needed.
    await page.locator('#selectionUndoBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('touch-drift-count')).length, { timeout: 5000 })
      .toBe(4);
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('4');

    await page.locator('#selectionDriftCountDecBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('touch-drift-count')).length, { timeout: 5000 })
      .toBe(3);

    await page.locator('#selectionUndoBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('touch-drift-count')).length, { timeout: 5000 })
      .toBe(4);
  });

  test('spread changes the distance between members', async ({ page }) => {
    await openScratchProject(page, 'touch-drift-spread');
    await page.locator('[data-mode="edit"]').click();
    await tap(page, await driftMemberScreen(page, 'drift-a'));
    await expect(page.locator('#selectionBarName')).toHaveText('CI (4x)');
    // Spread sits behind "More" on a phone (nl-o47.4).
    await page.locator('#selectionBarMoreBtn').click();

    const distanceAB = async () => {
      const rows = await readScratchLayoutWithDrift('touch-drift-spread');
      const a = rows.find((r) => r.id === 'drift-a');
      const b = rows.find((r) => r.id === 'drift-b');
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const before = await distanceAB(); // 6 ft, seeded

    await page.locator('#selectionSpreadLooserBtn').click();
    await expect.poll(distanceAB, { timeout: 5000 }).toBeGreaterThan(before + 0.1);
    const afterLooser = await distanceAB();

    await page.locator('#selectionSpreadTighterBtn').click();
    await expect.poll(distanceAB, { timeout: 5000 }).toBeLessThan(afterLooser - 0.1);
  });

  test('"+" on a single plant makes it a drift of 2; "-" brings back the same plant (nl-o47.6.9)', async ({ page }) => {
    await openScratchProject(page, 'touch-drift-convert');
    await page.locator('[data-mode="edit"]').click();
    await tap(page, await driftMemberScreen(page, 'solo'));

    await expect(page.locator('#selectionBar')).toBeVisible();
    await expect(page.locator('#selectionBarName')).toHaveText('Winecup');
    // The count stepper sits behind "More" on a phone (nl-o47.4), same as the
    // whole-drift one just above.
    await page.locator('#selectionBarMoreBtn').click();
    await expect(page.locator('#selectionDriftCountGroup')).toBeVisible();
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('1');
    await expect(page.locator('#selectionDriftCountDecBtn')).toBeDisabled();

    await page.locator('#selectionDriftCountIncBtn').click();
    await expect(page.locator('#selectionBarName')).toHaveText('CI (2x)');
    await expect(page.locator('#topSvg [data-drift-outline]')).toBeVisible();
    await expect
      .poll(async () => (await readScratchLayoutWithDrift('touch-drift-convert')).length, { timeout: 5000 })
      .toBe(2);
    let rows = await readScratchLayoutWithDrift('touch-drift-convert');
    const solo = rows.find((r) => r.id === 'solo');
    const other = rows.find((r) => r.id !== 'solo');
    expect(solo.driftId).not.toBe('');
    expect(other.driftId).toBe(solo.driftId);

    // "More" closed itself the instant "+" changed the bar's context (no
    // drift -> a real one), so it has to be reopened to reach "-", which
    // hands the original plant back, unlabelled, still selected.
    await page.locator('#selectionBarMoreBtn').click();
    await page.locator('#selectionDriftCountDecBtn').click();
    await expect(page.locator('#selectionBarName')).toHaveText('Winecup');
    await expect
      .poll(async () => (await readScratchLayoutWithDrift('touch-drift-convert')).length, { timeout: 5000 })
      .toBe(1);
    rows = await readScratchLayoutWithDrift('touch-drift-convert');
    expect(rows[0].id).toBe('solo');
    expect(rows[0].driftId).toBe('');
  });

  test('marking a drift planted from its own editor sets status on every member, by touch (nl-o47.6.10)', async ({
    page,
  }) => {
    const project = 'touch-drift-lifecycle';
    async function driftMembersFromHistory() {
      const history = await readScratchHistory(project);
      const entry = history?.entries[history.cursor];
      return (entry?.plants || []).filter((plant) => plant.driftId === 'winecup-drift');
    }

    await openScratchProject(page, project);
    await page.locator('[data-mode="edit"]').click();
    await tap(page, await driftMemberScreen(page, 'drift-a'));
    await expect(page.locator('#selectionBarName')).toHaveText('CI (4x)');

    // "Planting" sits behind "More", like every other whole-drift-only control.
    await page.locator('#selectionBarMoreBtn').click();
    await page.locator('#selectionDriftPlantingBtn').click();

    const sheet = page.locator('#detailSheet');
    await expect(sheet).toBeVisible();
    const section = sheet.locator('.plant-lifecycle');
    await expect(section.locator('.plant-lifecycle__scope')).toContainText(
      'Applies to all 4 plants in CI (4x)'
    );

    await section.locator('[data-lifecycle-status="planted"]').click();
    await expect
      .poll(async () => {
        const members = await driftMembersFromHistory();
        return members.length === 4 && members.every((m) => m.status === 'planted');
      }, { timeout: 5000 })
      .toBe(true);

    // Closing the sheet did not drill the selection into one member — Undo,
    // reachable straight from the primary row, reverts every member at once.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.locator('#selectionBarName')).toHaveText('CI (4x)');
    await page.locator('#selectionUndoBtn').click();
    await expect
      .poll(async () => (await driftMembersFromHistory()).filter((m) => m.status === 'planted').length, {
        timeout: 5000,
      })
      .toBe(0);
  });
});

test.describe('species table drift entries, by touch (nl-o47.6.7)', () => {
  // Seeded by tests-e2e/scratch-fixture.mjs's SPECIES_DRIFT_LAYOUT_CSV: the
  // desktop coverage (tests-e2e/driftSpeciesTable.spec.js) is thorough, so
  // this stays to the one thing worth proving is real on a touch device — a
  // tap (not a click) reaches the same handler.
  test('a tap on a drift entry rings its members in View mode; a tap in Edit mode selects it', async ({ page }) => {
    await openScratchProject(page, 'touch-drift-species');

    const chip = page.locator('#speciesTable button.species-table__drift-chip[data-drift-id="winecup-2"]');
    await chip.tap();
    await expect(page.locator('#topSvg circle[stroke-dasharray="7 6"]')).toHaveCount(3);
    await chip.tap();
    await expect(page.locator('#topSvg circle[stroke-dasharray="7 6"]')).toHaveCount(0);

    // Edit mode on a phone opens the full-screen editor (nl-o47.4):
    // #speciesTable is hosted in the Plants sheet there, not inline on the
    // page, so it has to be opened first.
    await page.locator('[data-mode="edit"]').click();
    await page.locator('#phoneEditorPlantsBtn').click();
    await expect(page.locator('#plantsSheet')).toBeVisible();
    await page
      .locator('#speciesTable button.species-table__drift-chip[data-drift-id="winecup-drift"]')
      .tap();
    await expect(page.locator('#selectionBarName')).toHaveText('CI (4x)');
    // Selecting the drift also closes the sheet, so the canvas underneath —
    // where the selection actually shows — is what the person sees next.
    await expect(page.locator('#plantsSheet')).toBeHidden();
  });
});

test.describe('suggesting drifts, by touch (nl-o47.6.5)', () => {
  // Seeded by tests-e2e/scratch-fixture.mjs's DRIFT_SUGGEST_LAYOUT_CSV: a
  // 4-member winecup mass (plus a lone winecup well outside its own
  // clustering distance) and a 3-member horseherb mass, both undrifted. The
  // desktop coverage (tests-e2e/driftSuggest.spec.js) is thorough; this
  // proves the same flow works end to end through real touch — the bar's own
  // Undo/Redo and its "More" popover, since the real #undoLayoutBtn sits in
  // the idle bar, hidden while a review is open.
  const driftIdOf = async (projectId, plantId) => {
    const rows = await readScratchLayoutWithDrift(projectId);
    return rows.find((row) => row.id === plantId)?.driftId || '';
  };

  test('the banner in the Plants sheet, reviewing on the plan, adjusting by tap, Accept in one undo step, the mirrored Undo, Skip, and Stop', async ({
    page,
  }) => {
    const project = 'touch-drift-suggest';
    await openScratchProject(page, project);
    await page.locator('[data-mode="edit"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

    await page.locator('#phoneEditorPlantsBtn').click();
    await expect(page.locator('#plantsSheet')).toBeVisible();
    await expect(page.locator('.species-table__suggest-drifts')).toContainText('2 possible drifts');
    const banner = page.locator('#suggestDriftsBtn');

    const bar = page.locator('#driftReviewBar');
    const label = page.locator('#driftReviewLabel');
    await banner.tap();
    // Opening review closes the Plants sheet — the canvas underneath, where
    // the suggestion's own outline shows, is what the person sees next.
    await expect(page.locator('#plantsSheet')).toBeHidden();
    await expect(bar).toBeVisible();
    // nl-o47.6.11: the review bar reads like a real drift's own label —
    // driftLabel's species initials plus count — then the position.
    await expect(label).toHaveText('CI (4x) · 1 of 2');
    // Skip and Accept are the two answers to every suggestion: both sit on
    // the primary row beside More, on one line, without opening More.
    const rowTops = await Promise.all(
      ['#driftReviewSkipBtn', '#driftReviewAcceptBtn', '#driftReviewMoreBtn'].map(async (id) => {
        await expect(page.locator(id)).toBeVisible();
        return Math.round((await page.locator(id).boundingBox()).y);
      })
    );
    expect(Math.max(...rowTops) - Math.min(...rowTops), 'Skip, Accept and More share one row').toBeLessThan(4);

    await expect(page.locator('#topSvg path[data-suggestion-outline="true"]')).toBeVisible();
    await expect(page.locator('#topSvg g[data-plant-id="sug-hb1"]')).toHaveAttribute('data-dimmed', 'true');

    // Adjust: a tap on an existing member toggles it out — the nearest hit
    // under the tap, bypassing selection/isolation/dragging entirely
    // (src/interaction/dragController.js's review branch).
    const wa4 = await plantScreenPosition(page, 'topSvg', 'sug-wa4');
    await tap(page, wa4);
    await expect(label).toHaveText('CI (3x) · 1 of 2');

    const historyBefore = await readScratchHistory(project);
    await page.locator('#driftReviewAcceptBtn').tap();
    await expect
      .poll(async () => {
        const rows = await readScratchLayoutWithDrift(project);
        const driftId = rows.find((row) => row.id === 'sug-wa1')?.driftId;
        return driftId && rows.filter((row) => row.driftId === driftId).map((row) => row.id).sort().join(',');
      })
      .toBe('sug-wa1,sug-wa2,sug-wa3');
    expect(await driftIdOf(project, 'sug-wa4')).toBe('');
    const historyAfter = await readScratchHistory(project);
    expect(historyAfter.entries.length - historyBefore.entries.length).toBe(1);
    await expect(label).toHaveText('CV (3x) · 2 of 2');

    // The real Undo sits in the idle bar, hidden while reviewing; the review
    // bar's own mirror lives in "More".
    await expect(page.locator('#undoLayoutBtn')).toBeHidden();
    await page.locator('#driftReviewMoreBtn').tap();
    await expect(page.locator('#driftReviewMore')).toHaveClass(/is-open/);
    await page.locator('#driftReviewUndoBtn').tap();
    await expect.poll(async () => driftIdOf(project, 'sug-wa1')).toBe('');
    // Recomputed cleanly: the very same winecup mass is current again.
    await expect(label).toHaveText('CI (4x) · 1 of 2');

    // Skip writes nothing and moves on ("More" closed itself on the Undo's
    // own recompute — a genuinely different suggestion — so it needs reopening).
    await page.locator('#driftReviewMoreBtn').tap();
    await page.locator('#driftReviewSkipBtn').tap();
    await expect(label).toHaveText('CV (3x) · 2 of 2');
    expect(await driftIdOf(project, 'sug-wa1')).toBe('');

    await page.locator('#driftReviewAcceptBtn').tap();
    await expect.poll(async () => driftIdOf(project, 'sug-hb1')).not.toBe('');

    // Finishing the list says so and leaves review via Stop.
    await expect(label).toContainText('Reviewed every suggested drift');
    await page.locator('#driftReviewMoreBtn').tap();
    await page.locator('#driftReviewStopBtn').tap();
    await expect(bar).toBeHidden();
    await expect(page.locator('#phoneEditorBar')).toBeVisible(); // the idle bar returns
  });
});

test.describe('grouping selected plants into a drift, by touch (nl-o47.6.4)', () => {
  // Seeded by tests-e2e/scratch-fixture.mjs's DRIFT_GROUP_LAYOUT_CSV (one
  // lone winecup, two more same-species undrifted, one horseherb) and
  // DRIFT_GROUP_MOVE_LAYOUT_CSV (a member of an existing 2-plant drift, mixed
  // lifecycle). Desktop coverage (tests-e2e/driftGroup.spec.js) is thorough;
  // this proves the same flow works end to end through real touch, and
  // captures the screenshots nl-o47.6.4 asks for at this phone width.
  const SHOT_DIR =
    '/tmp/claude-1000/-home-johntron-Development-native-landscaping/0ef350c8-f430-4836-9260-c20352a755ea/scratchpad/drift-group';

  test('a single plant\'s "Make drift", toggling two more same-species plants in, Accept writing one shared drift_id in one undo step with the whole drift selected', async ({
    page,
  }) => {
    const project = 'touch-drift-group';
    const driftIdOf = async (plantId) => {
      const rows = await readScratchLayoutWithDrift(project);
      return rows.find((row) => row.id === plantId)?.driftId || '';
    };

    await openScratchProject(page, project);
    await page.locator('[data-mode="edit"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

    const seed = await plantScreenPosition(page, 'topSvg', 'mk-seed');
    await tap(page, seed);
    await expect(page.locator('#selectionBar')).toBeVisible();

    // "Make drift" sits behind "More" on a phone, alongside Details/Clone/Remove.
    await page.locator('#selectionBarMoreBtn').click();
    const makeDriftBtn = page.locator('#selectionMakeDriftBtn');
    await expect(makeDriftBtn).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/01-make-drift-entry.png` });
    await makeDriftBtn.click();

    const bar = page.locator('#driftReviewBar');
    const label = page.locator('#driftReviewLabel');
    await expect(bar).toBeVisible();
    // No "· N of M" (there is no queue, unlike a suggestion's own label).
    await expect(label).toHaveText('CI (1x)');
    await expect(page.locator('#selectionBar')).toBeHidden();

    const mk2 = await plantScreenPosition(page, 'topSvg', 'mk-2');
    await tap(page, mk2);
    const mk3 = await plantScreenPosition(page, 'topSvg', 'mk-3');
    await tap(page, mk3);
    await expect(label).toHaveText('CI (3x)');
    await page.screenshot({ path: `${SHOT_DIR}/02-proposal-three-members.png` });

    const historyBefore = await readScratchHistory(project);
    await page.locator('#driftReviewAcceptBtn').tap();
    await expect
      .poll(async () => {
        const rows = await readScratchLayoutWithDrift(project);
        const driftId = rows.find((row) => row.id === 'mk-seed')?.driftId;
        return driftId && rows.filter((row) => row.driftId === driftId).map((row) => row.id).sort().join(',');
      })
      .toBe('mk-2,mk-3,mk-seed');
    expect(await driftIdOf('mk-other')).toBe('');
    const historyAfter = await readScratchHistory(project);
    expect(historyAfter.entries.length - historyBefore.entries.length).toBe(1);

    // Accept leaves review and selects the new drift whole.
    await expect(bar).toBeHidden();
    await expect(page.locator('#selectionBarName')).toHaveText('CI (3x)');
  });

  test('a tap pulling in a member of another drift says how many are moving, opens the lifecycle choice itself, and Accept writes the chosen status on every member with the leftover losing its label, by touch', async ({
    page,
  }) => {
    const project = 'touch-drift-group-move';
    const driftIdOf = async (plantId) => {
      const rows = await readScratchLayoutWithDrift(project);
      return rows.find((row) => row.id === plantId)?.driftId || '';
    };

    await openScratchProject(page, project);
    await page.locator('[data-mode="edit"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

    const seed = await plantScreenPosition(page, 'topSvg', 'mv-seed');
    await tap(page, seed);
    await page.locator('#selectionBarMoreBtn').click();
    await page.locator('#selectionMakeDriftBtn').click();

    const label = page.locator('#driftReviewLabel');
    await expect(label).toHaveText('CI (1x)');

    const third = await plantScreenPosition(page, 'topSvg', 'mv-third');
    await tap(page, third);
    await expect(label).toHaveText('CI (2x)');

    // mv-a already belongs to 'mv-existing' (2 planted members): tapping it
    // in is allowed — it will move — and the bar says so, visible without
    // opening "More" (unlike a suggestion review's own one-shot hint). Its
    // status disagrees with mv-seed/mv-third's, so Accept needs a choice —
    // driftReviewMode.js opens More itself the moment that becomes true on a
    // phone, since the chooser lives behind it and touch never shows a title.
    const a = await plantScreenPosition(page, 'topSvg', 'mv-a');
    await tap(page, a);
    await expect(label).toHaveText('CI (3x)');
    await expect(page.locator('#driftReviewMovingHint')).toHaveText(
      '1 from CI (2x). Choose a planting status in More before Accept.'
    );
    await expect(page.locator('#driftReviewMore')).toHaveClass(/is-open/);
    await expect(page.locator('#driftReviewAcceptBtn')).toBeDisabled();
    await page.screenshot({ path: `${SHOT_DIR}/03-moving-from-another-drift.png` });

    await page.locator('#driftReviewLifecycleOptions .chip', { hasText: 'Planned' }).tap();
    await expect(page.locator('#driftReviewAcceptBtn')).toBeEnabled();

    const historyBefore = await readScratchHistory(project);
    await page.locator('#driftReviewAcceptBtn').tap();

    await expect
      .poll(async () => {
        const rows = await readScratchLayoutWithDrift(project);
        const driftId = rows.find((row) => row.id === 'mv-seed')?.driftId;
        return driftId && rows.filter((row) => row.driftId === driftId).map((row) => row.id).sort().join(',');
      })
      .toBe('mv-a,mv-seed,mv-third');
    // mv-b, left alone in mv-existing, drops the label — a drift always has >= 2 members.
    expect(await driftIdOf('mv-b')).toBe('');
    const historyAfter = await readScratchHistory(project);
    expect(historyAfter.entries.length - historyBefore.entries.length).toBe(1);
    await expect(page.locator('#driftReviewBar')).toBeHidden();
    await expect(page.locator('#selectionBarName')).toHaveText('CI (3x)');
  });
});

test.describe('the phone editor (nl-o47.4)', () => {
  /** The maximized panel's own `.view` element's inline transform — what
   * canvasGesture.js writes on every pinch/pan frame. */
  async function viewTransform(page) {
    return page.evaluate(() => document.querySelector('.view-panel.is-maximized .view')?.style.transform || '');
  }

  /** The screen-px <-> viewBox-unit scale `svg.getScreenCTM()` reports right
   * now — matrixScale's own definition (src/render/screenPoint.js), inlined
   * here since a page.evaluate closure cannot import that module. Pinching
   * from `startDistance` to `endDistance` should grow this by about their
   * ratio, whatever the starting zoom was. */
  async function svgScreenScale(page, svgId) {
    return page.evaluate((id) => {
      const m = document.getElementById(id).getScreenCTM();
      return Math.hypot(m.a, m.b);
    }, svgId);
  }

  /** The maximized `.view`'s own on-screen center — a safe, chrome-free
   * pinch anchor regardless of which view is showing. */
  async function viewCenter(page) {
    return page.evaluate(() => {
      const rect = document.querySelector('.view-panel.is-maximized .view').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
  }

  /** The plan's own plant closest to a screen point, by its data-cx/data-cy
   * (nl-o47.6.7) mapped through the SAME svg.getScreenCTM() every other
   * screen-position helper in this file uses — the plant most likely to
   * still be on screen after a pinch centered on that same point. */
  async function plantNearestScreenPoint(page, svgId, point) {
    return page.evaluate(
      ({ svgId, point }) => {
        const svg = document.getElementById(svgId);
        let best = null;
        let bestDist = Infinity;
        svg.querySelectorAll('g[data-plant-id]').forEach((g) => {
          const cx = Number(g.getAttribute('data-cx'));
          const cy = Number(g.getAttribute('data-cy'));
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
          const screen = new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM());
          const dist = Math.hypot(screen.x - point.x, screen.y - point.y);
          if (dist < bestDist) {
            bestDist = dist;
            best = { id: g.getAttribute('data-plant-id'), x: screen.x, y: screen.y };
          }
        });
        return best;
      },
      { svgId, point }
    );
  }

  test('entering the editor: a fixed full-screen canvas, tabs, and the idle bar; the page does not scroll', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-editor');
    await expect(page.locator('#phoneEditorTabs')).toBeHidden();

    await page.locator('[data-mode="edit"]').click();

    await expect(page.locator('.views[data-maximized]')).toHaveCount(1);
    await expect(page.locator('#phoneEditorTabs')).toBeVisible();
    await expect(page.locator('#phoneEditorBar')).toBeVisible(); // nothing selected yet: the idle bar
    await expect(page.locator('#selectionBar')).toBeHidden();
    await expect(page.locator('body')).toHaveClass(/is-phone-editor-open/);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');

    // A scroll attempt on the page behind the fixed editor goes nowhere.
    await page.evaluate(() => window.scrollTo(0, 400));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('the view switcher shows an elevation', async ({ page }) => {
    await openScratchProject(page, 'touch-editor');
    await page.locator('[data-mode="edit"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

    await page.locator('[data-view-tab="south"]').click();

    await page.locator('.views[data-maximized="south"]').waitFor();
    await expect(page.locator('[data-view-tab="south"]')).toHaveClass(/is-active/);
    await expect(page.locator('[data-view-tab="plan"]')).not.toHaveClass(/is-active/);
    // The elevation's own panel is what is actually visible now, not just
    // named by data-maximized — configureViews keeps every panel in the DOM.
    await expect(page.locator('.view-panel.is-maximized svg#southSvg')).toBeVisible();
  });

  test('month buttons change the month', async ({ page }) => {
    await openScratchProject(page, 'touch-editor');
    await page.locator('[data-mode="edit"]').click();

    const before = await page.locator('#phoneEditorMonthLabel').textContent();
    await page.locator('#phoneEditorMonthNextBtn').click();
    const after = await page.locator('#phoneEditorMonthLabel').textContent();
    expect(after).not.toBe(before);
    // The one #monthSlider src/app.js already listens to is what actually moved.
    await expect(page.locator('#monthReadout')).toHaveText(after);

    await page.locator('#phoneEditorMonthPrevBtn').click();
    await expect(page.locator('#phoneEditorMonthLabel')).toHaveText(before);
  });

  test('Plants sheet opens and hosts the species table; a species row still highlights', async ({ page }) => {
    await openScratchProject(page, 'touch-editor');
    await page.locator('[data-mode="edit"]').click();

    await page.locator('#phoneEditorPlantsBtn').click();
    await expect(page.locator('#plantsSheet')).toBeVisible();
    // #speciesTable itself moved in, not a copy of it.
    await expect(page.locator('#plantsSheetBody #speciesTable')).toHaveCount(1);

    const row = page.locator('#speciesTable tr[data-species-key]').first();
    await row.hover();
    await expect(row).toHaveClass(/is-highlighted/);

    // The close BUTTON, not the backdrop: the backdrop spans the whole
    // viewport (position: absolute; inset: 0), and its geometric center —
    // where Playwright clicks by default — sits UNDER the sheet's own
    // bottom-anchored panel, which intercepts the click there.
    await page.locator('.plants-sheet__close').click();
    await expect(page.locator('#plantsSheet')).toBeHidden();
    // Closing the sheet does not tear the table down — reopening shows it again.
    await page.locator('#phoneEditorPlantsBtn').click();
    await expect(page.locator('#plantsSheetBody #speciesTable')).toHaveCount(1);
  });

  test('Done leaves the editor back to View mode', async ({ page }) => {
    await openScratchProject(page, 'touch-editor');
    await page.locator('[data-mode="edit"]').click();
    await expect(page.locator('#phoneEditorBar')).toBeVisible();

    await page.locator('#phoneEditorDoneBtn').click();

    await expect(page.locator('[data-mode="view"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#phoneEditorTabs')).toBeHidden();
    await expect(page.locator('#phoneEditorBar')).toBeHidden();
    await expect(page.locator('.views[data-maximized]')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/is-phone-editor-open/);
  });

  test('a pinch zooms: a plant\'s on-screen size grows by about the pinch ratio, and Fit returns to the start', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-editor');
    await page.locator('[data-mode="edit"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

    const before = await svgScreenScale(page, 'topSvg');
    const center = await viewCenter(page);
    const RATIO = 2.5;
    await expect(page.locator('#phoneEditorFitBtn')).toBeDisabled(); // already at fit

    await pinchGesture(page, { center, startDistance: 100, endDistance: 100 * RATIO });

    const after = await svgScreenScale(page, 'topSvg');
    expect(after / before, 'the on-screen scale grew by about the pinch ratio').toBeGreaterThan(RATIO * 0.75);
    expect(after / before).toBeLessThan(RATIO * 1.25);
    await expect(page.locator('#phoneEditorFitBtn')).toBeEnabled();

    await page.locator('#phoneEditorFitBtn').click();
    const backToFit = await svgScreenScale(page, 'topSvg');
    expect(backToFit).toBeCloseTo(before, 1);
    await expect(page.locator('#phoneEditorFitBtn')).toBeDisabled();
  });

  test('after zooming, a one-finger drag with nothing selected pans the canvas; no plant moves', async ({ page }) => {
    await openScratchProject(page, 'touch-editor-zoom');
    await page.locator('[data-mode="edit"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();
    const before = await readScratchLayout('touch-editor-zoom');

    const center = await viewCenter(page);
    await pinchGesture(page, { center, startDistance: 100, endDistance: 250 });
    const transformAfterZoom = await viewTransform(page);

    await expect(page.locator('#selectionBar')).toBeHidden(); // nothing selected
    await touchGesture(page, { x: center.x, y: center.y, dx: 30, dy: 40, steps: 8 });

    const transformAfterPan = await viewTransform(page);
    expect(transformAfterPan, 'the pan moved the transform').not.toBe(transformAfterZoom);
    expect(await readScratchLayout('touch-editor-zoom'), 'no plant moved').toEqual(before);
  });

  test('after zooming, tap-select + drag still moves the plant by the finger delta, undo reverts it, and a drift still selects with its outline', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-editor-zoom-drift');
    await page.locator('[data-mode="edit"]').click();
    await page.locator('.views[data-maximized="plan"]').waitFor();

    // DRIFT_LAYOUT_CSV's centroid (15, 11) sits close to backyard's own yard
    // center, so a pinch centered on the view keeps the whole drift on
    // screen once zoomed.
    const center = await viewCenter(page);
    await pinchGesture(page, { center, startDistance: 100, endDistance: 220 });

    const target = await plantNearestScreenPoint(page, 'topSvg', center);
    expect(target, 'a drift member is still on screen once zoomed').toBeTruthy();
    const savedBefore = (await readScratchLayoutWithDrift('touch-editor-zoom-drift')).find(
      (row) => row.id === target.id
    );

    await tap(page, target);
    await expect(page.locator('#selectionBarName')).toHaveText('CI (4x)');
    await expect(page.locator('#topSvg [data-drift-outline]')).toBeVisible();

    // Drag from elsewhere on screen — since nl-o47.2, a drag with a
    // selection may start anywhere on the drawing — and measure the moved
    // member's OWN on-screen delta through getScreenCTM (ground truth,
    // exactly like the nl-o47.1 tests), which only stays exact under a CSS
    // transform if screenPoint.js's CTM-based mapping (not a rect/viewBox
    // ratio) is what both hit-testing and this measurement go through.
    const D = 50;
    const before = await plantNearestScreenPoint(page, 'topSvg', center);
    const away = { x: center.x - 80, y: center.y - 80 };
    await touchGesture(page, { x: away.x, y: away.y, dx: D, dy: D, steps: 10 });
    const after = await plantNearestScreenPoint(page, 'topSvg', { x: before.x + D, y: before.y + D });

    expect(Math.hypot(after.x - before.x - D, after.y - before.y - D), 'the drag tracked the finger').toBeLessThan(
      14
    );

    await expect
      .poll(
        async () => (await readScratchLayoutWithDrift('touch-editor-zoom-drift')).find((row) => row.id === target.id)
          ?.x,
        { timeout: 5000 }
      )
      .not.toBe(savedBefore.x);

    // Undo lives in the primary row (nl-o47.4), reachable without Done.
    await page.locator('#selectionUndoBtn').click();
    await expect
      .poll(
        async () => (await readScratchLayoutWithDrift('touch-editor-zoom-drift')).find((row) => row.id === target.id)
          ?.x,
        { timeout: 5000 }
      )
      .toBeCloseTo(savedBefore.x, 3);
  });
});
