import test from 'node:test';
import assert from 'node:assert/strict';
import { clampLabelPosition, driftLabel } from '../src/render/labels.js';

test('driftLabel builds the first member\'s initials plus the member count (nl-o47.6.11)', () => {
  assert.equal(driftLabel([{ botanicalName: 'Callirhoe involucrata' }, {}, {}]), 'CI (3x)');
  assert.equal(driftLabel([{ botanicalName: 'Calyptocarpus vialis' }]), 'CV (1x)');
  // The FIRST member's own name wins even if a later member differs — every
  // member of a drift shares one species, so this only matters in a
  // pathological/legacy mix, and the first member's is picked deterministically.
  assert.equal(
    driftLabel([{ botanicalName: 'Callirhoe involucrata' }, { botanicalName: 'Calyptocarpus vialis' }]),
    'CI (2x)'
  );
});

test('driftLabel returns empty for an empty list, or a first member with no usable name', () => {
  assert.equal(driftLabel([]), '');
  assert.equal(driftLabel(null), '');
  assert.equal(driftLabel([{}]), '');
});

test('clampLabelPosition leaves a centred label alone when it already fits', () => {
  const viewBox = { width: 800, height: 600 };
  const point = { x: 400, y: 300 };
  const pos = clampLabelPosition(point, 'Winecup ×17', 16, viewBox);
  assert.equal(pos.x, 400);
  assert.equal(pos.y, 300);
});

test('clampLabelPosition pulls a label at the left edge inward so it stays fully on screen', () => {
  const viewBox = { width: 800, height: 600 };
  const point = { x: 2, y: 300 };
  const text = 'Winecup ×17'; // wide text at a tiny fontSize's half-width
  const pos = clampLabelPosition(point, text, 16, viewBox);
  const halfWidth = (text.length * 16 * 0.62) / 2;
  assert.ok(pos.x >= halfWidth, `x (${pos.x}) should clear the left edge by at least halfWidth (${halfWidth})`);
  assert.equal(pos.y, 300, 'y is untouched when only x overhangs');
});

test('clampLabelPosition pulls a label at the right edge inward', () => {
  const viewBox = { width: 800, height: 600 };
  const point = { x: 799, y: 300 };
  const text = 'Winecup ×17';
  const pos = clampLabelPosition(point, text, 16, viewBox);
  const halfWidth = (text.length * 16 * 0.62) / 2;
  assert.ok(pos.x <= viewBox.width - halfWidth, `x (${pos.x}) should clear the right edge`);
});

test('clampLabelPosition pulls a label at the top/bottom edges inward on y', () => {
  const viewBox = { width: 800, height: 600 };
  const top = clampLabelPosition({ x: 400, y: 0 }, 'Winecup ×17', 16, viewBox);
  assert.ok(top.y >= 8, `top y (${top.y}) should clear the top edge`);
  const bottom = clampLabelPosition({ x: 400, y: 600 }, 'Winecup ×17', 16, viewBox);
  assert.ok(bottom.y <= 592, `bottom y (${bottom.y}) should clear the bottom edge`);
});

test('clampLabelPosition never inverts its own clamp range for a label wider than the viewBox', () => {
  const viewBox = { width: 40, height: 40 };
  const pos = clampLabelPosition({ x: 5, y: 5 }, 'A drift name far too wide for this tiny viewBox ×99', 16, viewBox);
  // No room keeps text this wide fully on screen either way; the best x can
  // do is fall back to the centre rather than throw or invert min>max. y is
  // unaffected by the text's width, so it still clamps normally against the
  // (much smaller) font-height half.
  assert.equal(pos.x, viewBox.width / 2);
  assert.ok(pos.y >= 0 && pos.y <= viewBox.height, `y (${pos.y}) stays within the viewBox`);
});
