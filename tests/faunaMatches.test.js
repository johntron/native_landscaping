import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInteractionsIndex,
  buildNearbyFaunaIndex,
  emptyInteractionsIndex,
  emptyNearbyFaunaIndex,
  evidenceKind,
  matchesForGenus,
  RANGE_THRESHOLD_MI,
} from '../src/analysis/faunaMatches.js';

const INTERACTIONS_CSV = `genus,animal_species,animal_common,category,interaction_type,synonym_of,source
Asclepias,Danaus plexippus,Monarch,feeds-on,eatenBy,,globi
Asclepias,Bombus fervidus,Golden Northern Bumble Bee,pollinator,flowersVisitedBy,,globi
Asclepias,Rara avis,Some rare bird,feeds-on,eatenBy,,globi
`;

const NEARBY_CSV = `place,animal_species,animal_common,iconic_taxon,nearest_radius_mi,observation_count,fetched_on,source
home,Danaus plexippus,Monarch,Insecta,1,42,2026-01-01,inat
home,Bombus fervidus,Golden Northern Bumble Bee,Insecta,25,3,2026-01-01,inat
`;

test('matchesForGenus joins interactions to nearby records by species, dropping unseen animals', () => {
  const interactions = buildInteractionsIndex(INTERACTIONS_CSV);
  const nearbyFauna = buildNearbyFaunaIndex(NEARBY_CSV);
  const matches = matchesForGenus('Asclepias', { interactions, nearbyFauna, place: 'home' });

  const species = matches.map((m) => m.animalSpecies);
  assert.ok(species.includes('Danaus plexippus'), 'monarch is both interacting and nearby');
  assert.ok(species.includes('Bombus fervidus'), 'bumble bee is both interacting and nearby');
  assert.ok(!species.includes('Rara avis'), 'no nearby record exists for this one');
});

test('inRange compares the observed distance band against the taxon range threshold, never scoring a likelihood', () => {
  const interactions = buildInteractionsIndex(INTERACTIONS_CSV);
  const nearbyFauna = buildNearbyFaunaIndex(NEARBY_CSV);
  const matches = matchesForGenus('Asclepias', { interactions, nearbyFauna, place: 'home' });

  const monarch = matches.find((m) => m.animalSpecies === 'Danaus plexippus');
  assert.equal(monarch.inRange, true, `1mi is within Insecta's ${RANGE_THRESHOLD_MI.Insecta}mi range`);

  const bee = matches.find((m) => m.animalSpecies === 'Bombus fervidus');
  assert.equal(bee.inRange, false, `25mi exceeds Insecta's ${RANGE_THRESHOLD_MI.Insecta}mi range`);
});

test('a genus with no interaction rows returns no matches rather than throwing', () => {
  const interactions = buildInteractionsIndex(INTERACTIONS_CSV);
  const nearbyFauna = buildNearbyFaunaIndex(NEARBY_CSV);
  assert.deepEqual(matchesForGenus('Quercus', { interactions, nearbyFauna, place: 'home' }), []);
});

test('an unknown place returns no matches', () => {
  const interactions = buildInteractionsIndex(INTERACTIONS_CSV);
  const nearbyFauna = buildNearbyFaunaIndex(NEARBY_CSV);
  assert.deepEqual(matchesForGenus('Asclepias', { interactions, nearbyFauna, place: 'elsewhere' }), []);
});

test('a trinomial subspecies on one side still joins on genus+species', () => {
  const interactions = buildInteractionsIndex(
    `genus,animal_species,animal_common,category,interaction_type,synonym_of,source
Asclepias,Danaus plexippus plexippus,,pollinator,flowersVisitedBy,,globi
`
  );
  const nearbyFauna = buildNearbyFaunaIndex(NEARBY_CSV);
  const matches = matchesForGenus('Asclepias', { interactions, nearbyFauna, place: 'home' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].animalSpecies, 'Danaus plexippus');
});

test('empty indexes report zero size and never throw', () => {
  assert.equal(emptyInteractionsIndex().size, 0);
  assert.equal(emptyNearbyFaunaIndex().size, 0);
  assert.deepEqual(
    matchesForGenus('Asclepias', {
      interactions: emptyInteractionsIndex(),
      nearbyFauna: emptyNearbyFaunaIndex(),
      place: 'home',
    }),
    []
  );
});

// --- establishment_means (nl-a8v follow-on) -------------------------------
// nearby-fauna.csv now carries iNaturalist's per-place establishment_means, so
// a page arguing "this native plant feeds local wildlife" can stop citing
// European Starlings as evidence.
const ESTABLISHMENT_INTERACTIONS = [
  'genus,animal_species,animal_common,category,interaction_type,synonym_of,source',
  'Quercus,Erynnis horatius,Horace\'s Duskywing,feeds-on,eatenBy,,globi',
  'Quercus,Sturnus vulgaris,European Starling,feeds-on,eatenBy,,globi',
  'Quercus,Bombus pensylvanicus,American Bumble Bee,pollinator,flowersVisitedBy,,globi',
].join('\n');

const ESTABLISHMENT_FAUNA = [
  'place,animal_species,animal_common,iconic_taxon,nearest_radius_mi,observation_count,establishment_means,fetched_on,source',
  'home,Erynnis horatius,Horace\'s Duskywing,Insecta,3,4,native,2026-09-13,inat',
  'home,Sturnus vulgaris,European Starling,Aves,1,900,introduced,2026-09-13,inat',
  'home,Bombus pensylvanicus,American Bumble Bee,Insecta,3,20,,2026-09-13,inat',
].join('\n');

function establishmentCtx(extra = {}) {
  return {
    interactions: buildInteractionsIndex(ESTABLISHMENT_INTERACTIONS),
    nearbyFauna: buildNearbyFaunaIndex(ESTABLISHMENT_FAUNA),
    place: 'home',
    ...extra,
  };
}

test('establishment_means is parsed and carried onto every match', () => {
  const matches = matchesForGenus('Quercus', establishmentCtx());
  const byName = new Map(matches.map((m) => [m.animalSpecies, m.establishmentMeans]));
  assert.equal(byName.get('Erynnis horatius'), 'native');
  assert.equal(byName.get('Sturnus vulgaris'), 'introduced');
  assert.equal(byName.get('Bombus pensylvanicus'), '', 'unassessed stays empty, not guessed');
});

test('matches stay unfiltered by default, so existing callers are unchanged', () => {
  const matches = matchesForGenus('Quercus', establishmentCtx());
  assert.equal(matches.length, 3);
});

test('nativeOnly drops positively-introduced animals but keeps unassessed ones', () => {
  const matches = matchesForGenus('Quercus', establishmentCtx({ nativeOnly: true }));
  const names = matches.map((m) => m.animalSpecies);
  assert.ok(!names.includes('Sturnus vulgaris'), 'an introduced starling is not evidence for an oak');
  assert.ok(names.includes('Erynnis horatius'));
  assert.ok(
    names.includes('Bombus pensylvanicus'),
    'unassessed is not the same as introduced — it must survive the filter'
  );
});

// --- evidence labelling ---------------------------------------------------
test('evidenceKind maps the kept verbs and refuses to guess at an unknown one', () => {
  assert.equal(evidenceKind('hostOf'), 'develops-on');
  assert.equal(evidenceKind('hasEggsLayedOnBy'), 'develops-on');
  assert.equal(evidenceKind('eatenBy'), 'consumes');
  assert.equal(evidenceKind('flowersVisitedBy'), 'flower-visit');
  assert.equal(evidenceKind('adjacentTo'), '', 'a verb the fetch tool drops is not evidence');
  assert.equal(evidenceKind(undefined), '');
});

// hostOf and eatenBy share the coarse 'feeds-on' category, so before the
// strength ordering the surviving row — and therefore its label — depended on
// which one the CSV happened to list first. Both orders must now agree.
const BOTH_VERBS = (first, second) =>
  [
    'genus,animal_species,animal_common,category,interaction_type,synonym_of,source',
    `Cercis,Hyphantria cunea,Fall Webworm Moth,feeds-on,${first},,globi`,
    `Cercis,Hyphantria cunea,Fall Webworm Moth,feeds-on,${second},,globi`,
  ].join('\n');

const WEBWORM_NEARBY = [
  'place,animal_species,animal_common,iconic_taxon,nearest_radius_mi,observation_count,establishment_means,fetched_on,source',
  'home,Hyphantria cunea,Fall Webworm Moth,Insecta,1,12,native,2026-09-13,inat',
].join('\n');

for (const [first, second] of [
  ['hostOf', 'eatenBy'],
  ['eatenBy', 'hostOf'],
]) {
  test(`the strongest evidence wins regardless of row order (${first} then ${second})`, () => {
    const matches = matchesForGenus('Cercis', {
      interactions: buildInteractionsIndex(BOTH_VERBS(first, second)),
      nearbyFauna: buildNearbyFaunaIndex(WEBWORM_NEARBY),
      place: 'home',
    });
    assert.equal(matches.length, 1, 'still one row per animal per category');
    assert.equal(matches[0].evidence, 'develops-on');
    assert.equal(matches[0].interactionType, 'hostOf');
  });
}

test('evidenceKinds narrows to the requested labels', () => {
  const ctx = {
    interactions: buildInteractionsIndex(ESTABLISHMENT_INTERACTIONS),
    nearbyFauna: buildNearbyFaunaIndex(ESTABLISHMENT_FAUNA),
    place: 'home',
  };
  const all = matchesForGenus('Quercus', ctx);
  assert.ok(all.every((m) => m.evidence), 'every match carries a label');

  const visits = matchesForGenus('Quercus', { ...ctx, evidenceKinds: ['flower-visit'] });
  assert.deepEqual(
    visits.map((m) => m.animalSpecies),
    ['Bombus pensylvanicus']
  );
  const none = matchesForGenus('Quercus', { ...ctx, evidenceKinds: ['develops-on'] });
  assert.deepEqual(none, [], 'no hostOf records in this fixture, and none are invented');
});
