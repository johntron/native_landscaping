import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePageScale } from '../src/render/pageScale.js';

/** The shape example-frontyard derives: a tall plan and three shorter elevations. */
const VIEWS = [
  { extentFt: { width: 14, height: 34 } },
  { extentFt: { width: 14, height: 14 } },
  { extentFt: { width: 34, height: 14 } },
  { extentFt: { width: 14, height: 14 } },
];

test('the binding constraint is whichever runs out first', () => {
  // Width binds: 1400 px over the widest 34 ft is 41 px/ft, but 34 ft of height
  // in a 0.7 x 900 px budget is only 18.5.
  assert.ok(
    Math.abs(
      resolvePageScale({ views: VIEWS, availableWidthPx: 1400, availableHeightPx: 900 }) -
        (900 * 0.7) / 34
    ) < 1e-9
  );
  // Give it all the height it wants and the width binds instead.
  assert.ok(
    Math.abs(
      resolvePageScale({ views: VIEWS, availableWidthPx: 680, availableHeightPx: 100000 }) -
        680 / 34
    ) < 1e-9
  );
});

test('one scale means panel sizes carry the yard they cover', () => {
  const pxPerFt = resolvePageScale({ views: VIEWS, availableWidthPx: 1400, availableHeightPx: 900 });
  const widthOf = (view) => view.extentFt.width * pxPerFt;
  // The view that spans the yard's 30 ft depth really is drawn wider than the
  // ones spanning its 10 ft width — which is the point, and was not true when
  // each panel was fitted to its own cell.
  assert.ok(widthOf(VIEWS[2]) > widthOf(VIEWS[1]) * 2);
});

test('zoom multiplies the scale and nothing else', () => {
  const base = resolvePageScale({ views: VIEWS, availableWidthPx: 1400, availableHeightPx: 900 });
  const zoomed = resolvePageScale({
    views: VIEWS,
    availableWidthPx: 1400,
    availableHeightPx: 900,
    zoom: 2,
  });
  assert.ok(Math.abs(zoomed - base * 2) < 1e-9);
});

test('an unmeasured container does not resolve to zero', () => {
  // The first layout pass runs before the container has a width. Zero would
  // collapse every panel; the caller re-runs once the width is real.
  assert.ok(resolvePageScale({ views: VIEWS, availableWidthPx: 0, availableHeightPx: 0 }) > 0);
  assert.ok(resolvePageScale({ views: [], availableWidthPx: 1400, availableHeightPx: 900 }) > 0);
});

test('a yard too big for the page still draws, and the page scrolls', () => {
  const huge = [{ extentFt: { width: 100000, height: 100000 } }];
  assert.ok(resolvePageScale({ views: huge, availableWidthPx: 800, availableHeightPx: 600 }) >= 4);
});
