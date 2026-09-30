import { test, expect } from '@playwright/test';
import {
  openScratchProject,
  plantScreenPosition,
  readScratchHistory,
  readScratchLayoutWithDrift,
} from './helpers.js';

/** History entries hold real placement objects (src/data/placements.js), so
 * a lifecycle field like `status` reads off those rather than the exported
 * layout CSV — the same pattern tests-e2e/driftLifecycle.spec.js uses. */
async function currentPlantsFromHistory(projectId) {
  const history = await readScratchHistory(projectId);
  const entry = history?.entries[history.cursor];
  return entry?.plants || [];
}

/**
 * Desktop mouse coverage for "group selected plants into a drift" (nl-
 * o47.6.4, nl-o47.6's making method 2): the selection bar's "Make drift" on
 * a single plant not already in a drift opens the SAME review UI a
 * suggestion opens (src/interaction/driftReviewMode.js's group mode), seeded
 * with just that one plant. Seeded by tests-e2e/scratch-fixture.mjs's
 * DRIFT_GROUP_LAYOUT_CSV (one lone winecup, two more same-species undrifted,
 * one horseherb well clear of them) and DRIFT_GROUP_MOVE_LAYOUT_CSV (a
 * member of an existing 2-plant drift, mixed lifecycle). These specs write
 * (Accept auto-saves through POST /api/layout), so they run against the
 * scratch server, one project per test.
 */

const driftIdOf = async (projectId, plantId) => {
  const rows = await readScratchLayoutWithDrift(projectId);
  return rows.find((row) => row.id === plantId)?.driftId || '';
};

test('Make drift entry, a different-species tap ignored, shift-click toggles, Cancel writes nothing, then Accept writes one shared drift_id in one undo step with the whole drift selected', async ({
  page,
}) => {
  const project = 'desktop-drift-group';
  await openScratchProject(page, project);
  await page.locator('[data-mode="edit"]').click();

  const bar = page.locator('#driftReviewBar');
  const label = page.locator('#driftReviewLabel');
  const acceptBtn = page.locator('#driftReviewAcceptBtn');
  const cancelBtn = page.locator('#driftReviewSkipBtn'); // relabelled "Cancel" in group mode

  // A single plain plant's selection bar offers "Make drift" (not a real
  // drift yet, so Details/Clone/Remove still show too).
  const seed = await plantScreenPosition(page, 'topSvg', 'mk-seed');
  await page.mouse.click(seed.x, seed.y);
  const makeDriftBtn = page.locator('#selectionMakeDriftBtn');
  await expect(makeDriftBtn).toBeVisible();
  await expect(page.locator('#selectionDetailsBtn')).toBeVisible();

  await makeDriftBtn.click();
  // Opens the SAME review bar a suggestion does, seeded with just this one
  // plant: no "· N of M" (there is no queue), Accept disabled below 2.
  await expect(bar).toBeVisible();
  await expect(label).toHaveText('CI (1x)');
  await expect(acceptBtn).toBeDisabled();
  await expect(cancelBtn).toHaveText('Cancel');
  // Cancel is the way out here; a Stop in More would be the same button twice.
  await expect(page.locator('#driftReviewStopBtn')).toBeHidden();
  await expect(page.locator('#selectionBar')).toBeHidden(); // the ordinary selection is cleared throughout

  // A different-species tap does nothing (nl-o47.6.5's own "Adjust" rule),
  // but says so once in the bar's own visible hint (unlike a suggestion's,
  // this one is not tucked behind More).
  const other = await plantScreenPosition(page, 'topSvg', 'mk-other');
  await page.mouse.click(other.x, other.y);
  await expect(label).toHaveText('CI (1x)');
  await expect(page.locator('#driftReviewMovingHint')).toContainText('different species');

  // A same-species, undrifted plant joins on a plain click...
  const mk2 = await plantScreenPosition(page, 'topSvg', 'mk-2');
  await page.mouse.click(mk2.x, mk2.y);
  await expect(label).toHaveText('CI (2x)');
  await expect(acceptBtn).toBeEnabled(); // the floor (2) is met, lifecycles agree

  // ...and a SHIFT-click toggles it just the same (nl-o47.6.4's own note: no
  // marquee, a plain click already does this — shift needs no special code).
  const mk3 = await plantScreenPosition(page, 'topSvg', 'mk-3');
  await page.mouse.click(mk3.x, mk3.y, { modifiers: ['Shift'] });
  await expect(label).toHaveText('CI (3x)');

  // Cancel leaves without writing anything.
  const historyBeforeCancel = await readScratchHistory(project);
  await cancelBtn.click();
  await expect(bar).toBeHidden();
  expect(await driftIdOf(project, 'mk-seed')).toBe('');
  expect(await driftIdOf(project, 'mk-2')).toBe('');
  expect(await driftIdOf(project, 'mk-3')).toBe('');
  const historyAfterCancel = await readScratchHistory(project);
  expect(historyAfterCancel.entries.length).toBe(historyBeforeCancel.entries.length);

  // Re-select the seed and do it again, this time accepting.
  await page.mouse.click(seed.x, seed.y);
  await makeDriftBtn.click();
  await page.mouse.click(mk2.x, mk2.y);
  await page.mouse.click(mk3.x, mk3.y);
  await expect(label).toHaveText('CI (3x)');

  const historyBefore = await readScratchHistory(project);
  await acceptBtn.click();

  await expect
    .poll(async () => {
      const rows = await readScratchLayoutWithDrift(project);
      const driftId = rows.find((row) => row.id === 'mk-seed')?.driftId;
      return driftId && rows.filter((row) => row.driftId === driftId).map((row) => row.id).sort().join(',');
    })
    .toBe('mk-2,mk-3,mk-seed');
  expect(await driftIdOf(project, 'mk-other')).toBe('');
  const historyAfter = await readScratchHistory(project);
  expect(historyAfter.entries.length - historyBefore.entries.length).toBe(1);

  // Accept leaves review and selects the new drift whole.
  await expect(bar).toBeHidden();
  await expect(page.locator('#selectionBar')).toBeVisible();
  await expect(page.locator('#selectionBarName')).toHaveText('CI (3x)');
});

test('including a member of another 2-plant drift moves it (the leftover loses its label), and mixed lifecycles require a choice before Accept', async ({
  page,
}) => {
  const project = 'desktop-drift-group-move';
  await openScratchProject(page, project);
  await page.locator('[data-mode="edit"]').click();

  const bar = page.locator('#driftReviewBar');
  const label = page.locator('#driftReviewLabel');
  const acceptBtn = page.locator('#driftReviewAcceptBtn');

  const seed = await plantScreenPosition(page, 'topSvg', 'mv-seed');
  await page.mouse.click(seed.x, seed.y);
  await page.locator('#selectionMakeDriftBtn').click();
  await expect(label).toHaveText('CI (1x)');

  const third = await plantScreenPosition(page, 'topSvg', 'mv-third');
  await page.mouse.click(third.x, third.y);
  await expect(label).toHaveText('CI (2x)');
  await expect(acceptBtn).toBeEnabled(); // mv-seed + mv-third agree (both planned)

  // mv-a already belongs to 'mv-existing' (2 planted members, mv-a + mv-b) —
  // tapping it in is allowed (it will move), and the bar says so, reading
  // mv-existing's own CURRENT full label, not just the one plant about to move.
  const a = await plantScreenPosition(page, 'topSvg', 'mv-a');
  await page.mouse.click(a.x, a.y);
  await expect(label).toHaveText('CI (3x)');
  // Mixed lifecycles (mv-seed/mv-third planned, mv-a planted): Accept is
  // refused until a shared status is chosen — the SAME lifecycle-choice UI a
  // suggestion review uses, already inline on desktop (no "in More" in the
  // prompt here — unlike touch.spec.js's own version of this test, nothing
  // needs opening).
  await expect(page.locator('#driftReviewMovingHint')).toHaveText(
    '1 from CI (2x). Choose a planting status before Accept.'
  );
  await expect(acceptBtn).toBeDisabled();
  await expect(page.locator('#driftReviewLifecycleSummary')).toContainText('2 planned');
  await expect(page.locator('#driftReviewLifecycleSummary')).toContainText('1 planted');
  await page.locator('#driftReviewLifecycleOptions .chip', { hasText: 'Planned' }).click();
  await expect(acceptBtn).toBeEnabled();

  const historyBefore = await readScratchHistory(project);
  await acceptBtn.click();

  await expect
    .poll(async () => {
      const rows = await readScratchLayoutWithDrift(project);
      const driftId = rows.find((row) => row.id === 'mv-seed')?.driftId;
      return driftId && rows.filter((row) => row.driftId === driftId).map((row) => row.id).sort().join(',');
    })
    .toBe('mv-a,mv-seed,mv-third');
  const plants = await currentPlantsFromHistory(project);
  const moved = plants.filter((plant) => ['mv-seed', 'mv-third', 'mv-a'].includes(plant.id));
  expect(moved.length).toBe(3);
  // 'planned' is written as the ABSENCE of a status field (src/data/plantLifecycle.js),
  // so mv-a (previously status: 'planted') losing that field is the chosen
  // lifecycle applying to every member, moved-in included.
  moved.forEach((plant) => expect(plant.status).toBeUndefined());

  // mv-b, left alone in mv-existing, drops the label — a drift always has >= 2 members.
  expect(await driftIdOf(project, 'mv-b')).toBe('');

  const historyAfter = await readScratchHistory(project);
  expect(historyAfter.entries.length - historyBefore.entries.length).toBe(1);
  await expect(bar).toBeHidden();
  await expect(page.locator('#selectionBarName')).toHaveText('CI (3x)');
});
