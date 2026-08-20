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
        getContext: () => ({ drawImage: (...args) => calls.push(args) }),
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

  return run({ svg, calls }).finally(() => {
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

test('a crop draws only its rectangle of the source image', async () => {
  await withStubbedDom(async ({ svg, calls }) => {
    // projects/example-frontyard's street-bed: 9x6 ft at (3,3) out of a plan
    // covering 12x25 ft at (2,2).
    await captureViewToPng({
      svg,
      viewBox: { width: 432, height: 288 },
      backgroundUrl: 'plan.svg',
      sourceRect: { x: 1 / 12, y: 16 / 25, width: 9 / 12, height: 6 / 25 },
      scale: 1,
    });
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = calls[0];
    assert.ok(Math.abs(sx - 1000 / 12) < 1e-9, `sx ${sx}`);
    assert.ok(Math.abs(sy - (800 * 16) / 25) < 1e-9, `sy ${sy}`);
    assert.ok(Math.abs(sw - (1000 * 9) / 12) < 1e-9, `sw ${sw}`);
    assert.ok(Math.abs(sh - (800 * 6) / 25) < 1e-9, `sh ${sh}`);
    assert.deepEqual([dx, dy, dw, dh], [0, 0, 432, 288]);
  });
});

test('a view with no background composites only its overlay', async () => {
  await withStubbedDom(async ({ svg, calls }) => {
    await captureViewToPng({ svg, viewBox: { width: 100, height: 100 } });
    assert.equal(calls.length, 1);
  });
});
