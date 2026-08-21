import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCRATCH_DIR } from './scratch-fixture.mjs';
import { SCRATCH_BASE, openScratchProject } from './helpers.js';

// Its own copy of the yard, per the convention in scratch-fixture.mjs: this
// spec writes features.json, and a spec that shares a project with another
// one's assertions is a spec that breaks it.
const PROJECT = 'features-save';

test.describe.configure({ mode: 'serial' });

const HOUSE = {
  id: 'house',
  type: 'box',
  label: 'House',
  footprintFt: [
    { x: 8, y: 12 },
    { x: 24, y: 12 },
    { x: 24, y: 20 },
    { x: 8, y: 20 },
  ],
  heightFt: 10,
};

function featuresUrl(project = PROJECT) {
  return `${SCRATCH_BASE}/api/features?project=${project}`;
}

async function readSavedFeatures() {
  const raw = await readFile(
    path.join(SCRATCH_DIR, 'projects', PROJECT, 'features.json'),
    'utf8'
  );
  return JSON.parse(raw);
}

test('a project with no features.json loads as an empty yard, not an error', async ({ request }) => {
  const response = await request.get(featuresUrl('drag-plan'));
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ features: [] });
});

test('saving writes features.json inside the project, with the defaults dropped', async ({
  request,
}) => {
  const response = await request.post(featuresUrl(), { data: { features: [HOUSE] } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ features: [HOUSE] });

  // Nothing normalizeFeatures would have supplied is written to the file.
  const saved = await readSavedFeatures();
  expect(saved).toEqual({ features: [HOUSE] });
  expect(saved.features[0]).not.toHaveProperty('style');
  expect(saved.features[0]).not.toHaveProperty('baseFt');

  // And it reads straight back out through the same endpoint.
  expect(await (await request.get(featuresUrl())).json()).toEqual({ features: [HOUSE] });
});

test('a body without features[] is refused rather than erasing the yard', async ({ request }) => {
  const refused = await request.post(featuresUrl(), { data: { name: 'not a feature list' } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toContain('features[]');

  const malformed = await request.post(featuresUrl(), {
    data: { features: [{ id: 'house', type: 'box', footprintFt: HOUSE.footprintFt }] },
  });
  expect(malformed.status()).toBe(400);
  expect((await malformed.json()).error).toContain('positive heightFt');

  // Neither one touched the file the previous test saved.
  expect(await readSavedFeatures()).toEqual({ features: [HOUSE] });
});

test('the project id comes from the query, so a body cannot write elsewhere', async ({
  request,
}) => {
  const response = await request.post(featuresUrl(), {
    data: { id: '../drag-plan', features: [HOUSE] },
  });
  expect(response.status()).toBe(200);
  // The project the body named is untouched; the one the query addressed got it.
  expect(await (await request.get(featuresUrl('drag-plan'))).json()).toEqual({ features: [] });
  expect(await readSavedFeatures()).toEqual({ features: [HOUSE] });

  // Emptying the yard is a legitimate save — it is how the last feature goes.
  expect((await request.post(featuresUrl(), { data: { features: [] } })).status()).toBe(200);
  expect(await readSavedFeatures()).toEqual({ features: [] });
});

test('the app draws saved features in every view, and boots clean without any', async ({
  page,
}) => {
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.request.post(featuresUrl(), { data: { features: [HOUSE] } });
  await openScratchProject(page, PROJECT);

  // The plan gets the footprint; every elevation gets a silhouette of the same
  // one feature, which is the point of one model projected into every view.
  await expect(page.locator('#topSvg g[data-feature-id="house"] polygon')).toHaveCount(1);
  const elevations = page.locator('.view svg g[data-feature-id="house"]');
  expect(await elevations.count()).toBeGreaterThan(1);

  // A project that has never drawn a feature must not log a 404 for the
  // features it does not have.
  await openScratchProject(page, 'drag-plan');
  await expect(page.locator('#topSvg g[data-feature-id]')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});
