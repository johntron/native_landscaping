import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { SCRATCH_SERVER_DATA_DIR, readSeededProject } from './scratch-fixture.mjs';
import { SCRATCH_BASE } from './helpers.js';
import { importLayer, locationKey, openEcosystemDb } from '../tools/ecosystemIndexDb.js';

/**
 * "Habitat nearby" on What's nearby, from the yard's own site layers
 * (nl-3s5.31: per yard in ecosystem.db, served by /api/ecosystem/site; they
 * were the committed ecology/anchors.csv). A scratch yard gets a made-up
 * location and made-up anchors, seeded straight into the scratch server's
 * databases, so no real place is read and nothing reaches NHD or Overpass.
 * Asserts the section's shape and honesty rules, not real names.
 */
const PROJECT = 'habitat-nearby';
const HERE = { lat: 10.5, lng: 20.5 }; // nowhere near anyone's yard
const FETCHED_ON = '2026-01-02';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  const { id } = readSeededProject(SCRATCH_SERVER_DATA_DIR, PROJECT);
  const app = new DatabaseSync(path.join(SCRATCH_SERVER_DATA_DIR, 'app.db'));
  try {
    app.exec('PRAGMA busy_timeout = 5000');
    app.prepare('UPDATE projects SET location_json = ? WHERE id = ?').run(JSON.stringify(HERE), id);
  } finally {
    app.close();
  }
  const ecosystem = openEcosystemDb(path.join(SCRATCH_SERVER_DATA_DIR, 'ecosystem.db'));
  try {
    const key = locationKey(HERE);
    const anchor = (kind, name, distance_mi, detail, status, source) => ({ kind, name, status, distance_mi, detail, fetched_on: FETCHED_ON, source });
    importLayer(ecosystem, id, 'streams', key, [
      anchor('stream', 'Fixture Creek', 1.25, 'channel', 'anchor', 'test fixture'),
      anchor('stream', 'Fixture Branch', 0.5, 'channel', 'anchor', 'test fixture'),
    ], { fetchedOn: FETCHED_ON });
    importLayer(ecosystem, id, 'greenspace', key, [
      anchor('park', 'Fixture Park', 0.75, 'leisure=park, ~4 acres', 'candidate', 'test fixture'),
      anchor('cemetery', 'Fixture Cemetery', 0.25, 'landuse=cemetery, ~2 acres', 'candidate', 'test fixture'),
    ], { fetchedOn: FETCHED_ON });
  } finally {
    ecosystem.close();
  }
});

const distances = (list) =>
  list.locator('.plant-matches__evidence').evaluateAll((nodes) =>
    nodes.map((node) => Number((node.textContent.match(/([\d.]+) mi away/) || [])[1]))
  );

test('the What’s nearby page lists the yard’s streams and unchecked green space by distance, with credit', async ({ page }) => {
  await page.goto(`${SCRATCH_BASE}/ecosystem.html?project=${PROJECT}`);
  const section = page.locator('#habitatNearby');
  await expect(section).toBeVisible();

  const anchors = page.locator('#habitatAnchors');
  const candidates = page.locator('#habitatCandidates');
  await expect(anchors.locator('.plant-matches__item strong')).toHaveText(['Fixture Branch', 'Fixture Creek']);
  await expect(candidates.locator('.plant-matches__item strong')).toHaveText(['Fixture Cemetery', 'Fixture Park']);

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
  await expect(credit).toContainText(`Fetched ${FETCHED_ON}.`);
  await expect(credit.locator('a[href="https://www.openstreetmap.org/copyright"]')).toHaveText('OpenStreetMap');
});

test('the retired site CSVs are not served', async ({ request }) => {
  for (const file of ['ecology/anchors.csv', 'ecology/nearby-fauna.csv']) {
    expect((await request.get(`${SCRATCH_BASE}/${file}`)).status(), file).toBe(404);
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 900 } });

  // styles.css hides every .data-note on a phone. These are the section's
  // caveats and the OpenStreetMap credit the ODbL requires, so they must show.
  test('the caveat and the source credit stay visible', async ({ page }) => {
    await page.goto(`${SCRATCH_BASE}/ecosystem.html?project=${PROJECT}`);
    await expect(page.locator('#habitatNearby')).toBeVisible();
    await expect(page.locator('#habitatNearbyNote')).toBeVisible();
    await expect(page.locator('#habitatNearbyCredit')).toBeVisible();
  });
});
