import { test, expect } from '@playwright/test';
import { dragInPanel, openScratchProject, readScratchLayout } from './helpers.js';

// Dragging saves through POST /api/layout, so these run against the throwaway
// document root built by scratch-fixture.mjs — never the repo's own projects/.
// Each spec owns a project, because a drag in one would move the plants the
// next one aims at.

/** Rows whose saved position differs from an untouched copy of the same yard. */
async function movedRows(projectId, original, axis) {
  const saved = await readScratchLayout(projectId);
  return saved.filter((row) => {
    const was = original.find((r) => r.id === row.id);
    if (!was) return false;
    if (axis) return Math.abs(was[axis] - row[axis]) > 1e-6;
    return Math.abs(was.x - row.x) > 1e-6 || Math.abs(was.y - row.y) > 1e-6;
  });
}

test.describe('dragging plants', () => {
  test('a plan-view drag moves the plant and saves it', async ({ page }) => {
    await openScratchProject(page, 'drag-plan');
    await page.locator('[data-mode="edit"]').click();

    const result = await dragInPanel(page, 'topSvg');
    expect(result.grabbed, 'the hit test found a plant').toBe(true);
    expect(result.moved, 'the drawing responded').toBe(true);

    // The move reached disk, not just the DOM. The save is a POST, so poll.
    const original = await readScratchLayout('drag-locked'); // untouched copy of the same yard
    await expect
      .poll(async () => (await movedRows('drag-plan', original)).length, { timeout: 5000 })
      .toBe(1);
  });

  test('an elevation drag moves the plant along that view axis only', async ({ page }) => {
    await openScratchProject(page, 'drag-elevation');
    await page.locator('[data-mode="edit"]').click();

    // The south elevation runs the yard's x axis across the drawing, so a drag
    // there edits x and must leave y alone.
    const result = await dragInPanel(page, 'southSvg', { kind: 'elevation', dy: 0 });
    expect(result.grabbed, 'the hit test found a plant').toBe(true);
    expect(result.moved, 'the drawing responded').toBe(true);

    const original = await readScratchLayout('drag-locked'); // untouched copy of the same yard
    await expect
      .poll(async () => (await movedRows('drag-elevation', original, 'x')).length, { timeout: 5000 })
      .toBe(1);
    expect(
      (await movedRows('drag-elevation', original, 'y')).length,
      'the depth axis stayed put'
    ).toBe(0);
  });

  test('dragging is refused outside edit mode', async ({ page }) => {
    await openScratchProject(page, 'drag-locked');
    // View mode is the default; no click needed.
    const result = await dragInPanel(page, 'topSvg');
    expect(result.grabbed, 'nothing is grabbed while locked').toBe(false);
    expect(result.moved, 'the drawing did not change').toBe(false);
  });
});
