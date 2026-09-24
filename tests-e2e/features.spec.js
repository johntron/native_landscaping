import { test, expect } from '@playwright/test';
import { SCRATCH_SERVER_DATA_DIR, readSeededProject } from './scratch-fixture.mjs';
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

/** Exactly what the save stored (app.db projects.features_json), not the API's normalized copy. */
async function readSavedFeatures() {
  return readSeededProject(SCRATCH_SERVER_DATA_DIR, PROJECT).features;
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

/**
 * The editor. Its own project again, because every gesture here rewrites
 * features.json and a spec sharing that file with another one breaks it.
 */
test.describe('features mode', () => {
  const EDIT = 'features-edit';

  test.beforeEach(async ({ request }) => {
    // Each test starts from an empty yard rather than from what the last one left.
    await request.post(featuresUrl(EDIT), { data: { features: [] } });
  });

  async function enterFeaturesMode(page) {
    await openScratchProject(page, EDIT);
    await page.locator('[data-mode="features"]').click();
    await expect(page.locator('#featureRow')).toBeVisible();
  }

  /** The plan panel's centre, in page coordinates. */
  async function planCentre(page) {
    const svg = page.locator('#topSvg');
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  test('a shape can be added, moved, reshaped, and deleted', async ({ page }) => {
    await enterFeaturesMode(page);

    await page.locator('#featureRow button', { hasText: '+ box' }).click();
    const shape = page.locator('#topSvg g[data-feature-id="box"]');
    await expect(shape).toHaveCount(1);
    // One model, every view: the elevations get a silhouette of the same box.
    expect(await page.locator('.view svg g[data-feature-id="box"]').count()).toBeGreaterThan(1);

    // It lands in the middle of the plan, so the centre of the panel is inside it.
    const centre = await planCentre(page);
    const before = await shape.locator('polygon').getAttribute('points');
    // One model projected into every view: an elevation has to follow the plan
    // drag, and this is the assertion a later render optimization would break.
    const silhouette = page.locator('.view svg:not(#topSvg) g[data-feature-id="box"] rect').first();
    const silhouetteBefore = await silhouette.getAttribute('x');

    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 60, centre.y + 40, { steps: 8 });
    await page.mouse.up();

    const afterMove = await shape.locator('polygon').getAttribute('points');
    expect(afterMove).not.toEqual(before);
    expect(await silhouette.getAttribute('x')).not.toEqual(silhouetteBefore);
    // Moving translates the shape: its width in pixels is unchanged.
    expect(spanOf(afterMove)).toBeCloseTo(spanOf(before), 1);

    // Dragging a corner reshapes rather than translates.
    const handle = page.locator('#topSvg circle[data-feature-handle="vertex:0"]');
    await expect(handle).toHaveCount(1);
    const handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 80, handleBox.y - 50, { steps: 8 });
    await page.mouse.up();
    const afterReshape = await shape.locator('polygon').getAttribute('points');
    expect(spanOf(afterReshape)).toBeGreaterThan(spanOf(afterMove) + 1);

    // Saving writes the yard model, and it comes back the same shape.
    await page.locator('#featureRow button', { hasText: 'Save features' }).click();
    await expect(page.locator('#featureRow .feature-panel__status')).toHaveText('Features saved');
    const saved = await (await page.request.get(featuresUrl(EDIT))).json();
    expect(saved.features).toHaveLength(1);
    expect(saved.features[0].id).toBe('box');

    await page.locator('#featureRow [aria-label="Remove"]').first().click();
    await expect(page.locator('#topSvg g[data-feature-id]')).toHaveCount(0);
  });

  test('the panel lists the saved features on entering the mode, before any edit', async ({
    page,
  }) => {
    // The panel is built before the features finish loading, so it used to hold
    // the empty list the app starts with: the yard drew its shapes and the list
    // still said nothing was there until an edit re-rendered it. On a phone the
    // list is how a feature is picked, so that was the whole editor missing.
    await page.request.post(featuresUrl(EDIT), { data: { features: [HOUSE] } });
    await enterFeaturesMode(page);

    await expect(page.locator('#featureRow .feature-panel__item')).toHaveCount(1);
    await expect(page.locator('#featureRow .feature-panel__pick')).toContainText('House');
    await expect(page.locator('#featureRow')).not.toContainText('Nothing drawn yet');
  });

  test('a rejected edit leaves the drawing on the last good state', async ({ page }) => {
    await enterFeaturesMode(page);
    await page.locator('#featureRow button', { hasText: '+ wall' }).click();
    const shape = page.locator('#topSvg g[data-feature-id="wall"] polyline');
    const before = await shape.getAttribute('points');

    // A wall with no height renders as nothing in an elevation, so
    // normalizeFeatures refuses it. The drawing must not follow the refusal.
    const height = page.locator('#featureRow input[type="number"]').first();
    await height.fill('0');
    await height.blur();

    await expect(page.locator('#featureRow .feature-panel__status')).toContainText('heightFt');
    await expect(shape).toHaveAttribute('points', before);
    await expect(page.locator('#topSvg g[data-feature-id="wall"]')).toHaveCount(1);
  });

  test('nothing in the panel ever moves the drawing under the pointer', async ({ page }) => {
    await enterFeaturesMode(page);
    const planTop = async () => (await page.locator('#topSvg').boundingBox()).y;

    // The panel sits directly above the drawing, so its height is the drawing's
    // position. Adding a shape used to push the canvas down 154 px and every
    // shape after it another 45, so the click that followed landed nowhere near
    // where it was aimed.
    const settled = await planTop();
    await page.locator('#featureRow button', { hasText: '+ wall' }).click();
    expect(await planTop(), 'the first shape moved the drawing').toBe(settled);
    await page.locator('#featureRow button', { hasText: '+ surface' }).click();
    expect(await planTop(), 'a later shape moved the drawing').toBe(settled);

    // Deselecting used to collapse the form and yank the canvas up about a
    // hundred pixels, so the click after it landed nowhere near where it was
    // aimed. Nothing about the selection may move the drawing.
    const svg = await page.locator('#topSvg').boundingBox();
    await page.mouse.click(svg.x + 12, svg.y + 12);
    await expect(page.locator('#topSvg circle[data-feature-handle]')).toHaveCount(0);
    expect(await planTop()).toBe(settled);

    // Nor may switching between kinds: a surface has no height to edit, but the
    // field holds its place rather than vanishing.
    await page.locator('#featureRow .feature-panel__pick', { hasText: 'wall' }).click();
    expect(await planTop()).toBe(settled);
    await page.locator('#featureRow .feature-panel__pick', { hasText: 'surface' }).click();
    expect(await planTop()).toBe(settled);
    await expect(page.locator('#featureRow input[type="number"]').first()).toBeDisabled();

    // And the shape itself is still there through all of it.
    await expect(page.locator('#topSvg g[data-feature-id="wall"] polyline')).toHaveCount(1);
  });

  test('features are edited on the plan only; elevations stay derived', async ({ page }) => {
    await enterFeaturesMode(page);
    await page.locator('#featureRow button', { hasText: '+ box' }).click();

    // Handles are drawn on plans and nowhere else — an elevation is a projection
    // of the model, not a second place to edit it. Scoped to elevation panels
    // rather than to "not #topSvg": a project may have several plan views, and
    // every one of them edits the shared model.
    await expect(page.locator('#topSvg circle[data-feature-handle]')).not.toHaveCount(0);
    const elevations = page.locator('[data-view-panel]').filter({ hasNotText: 'Looking Down' });
    await expect(elevations.locator('circle[data-feature-handle]')).toHaveCount(0);
    await expect(elevations.locator('g[data-feature-id="box"]')).not.toHaveCount(0);
  });
});

/** Width in pixels of a polygon's points attribute, for translate-vs-reshape. */
function spanOf(points) {
  const xs = points.split(' ').map((pair) => Number(pair.split(',')[0]));
  return Math.max(...xs) - Math.min(...xs);
}

/**
 * The bug this reproduces: a project whose elevations showed a narrower slice
 * of yard than its plan had a shared yard far smaller than the plan. A new
 * shape sized and placed by the plan looked right in the plan and was wholly
 * off-canvas in every elevation — "I do not see the wall in the other views".
 *
 * That arrangement is no longer expressible: every view is derived from one
 * declared yard. The test stays as the guard that the derivation holds.
 */
test.describe('a new feature lands inside every derived view', () => {
  const NARROW = 'features-derived';

  test.beforeEach(async ({ request }) => {
    await request.post(featuresUrl(NARROW), { data: { features: [] } });
  });

  for (const type of ['wall', 'box', 'surface']) {
    test(`a new ${type} lands inside every elevation, not off its canvas`, async ({ page }) => {
      await openScratchProject(page, NARROW);
      await page.locator('[data-mode="features"]').click();
      await page.locator('#featureRow button', { hasText: `+ ${type}` }).click();

      const panels = await page.locator('.view svg').all();
      expect(panels.length).toBe(3);
      for (const svg of panels) {
        const id = await svg.getAttribute('id');
        const shape = svg.locator(`g[data-feature-id="${type}"] > *`);
        await expect(shape, `${id} draws the ${type}`).toHaveCount(1);

        // Drawn is not the same as visible: the whole point of the bug was a
        // shape rendered at coordinates outside the viewBox.
        const box = await svg.evaluate((node) => ({
          w: node.viewBox.baseVal.width,
          h: node.viewBox.baseVal.height,
        }));
        const bbox = await shape.evaluate((node) => {
          const b = node.getBBox();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        });
        expect(bbox.x, `${id} starts left of its right edge`).toBeLessThan(box.w);
        expect(bbox.x + bbox.width, `${id} ends right of its left edge`).toBeGreaterThan(0);
        expect(bbox.y, `${id} starts above its bottom edge`).toBeLessThan(box.h);
        expect(bbox.y + bbox.height, `${id} ends below its top edge`).toBeGreaterThan(0);
      }
    });
  }
});

/*
 * The panel is a fixed-height scroller (see #featureRow in styles.css). A
 * column flexbox shrinks its children to fit that height, so the form's box was
 * squeezed to its min-height while its fields painted straight out the bottom —
 * and the footer, which comes after it, drew "Save features" across the Height
 * input. Phone-sized on purpose: with a tall viewport the content fits and the
 * shrink never happens.
 */
test.describe('the features panel on a phone', () => {
  test.use({ viewport: { width: 393, height: 830 } });

  test('the Save button sits below the form instead of over it', async ({ page }) => {
    await page.request.post(featuresUrl('features-edit'), { data: { features: [HOUSE] } });
    await openScratchProject(page, 'features-edit');
    await page.locator('[data-mode="features"]').click();
    await page.locator('#featureRow .feature-panel__pick').first().click();
    await page.locator('#featureRow').evaluate((row) => {
      row.scrollTop = row.scrollHeight;
    });

    const geometry = await page.locator('#featureRow').evaluate((row) => {
      const form = row.querySelector('.feature-panel__form');
      const footer = row.querySelector('.feature-panel__footer');
      const height = row.querySelector('input[type="number"]');
      const box = height.getBoundingClientRect();
      return {
        formBottom: form.getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top,
        // Every section keeps its natural height; the scroller takes the slack.
        formFits: form.clientHeight >= form.scrollHeight,
        hitsHeightInput:
          document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === height,
      };
    });

    expect(geometry.formFits, 'the form is not compressed below its content').toBe(true);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.formBottom);
    expect(geometry.hitsHeightInput, 'nothing is drawn over the Height input').toBe(true);
  });
});
