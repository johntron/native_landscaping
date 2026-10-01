import { test, expect } from '@playwright/test';
import { parseCsv } from '../src/data/csvLoader.js';
import { openScratchProject, readScratchHistory, readScratchLayout, SCRATCH_BASE } from './helpers.js';

// "Paint a drift along a stroke" (nl-o47.6.6), by mouse. Painting auto-saves
// through POST /api/layout exactly like every other drift-making path, so
// this runs against the throwaway scratch server, never the repo's own
// projects/ (docs/testing.md).

const planPlants = (page) => page.locator('#topSvg g[data-plant-id]');

/** Winecup (plants.csv): width_ft 3, so its resolved spacing is
 * 3 * SPACING_FACTOR (0.5, src/state/driftGeometry.js) = 1.5 ft. */
const SPACING_FT = 1.5;

async function openAddPlantSheet(page) {
  await page.locator('[data-mode="edit"]').click();
  await page.locator('#addPlantBtn').click();
  await expect(page.locator('#addPlantSheet')).toBeVisible();
}

/** The scratch yard's saved layout as full CSV rows (id, species_id,
 * drift_id, …) — readScratchLayout/readScratchLayoutWithDrift (helpers.js)
 * each drop columns this needs the others of. */
async function readScratchLayoutRows(projectId) {
  const res = await fetch(`${SCRATCH_BASE}/api/layout?project=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error(`/api/layout for ${projectId} answered ${res.status}`);
  return parseCsv(await res.text());
}

/**
 * Screen px per plan foot, measured EMPIRICALLY from two already-placed
 * plants' own feet (the saved layout) and their current on-screen centres
 * (`data-cx`/`data-cy`, nl-o47.6.7, mapped through svg.getScreenCTM() —
 * correct under any zoom or CSS transform, nl-o47.1/nl-o47.4). Never derive
 * this from `--page-px-per-ft` alone: that is the page's REST scale in
 * screen px per foot, which is a different number from the SVG's own
 * internal viewBox-units-per-foot, and conflating the two silently drops a
 * factor of the current screenCTM scale. The plan is never rotated or
 * mirrored (unlike an elevation), so one scalar applies along both axes.
 */
async function screenPxPerFoot(page, svgId, projectId) {
  const rows = await readScratchLayoutRows(projectId);
  let a = rows[0];
  let b = rows[0];
  rows.forEach((row) => {
    if (Number(row.x_ft) < Number(a.x_ft)) a = row;
    if (Number(row.x_ft) > Number(b.x_ft)) b = row;
  });
  const feetDist = Math.hypot(Number(b.x_ft) - Number(a.x_ft), Number(b.y_ft) - Number(a.y_ft));
  const [screenA, screenB] = await page.evaluate(
    ({ svgId, idA, idB }) => {
      const svg = document.getElementById(svgId);
      const screenOf = (id) => {
        const g = svg.querySelector(`g[data-plant-id="${CSS.escape(id)}"]`);
        const point = new DOMPoint(Number(g.getAttribute('data-cx')), Number(g.getAttribute('data-cy')));
        const screen = point.matrixTransform(svg.getScreenCTM());
        return { x: screen.x, y: screen.y };
      };
      return [screenOf(idA), screenOf(idB)];
    },
    { svgId, idA: a.id, idB: b.id }
  );
  const screenDist = Math.hypot(screenB.x - screenA.x, screenB.y - screenA.y);
  return screenDist / feetDist;
}

/** Every `g[data-plant-id]` on the plan NOT currently dimmed (nl-o47.6.2's
 * isolation): exactly a whole selected drift's own members, once something is
 * selected — everything else, existing plants and any other drift alike,
 * dims. The way to confirm Done selected THIS stroke's drift and not some
 * other same-sized one. */
async function nonDimmedPlantIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#topSvg g[data-plant-id]')]
      .filter((g) => g.getAttribute('data-dimmed') !== 'true')
      .map((g) => g.getAttribute('data-plant-id'))
  );
}

test.describe('painting a drift along a stroke by mouse (nl-o47.6.6)', () => {
  test('choosing Paint enters paint mode; a known-length stroke places the right count sharing one driftId in one history entry; a second stroke makes a second drift; Done selects the last one; existing plants never move', async ({
    page,
  }) => {
    await openScratchProject(page, 'paint-mouse');
    await openAddPlantSheet(page);

    const before = await planPlants(page).count();
    const idsBefore = await planPlants(page).evaluateAll((els) => els.map((el) => el.dataset.plantId));
    const layoutBefore = await readScratchLayoutRows('paint-mouse');
    const existingBefore = layoutBefore.filter((row) => idsBefore.includes(row.id));
    const historyBefore = (await readScratchHistory('paint-mouse'))?.entries.length ?? 0;

    // The Place | Paint toggle sits beside "How many?" (nl-o47.6.6); Paint
    // hides the count stepper, since it means nothing there.
    await expect(page.locator('#addPlantModePlaceBtn')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#addPlantModePaintBtn').click();
    await expect(page.locator('#addPlantModePaintBtn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#addPlantCountFields')).toBeHidden();

    await page.locator('#addPlantSearch').fill('Winecup');
    const row = page.locator('#addPlantList .add-plant-sheet__row').first();
    const speciesId = await row.getAttribute('data-species-id');
    await row.locator('.add-plant-sheet__pick').click();

    // Choosing a species in Paint closes the sheet and enters paint mode.
    await expect(page.locator('#addPlantSheet')).toBeHidden();
    await expect(page.locator('#paintBar')).toBeVisible();
    await expect(page.locator('#paintBarLabel')).toContainText('Paint');
    await expect(page.locator('#selectionBar')).toBeHidden(); // suspended throughout painting
    // A clear mode cue on desktop (styles.css's is-paint-enabled).
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.getElementById('topSvg')).cursor))
      .toBe('crosshair');

    const N = 5;
    // Comfortably past (N-1) spacings and short of N, so small pixel-rounding
    // noise cannot flip which multiple of the spacing the stroke lands on
    // (resampleStroke: floor(lengthFt / spacingFt) + 1 plants, start included).
    const strokeFt = (N - 1 + 0.4) * SPACING_FT;
    // page.mouse uses viewport coordinates and does not scroll (docs/testing.md).
    await page.locator('#topSvg').scrollIntoViewIfNeeded();
    const box = await page.locator('#topSvg').boundingBox();
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const scale = await screenPxPerFoot(page, 'topSvg', 'paint-mouse');
    const dxPx = strokeFt * scale;

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // A live preview appears mid-drag (src/render/topView.js's appendPaintPreview).
    await page.mouse.move(start.x + dxPx / 2, start.y, { steps: 5 });
    await expect(page.locator('.paint-preview-dot').first()).toBeVisible();
    await page.mouse.move(start.x + dxPx, start.y, { steps: 5 });
    await page.mouse.up();

    await expect(planPlants(page)).toHaveCount(before + N);
    await expect(page.locator('.paint-preview-dot')).toHaveCount(0); // cleared once the stroke committed
    await expect(page.locator('#paintBar')).toBeVisible(); // still painting: more strokes until Done

    const idsAfterStroke1 = await planPlants(page).evaluateAll((els) => els.map((el) => el.dataset.plantId));
    const newIds1 = idsAfterStroke1.filter((id) => !idsBefore.includes(id));
    expect(newIds1.length).toBe(N);

    await expect
      .poll(async () => (await readScratchHistory('paint-mouse'))?.entries.length ?? 0, { timeout: 5000 })
      .toBe(historyBefore + 1);
    const historyAfterStroke1 = (await readScratchHistory('paint-mouse')).entries;
    expect(historyAfterStroke1[historyAfterStroke1.length - 1].description).toMatch(/^Painted /);

    const layoutAfterStroke1 = await readScratchLayoutRows('paint-mouse');
    const newRows1 = layoutAfterStroke1.filter((row) => newIds1.includes(row.id));
    newRows1.forEach((row) => expect(row.species_id).toBe(speciesId));
    const driftIds1 = new Set(newRows1.map((row) => row.drift_id));
    expect(driftIds1.size).toBe(1);
    const [driftId1] = driftIds1;
    expect(driftId1).toBeTruthy();

    // Existing plants have not moved.
    expect(layoutAfterStroke1.filter((row) => idsBefore.includes(row.id))).toEqual(existingBefore);

    // A second stroke, a bit south of the first, makes a SECOND drift.
    const start2 = { x: start.x, y: start.y + Math.min(80, box.height / 4) };
    await page.mouse.move(start2.x, start2.y);
    await page.mouse.down();
    await page.mouse.move(start2.x + dxPx, start2.y, { steps: 10 });
    await page.mouse.up();

    const idsAfterStroke2 = await planPlants(page).evaluateAll((els) => els.map((el) => el.dataset.plantId));
    const newIds2 = idsAfterStroke2.filter((id) => !idsAfterStroke1.includes(id));
    expect(newIds2.length).toBe(N);
    const layoutAfterStroke2 = await readScratchLayoutRows('paint-mouse');
    const newRows2 = layoutAfterStroke2.filter((row) => newIds2.includes(row.id));
    const driftIds2 = new Set(newRows2.map((row) => row.drift_id));
    expect(driftIds2.size).toBe(1);
    const [driftId2] = driftIds2;
    expect(driftId2).toBeTruthy();
    expect(driftId2).not.toBe(driftId1);

    // Done leaves paint mode and selects the LAST painted drift specifically
    // (not merely "a drift this size") — isolation dims every other plant.
    await page.locator('#paintDoneBtn').click();
    await expect(page.locator('#paintBar')).toBeHidden();
    await expect(page.locator('#selectionBar')).toBeVisible();
    await expect(page.locator('#selectionBarName')).toHaveText(new RegExp(`\\(${N}x\\)`));
    expect(new Set(await nonDimmedPlantIds(page))).toEqual(new Set(newIds2));

    // Undo (the real toolbar button now that paint mode has ended) removes
    // the second drift in one step.
    await page.locator('#undoLayoutBtn').click();
    await expect(planPlants(page)).toHaveCount(before + N);
    await expect.poll(async () => (await readScratchLayout('paint-mouse')).length, { timeout: 5000 }).toBe(before + N);

    // Existing plants still haven't moved, after everything.
    const finalLayout = await readScratchLayoutRows('paint-mouse');
    expect(finalLayout.filter((row) => idsBefore.includes(row.id))).toEqual(existingBefore);
  });
});
