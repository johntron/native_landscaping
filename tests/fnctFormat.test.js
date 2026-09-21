import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmptyCatalogValue, humanizeWords, formatMonthRange, formatCatalogValue } from '../src/fnct/fnctFormat.js';

test('isEmptyCatalogValue treats blank, "none" and "0" as nothing to show', () => {
  assert.ok(isEmptyCatalogValue(''));
  assert.ok(isEmptyCatalogValue('none'));
  assert.ok(isEmptyCatalogValue('None'));
  assert.ok(isEmptyCatalogValue('0'));
  assert.ok(!isEmptyCatalogValue('low'));
  assert.ok(!isEmptyCatalogValue('10'));
});

test('humanizeWords title-cases hyphenated and comma-separated codes', () => {
  assert.equal(humanizeWords('part-sun'), 'Part Sun');
  assert.equal(humanizeWords('sandy,loamy'), 'Sandy, Loamy');
  assert.equal(humanizeWords('low'), 'Low');
});

test('humanizeWords separates a slash-joined pair with spaces', () => {
  assert.equal(humanizeWords('spike/raceme'), 'Spike / Raceme');
});

test('formatMonthRange converts a numeric range to month names', () => {
  assert.equal(formatMonthRange('4-11'), 'April–November');
  assert.equal(formatMonthRange('9-11'), 'September–November');
});

test('formatMonthRange converts a single month number', () => {
  assert.equal(formatMonthRange('9'), 'September');
});

test('formatMonthRange leaves non-month-shaped input unchanged', () => {
  assert.equal(formatMonthRange('sandy'), 'sandy');
  assert.equal(formatMonthRange('13-14'), '13-14');
});

test('formatCatalogValue recognizes a hex color and returns a swatch + text', () => {
  const result = formatCatalogValue('color', '#9a5fb8');
  assert.deepEqual(result, { swatch: '#9a5fb8', text: '#9A5FB8' });
});

test('formatCatalogValue falls back to humanized words for a non-hex color field', () => {
  assert.equal(formatCatalogValue('color', 'red-orange'), 'Red Orange');
});

test('formatCatalogValue appends units for a feet field', () => {
  assert.equal(formatCatalogValue('feet', '1.5'), '1.5 ft');
});

test('formatCatalogValue formats a months field by name', () => {
  assert.equal(formatCatalogValue('months', '4-11'), 'April–November');
});

test('formatCatalogValue passes a number field through unchanged', () => {
  assert.equal(formatCatalogValue('number', '60'), '60');
});
