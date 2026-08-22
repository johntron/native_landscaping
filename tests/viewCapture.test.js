import test from 'node:test';
import assert from 'node:assert/strict';
import { captureViewToPng } from '../src/export/viewCapture.js';

/**
 * captureViewToPng talks to canvas, Image, and XMLSerializer, none of which Node
 * has. Stub the few calls it makes so the one piece of arithmetic worth pinning —
 * the source rectangle a cropped view draws from — can be asserted.
 */
function withStubbedDom(run) {
  const calls = [];
  const fills = [];
  const saved = {};
  const set = (key, value) => {
    saved[key] = globalThis[key];
    globalThis[key] = value;
  };

  set('document', {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: (...args) => calls.push(args),
          fillRect: (...args) => fills.push(args),
          set fillStyle(value) {
            fills.push(value);
          },
        }),
        toBlob: (cb) => cb({ type: 'image/png' }),
      };
    },
  });
  set('Image', class {
    set src(value) {
      this.naturalWidth = 1000;
      this.naturalHeight = 800;
      this.url = value;
      queueMicrotask(() => this.onload());
    }
  });
  set('XMLSerializer', class {
    serializeToString() {
      return '<svg/>';
    }
  });
  set('URL', { createObjectURL: () => 'blob:overlay', revokeObjectURL: () => {} });

  const svg = {
    cloneNode: () => ({ setAttribute() {} }),
  };

  return run({ svg, calls, fills }).finally(() => {
    Object.entries(saved).forEach(([key, value]) => {
      globalThis[key] = value;
    });
  });
}

test('without a crop the whole photo is stretched over the view', async () => {
  await withStubbedDom(async ({ svg, calls }) => {
    await captureViewToPng({
      svg,
      viewBox: { width: 400, height: 300 },
      backgroundUrl: 'plan.webp',
      scale: 2,
    });
    // Background first, then the SVG overlay on top.
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(1), [0, 0, 800, 600]);
  });
});

test('a placed photo is drawn into its rectangle of the canvas', async () => {
  await withStubbedDom(async ({ svg, calls }) => {
    // A photo covering part of the panel, and hanging off its left edge — the
    // ordinary case once the panel is sized by the yard rather than the photo.
    await captureViewToPng({
      svg,
      viewBox: { width: 432, height: 288 },
      backgroundUrl: 'plan.svg',
      destRect: { x: -20, y: 30, width: 300, height: 200 },
      scale: 2,
    });
    // Destination form: four arguments after the image, in canvas pixels. A
    // source rect could not say "starts 20 px before the left edge".
    assert.deepEqual(calls[0].slice(1), [-40, 60, 600, 400]);
  });
});

test('a view with no background composites only its overlay', async () => {
  await withStubbedDom(async ({ svg, calls }) => {
    await captureViewToPng({ svg, viewBox: { width: 100, height: 100 } });
    assert.equal(calls.length, 1);
  });
});

test('the panel surface is painted behind a photo that does not cover it', async () => {
  await withStubbedDom(async ({ svg, fills }) => {
    await captureViewToPng({
      svg,
      viewBox: { width: 400, height: 300 },
      backgroundUrl: 'plan.webp',
      destRect: { x: 40, y: 30, width: 100, height: 75 },
      scale: 2,
    });
    // On screen the uncovered margin is .view's background-color. A view is the
    // yard plus a margin on every side, so leaving it transparent would put a
    // hole around every exported drawing rather than around an odd one.
    assert.deepEqual(fills, ['#f2f0eb', [0, 0, 800, 600]]);
  });
});
