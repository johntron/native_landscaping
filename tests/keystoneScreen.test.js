import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildHostGeneraIndex } from '../src/analysis/hostGenera.js';
import { buildNearbyFaunaIndex } from '../src/analysis/faunaMatches.js';
import {
  buildFnctScreenIndex,
  buildGrowthIndex,
  buildLepHostIndex,
  resolveGrowthTier,
  screenKeystoneGenera,
  verdictFor,
  CANOPY_HEIGHT_FT,
} from '../src/analysis/keystoneScreen.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

const rows = screenKeystoneGenera({
  hostGenera: buildHostGeneraIndex(read('ecology/host-genera.csv'), { ecoregion: '9' }),
  fnctScreen: buildFnctScreenIndex(read('ecology/fnct-genus-screen.csv')),
  lepHosts: buildLepHostIndex(read('ecology/fnct-lepidoptera-hosts.csv')),
  growth: buildGrowthIndex(read('blackland-prairie-natives.csv')),
  nearbyFauna: buildNearbyFaunaIndex(read('ecology/nearby-fauna.csv')),
  place: 'home',
});
const byGenus = (g) => rows.find((r) => r.genus === g);

test('the screen rejects exactly the genera the flora gives no treatment', () => {
  const rejected = rows.filter((r) => r.verdict === 'rejected').map((r) => r.genus);
  // The headline of the whole demo: the continental keystone list recommends
  // conifers and northern hardwoods for a Blackland Prairie yard.
  ['Larix', 'Tsuga', 'Abies', 'Picea', 'Pseudotsuga', 'Castanea', 'Corylus', 'Malus'].forEach((g) =>
    assert.ok(rejected.includes(g), `${g} should be rejected`)
  );
  rejected.forEach((g) => assert.equal(byGenus(g).fnctTreated, false));
});

// Betula is the subtler case and the one worth getting right: it IS in the
// flora, so it must NOT be rejected, even though 189 caterpillar species is
// still the wrong number for Dallas.
test('Betula is in the flora and so is not rejected', () => {
  const betula = byGenus('Betula');
  assert.equal(betula.fnctTreated, true);
  assert.equal(betula.fnctPage, '439');
  assert.notEqual(betula.verdict, 'rejected');
  assert.equal(betula.lepHostSpecies, 189, 'NWF\'s claim is still reported, not suppressed');
});

test('Celtis is screened and confirmed even though NWF never listed it', () => {
  const celtis = byGenus('Celtis');
  assert.equal(celtis.lepHostSpecies, null, 'absent from the keystone list');
  assert.equal(celtis.fnctTreated, true);
  assert.equal(celtis.fnctPage, '1036');
  assert.equal(celtis.verdict, 'confirmed-local');
  assert.ok(celtis.confirmedCount >= 3);
  const confirmed = celtis.confirmedNearby.map((c) => c.species);
  assert.ok(confirmed.includes('Asterocampa celtis'), 'hackberry butterfly');
});

test('every growth tier is represented among the locally confirmed genera', () => {
  const habits = new Set(
    rows.filter((r) => r.verdict === 'confirmed-local' && r.habit).map((r) => r.habit)
  );
  ['Tree', 'Forb/herb', 'Vine'].forEach((h) => assert.ok(habits.has(h), `no ${h} confirmed`));
});

test('an 80-foot shrub is reported as a tree, and the disagreement is kept', () => {
  const celtis = byGenus('Celtis');
  assert.equal(celtis.habit, 'Tree');
  assert.equal(celtis.usdaHabit, 'Shrub');
  assert.match(celtis.habitConflict, /my read of the height/);

  assert.equal(resolveGrowthTier('Shrub', CANOPY_HEIGHT_FT - 1).habit, 'Shrub');
  assert.equal(resolveGrowthTier('Vine', 83).habit, 'Vine', 'height says nothing about a vine');
  assert.equal(resolveGrowthTier('Tree', 110).conflict, '', 'no conflict to report');
});

test('provenance resolves to the flora wherever the flora backs the row', () => {
  assert.equal(byGenus('Quercus').tier, 'primary-flora');
  assert.equal(byGenus('Quercus').tierInfo.short, 'FNCT');
});

test('verdictFor separates "not in the flora" from "in it but no named hosts"', () => {
  const treated = { treated: true };
  assert.equal(verdictFor({ flora: null, hosts: [], confirmed: [], nwf: {} }), 'rejected');
  assert.equal(verdictFor({ flora: null, hosts: [], confirmed: [], nwf: null }), 'unscreened');
  assert.equal(verdictFor({ flora: treated, hosts: [], confirmed: [], nwf: {} }), 'in-flora');
  assert.equal(verdictFor({ flora: treated, hosts: [{}], confirmed: [], nwf: {} }), 'flora-hosts');
  assert.equal(verdictFor({ flora: treated, hosts: [{}], confirmed: [{}], nwf: {} }), 'confirmed-local');
});

test('rows sort with the strongest local evidence first', () => {
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].confirmedCount >= rows[i].confirmedCount, 'confirmed count is non-increasing');
  }
});
