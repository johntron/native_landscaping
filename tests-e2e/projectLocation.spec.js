import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { SCRATCH_SERVER_DATA_DIR } from './scratch-fixture.mjs';
import { SCRATCH_BASE, openScratchProject } from './helpers.js';

/**
 * Setting a yard's location from Setup mode (nl-3s5.30): look up, confirm,
 * save, and What's nearby moves from "no location set" to building.
 *
 * The geocoder is stubbed through the probe cache the scratch server reads
 * (tools/geocode.mjs and tools/ecoregionLookup.mjs are fetch-through caches):
 * the fake address and its ecoregion are seeded below, so the server answers
 * from the cache and never calls Nominatim or the CEC service. The address is
 * made up; the point is downtown Dallas.
 */
const PROJECT = 'location-set';
const QUERY = '1 Fixture Way, Testville, TX';
const LAT = 32.7767123;
const LNG = -96.7970456;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  const db = new DatabaseSync(path.join(SCRATCH_SERVER_DATA_DIR, 'probe-cache.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const put = db.prepare(
      `INSERT INTO probe_cache (source, endpoint, cache_key, raw, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source, endpoint, cache_key) DO UPDATE SET raw = excluded.raw`
    );
    const now = new Date().toISOString();
    put.run('nominatim', 'search', QUERY, JSON.stringify([
      { lat: String(LAT), lon: String(LNG), display_name: 'Fixture Way, Testville, Texas, United States', address: { state: 'Texas' } },
    ]), now);
    // tools/ecoregionLookup.mjs keys by the point rounded to 3 decimals, as numbers.
    const key = `${Math.round(LAT * 1000) / 1000},${Math.round(LNG * 1000) / 1000}`;
    put.run('cec-ecoregions', 'level1-query', key, JSON.stringify({ features: [{ attributes: { LEVEL1: 9, NameL1_En: 'GREAT PLAINS' } }] }), now);
  } finally {
    db.close();
  }
});

test('an owner looks an address up, confirms the match, and What\'s nearby starts building', async ({ page }) => {
  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();
  const section = page.locator('#setupRow .setup-panel__location');
  await expect(section.locator('.setup-panel__location-current')).toHaveText('No location set yet.');

  await section.locator('input.setup-panel__location-input').fill(QUERY);
  await section.getByRole('button', { name: 'Look up' }).click();
  const match = section.locator('.setup-panel__location-match');
  await expect(match).toContainText('Found: Fixture Way, Testville, Texas');
  await expect(match).toContainText('32.777, -96.797 (rounded)');
  await expect(match.locator('[data-region]')).toHaveAttribute('data-region', 'covered');

  await match.getByRole('button', { name: 'Save this location' }).click();
  await expect(section.locator('.setup-panel__location-current')).toHaveText('Set: 32.777, -96.797 (rounded).');
  await expect(section.locator('.setup-panel__location-message')).toContainText('within 30 minutes');

  // The owner's API answer is rounded; the full point stays on the server.
  const read = await (await fetch(`${SCRATCH_BASE}/api/project-location?project=${PROJECT}`)).json();
  expect(read.location).toEqual({ set: true, lat: 32.777, lng: -96.797 });

  // Not a revision: the setup history holds no trace of it.
  const history = await (await fetch(`${SCRATCH_BASE}/api/history?project=${PROJECT}`)).text();
  expect(history).not.toContain('32.77');

  // The scratch server serves design.html, not ecosystem.html, so What's
  // nearby is checked through its API and the design page's drawer, which
  // render through the same describeIndexWait.
  const nearby = await (await fetch(`${SCRATCH_BASE}/api/ecosystem?project=${PROJECT}`)).json();
  expect(nearby.index.state).toBe('queued');
  await page.locator('#ecoDrawerTab').click();
  await expect(page.locator('#ecoDrawerBody')).toContainText('Building the index');
});

test('clearing it puts What\'s nearby back to "no location set"', async ({ page }) => {
  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();
  const section = page.locator('#setupRow .setup-panel__location');
  await expect(section.locator('.setup-panel__location-current')).toContainText('Set: 32.777');
  page.once('dialog', (dialog) => dialog.accept());
  await section.getByRole('button', { name: 'Clear location' }).click();
  await expect(section.locator('.setup-panel__location-current')).toHaveText('No location set yet.');

  const nearby = await (await fetch(`${SCRATCH_BASE}/api/ecosystem?project=${PROJECT}`)).json();
  expect(nearby.index.state).toBe('no-location');
  await page.locator('#ecoDrawerTab').click();
  await expect(page.locator('#ecoDrawerBody')).toContainText('has no location set');
});
