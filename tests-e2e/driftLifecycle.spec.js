import { test, expect } from '@playwright/test';
import { openScratchProject, plantScreenPosition, readScratchHistory } from './helpers.js';

/**
 * One planting status per drift (nl-o47.6.10), desktop/mouse coverage.
 * Seeded by tests-e2e/scratch-fixture.mjs's DRIFT_LAYOUT_CSV: a 4-member
 * winecup drift ("winecup-drift") plus one unrelated horseherb plant. Writes
 * (marking planted, "+"), so this runs against the scratch server, its own
 * project.
 *
 * History entries hold real placement objects (src/data/placements.js), so
 * these read status/localEcotype straight off them rather than parsing the
 * exported layout CSV — the same pattern tests-e2e/plantLifecycle.spec.js
 * uses for one plant.
 */

const PROJECT = 'desktop-drift-lifecycle';
const DRIFT_ID = 'winecup-drift';
const SEEDED_MEMBERS = ['drift-a', 'drift-b', 'drift-c', 'drift-d'];

async function driftMembersFromHistory(driftId = DRIFT_ID) {
  const history = await readScratchHistory(PROJECT);
  const entry = history?.entries[history.cursor];
  return (entry?.plants || []).filter((plant) => plant.driftId === driftId);
}

test('marking a drift planted from its own editor sets status on every member in one undo step; "+" then copies it to the new member; a drilled-in member\'s own Details edit applies to all', async ({
  page,
}) => {
  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="edit"]').click();
  const target = await plantScreenPosition(page, 'topSvg', 'drift-a');
  await page.mouse.click(target.x, target.y); // whole drift selected
  await expect(page.locator('#selectionBarName')).toContainText('4 plants');

  // "Planting" opens #detailSheet drift-scoped, without drilling the
  // selection into one member (src/ui/detailSheet.js's `drift` option).
  await page.locator('#selectionDriftPlantingBtn').click();
  const sheet = page.locator('#detailSheet');
  await expect(sheet).toBeVisible();
  const section = sheet.locator('.plant-lifecycle');
  await expect(section).toBeVisible();
  await expect(section.locator('.plant-lifecycle__scope')).toContainText('Applies to all 4 plants in Winecup drift');
  // Opened for the whole drift, the sheet shows no one member's position and
  // no Clone/Remove row, which would act on a member nobody picked.
  await expect(sheet.locator('#detailSheetLines')).not.toContainText('Position:');
  await expect(sheet.locator('#detailSheetRemoveBtn')).toBeHidden();
  await expect(sheet.locator('#detailSheetCloneBtn')).toBeHidden();

  await section.locator('[data-lifecycle-status="planted"]').click();
  await expect
    .poll(async () => {
      const members = await driftMembersFromHistory();
      return members.length === 4 && members.every((m) => m.status === 'planted');
    }, { timeout: 5000 })
    .toBe(true);

  // Closing the sheet must not have drilled the selection into one member —
  // it is still the whole drift, so the very next Undo (in the primary row)
  // reaches this one edit directly.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.locator('#selectionBarName')).toContainText('4 plants');
  await page.locator('#undoLayoutBtn').click();
  await expect
    .poll(async () => (await driftMembersFromHistory()).filter((m) => m.status === 'planted').length, {
      timeout: 5000,
    })
    .toBe(0);

  // Redo, then "+": the new member copies the drift's own (now planted) lifecycle.
  await page.locator('#redoLayoutBtn').click();
  await expect
    .poll(async () => (await driftMembersFromHistory()).filter((m) => m.status === 'planted').length, {
      timeout: 5000,
    })
    .toBe(4);

  await page.locator('#selectionDriftCountIncBtn').click();
  await expect.poll(async () => (await driftMembersFromHistory()).length, { timeout: 5000 }).toBe(5);
  const withNewMember = await driftMembersFromHistory();
  const newMember = withNewMember.find((m) => !SEEDED_MEMBERS.includes(m.id));
  expect(newMember, 'the + button added a fifth member').toBeTruthy();
  expect(newMember.status, 'the new member copies the drift\'s own planted status').toBe('planted');

  // A drilled-in member's OWN Details still edits the whole drift (nl-o47.6.10):
  // a second click on an already-whole-selected member drills into it.
  await page.mouse.click(target.x, target.y);
  await page.locator('#selectionDetailsBtn').click();
  await expect(sheet).toBeVisible();
  await expect(section.locator('.plant-lifecycle__scope')).toContainText('Applies to all 5 plants in Winecup drift');
  // A drilled-in member is one plant again: its position and Clone/Remove are back.
  await expect(sheet.locator('#detailSheetLines')).toContainText('Position:');
  await expect(sheet.locator('#detailSheetRemoveBtn')).toBeVisible();

  await section.locator('input[name="localEcotype"]').click();
  await expect
    .poll(async () => {
      const members = await driftMembersFromHistory();
      return members.length === 5 && members.every((m) => m.localEcotype === true);
    }, { timeout: 5000 })
    .toBe(true);
});
