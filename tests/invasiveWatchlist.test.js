import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvasiveWatchlistIndex, classifyInvasive } from '../src/analysis/invasiveWatchlist.js';

const CSV = `genus,species,common_name,source
Ligustrum,,Privet,test
Morus,alba,White Mulberry,test`;

test('buildInvasiveWatchlistIndex matches a genus-wide row for any species', () => {
  const watchlist = buildInvasiveWatchlistIndex(CSV);
  assert.equal(watchlist.match('Ligustrum sinense').commonName, 'Privet');
  assert.equal(watchlist.match('Ligustrum japonicum').commonName, 'Privet');
});

test('buildInvasiveWatchlistIndex only matches the named species, never a native congener', () => {
  const watchlist = buildInvasiveWatchlistIndex(CSV);
  assert.equal(watchlist.match('Morus alba').commonName, 'White Mulberry');
  assert.equal(watchlist.match('Morus rubra'), null);
});

test('buildInvasiveWatchlistIndex returns null for an unrelated genus', () => {
  const watchlist = buildInvasiveWatchlistIndex(CSV);
  assert.equal(watchlist.match('Quercus virginiana'), null);
});

test('classifyInvasive returns null against an empty watchlist', () => {
  const relevance = classifyInvasive({ taxon_name: 'Pyrus calleryana' }, { watchlist: { size: 0, match: () => null } });
  assert.equal(relevance, null);
});

test('classifyInvasive returns a descriptor with the CSV source cited', () => {
  const watchlist = buildInvasiveWatchlistIndex(CSV);
  const relevance = classifyInvasive({ taxon_name: 'Morus alba' }, { watchlist });
  assert.equal(relevance.kind, 'invasive-watchlist');
  assert.equal(relevance.commonName, 'White Mulberry');
  assert.equal(relevance.source, 'test');
});
