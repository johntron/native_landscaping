import { test, expect } from '@playwright/test';
import {
  openScratchProject,
  plantScreenPosition,
  readScratchHistory,
  readScratchLayoutWithDrift,
} from './helpers.js';

/**
 * Desktop mouse coverage for "suggest drifts from an existing yard"
 * (nl-o47.6.5). Seeded by tests-e2e/scratch-fixture.mjs's own
 * DRIFT_SUGGEST_LAYOUT_CSV (two undrifted masses: winecup x4 plus a lone
 * winecup well outside its own clustering distance, and horseherb x3) and
 * DRIFT_SUGGEST_MIXED_LAYOUT_CSV (one mass whose members disagree in
 * lifecycle). These specs write (Accept auto-saves through POST /api/layout),
 * so they run against the scratch server, one project per test.
 */

const driftIdOf = async (projectId, plantId) => {
  const rows = await readScratchLayoutWithDrift(projectId);
  return rows.find((row) => row.id === plantId)?.driftId || '';
};

test('the banner, reviewing, adjusting, Accept in one undo step, Undo recomputing cleanly, Skip writing nothing, and Stop', async ({
  page,
}) => {
  const project = 'desktop-drift-suggest';
  await openScratchProject(page, project);
  await page.locator('[data-mode="edit"]').click();

  const banner = page.locator('#suggestDriftsBtn');
  await expect(banner).toBeVisible();
  await expect(page.locator('.species-table__suggest-drifts')).toContainText('2 possible drifts');

  const bar = page.locator('#driftReviewBar');
  const label = page.locator('#driftReviewLabel');
  await banner.click();
  // Opening review is Winecup's own 4-member mass — the larger of the two,
  // reviewed first (largest-first). The bar reads like a real drift's own
  // label (nl-o47.6.11): driftLabel's species initials plus count, then the
  // position in the session.
  await expect(bar).toBeVisible();
  await expect(label).toHaveText('CI (4x) · 1 of 2');
  await expect(banner).toBeHidden(); // the banner hides itself while a review is open

  // Drawing: a dashed, distinctly-tokened outline (never the real-drift one),
  // and everything outside the suggestion dims — including the OTHER
  // suggestion's own members.
  await expect(page.locator('#topSvg path[data-suggestion-outline="true"]')).toBeVisible();
  await expect(page.locator('#topSvg path[data-drift-outline="true"]')).toHaveCount(0);
  await expect(page.locator('#topSvg g[data-plant-id="sug-hb1"]')).toHaveAttribute('data-dimmed', 'true');
  await expect(page.locator('#topSvg g[data-plant-id="sug-wa1"]')).not.toHaveAttribute('data-dimmed', 'true');

  // Adjust: a tap on an existing member toggles it OUT.
  const wa4 = await plantScreenPosition(page, 'topSvg', 'sug-wa4');
  await page.mouse.click(wa4.x, wa4.y);
  await expect(label).toHaveText('CI (3x) · 1 of 2');
  await expect(page.locator('#topSvg g[data-plant-id="sug-wa4"]')).toHaveAttribute('data-dimmed', 'true');

  // A tap on a same-species, undrifted plant elsewhere in the yard (well
  // outside the algorithmic cluster) toggles it IN.
  const loner = await plantScreenPosition(page, 'topSvg', 'sug-wa-loner');
  await page.mouse.click(loner.x, loner.y);
  await expect(label).toHaveText('CI (4x) · 1 of 2');
  await expect(page.locator('#topSvg g[data-plant-id="sug-wa-loner"]')).not.toHaveAttribute('data-dimmed', 'true');

  // A tap on a DIFFERENT species does nothing (no count/hint change).
  const hb1 = await plantScreenPosition(page, 'topSvg', 'sug-hb1');
  await page.mouse.click(hb1.x, hb1.y);
  await expect(label).toHaveText('CI (4x) · 1 of 2');

  const historyBefore = await readScratchHistory(project);
  await page.locator('#driftReviewAcceptBtn').click();

  // Accept wrote exactly the adjusted membership — wa1/wa2/wa3/wa-loner, NOT
  // wa4 (toggled out) and NOT the horseherb mass — as one history entry.
  await expect
    .poll(async () => {
      const rows = await readScratchLayoutWithDrift(project);
      const driftId = rows.find((row) => row.id === 'sug-wa1')?.driftId;
      return driftId && rows.filter((row) => row.driftId === driftId).map((row) => row.id).sort().join(',');
    })
    .toBe('sug-wa-loner,sug-wa1,sug-wa2,sug-wa3');
  expect(await driftIdOf(project, 'sug-wa4')).toBe('');
  expect(await driftIdOf(project, 'sug-hb1')).toBe('');
  const historyAfter = await readScratchHistory(project);
  expect(historyAfter.entries.length - historyBefore.entries.length).toBe(1);

  // Moved on: the horseherb mass is next (the winecup one just accepted no
  // longer exists to suggest).
  await expect(label).toHaveText('CV (3x) · 2 of 2');

  // Undo reverts the accept in one step, and review recomputes cleanly
  // rather than showing a suggestion built on stale (now-drifted) plants:
  // the very same winecup cluster reappears, fresh (its own adjustment
  // forgotten — a new review of it, not a resumed one).
  await page.locator('#undoLayoutBtn').click();
  await expect
    .poll(async () => driftIdOf(project, 'sug-wa1'))
    .toBe('');
  expect(await driftIdOf(project, 'sug-wa-loner')).toBe('');
  // the toggle-out/toggle-in adjustment did not survive the recompute
  await expect(label).toHaveText('CI (4x) · 1 of 2');

  // Skip writes nothing and moves on.
  await page.locator('#driftReviewSkipBtn').click();
  await expect(label).toHaveText('CV (3x) · 2 of 2');
  expect(await driftIdOf(project, 'sug-wa1')).toBe('');

  await page.locator('#driftReviewAcceptBtn').click();
  await expect.poll(async () => driftIdOf(project, 'sug-hb1')).not.toBe('');
  const hbDrift = await driftIdOf(project, 'sug-hb1');
  expect(await driftIdOf(project, 'sug-hb2')).toBe(hbDrift);
  expect(await driftIdOf(project, 'sug-hb3')).toBe(hbDrift);

  // Nothing left this session (winecup was Skipped, horseherb just Accepted):
  // finishing the list says so, Accept/Skip are gone.
  await expect(label).toContainText('Reviewed every suggested drift');
  await expect(page.locator('#driftReviewAcceptBtn')).toBeHidden();
  await expect(page.locator('#driftReviewSkipBtn')).toBeHidden();

  await page.locator('#driftReviewStopBtn').click();
  await expect(bar).toBeHidden();
  // A Skip is only for the session: stopping (and the banner's own fresh
  // recompute) offers the winecup mass again.
  await expect(banner).toBeVisible();
  await expect(page.locator('.species-table__suggest-drifts')).toContainText('1 possible drift');
});

test('a suggestion whose members disagree in lifecycle requires a choice before Accept, then every member shares it', async ({
  page,
}) => {
  const project = 'desktop-drift-suggest-mixed';
  await openScratchProject(page, project);
  await page.locator('[data-mode="edit"]').click();

  await page.locator('#suggestDriftsBtn').click();
  const label = page.locator('#driftReviewLabel');
  await expect(label).toHaveText('CB (3x) · 1 of 1');

  const acceptBtn = page.locator('#driftReviewAcceptBtn');
  await expect(acceptBtn).toBeDisabled();
  await expect(page.locator('#driftReviewLifecycle')).toBeVisible();
  await expect(page.locator('#driftReviewLifecycleSummary')).toContainText('2 planned, 1 planted');

  const options = page.locator('#driftReviewLifecycleOptions button');
  await expect(options).toHaveCount(2);
  await options.filter({ hasText: 'Planned' }).click();
  await expect(acceptBtn).toBeEnabled();

  await acceptBtn.click();
  await expect.poll(async () => driftIdOf(project, 'sug-cb1')).not.toBe('');
  const driftId = await driftIdOf(project, 'sug-cb1');
  expect(await driftIdOf(project, 'sug-cb2')).toBe(driftId);
  expect(await driftIdOf(project, 'sug-cb3')).toBe(driftId);

  // Every member now shares the chosen (planned) lifecycle — including
  // sug-cb2, which was planted before Accept.
  const history = await readScratchHistory(project);
  const entry = history.entries[history.cursor];
  const members = (entry.plants || []).filter((plant) => plant.driftId === driftId);
  expect(members.length).toBe(3);
  members.forEach((plant) => expect(plant.status ?? 'planned').toBe('planned'));
});
