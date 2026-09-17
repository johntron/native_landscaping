import { test, expect } from '@playwright/test';
import { openScratchProject } from './helpers.js';

// Read-only, but pointed at a scratch project all the same: a spec aimed at a
// project missing from SCRATCH_PROJECTS does not fail, it silently falls back
// to drag-plan and asserts against the wrong yard. `ecology-check` is a copy of
// backyard, which declares ecoregion 9 and a part-sun / medium / clay site, so
// all seven dimensions have the inputs they need.

const rows = (page) => page.locator('#ecologyCheck .ecology-check__row');

test.describe('the ecology check panel', () => {
  test('reports one row per dimension, above the species table', async ({ page }) => {
    await openScratchProject(page, 'ecology-check');

    const panel = page.locator('#ecologyCheck');
    await expect(panel).toBeVisible();
    await expect(rows(page)).toHaveCount(7);

    // Every row carries one of exactly the four chips the analysis emits — an
    // unrecognised status would render as an unstyled chip, not an error.
    const statuses = await rows(page).evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector('.ecology-chip')?.className || '')
    );
    const allowed = ['ok', 'partial', 'gap', 'not-declared'];
    for (const className of statuses) {
      expect(allowed.some((status) => className.includes(`ecology-chip--${status}`))).toBe(true);
    }

    // The panel sits above the species table, which is where the plan puts it.
    const order = await page.evaluate(() => {
      const check = document.getElementById('ecologyCheck');
      const table = document.getElementById('speciesTable');
      return check.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after';
    });
    expect(order).toBe('before');
  });

  test('a dimension expands to show its findings, and collapses again', async ({ page }) => {
    await openScratchProject(page, 'ecology-check');

    const row = page.locator('#ecologyCheck .ecology-check__row', {
      has: page.locator('.ecology-check__details-btn'),
    }).first();
    const details = row.locator('.ecology-check__detail');
    const button = row.locator('.ecology-check__details-btn');

    await expect(details).toBeHidden();
    await button.click();
    await expect(details).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(details.locator('li').first()).not.toBeEmpty();

    await button.click();
    await expect(details).toBeHidden();
  });

  test('the whole panel collapses from its header', async ({ page }) => {
    await openScratchProject(page, 'ecology-check');

    const toggle = page.locator('#ecologyCheck .ecology-check__toggle');
    const body = page.locator('#ecologyCheckBody');
    await expect(body).toBeVisible();
    await toggle.click();
    await expect(body).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('the genus checks actually loaded their table', async ({ page }) => {
    await openScratchProject(page, 'ecology-check');

    // If ecology/host-genera.csv had 404'd these would read "not declared", so
    // this is the assertion that catches a missing entry in LINKED.
    const keystone = page.locator('#ecologyCheck [data-rule-id="keystone-genera"]');
    await expect(keystone.locator('.ecology-chip')).not.toHaveText('Not declared');
    await expect(page.locator('#ecologyCheck [data-rule-id="larval-hosts"] .ecology-chip')).not.toHaveText(
      'Not declared'
    );
  });
});
