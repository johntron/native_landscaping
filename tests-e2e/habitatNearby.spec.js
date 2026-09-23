import { test, expect } from '@playwright/test';

// Read-only. Asserts the section's shape and honesty rules, not the names in
// ecology/anchors.csv, which the fetch tools regenerate.

const distances = (list) =>
  list.locator('.plant-matches__evidence').evaluateAll((nodes) =>
    nodes.map((node) => Number((node.textContent.match(/([\d.]+) mi away/) || [])[1]))
  );

test('the What’s nearby page lists streams and unchecked green space by distance, with credit', async ({ page }) => {
  await page.goto('/ecosystem.html?project=backyard');
  const section = page.locator('#habitatNearby');
  await expect(section).toBeVisible();

  const anchors = page.locator('#habitatAnchors');
  const candidates = page.locator('#habitatCandidates');
  await expect(anchors.locator('.plant-matches__item').first()).toBeVisible();
  await expect(candidates.locator('.plant-matches__item').first()).toBeVisible();

  for (const list of [anchors, candidates]) {
    const values = await distances(list);
    expect(values.every(Number.isFinite)).toBe(true);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  }

  // Location and distance only: no entry may carry a score, rating, or percentage.
  const entryText = await section.locator('.plant-matches__item').allTextContents();
  expect(entryText.filter((text) => /score|rating|connect|%/i.test(text))).toEqual([]);
  await expect(section).toContainText('does not score');

  const credit = page.locator('#habitatNearbyCredit');
  await expect(credit).toContainText('U.S. Geological Survey');
  await expect(credit).toContainText('Open Database License');
  await expect(credit.locator('a[href="https://www.openstreetmap.org/copyright"]')).toHaveText('OpenStreetMap');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 900 } });

  // styles.css hides every .data-note on a phone. These are the section's
  // caveats and the OpenStreetMap credit the ODbL requires, so they must show.
  test('the caveat and the source credit stay visible', async ({ page }) => {
    await page.goto('/ecosystem.html?project=backyard');
    await expect(page.locator('#habitatNearby')).toBeVisible();
    await expect(page.locator('#habitatNearbyNote')).toBeVisible();
    await expect(page.locator('#habitatNearbyCredit')).toBeVisible();
  });
});
