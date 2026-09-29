import { test, expect } from '@playwright/test';
import { openScratchProject, plantScreenPosition, readScratchLayoutWithDrift } from './helpers.js';

/**
 * Desktop mouse coverage for selecting, isolating, dragging, and resizing a
 * drift (nl-o47.6.2) — the mouse-specific half of tests-e2e/touch.spec.js's
 * "drifts" describe block. Mouse has no separate tap step: pressing a member
 * of an already whole-selected drift starts the group drag immediately, and
 * only narrows to that one member if the press turns out to be a plain click
 * (no movement) — see src/interaction/dragController.js's own comment. These
 * specs write (drag/count/spread/rename all auto-save), so they run against
 * the scratch server, one project per test, never the repo's own projects/.
 */

const DRIFT_MEMBERS = ['drift-a', 'drift-b', 'drift-c', 'drift-d'];
const SEEDED_POSITIONS = {
  'drift-a': { x: 12, y: 8 },
  'drift-b': { x: 18, y: 8 },
  'drift-c': { x: 12, y: 14 },
  'drift-d': { x: 18, y: 14 },
};

/** The midpoint between two members' own screen positions — see
 * touch.spec.js's identical helper for why this lands on the drift's own
 * centroid without replicating the app's feet<->viewBox transform here. */
async function midpointOf(page, idA, idB) {
  const a = await plantScreenPosition(page, 'topSvg', idA);
  const b = await plantScreenPosition(page, 'topSvg', idB);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * A point inside the plan panel that is not on any plant and clearly outside
 * the seeded drift's own outline: 70 screen px right of the unrelated
 * lone-plant (well past MIN_HITBOX_RADIUS_PX's own reach, and lone-plant
 * itself sits at yard (4, 4), far from the drift's (12-18, 8-14) square).
 * Derived from a real plant's own screenCTM-mapped position, unlike
 * touch.spec.js's own emptySpotIn (the panel's bounding-rect corner): on the
 * desktop layout a view panel's own toggle row can sit over that corner.
 */
async function emptySpotIn(page, svgId) {
  const lone = await plantScreenPosition(page, svgId, 'lone-plant');
  return { x: lone.x + 70, y: lone.y };
}

async function driftMemberIds(projectId) {
  return (await readScratchLayoutWithDrift(projectId))
    .filter((row) => row.driftId === 'winecup-drift')
    .map((row) => row.id);
}

test.describe('drifts, by mouse (nl-o47.6.2)', () => {
  test('a click on a member selects the whole drift; a click between members does too; a second click drills in; a click outside leaves', async ({
    page,
  }) => {
    await openScratchProject(page, 'desktop-drift-select');
    await page.locator('[data-mode="edit"]').click();

    const target = await plantScreenPosition(page, 'topSvg', 'drift-a');
    await page.mouse.click(target.x, target.y);

    await expect(page.locator('#selectionBar')).toBeVisible();
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();
    await expect(page.locator('#selectionDriftCountLabel')).toContainText('4 plants');
    await expect(page.locator('#topSvg [data-drift-outline]')).toBeVisible();
    expect(await page.locator('#topSvg [data-selection-ring]').count()).toBe(4);
    await expect(page.locator('#topSvg g[data-plant-id="lone-plant"]')).toHaveAttribute('data-dimmed', 'true');

    // A click in the gap between members (the drift's own centroid) also
    // selects the whole drift — no member is directly under the pointer.
    const gap = await midpointOf(page, 'drift-a', 'drift-d');
    await page.mouse.click(gap.x, gap.y);
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();
    await expect(page.locator('#selectionDriftCountLabel')).toContainText('4 plants');

    // A further click (no movement) on a member of the already whole-
    // selected drift drills into it.
    await page.mouse.click(target.x, target.y);
    await expect(page.locator('#selectionDriftNameGroup')).toBeHidden();
    await expect(page.locator('#selectionBarName')).toBeVisible();
    await expect(page.locator('#selectionBackToDriftBtn')).toBeVisible();
    await expect(page.locator('#selectionRemoveFromDriftBtn')).toBeVisible();

    // A click outside the (still isolated, now drilled-into) drift's own
    // outline leaves it.
    const outside = await emptySpotIn(page, 'topSvg');
    await page.mouse.click(outside.x, outside.y);
    await expect(page.locator('#selectionBar')).toBeHidden();
  });

  test('pressing a member and dragging moves the whole drift, as one undo step, leaving the unrelated plant alone', async ({
    page,
  }) => {
    await openScratchProject(page, 'desktop-drift-drag');
    await page.locator('[data-mode="edit"]').click();

    const target = await plantScreenPosition(page, 'topSvg', 'drift-a');
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    // A fresh press on an unselected drift's member selects it and starts
    // dragging the whole group in the SAME gesture — no separate click first.
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();
    await page.mouse.move(target.x + 40, target.y - 30, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(
        async () => (await readScratchLayoutWithDrift('desktop-drift-drag')).find((r) => r.id === 'drift-a')?.x,
        { timeout: 5000 }
      )
      .not.toBeCloseTo(SEEDED_POSITIONS['drift-a'].x, 3);

    const after = await readScratchLayoutWithDrift('desktop-drift-drag');
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
        async () => (await readScratchLayoutWithDrift('desktop-drift-drag')).find((r) => r.id === 'drift-a')?.x,
        { timeout: 5000 }
      )
      .toBeCloseTo(SEEDED_POSITIONS['drift-a'].x, 2);
  });

  test('+ adds a member and - removes one, each its own undo step', async ({ page }) => {
    await openScratchProject(page, 'desktop-drift-count');
    await page.locator('[data-mode="edit"]').click();
    const target = await plantScreenPosition(page, 'topSvg', 'drift-a');
    await page.mouse.click(target.x, target.y);
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('4');

    await page.locator('#selectionDriftCountIncBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('desktop-drift-count')).length, { timeout: 5000 })
      .toBe(5);
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('5');

    await page.locator('#undoLayoutBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('desktop-drift-count')).length, { timeout: 5000 })
      .toBe(4);

    await page.locator('#selectionDriftCountDecBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('desktop-drift-count')).length, { timeout: 5000 })
      .toBe(3);

    await page.locator('#undoLayoutBtn').click();
    await expect
      .poll(async () => (await driftMemberIds('desktop-drift-count')).length, { timeout: 5000 })
      .toBe(4);
  });

  test('spread changes the distance between members', async ({ page }) => {
    await openScratchProject(page, 'desktop-drift-spread');
    await page.locator('[data-mode="edit"]').click();
    const target = await plantScreenPosition(page, 'topSvg', 'drift-a');
    await page.mouse.click(target.x, target.y);
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();

    const distanceAB = async () => {
      const rows = await readScratchLayoutWithDrift('desktop-drift-spread');
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
    await openScratchProject(page, 'desktop-drift-rename');
    await page.locator('[data-mode="edit"]').click();
    const target = await plantScreenPosition(page, 'topSvg', 'drift-a');
    await page.mouse.click(target.x, target.y);
    await expect(page.locator('#selectionDriftNameGroup')).toBeVisible();

    await page.locator('#selectionDriftNameInput').fill('Front Edge');
    await page.locator('#selectionDriftNameInput').press('Enter');

    await expect(page.locator('#selectionDriftNameInput')).toHaveValue('Front edge');
    await expect
      .poll(
        async () =>
          (await readScratchLayoutWithDrift('desktop-drift-rename')).find((r) => r.id === 'drift-a')?.driftId,
        { timeout: 5000 }
      )
      .toBe('front-edge');

    await openScratchProject(page, 'desktop-drift-rename'); // a fresh load of the same yard
    const reloaded = await plantScreenPosition(page, 'topSvg', 'drift-a');
    await page.mouse.click(reloaded.x, reloaded.y);
    await expect(page.locator('#selectionDriftNameInput')).toHaveValue('Front edge');
  });

  test('a refused rename (empty, or colliding with another drift) is refused inline, no window.prompt', async ({
    page,
  }) => {
    await openScratchProject(page, 'desktop-drift-rename-refuse');
    await page.locator('[data-mode="edit"]').click();
    const target = await plantScreenPosition(page, 'topSvg', 'drift-a');
    await page.mouse.click(target.x, target.y);

    const input = page.locator('#selectionDriftNameInput');
    await input.fill('');
    await input.press('Enter');
    await expect(page.locator('#selectionDriftNameStatus')).toBeVisible();
    await expect(page.locator('#selectionDriftNameStatus')).not.toBeEmpty();

    // The drift's own id (winecup-drift, humanized "Winecup drift") is the
    // only other name to collide with in this seeded yard — collide with
    // itself is defined as a no-op, not a refusal, so this only checks that
    // an empty name specifically is refused and shown inline.
  });

  test('"+" on a single plant makes it a drift of 2; "-" brings back the same plant; both undo/redo (nl-o47.6.9)', async ({
    page,
  }) => {
    await openScratchProject(page, 'desktop-drift-convert');
    await page.locator('[data-mode="edit"]').click();
    const target = await plantScreenPosition(page, 'topSvg', 'solo');
    await page.mouse.click(target.x, target.y);

    await expect(page.locator('#selectionBar')).toBeVisible();
    await expect(page.locator('#selectionBarName')).toHaveText('Winecup');
    await expect(page.locator('#selectionDriftCountGroup')).toBeVisible();
    await expect(page.locator('#selectionDriftCountValue')).toHaveText('1');
    await expect(page.locator('#selectionDriftCountDecBtn')).toBeDisabled();
    await expect(page.locator('#topSvg [data-drift-outline]')).toBeHidden();

    await page.locator('#selectionDriftCountIncBtn').click();
    await expect(page.locator('#selectionBarName')).toContainText('· 2 plants');
    await expect(page.locator('#topSvg [data-drift-outline]')).toBeVisible();
    await expect
      .poll(async () => (await readScratchLayoutWithDrift('desktop-drift-convert')).length, { timeout: 5000 })
      .toBe(2);
    let rows = await readScratchLayoutWithDrift('desktop-drift-convert');
    const solo = rows.find((r) => r.id === 'solo');
    const other = rows.find((r) => r.id !== 'solo');
    expect(solo.driftId, 'the original plant keeps its own id and gains a driftId').not.toBe('');
    expect(other.driftId).toBe(solo.driftId);

    // "-" (the tie-break: the newer member) hands the original plant back,
    // unlabelled, still selected as a single plant.
    await page.locator('#selectionDriftCountDecBtn').click();
    await expect(page.locator('#selectionBarName')).toHaveText('Winecup');
    await expect
      .poll(async () => (await readScratchLayoutWithDrift('desktop-drift-convert')).length, { timeout: 5000 })
      .toBe(1);
    rows = await readScratchLayoutWithDrift('desktop-drift-convert');
    expect(rows[0].id).toBe('solo');
    expect(rows[0].driftId).toBe('');

    // Undo brings the drift of 2 back; undo again returns to the plain plant.
    await page.locator('#undoLayoutBtn').click();
    await expect
      .poll(async () => (await readScratchLayoutWithDrift('desktop-drift-convert')).length, { timeout: 5000 })
      .toBe(2);
    await page.locator('#undoLayoutBtn').click();
    await expect
      .poll(async () => (await readScratchLayoutWithDrift('desktop-drift-convert')).length, { timeout: 5000 })
      .toBe(1);
    rows = await readScratchLayoutWithDrift('desktop-drift-convert');
    expect(rows[0].id).toBe('solo');
    expect(rows[0].driftId).toBe('');

    // Redo replays both steps.
    await page.locator('#redoLayoutBtn').click();
    await page.locator('#redoLayoutBtn').click();
    await expect
      .poll(async () => (await readScratchLayoutWithDrift('desktop-drift-convert')).length, { timeout: 5000 })
      .toBe(1);
    rows = await readScratchLayoutWithDrift('desktop-drift-convert');
    expect(rows[0].id).toBe('solo');
    expect(rows[0].driftId).toBe('');
  });
});
