import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RULES, STATUSES, analyzeEcology, buildEcologyContext } from '../src/analysis/ecology.js';
import { describeMonths, monthName } from '../src/analysis/months.js';
import { parseSpeciesCsv, createPlantFromSpecies, buildPlantsFromCsv } from '../src/data/plantParser.js';
import { buildHostGeneraIndex } from '../src/analysis/hostGenera.js';
import { buildInteractionsIndex, buildNearbyFaunaIndex } from '../src/analysis/faunaMatches.js';

const CATALOG = parseSpeciesCsv(
  readFileSync(fileURLToPath(new URL('../plants.csv', import.meta.url)), 'utf8')
);

/** Place one of each named species, so a fixture reads as a list of common names. */
function place(...botanicalNames) {
  return botanicalNames.map((name, idx) => {
    const entry = CATALOG.find((row) => row.botanicalName === name);
    assert.ok(entry, `plants.csv has no ${name}`);
    return createPlantFromSpecies(entry, { id: `p${idx}`, x: idx, y: 0 });
  });
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** A minimal species row, for the cases no catalog species happens to cover. */
function synthetic(botanicalName) {
  return {
    id: botanicalName,
    botanicalName,
    botanicalKey: botanicalName.toLowerCase(),
    speciesEpithet: botanicalName.split(' ')[1],
    commonName: botanicalName,
    growthShape: 'mound',
    growingMonths: [],
    floweringMonths: [],
    fruitMonths: [],
    fruitLoad: '',
    width: 2,
    height: 2,
  };
}

function run(plants, extra = {}) {
  const results = analyzeEcology(
    buildEcologyContext({ plants, species: CATALOG, ...extra })
  );
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

test('describeMonths names runs the way a season is written, wrapping the year end', () => {
  assert.equal(describeMonths([10, 11, 12, 1, 2]), 'Oct-Feb');
  assert.equal(describeMonths([3]), 'Mar');
  assert.equal(describeMonths([1, 2, 6]), 'Jan-Feb, Jun');
  // A run that wraps the year end is one run, and reported from its true start.
  assert.equal(describeMonths([11, 12, 1, 5]), 'May, Nov-Jan');
  assert.equal(describeMonths([]), 'no months');
  assert.equal(describeMonths([1,2,3,4,5,6,7,8,9,10,11,12]), 'all year');
  assert.equal(monthName(12), 'Dec');
});

test('every result carries one of exactly four statuses', () => {
  const allowed = new Set(Object.values(STATUSES));
  const results = analyzeEcology(buildEcologyContext({ plants: place('Salvia farinacea'), species: CATALOG }));
  assert.equal(results.length, RULES.length);
  results.forEach((result) => {
    assert.ok(allowed.has(result.status), `${result.id} returned "${result.status}"`);
    assert.ok(result.title && result.summary, `${result.id} needs a title and summary`);
    assert.ok(Array.isArray(result.findings) && Array.isArray(result.suggestions));
  });
});

test('an empty yard reports not-declared everywhere rather than throwing', () => {
  const results = analyzeEcology(buildEcologyContext({ plants: [], species: CATALOG }));
  results.forEach((result) => assert.equal(result.status, STATUSES.NOT_DECLARED, result.id));
});

test('a rule that throws becomes a not-declared row, never an exception', () => {
  const ctx = buildEcologyContext({ plants: place('Salvia farinacea'), species: CATALOG });
  Object.defineProperty(ctx, 'placedSpecies', {
    get() {
      throw new Error('boom');
    },
  });
  const results = analyzeEcology(ctx);
  results.forEach((result) => {
    assert.equal(result.status, STATUSES.NOT_DECLARED);
  });
  assert.match(results[0].summary, /boom/);
});

test('bloom succession counts species per month and only inside the growing window', () => {
  // Autumn sage blooms Mar-Nov and grows Mar-Dec, so December is bare and inside
  // the window; January and February are outside it and must not read as gaps.
  const result = run(place('Salvia farinacea'))['bloom-succession'];
  assert.equal(result.status, STATUSES.GAP);
  assert.ok(
    result.findings.some((f) => /outside every planted species/.test(f)),
    'dormant months are named as out of window, not counted as gaps'
  );
  assert.ok(result.suggestions.length, 'suggests catalog species covering the bare months');
});

test('bloom succession is thin, not a gap, when a month rests on one species', () => {
  // Hand-built rather than drawn from the catalog: the point is the boundary
  // between "covered" and "covered by one thing", which no real pair happens to sit on.
  const evergreen = { ...synthetic('Aaa aaa'), growingMonths: ALL_MONTHS, floweringMonths: ALL_MONTHS };
  const nearly = {
    ...synthetic('Bbb bbb'),
    growingMonths: ALL_MONTHS,
    floweringMonths: ALL_MONTHS.filter((m) => m !== 12),
  };
  const both = [evergreen, nearly].map((entry, idx) =>
    createPlantFromSpecies(entry, { id: `s${idx}`, x: idx, y: 0 })
  );
  const result = run(both)['bloom-succession'];
  assert.equal(result.status, STATUSES.PARTIAL);
  assert.ok(result.findings.some((f) => /Only one species blooms in Dec/.test(f)));

  const result2 = run([both[0]])['bloom-succession'];
  assert.equal(result2.status, STATUSES.PARTIAL, 'one all-year bloomer is thin every month');
  const result3 = run(both.concat(
    createPlantFromSpecies({ ...synthetic('Ccc ccc'), growingMonths: ALL_MONTHS, floweringMonths: ALL_MONTHS }, { id: 's3', x: 3, y: 0 })
  ))['bloom-succession'];
  assert.equal(result3.status, STATUSES.OK);
  assert.match(result3.summary, /blooms every month/);
});

test('a wrap-around fruit range counts as winter food', () => {
  const winterFruiter = CATALOG.find((entry) => entry.botanicalName === 'Ilex vomitoria');
  assert.ok(winterFruiter.fruitMonths.includes(1), 'parseMonthField wraps 10-2 into January');
  assert.ok(winterFruiter.fruitMonths.includes(12));
});

test('bird food judges the Sep-Feb window, not the whole year', () => {
  // Passionflower fruits Jul-Oct: summer food only, so the winter months are bare.
  const summerOnly = run(place('Passiflora incarnata'))['bird-food'];
  assert.equal(summerOnly.status, STATUSES.GAP);
  assert.ok(summerOnly.findings.some((f) => /No fruit at all/.test(f)));

  const winter = run(place('Ilex vomitoria', 'Callicarpa americana', 'Rhus aromatica'))['bird-food'];
  assert.notEqual(winter.status, STATUSES.GAP);
});

test('bird food ignores a species whose fruit load is none', () => {
  const none = CATALOG.filter((entry) => entry.fruitLoad === 'none' && entry.fruitMonths.length);
  if (!none.length) return; // the catalog may carry no such row; the guard still matters
  const result = run(place(none[0].botanicalName))['bird-food'];
  assert.equal(result.status, STATUSES.GAP);
});

test('bird food excludes a fruiting species with no declared crop size, rather than assuming sparse (nl-c58)', () => {
  const entry = { ...synthetic('Ilex undeclaredload'), fruitMonths: [10, 11, 12], fruitLoad: '' };
  const plant = createPlantFromSpecies(entry, { id: 'u', x: 0, y: 0 });
  const result = run([plant])['bird-food'];
  assert.ok(
    result.findings.some((f) => /1 fruiting species declares no crop size/.test(f)),
    'a blank fruit_load must be reported as unknown, not silently treated as sparse'
  );
});

test('vertical layers reports empty strata and suggests fillers for them', () => {
  const groundOnly = run(place('Calyptocarpus vialis'))['vertical-layers'];
  assert.equal(groundOnly.status, STATUSES.GAP);
  assert.ok(groundOnly.findings.some((f) => /canopy: 0 species/.test(f)));
  assert.ok(groundOnly.suggestions.length);

  const layered = run(
    place("Cercis canadensis var. texensis 'Oklahoma'", 'Sorghastrum nutans', 'Salvia farinacea', 'Calyptocarpus vialis')
  )['vertical-layers'];
  assert.equal(layered.status, STATUSES.OK);
  assert.deepEqual(layered.suggestions, [], 'nothing to suggest when every layer is filled');
});

test('vertical layers excludes a species with no declared height or shape, rather than bucketing it as groundcover (nl-c58)', () => {
  const declared = { ...synthetic('Species undeclared'), growthShape: '', height: null };
  const plant = createPlantFromSpecies(declared, { id: 'u', x: 0, y: 0 });
  const result = run([plant], { species: [declared] })['vertical-layers'];
  assert.ok(
    result.findings.some((f) => /1 species declares no height or shape/.test(f)),
    'a blank height/shape must be excluded and reported, not defaulted to a 1 ft groundcover'
  );
});

test('vertical layers reports not-declared, not four empty layers, when nothing placed can be classified (nl-c58)', () => {
  const declared = { ...synthetic('Species wholly undeclared'), growthShape: '', height: null };
  const plant = createPlantFromSpecies(declared, { id: 'u', x: 0, y: 0 });
  const result = run([plant], { species: [declared] })['vertical-layers'];
  assert.equal(result.status, STATUSES.NOT_DECLARED);
  assert.doesNotMatch(result.summary, /empty/, 'must not describe this as an empty yard');
});

test('vertical layers excludes a species with no entry in ctx.species at all, rather than falling back to its fabricated plant size (nl-c58)', () => {
  // A plant whose botanicalKey is absent from ctx.species (a data mismatch,
  // not a blank field) must not fall back to the plant object's own
  // createPlantFromSpecies-fabricated height (?? 1) — that reintroduces the
  // exact bug this rule exists to avoid.
  const declared = { ...synthetic('Species not in catalog'), botanicalKey: 'not-in-catalog' };
  const plant = createPlantFromSpecies({ ...declared, botanicalKey: 'different-key' }, { id: 'u', x: 0, y: 0 });
  const result = run([plant], { species: [] })['vertical-layers'];
  assert.equal(result.status, STATUSES.NOT_DECLARED);
});

test('layers are counted by species, so a big drift of one plant fills one layer only', () => {
  const drift = place('Calyptocarpus vialis');
  const many = Array.from({ length: 19 }, (_, i) => ({ ...drift[0], id: `d${i}` }));
  const result = run(many)['vertical-layers'];
  assert.ok(result.findings.some((f) => /ground layer: 1 species/.test(f)));
});

const HOST_GENERA = buildHostGeneraIndex(
  readFileSync(fileURLToPath(new URL('../ecology/host-genera.csv', import.meta.url)), 'utf8'),
  { ecoregion: '9' }
);

/** The context rules 4/10 and 5 need: an ecoregion and a loaded genus table. */
function runWithGenera(plants, extra = {}) {
  return run(plants, { hostGenera: HOST_GENERA, ecoregion: '9', ...extra });
}

test('keystone genera: Packera resolves through synonym_of and counts', () => {
  // NWF files ragwort under Senecio; the catalog and both layouts use Packera
  // obovata. Without synonym resolution the frontyard's ragwort is invisible here.
  const result = runWithGenera(place('Packera obovata'))['keystone-genera'];
  assert.match(result.findings[0], /Packera \(22 specialist bees — listed as Senecio\)/);
  assert.notEqual(result.status, STATUSES.GAP, 'a keystone genus IS planted');
});

test('keystone genera: a bee-only genus never reads as a fully met dimension', () => {
  // Packera earns its place entirely through Senecio's pollen-specialist-bee
  // count. Nothing there hosts a caterpillar, which is the half that carries
  // birds — so however much ground it holds, this cannot be "ok".
  const result = runWithGenera(place('Packera obovata'))['keystone-genera'];
  assert.equal(result.status, STATUSES.PARTIAL);
  assert.match(result.summary, /specialist bees only/);

  // A lep-host genus at the same share DOES clear the bar.
  const withLep = runWithGenera(place('Helianthus maximiliani'))['keystone-genera'];
  assert.equal(withLep.status, STATUSES.OK);
});

test('keystone genera says whose numbers those are, every time it shows them', () => {
  // The most misread number on the panel: an ecoregion-wide GENUS count is not a
  // property of the planted species and is not a headcount this yard delivers.
  const result = runWithGenera(place('Packera obovata'))['keystone-genera'];
  assert.ok(
    result.findings.some((f) => /for the GENUS across the whole of ecoregion 9/.test(f)),
    'the caveat rides along with the counts'
  );
  const none = runWithGenera(place('Salvia farinacea'))['keystone-genera'];
  assert.ok(
    !none.findings.some((f) => /for the GENUS/.test(f)),
    'and is not shown when there are no counts to misread'
  );
});

test('a month the catalog cannot fill is reported, not counted against the design', () => {
  // December is the real case: NCTX natives are dormant and NOTHING in the
  // catalog blooms then, so demanding it teaches the reader to ignore the panel.
  // November is the opposite — five catalog species reach it, so it stays a gap.
  const catalogBloom = new Set(CATALOG.flatMap((entry) => entry.floweringMonths));
  assert.equal(catalogBloom.has(12), false, 'nothing in the catalog blooms in December');
  assert.equal(catalogBloom.has(11), true, 'five species reach November');

  const allYear = createPlantFromSpecies(
    { ...synthetic('Aaa aaa'), growingMonths: ALL_MONTHS, floweringMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { id: 'a', x: 0, y: 0 }
  );
  const result = run([allYear])['bloom-succession'];
  // Nov is closable and drives the status; Dec is not and only gets a note.
  assert.equal(result.status, STATUSES.GAP);
  assert.ok(result.findings.some((f) => /Nothing blooms in Nov/.test(f)));
  assert.ok(
    result.findings.some((f) => /Nothing in the catalog blooms in Dec/.test(f) && /not counted/.test(f))
  );
  assert.ok(
    result.findings.some((f) => /winter FRUIT is the check that matters/.test(f)),
    'and points at the check that does matter in those months'
  );
});

test('the same split makes bloom and fruit disagree about December, correctly', () => {
  // One helper, two fields: nothing blooms in December so bloom lets it go,
  // while yaupon fruits straight through it so an empty December stays a gap.
  const summerFruiter = run(place('Passiflora incarnata'));
  assert.equal(summerFruiter['bird-food'].status, STATUSES.GAP);
  assert.ok(
    summerFruiter['bird-food'].findings.some(
      (f) => /No fruit at all in/.test(f) && /gap worth closing/.test(f)
    )
  );
});

test('keystone genera: a design with none reports a gap, and says so as a gap to close', () => {
  const result = runWithGenera(place('Passiflora incarnata', 'Calyptocarpus vialis'))['keystone-genera'];
  assert.equal(result.status, STATUSES.GAP);
  assert.match(result.summary, /keystone genus for ecoregion 9/);
  assert.ok(result.suggestions.length, 'names catalog species that would close it');
  assert.ok(
    result.suggestions.every((s) => /keystone genus/.test(s)),
    'every suggestion says which genus it brings'
  );
});

test('keystone genera suggestions rank a clean site fit ahead of a mismatch, and say what does not match', () => {
  // Synthetic candidates, not real catalog species: the ranking behavior under
  // test must hold regardless of how many clean-fitting keystone genera the
  // catalog happens to carry, so this does not drift as it grows.
  const hostGenera = buildHostGeneraIndex(
    'genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source\n' +
      'Cleanhostus,9,20,,,,test\n' +
      'Mismatchus,9,80,,,,test\n', // ecologically stronger, but wants full sun on a part-sun site
    { ecoregion: '9' }
  );
  const cleanFit = { ...synthetic('Cleanhostus fitus'), sunPref: 'part-sun', waterPref: 'medium', soilPref: ['clay'] };
  const mismatch = {
    ...synthetic('Mismatchus badus'),
    sunPref: 'full-sun',
    waterPref: 'medium',
    soilPref: ['clay'],
  };
  const site = { sun: 'part-sun', water: 'medium', soil: 'clay' };
  const result = run(place('Passiflora incarnata'), {
    hostGenera,
    ecoregion: '9',
    site,
    species: CATALOG.concat([cleanFit, mismatch]),
  })['keystone-genera'];
  const bySpecies = (name) => result.suggestions.findIndex((s) => s.includes(name));
  const cleanIdx = bySpecies('Cleanhostus fitus');
  const mismatchIdx = bySpecies('Mismatchus badus');
  assert.ok(cleanIdx !== -1 && mismatchIdx !== -1, 'both candidates are offered');
  assert.ok(cleanIdx < mismatchIdx, 'the clean fit outranks the ecologically stronger mismatch');
  assert.match(result.suggestions[mismatchIdx], /partial match/);
  assert.match(result.suggestions[mismatchIdx], /wants full sun but this site gives part sun/);
  assert.doesNotMatch(result.suggestions[cleanIdx], /partial match/);
});

test('keystone genera measures footprint area, not head-count', () => {
  // One wide keystone plant against many narrow non-keystone ones: a head-count
  // would call this a rounding error, an area ratio would not.
  const wide = { ...synthetic('Helianthus test'), width: 10, height: 3 };
  const narrow = { ...synthetic('Passiflora test'), width: 1, height: 1 };
  const plants = [
    createPlantFromSpecies(wide, { id: 'w', x: 0, y: 0 }),
    ...Array.from({ length: 5 }, (_, i) => createPlantFromSpecies(narrow, { id: `n${i}`, x: i, y: 1 })),
  ];
  const result = run(plants, {
    hostGenera: HOST_GENERA,
    ecoregion: '9',
    species: CATALOG.concat([wide, narrow]),
  })['keystone-genera'];
  // pi*25 of 314 keystone vs 5 * pi*0.25 — about 95%.
  assert.match(result.findings[1], /9[0-9]% of the planted footprint/);
  assert.equal(result.status, STATUSES.OK);
});

test('keystone genera excludes plants with no declared width from BOTH sides', () => {
  // createPlantFromSpecies defaults width to 1, which is harmless for a perennial
  // and badly wrong for a tree. Counting one would move the ratio, not just blur it.
  const noWidth = { ...synthetic('Quercus test'), width: null };
  const sized = { ...synthetic('Passiflora test'), width: 4 };
  const plants = [
    createPlantFromSpecies(noWidth, { id: 'q', x: 0, y: 0 }),
    createPlantFromSpecies(sized, { id: 's', x: 1, y: 0 }),
  ];
  const result = run(plants, {
    hostGenera: HOST_GENERA,
    ecoregion: '9',
    species: CATALOG.concat([noWidth, sized]),
  })['keystone-genera'];
  assert.ok(result.findings.some((f) => /1 plant declares no width/.test(f)));
  assert.match(result.findings[1], /0% of the planted footprint \(0 of 12.6 sq ft\)/);
});

test('a project with no ecoregion reports not-declared on the genus rules', () => {
  const results = run(place('Packera obovata'));
  assert.equal(results['keystone-genera'].status, STATUSES.NOT_DECLARED);
  assert.equal(results['larval-hosts'].status, STATUSES.NOT_DECLARED);
  assert.match(results['keystone-genera'].summary, /declares no ecoregion/);
});

test('a failed host-genera load degrades the genus rules, it does not break them', () => {
  const results = run(place('Packera obovata'), { ecoregion: '9' });
  assert.equal(results['keystone-genera'].status, STATUSES.NOT_DECLARED);
  assert.match(results['keystone-genera'].summary, /did not load/);
  // The rules that need no table keep working.
  assert.notEqual(results['bloom-succession'].status, STATUSES.NOT_DECLARED);
});

test('larval hosts is not derived from keystone membership', () => {
  // Antelope-horns is a monarch host and Asclepias is on NEITHER NWF top-30 list.
  // Deriving rule 5 from the keystone columns would score this design as hostless.
  const results = runWithGenera(place('Asclepias asperula'));
  assert.equal(results['keystone-genera'].status, STATUSES.GAP, 'not a keystone genus');
  assert.notEqual(results['larval-hosts'].status, STATUSES.GAP, 'but it is a larval host');
  assert.ok(results['larval-hosts'].findings.some((f) => /Asclepias hosts monarch/.test(f)));
});

test('larval hosts: none planted is a gap with named replacements', () => {
  const result = runWithGenera(place('Salvia farinacea'))['larval-hosts'];
  assert.equal(result.status, STATUSES.GAP);
  assert.ok(result.suggestions.length);
  assert.ok(result.suggestions.every((s) => /host to/.test(s)));
});

test('larval hosts suggestions rank a clean site fit ahead of a mismatch, and say what does not match', () => {
  // Synthetic candidates, not real catalog species: the ranking behavior under
  // test must hold regardless of how many clean-fitting hosts the catalog
  // happens to carry, so this does not drift as host-genera.csv grows.
  const hostGenera = buildHostGeneraIndex(
    'genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source\n' +
      'Cleanhostus,9,,,test skipper,,test\n' +
      'Mismatchus,9,,,test hairstreak,,test\n',
    { ecoregion: '9' }
  );
  const cleanFit = { ...synthetic('Cleanhostus fitus'), sunPref: 'part-sun', waterPref: 'medium', soilPref: ['clay'] };
  const mismatch = {
    ...synthetic('Mismatchus badus'),
    sunPref: 'full-sun',
    waterPref: 'low',
    soilPref: ['clay'],
  };
  const site = { sun: 'part-sun', water: 'medium', soil: 'clay' };
  const result = run(place('Salvia farinacea'), {
    hostGenera,
    ecoregion: '9',
    site,
    species: CATALOG.concat([cleanFit, mismatch]),
  })['larval-hosts'];
  const bySpecies = (name) => result.suggestions.findIndex((s) => s.includes(name));
  const cleanIdx = bySpecies('Cleanhostus fitus');
  const mismatchIdx = bySpecies('Mismatchus badus');
  assert.ok(cleanIdx !== -1 && mismatchIdx !== -1, 'both candidates are offered');
  assert.ok(cleanIdx < mismatchIdx, 'the clean fit outranks the mismatch');
  assert.match(result.suggestions[mismatchIdx], /partial match/);
  assert.match(result.suggestions[mismatchIdx], /full sun.*part sun/);
  assert.match(result.suggestions[mismatchIdx], /low water on a medium-water site/);
  assert.doesNotMatch(result.suggestions[cleanIdx], /partial match/);
});

test('larval hosts: one genus is partial, two or more is ok', () => {
  const one = runWithGenera(place('Asclepias asperula'))['larval-hosts'];
  assert.equal(one.status, STATUSES.PARTIAL);
  assert.match(one.summary, /rests on one genus/);

  const several = runWithGenera(place('Asclepias asperula', 'Passiflora incarnata'))['larval-hosts'];
  assert.equal(several.status, STATUSES.OK);
  assert.deepEqual(several.suggestions, [], 'nothing to suggest once the bar is cleared');
});

const INTERACTIONS_FIXTURE = buildInteractionsIndex(
  `genus,animal_species,animal_common,category,interaction_type,synonym_of,source
Asclepias,Danaus plexippus,Monarch,feeds-on,eatenBy,,globi
Asclepias,Bombus fervidus,Golden Northern Bumble Bee,pollinator,flowersVisitedBy,,globi
`
);
const NEARBY_FAUNA_FIXTURE = buildNearbyFaunaIndex(
  `animal_species,animal_common,iconic_taxon,nearest_radius_mi,observation_count,fetched_on,source
Danaus plexippus,Monarch,Insecta,1,42,2026-01-01,inat
`
);

// nl-3s5.31: the fauna is the yard's own (/api/ecosystem/site), so a yard
// with no place label but with nearby rows is graded, not refused.
test('local fauna support needs the yard’s own rows, not a place label', () => {
  const result = runWithGenera(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    nearbyFauna: NEARBY_FAUNA_FIXTURE,
  })['local-fauna-support'];
  assert.equal(result.status, STATUSES.PARTIAL);
  assert.match(result.summary, /near this yard/);
});

test('local fauna support reports not-declared when either table failed to load', () => {
  const noInteractions = run(place('Asclepias asperula'), {
    nearbyFauna: NEARBY_FAUNA_FIXTURE,
  })['local-fauna-support'];
  assert.equal(noInteractions.status, STATUSES.NOT_DECLARED);

  const noNearbyFauna = run(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
  })['local-fauna-support'];
  assert.equal(noNearbyFauna.status, STATUSES.NOT_DECLARED);
});

test('local fauna support matches a planted genus against an animal reported nearby', () => {
  const result = run(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    nearbyFauna: NEARBY_FAUNA_FIXTURE,
  })['local-fauna-support'];
  assert.equal(result.status, STATUSES.PARTIAL, 'one matched species is a start, not ample');
  assert.match(result.summary, /1 animal species/);
  assert.ok(
    result.findings.some((f) => /Asclepias/.test(f) && /Monarch/.test(f)),
    'names the matching genus and animal'
  );
});

test('local fauna support drops a match outside the taxon range threshold', () => {
  const farAway = buildNearbyFaunaIndex(
    `animal_species,animal_common,iconic_taxon,nearest_radius_mi,observation_count,fetched_on,source
Danaus plexippus,Monarch,Insecta,25,1,2026-01-01,inat
`
  );
  const result = run(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    nearbyFauna: farAway,
  })['local-fauna-support'];
  assert.equal(result.status, STATUSES.GAP);
});

test('local fauna support points at the keystone-genera check rather than inventing its own recommendation', () => {
  const result = run(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    nearbyFauna: NEARBY_FAUNA_FIXTURE,
  })['local-fauna-support'];
  assert.ok(result.suggestions.some((s) => /[Kk]eystone genera/.test(s)));
});

test('the shipped example yard analyses without throwing, and reports what the data says', () => {
  // backyard is the one yard still tracked (nl-3s5.3); the others are private, in app.db.
  ['backyard'].forEach((id) => {
    const layout = readFileSync(
      fileURLToPath(new URL(`../projects/${id}/planting_layout.csv`, import.meta.url)),
      'utf8'
    );
    const plants = buildPlantsFromCsv(
      readFileSync(fileURLToPath(new URL('../plants.csv', import.meta.url)), 'utf8'),
      layout
    );
    const results = run(plants, { hostGenera: HOST_GENERA, ecoregion: '9' });
    // A weak keystone score is a TRUE finding, not a bug: neither shipped project
    // plants an oak (nl-41o.13 added Quercus to the catalog, but planting it is
    // a design decision this test fixture doesn't make). The catalog still can't
    // supply every heavy-hitting genus on its own — no Prunus, no Salix, no
    // Betula — and every project must say so, whatever its area ratio works out
    // to. It should also now suggest an oak, since one is finally plantable.
    assert.ok(
      results['keystone-genera'].findings.some((f) => /Prunus \(222 caterpillar species\)/.test(f)),
      `${id} must name the keystone genera the catalog still cannot supply`
    );
    assert.ok(
      results['keystone-genera'].suggestions.some((s) => /Quercus/.test(s)),
      `${id} should now be able to suggest an oak (nl-41o.13)`
    );
    assert.notEqual(results['larval-hosts'].status, STATUSES.NOT_DECLARED, id);
    // The plan's own survey (see src/analysis/rules/drifts.js) found this exact
    // shape waiting: frontyard is nearly one-of-everything, backyard concentrates
    // properly. Locking both in as a regression check on the real fixtures.
    if (id === 'example-frontyard') assert.equal(results['drifts'].status, STATUSES.GAP, id);
    if (id === 'backyard') assert.equal(results['drifts'].status, STATUSES.OK, id);
  });
});

/**
 * Rule 8's comparator is ASYMMETRIC and the direction has been inverted once
 * already (commit ed9d75c). Both directions are covered on both scales.
 */
function siteResult(plant, site) {
  return run([plant], { site, hostGenera: HOST_GENERA, ecoregion: '9' })['site-match'];
}

function planted(overrides) {
  return createPlantFromSpecies({ ...synthetic('Testus testus'), ...overrides }, { id: 't', x: 0, y: 0 });
}

test('site match: a plant needing MORE light than the site gives is a real failure', () => {
  // full-sun is a high light REQUIREMENT (little bluestem, Indiangrass), not a
  // tolerance — see ed9d75c. One step off is real, two is hard.
  const oneStep = siteResult(planted({ sunPref: 'full-sun' }), { sun: 'part-sun' });
  assert.equal(oneStep.status, STATUSES.PARTIAL);
  assert.match(oneStep.findings[0], /too little light/);

  const twoSteps = siteResult(planted({ sunPref: 'full-sun' }), { sun: 'shade' });
  assert.equal(twoSteps.status, STATUSES.GAP);
  assert.match(twoSteps.findings[0], /too little light/);
});

test('site match: a plant needing LESS light than the site gives is the other failure', () => {
  // A part-sun plant in a full-sun yard is usually fine; a shade sedge is not.
  const oneStep = siteResult(planted({ sunPref: 'part-sun' }), { sun: 'full-sun' });
  assert.equal(oneStep.status, STATUSES.PARTIAL);
  assert.match(oneStep.findings[0], /usually fine/);
  assert.doesNotMatch(oneStep.findings[0], /too little light/, 'not the same finding as the other direction');

  const twoSteps = siteResult(planted({ sunPref: 'shade' }), { sun: 'full-sun' });
  assert.equal(twoSteps.status, STATUSES.GAP);
  assert.match(twoSteps.findings[0], /scorched/);
});

test('site match: both water directions are findings, and they are different findings', () => {
  const tooDry = siteResult(planted({ waterPref: 'high' }), { water: 'low' });
  assert.equal(tooDry.status, STATUSES.GAP, 'two steps is hard');
  assert.match(tooDry.findings[0], /drought out/);

  const tooWet = siteResult(planted({ waterPref: 'low' }), { water: 'high' });
  assert.equal(tooWet.status, STATUSES.GAP);
  assert.match(tooWet.findings[0], /expect rot/);
  assert.doesNotMatch(tooWet.findings[0], /drought/, 'rot and drought are not the same advice');

  const mildlyDry = siteResult(planted({ waterPref: 'medium' }), { water: 'low' });
  assert.equal(mildlyDry.status, STATUSES.PARTIAL);
  assert.match(mildlyDry.findings[0], /drought out/);
});

test('site match: a soil mismatch is a caution and does NOT drive the status', () => {
  // soil_pref holds one PREFERRED soil and the catalog records no tolerance, so
  // a mismatch is an unknown, not a known failure. Scoring it like a failure is
  // what made this check punitive; the caution is reported and set aside.
  assert.equal(siteResult(planted({ soilPref: ['clay'] }), { soil: 'clay' }).status, STATUSES.OK);

  const off = siteResult(planted({ soilPref: ['sandy'] }), { soil: 'clay' });
  assert.equal(off.status, STATUSES.OK, 'reported, not counted against the design');
  assert.ok(off.findings.some((f) => /not counted against the design/.test(f)));
  assert.ok(
    off.findings.some((f) => /prefers sandy soil on a clay site/.test(f) && /shorter-lived/.test(f)),
    'the copy says what to expect, not just that it is wrong'
  );

  // A real light or water failure still lands, alongside the soil caution.
  const both = siteResult(planted({ soilPref: ['sandy'], sunPref: 'shade' }), {
    soil: 'clay',
    sun: 'full-sun',
  });
  assert.equal(both.status, STATUSES.GAP, 'the sun failure still decides the status');

  // A multi-valued cell is a set, not a scale — the draft regional CSVs write "sandy,loamy".
  assert.equal(siteResult(planted({ soilPref: ['sandy', 'clay'] }), { soil: 'clay' }).status, STATUSES.OK);
});

test('site match: a mismatch against a MEASURED soil set (nl-9a6) is a real gap, not a caution', () => {
  // A comma-separated soil_pref came from USDA's soil_coarse/medium/fine
  // triple, not a bare preference, so a site outside that set is a known
  // failure and should drive the status like sun/water do.
  const off = siteResult(planted({ soilPref: ['sandy', 'loamy'] }), { soil: 'clay' });
  assert.equal(off.status, STATUSES.PARTIAL, 'a measured mismatch counts against the design');
  assert.ok(off.findings.some((f) => /takes sandy or loamy soil, not the clay this site has/.test(f)));
  assert.ok(
    !off.findings.some((f) => /not counted against the design/.test(f)),
    'a measured mismatch is not filed under the unknowns list'
  );
});

test('site match: a compound soil texture also takes its named halves (nl-5c8)', () => {
  // 'clay-loam' is one token (the hyphen is the texture name, not a separator),
  // but it sits between clay and loam, so a site declared as either should not
  // raise a caution against a plant that lists only the compound.
  const clayLoam = { soilPref: ['clay-loam'] };
  assert.equal(siteResult(planted(clayLoam), { soil: 'clay-loam' }).status, STATUSES.OK);
  assert.equal(siteResult(planted(clayLoam), { soil: 'clay' }).status, STATUSES.OK);
  assert.equal(siteResult(planted(clayLoam), { soil: 'loamy' }).status, STATUSES.OK);

  // Sandy is neither half, so the caution still fires.
  const sandySite = siteResult(planted(clayLoam), { soil: 'sandy' });
  assert.ok(sandySite.findings.some((f) => /prefers clay-loam soil on a sandy site/.test(f)));
});

test('site match: an undeclared axis is skipped, not guessed', () => {
  const result = siteResult(planted({ sunPref: 'shade', waterPref: 'high', soilPref: ['sandy'] }), {
    soil: 'sandy',
  });
  assert.equal(result.status, STATUSES.OK, 'sun and water were never declared, so never checked');
  assert.ok(result.findings.some((f) => /declares no sun or water/.test(f)));
});

test('site match: a project with no site block reports not-declared rather than throwing', () => {
  const result = run(place('Salvia farinacea'), { hostGenera: HOST_GENERA, ecoregion: '9' })['site-match'];
  assert.equal(result.status, STATUSES.NOT_DECLARED);
  assert.match(result.findings[0], /Add a "site" block/);
});

test('site match: a blank preference on the plant is not a mismatch', () => {
  const result = siteResult(planted({ sunPref: '', waterPref: '', soilPref: [] }), {
    sun: 'shade',
    water: 'low',
    soil: 'clay',
  });
  assert.equal(result.status, STATUSES.OK);
});

test('site match: a blank preference on the plant is reported, not silently skipped (nl-c58)', () => {
  // Before nl-c58, this read exactly like a perfectly matched design: no finding,
  // no caution, nothing. The site declares all three axes; the plant declares none.
  const result = siteResult(planted({ sunPref: '', waterPref: '', soilPref: [] }), {
    sun: 'shade',
    water: 'low',
    soil: 'clay',
  });
  assert.ok(result.findings.some((f) => /1 planted species declares no sun preference/.test(f)));
  assert.ok(result.findings.some((f) => /1 planted species declares no water preference/.test(f)));
  assert.ok(result.findings.some((f) => /1 planted species declares no soil preference/.test(f)));
});

test('site match: the summary does not claim a match when nothing was actually checked (nl-c58)', () => {
  // Before this fix the summary read "Every planted species matches the
  // declared site" here -- true of zero checked axes, and indistinguishable
  // in the collapsed panel from a design that was actually verified.
  const result = siteResult(planted({ sunPref: '', waterPref: '', soilPref: [] }), {
    sun: 'shade',
    water: 'low',
    soil: 'clay',
  });
  assert.doesNotMatch(result.summary, /Every planted species matches/);
  assert.match(result.summary, /could not be fully checked/);
});

test('site match: only the axes the plant leaves blank are reported as undeclared', () => {
  const result = siteResult(planted({ sunPref: 'shade', waterPref: '', soilPref: ['clay'] }), {
    sun: 'shade',
    water: 'low',
    soil: 'clay',
  });
  assert.ok(result.findings.some((f) => /1 planted species declares no water preference/.test(f)));
  assert.ok(!result.findings.some((f) => /declares no sun preference/.test(f)));
  assert.ok(!result.findings.some((f) => /declares no soil preference/.test(f)));
});

/** A synthetic species with an explicit width_ft, for controlled clumping/spacing fixtures. */
function widthSpecies(botanicalName, width) {
  return { ...synthetic(botanicalName), width };
}

/** Place count plants of one species entry along the x axis, spacing ft apart, starting at startX. */
function placeSpaced(entry, count, spacing, startX = 0) {
  return Array.from({ length: count }, (_, i) =>
    createPlantFromSpecies(entry, { id: `${entry.botanicalKey}-${i}`, x: startX + i * spacing, y: 0 })
  );
}

test('drifts: fewer than 5 plants is not-declared, too few to judge', () => {
  const entry = widthSpecies('Aaa aaa', 2);
  const result = run(placeSpaced(entry, 4, 0.5), { species: [entry] })['drifts'];
  assert.equal(result.status, STATUSES.NOT_DECLARED);
});

test('drifts: one-of-everything reads as a gap, and singles are named', () => {
  const species = ['Aaa aaa', 'Bbb bbb', 'Ccc ccc'].map((name) => widthSpecies(name, 2));
  // Two individuals per species, 100 ft apart -- nowhere near the ~3 ft clump
  // threshold for width 2, so every species' largest clump is 1.
  const plants = species.flatMap((entry) => placeSpaced(entry, 2, 100));
  const result = run(plants, { species })['drifts'];
  assert.equal(result.status, STATUSES.GAP);
  assert.ok(result.findings.some((f) => /3 species are planted as isolated singles/.test(f)));
  assert.deepEqual(result.suggestions, []);
});

test('drifts: a clump of 5-9 is a real but modest drift (partial)', () => {
  const entry = widthSpecies('Aaa aaa', 2);
  // Spaced 0.5 ft apart, well under the (1+1)*1.5 = 3 ft clump threshold, so
  // all 6 individuals merge into one clump via the union-find chain.
  const result = run(placeSpaced(entry, 6, 0.5), { species: [entry] })['drifts'];
  assert.equal(result.status, STATUSES.PARTIAL);
  assert.match(result.summary, /thin side of the 5-10\+/);
});

test('drifts: a clump of 10+ reads as a real drift (ok)', () => {
  const entry = widthSpecies('Aaa aaa', 2);
  const result = run(placeSpaced(entry, 10, 0.5), { species: [entry] })['drifts'];
  assert.equal(result.status, STATUSES.OK);
  assert.match(result.findings[0], /Largest drift: Aaa aaa, 10 plants/);
});

/** Two plants of given species/width, `distance` ft apart on the x axis. */
function pairAt(entryA, entryB, distance) {
  return [
    createPlantFromSpecies(entryA, { id: 'a', x: 0, y: 0 }),
    createPlantFromSpecies(entryB, { id: 'b', x: distance, y: 0 }),
  ];
}

test('mature spacing: fewer than 2 plants is not-declared', () => {
  const entry = widthSpecies('Aaa aaa', 4);
  const result = run(placeSpaced(entry, 1, 0), { species: [entry] })['mature-spacing'];
  assert.equal(result.status, STATUSES.NOT_DECLARED);
});

test('mature spacing: a same-species pair planted close is drifts.js territory, not this rule\'s', () => {
  const same = widthSpecies('Aaa aaa', 4);
  const other = widthSpecies('Bbb bbb', 4);
  const plants = [
    ...pairAt(same, same, 0.1), // same species, nearly on top of each other -- ignored here
    createPlantFromSpecies(other, { id: 'c', x: 100, y: 0 }), // far from everything
  ];
  const result = run(plants, { species: [same, other] })['mature-spacing'];
  assert.equal(result.status, STATUSES.OK);
  assert.ok(!result.findings.some((f) => /Aaa aaa and Aaa aaa/.test(f)));
});

test('mature spacing: cross-species overlap severities are mild, real, and hard', () => {
  const a = widthSpecies('Aaa aaa', 4);
  const b = widthSpecies('Bbb bbb', 4); // combinedRadius = 4 for every a/b pair below

  const mild = run(pairAt(a, b, 3.6), { species: [a, b] })['mature-spacing']; // overlap 0.4, ratio 0.1
  assert.equal(mild.status, STATUSES.PARTIAL);
  assert.ok(mild.findings.some((f) => /\(mild\)/.test(f)));

  const real = run(pairAt(a, b, 2), { species: [a, b] })['mature-spacing']; // overlap 2, ratio 0.5
  assert.equal(real.status, STATUSES.PARTIAL);
  assert.ok(real.findings.some((f) => /\(real\)/.test(f)));

  const hard = run(pairAt(a, b, 0.4), { species: [a, b] })['mature-spacing']; // overlap 3.6, ratio 0.9
  assert.equal(hard.status, STATUSES.GAP);
  assert.ok(hard.findings.some((f) => /\(hard\)/.test(f)));
});

test('mature spacing: a pair missing declared width is excluded, not silently passed', () => {
  const declared = widthSpecies('Aaa aaa', 4);
  const undeclared = widthSpecies('Bbb bbb', undefined);
  const result = run(pairAt(declared, undeclared, 0.1), { species: [declared, undeclared] })[
    'mature-spacing'
  ];
  assert.equal(result.status, STATUSES.NOT_DECLARED);
  assert.match(result.summary, /1 pair excluded/);
});
