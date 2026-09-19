import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveField, SOURCE } from '../tools/claims/precedence.js';

test('resolveField: differently-ranked sources return the primary\'s value and a stated reason', () => {
  const result = resolveField(
    [
      { value: 'full-sun', source: SOURCE.USDA_CHARACTERISTICS },
      { value: 'part-sun', source: SOURCE.NPIN },
    ],
    'sun_pref',
  );
  assert.equal(result.value, 'part-sun');
  assert.equal(result.source, SOURCE.NPIN);
  assert.match(result.reason, /npin is primary for sun_pref/);
});

test('resolveField: Passiflora lutea sun_pref resolves to NPIN, reproducing commit 1fa2a13\'s hand correction', () => {
  const result = resolveField(
    [
      { value: 'full-sun', source: SOURCE.USDA_CHARACTERISTICS, citation: 'Shade Tolerance' },
      { value: 'part-sun', source: SOURCE.NPIN, citation: 'directly stated' },
    ],
    'sun_pref',
  );
  assert.deepEqual({ value: result.value, source: result.source }, { value: 'part-sun', source: SOURCE.NPIN });
});

test('resolveField: a tie under the precedence table returns no value and routes to review', () => {
  const result = resolveField(
    [
      { value: 'Minor', source: SOURCE.USDA_CHARACTERISTICS, citation: 'Martin' },
      { value: 'Moderate', source: SOURCE.USDA_CHARACTERISTICS, citation: 'Miller' },
    ],
    'LargeMammals',
  );
  assert.equal(result.value, undefined);
  assert.equal(result.status, 'review');
  assert.match(result.reason, /Martin.*Minor.*vs.*Miller.*Moderate/s);
});

test('resolveField: agreeing claims tied at the same rank are not a conflict', () => {
  const result = resolveField(
    [
      { value: 'Minor', source: SOURCE.USDA_CHARACTERISTICS, citation: 'Martin' },
      { value: 'Minor', source: SOURCE.USDA_CHARACTERISTICS, citation: 'Miller' },
    ],
    'LargeMammals',
  );
  assert.equal(result.value, 'Minor');
  assert.equal(result.status, undefined);
});

test('resolveField: the three known tie cases land in review, not export', () => {
  // Callicarpa americana LargeMammals: Martin vs Miller, both /api/PlantWildlife (USDA).
  const callicarpa = resolveField(
    [
      { value: 'Minor', source: SOURCE.USDA_CHARACTERISTICS, citation: 'Martin' },
      { value: 'Moderate', source: SOURCE.USDA_CHARACTERISTICS, citation: 'Miller' },
    ],
    'LargeMammals',
  );
  assert.equal(callicarpa.status, 'review');

  // Cyperus esculentus nativity_nctx: the flora's own text cites Mabberley vs Tucker.
  const cyperus = resolveField(
    [
      { value: 'introduced', source: SOURCE.NCTX_FLORA, citation: 'Mabberley 1987' },
      { value: 'native', source: SOURCE.NCTX_FLORA, citation: 'Tucker 1994' },
    ],
    'nativity_nctx',
  );
  assert.equal(cyperus.status, 'review');

  // Nymphaea mexicana nativity_nctx: the flora's one NCTX record flagged "probably a hybrid",
  // undermining its own citation — modeled as two disagreeing flora claims.
  const nymphaea = resolveField(
    [
      { value: 'native', source: SOURCE.NCTX_FLORA, citation: 'NCTX record' },
      { value: 'review', source: SOURCE.NCTX_FLORA, citation: 'probably a hybrid' },
    ],
    'nativity_nctx',
  );
  assert.equal(nymphaea.status, 'review');
});

test('resolveField: a manual correction outranks every source, including a fresh re-crawl claim', () => {
  const result = resolveField(
    [
      { value: 'full-sun', source: SOURCE.USDA_CHARACTERISTICS },
      { value: 'part-sun', source: SOURCE.MANUAL_CORRECTION, citation: 'NPIN direct statement — john.syrinek@gmail.com' },
    ],
    'sun_pref',
  );
  assert.equal(result.value, 'part-sun');
  assert.equal(result.source, SOURCE.MANUAL_CORRECTION);
  assert.match(result.reason, /manual-correction outranks/);
});

test('resolveField: iNaturalist claims are never admissible as a value source', () => {
  const result = resolveField(
    [{ value: 'native', source: SOURCE.INATURALIST }],
    'nativity_nctx',
  );
  // Unranked and alone: still resolves (it's the only claim present), but
  // never beats a ranked source, and never silently wins a real field.
  assert.equal(result.value, 'native');
  assert.equal(result.source, SOURCE.INATURALIST);

  const withFlora = resolveField(
    [
      { value: 'native', source: SOURCE.INATURALIST },
      { value: 'introduced', source: SOURCE.NCTX_FLORA },
    ],
    'nativity_nctx',
  );
  assert.equal(withFlora.source, SOURCE.NCTX_FLORA);
});

test('resolveField: no claims resolves to null', () => {
  assert.equal(resolveField([], 'sun_pref'), null);
});
