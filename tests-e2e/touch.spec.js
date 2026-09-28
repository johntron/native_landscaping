import { test, expect } from '@playwright/test';
import {
  openScratchProject,
  pinchGesture,
  plantPointerTarget,
  plantPosition,
  plantScreenPosition,
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

  test('with nothing selected, a vertical swipe over the drawing scrolls the page and moves no plant', async ({
    page,
  }) => {
    await openScratchProject(page, 'touch-hold');
    await page.locator('[data-mode="edit"]').click();
    await expect(page.locator('#selectionBar')).toBeHidden();

    const before = await readScratchLayout('touch-hold');
    const spot = await emptySpotIn(page, 'topSvg');
    const scrollBefore = await page.evaluate(() => window.scrollY);

    await touchGesture(page, { x: spot.x, y: spot.y, dy: -120 });

    expect(
      await page.evaluate(() => window.scrollY),
      'a finger on empty canvas still pans the page'
    ).toBeGreaterThan(scrollBefore);
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

    await page.locator('#selectionNudgeE').click();

    await expect
      .poll(async () => (await savedPosition('touch-nudge', target.id))?.x, { timeout: 5000 })
      .not.toBe(before.x);
    const afterNudge = await savedPosition('touch-nudge', target.id);
    // East is +x, by exactly the nudge step (0.5 ft, src/state/nudgeSelection.js).
    expect(afterNudge.x - before.x).toBeCloseTo(0.5, 5);
    expect(afterNudge.y, 'nudging east leaves y alone').toBeCloseTo(before.y, 5);

    // Undo lives in the Edit row; the nudge committed its own revision.
    await page.locator('#undoLayoutBtn').click();
    await expect
      .poll(async () => (await savedPosition('touch-nudge', target.id))?.x, { timeout: 5000 })
      .toBeCloseTo(before.x, 5);
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
      return { x: rect.left + rect.width / 2, y: rect.top + Math.min(30, rect.height / 4) };
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
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();
    await expect(page.locator('#selectionDriftCountLabel')).toContainText('4 plants');
    await expect(page.locator('#topSvg [data-drift-outline]')).toBeVisible();
    // Every member gets a selection ring; the unrelated plant is dimmed, not ringed.
    expect(await page.locator('#topSvg [data-selection-ring]').count()).toBe(4);
    await expect(page.locator('#topSvg g[data-plant-id="lone-plant"]')).toHaveAttribute('data-dimmed', 'true');

    // A tap in the gap between members, well inside the outline (the drift's
    // own centroid — see midpointOf), also selects the whole drift.
    await tap(page, await midpointOf(page, 'drift-a', 'drift-d'));
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();
    await expect(page.locator('#selectionDriftCountLabel')).toContainText('4 plants');

    // A further tap on a member drills into it: the plain single-plant bar
    // returns, with the two drift-member extras.
    await tap(page, target);
    await expect(page.locator('#selectionDriftNameGroup')).toBeHidden();
    await expect(page.locator('#selectionBarName')).toBeVisible();
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
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();

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

    await page.locator('#undoLayoutBtn').click();
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
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('4');

    await page.locator('#selectionDriftCountIncBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('touch-drift-count')).length, { timeout: 5000 })
      .toBe(5);
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('5');

    await page.locator('#undoLayoutBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('touch-drift-count')).length, { timeout: 5000 })
      .toBe(4);

    await page.locator('#selectionDriftCountDecBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('touch-drift-count')).length, { timeout: 5000 })
      .toBe(3);

    await page.locator('#undoLayoutBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('touch-drift-count')).length, { timeout: 5000 })
      .toBe(4);
  });

  test('spread changes the distance between members', async ({ page }) => {
    await openScratchProject(page, 'touch-drift-spread');
    await page.locator('[data-mode="edit"]').click();
    await tap(page, await driftMemberScreen(page, 'drift-a'));
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();

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

  test('rename changes the label and survives a reload', async ({ page }) => {
    await openScratchProject(page, 'touch-drift-rename');
    await page.locator('[data-mode="edit"]').click();
    await tap(page, await driftMemberScreen(page, 'drift-a'));
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();

    await page.locator('#selectionDriftNameInput').fill('Front Edge');
    await page.locator('#selectionDriftNameInput').press('Enter');

    await expect(page.locator('#selectionDriftNameInput')).toHaveValue('Front edge');
    await expect
      .poll(
        async () => (await readScratchLayoutWithDrift('touch-drift-rename')).find((r) => r.id === 'drift-a')?.driftId,
        { timeout: 5000 }
      )
      .toBe('front-edge');

    await openScratchProject(page, 'touch-drift-rename'); // a fresh load of the same yard
    await tap(page, await driftMemberScreen(page, 'drift-a'));
    await expect(page.locator('#selectionDriftNameInput')).toHaveValue('Front edge');
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

    await page.locator('[data-mode="edit"]').click();
    await page
      .locator('#speciesTable button.species-table__drift-chip[data-drift-id="winecup-drift"]')
      .tap();
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();
    await expect(page.locator('#selectionDriftCountLabel')).toContainText('4 plants');
  });
});
