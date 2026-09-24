import { test, expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { SCRATCH_SERVER_DATA_DIR, readSeededProject } from './scratch-fixture.mjs';
import { openScratchProject } from './helpers.js';

// Its own copy of the yard, per the convention in scratch-fixture.mjs: a spec
// that overwrites a view's background must not be sharing that view with
// another spec's assertions.
const PROJECT = 'background-upload';

/**
 * Uploading writes into the yard's photo directory, so this whole spec runs against
 * the scratch server. Serially, because the two tests upload to the same view
 * and the second one's assertion about superseded files depends on the first
 * one's file being gone.
 */
test.describe.configure({ mode: 'serial' });

/** The yard's photo directory under the scratch server's DATA_DIR (nl-3s5.3). */
function imgDir() {
  return readSeededProject(SCRATCH_SERVER_DATA_DIR, PROJECT).imgDir;
}

/**
 * A photo-shaped PNG, built here rather than committed: the point is to feed
 * the encoder something with real gradients and texture, so the size assertions
 * mean something. Flat colour would compress to nothing and prove nothing.
 */
function makePng(width, height) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const texture = Math.sin(x / 7) * Math.cos(y / 11) * 28;
      raw[offset] = clampByte(40 + (x / width) * 150 + texture);
      raw[offset + 1] = clampByte(90 + (y / height) * 120 - texture);
      raw[offset + 2] = clampByte(60 + ((x + y) / (width + height)) * 90 + texture);
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Node <20.15 has no zlib.crc32; PNG needs one either way. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Open Setup mode with the first view selected. */
async function openSetup(page) {
  await openScratchProject(page, PROJECT);
  await page.locator('[data-mode="setup"]').click();
  await expect(page.locator('#setupRow')).toBeVisible();
}

const backgroundField = (page) =>
  page.locator('.setup-panel__field', { hasText: 'Background image' }).locator('input');
const statusText = (page) => page.locator('.setup-panel__status');

/**
 * The CSS url() a panel is currently painting. The first plan view's svg is
 * `topSvg`; every other view's is `<id>Svg` (src/render/viewConfig.js), so an
 * elevation has to be addressed by its own id.
 */
const panelBackground = (page, svgId = 'topSvg') =>
  page.evaluate((id) => document.getElementById(id).closest('.view').style.backgroundImage, svgId);

test('uploading a photo compresses it, stores it, and points the view at it', async ({ page }) => {
  await openSetup(page);
  const viewId = await page.evaluate(() => document.querySelector('.setup-panel__item.is-selected button').textContent);

  const source = makePng(3200, 2400);
  await page.locator('input[data-background-upload]').setInputFiles({
    name: 'front-yard.png',
    mimeType: 'image/png',
    buffer: source,
  });

  await expect(statusText(page)).toContainText('Background set', { timeout: 20000 });

  // The path the server chose, not anything the client sent: view id, content
  // hash, extension from the sniffed type.
  const stored = await backgroundField(page).inputValue();
  expect(stored).toMatch(/^img\/[a-z0-9_-]+-[0-9a-f]{12}\.webp$/);
  expect(stored).not.toContain('front-yard');

  const onDisk = path.join(imgDir(), path.basename(stored));
  const bytes = await readFile(onDisk);

  // Really a WebP, and really much smaller than what was picked.
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
  expect(bytes.length).toBeLessThan(source.length / 4);
  expect(bytes.length).toBeLessThan(900 * 1024);

  // Capped at the long edge, and the status line reports what the user got.
  await expect(statusText(page)).toContainText('2400×1800');

  // The panel is actually pointed at the new file. Backgrounds are a CSS
  // background-image on .view (src/render/viewConfig.js), not an SVG <image>.
  expect(await panelBackground(page)).toContain(path.basename(stored));
  expect(viewId).toBeTruthy();
});

test('a second upload replaces the first rather than piling up', async ({ page }) => {
  await openSetup(page);
  const first = await backgroundField(page).inputValue();

  // Different pixels, so a different hash and a different path — which is what
  // makes the browser fetch the new photo instead of the cached one.
  await page.locator('input[data-background-upload]').setInputFiles({
    name: 'second.png',
    mimeType: 'image/png',
    buffer: makePng(1600, 1200),
  });
  await expect(statusText(page)).toContainText('Background set', { timeout: 20000 });

  const second = await backgroundField(page).inputValue();
  expect(second).not.toBe(first);
  // A changed url() is the whole reason the name carries a content hash: the
  // same string would give the browser no reason to re-fetch anything.
  expect(await panelBackground(page)).toContain(path.basename(second));

  const viewId = second.replace(/^img\//, '').replace(/-[0-9a-f]{12}\.webp$/, '');
  const remaining = (await readdir(imgDir())).filter((name) => name.startsWith(`${viewId}-`));
  expect(remaining).toEqual([path.basename(second)]);

  // Already inside the edge limit, so it is stored at its own size.
  await expect(statusText(page)).toContainText('1600×1200');
});

test('uploading to an elevation lands on that view, not the plan', async ({ page }) => {
  await openSetup(page);

  // Every earlier test uploads to the first view, which is the plan — and the
  // plan panel is the one addressed as `topSvg`. An elevation exercises the
  // other half of viewConfig's id scheme.
  await page.locator('.setup-panel__pick', { hasText: 'South elevation' }).click();
  const planBefore = await panelBackground(page);

  await page.locator('input[data-background-upload]').setInputFiles({
    name: 'south.png',
    mimeType: 'image/png',
    buffer: makePng(2000, 1500),
  });
  await expect(statusText(page)).toContainText('Background set', { timeout: 20000 });

  const stored = await backgroundField(page).inputValue();
  expect(stored).toMatch(/^img\/south-[0-9a-f]{12}\.webp$/);
  expect(await panelBackground(page, 'southSvg')).toContain(path.basename(stored));
  // The plan is a different view and keeps its own photo.
  expect(await panelBackground(page)).toBe(planBefore);
});

test('an uploaded photo letterboxes instead of stretching, and leaves the view geometry alone', async ({ page }) => {
  await openSetup(page);

  const extent = () => page.evaluate(() =>
    [...document.querySelectorAll('.setup-panel__field')]
      .filter((f) =>
        /^(East–west|North–south) \(ft\)$/.test(
          f.querySelector('.setup-panel__field-label').textContent
        )
      )
      .map((f) => f.querySelector('input').value));

  const before = await extent();

  // 16:9 into the plan view, which is 4:3. Under the old `background-size:
  // 100% 100%` this was scaled differently on each axis, so a plant at the
  // right height in feet sat at the wrong height against the photo.
  await page.locator('input[data-background-upload]').setInputFiles({
    name: 'wide.png',
    mimeType: 'image/png',
    buffer: makePng(1920, 1080),
  });
  await expect(statusText(page)).toContainText('Background set', { timeout: 20000 });

  // The photo fits inside the panel whole, at one scale on both axes.
  const painted = await page.evaluate(
    () => getComputedStyle(document.getElementById('topSvg').closest('.view')).backgroundSize
  );
  expect(painted).toBe('contain');

  // And the yard is untouched — a photo has never been able to reshape it, and
  // now it cannot reshape the view it sits behind either.
  expect(await extent()).toEqual(before);
});

test('a tall yard is fitted to the viewport, at one scale for every panel', async ({ page }) => {
  await openSetup(page);

  // A deliberately extreme portrait yard: at any fixed scale this panel would
  // be many times the viewport height, so the page scale has to come down.
  const setFeet = async (label, value) => {
    const input = page.locator('.setup-panel__field', { hasText: label }).locator('input');
    await input.fill(String(value));
    await input.dispatchEvent('change');
  };
  await setFeet('East–west (ft)', 10);
  await setFeet('North–south (ft)', 50);
  await setFeet('Margin around it (ft)', 0);

  const view = page.locator('#topSvg').locator('xpath=ancestor::*[contains(@class,"view")][1]');
  const viewportHeight = page.viewportSize().height;
  // .view is content-box with a 1px border, so the fit governs the content
  // height and the bounding box is that plus the two borders.
  const border = await view.evaluate((el) => {
    const style = getComputedStyle(el);
    return parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  });

  // Read outside Setup: there the focused panel shows a WIDENED window, with
  // room around the view for positioning a photo, so its proportions are the
  // working area's rather than the yard's.
  const inSetup = await view.boundingBox();
  await page.locator('[data-mode="view"]').click();
  const box = await view.boundingBox();

  expect(box.height - border).toBeLessThanOrEqual(viewportHeight * 0.7 + 1);
  // Still exactly 1:5 — the panel is extentFt x the page scale on both axes,
  // so the yard's proportions are the panel's proportions.
  expect(box.width / box.height).toBeCloseTo(10 / 50, 2);

  // Setup shows one drawing and gives it more of the page than four sharing.
  expect(inSetup.height - border).toBeLessThanOrEqual(viewportHeight * 0.88 + 1);
  expect(inSetup.height).toBeGreaterThan(box.height);

  // And a foot is worth the same on screen in the elevation beside it: the
  // south view spans the same 10 ft east-west, so it is exactly as wide.
  const south = await page
    .locator('#southSvg')
    .locator('xpath=ancestor::*[contains(@class,"view")][1]')
    .boundingBox();
  expect(south.width).toBeCloseTo(box.width, 1);
});

test('an upload that is not an image is refused before anything is written', async ({ page }) => {
  await openSetup(page);
  const before = await readdir(imgDir());

  await page.locator('input[data-background-upload]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not a photo'),
  });

  await expect(statusText(page)).toContainText('not an image');
  await expect(statusText(page)).toHaveAttribute('data-state', 'error');
  expect(await readdir(imgDir())).toEqual(before);
});
