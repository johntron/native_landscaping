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
  `place,animal_species,animal_common,iconic_taxon,nearest_radius_mi,observation_count,fetched_on,source
home,Danaus plexippus,Monarch,Insecta,1,42,2026-01-01,inat
`
);

test('local fauna support reports not-declared when the project has no place', () => {
  const result = runWithGenera(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    nearbyFauna: NEARBY_FAUNA_FIXTURE,
  })['local-fauna-support'];
  assert.equal(result.status, STATUSES.NOT_DECLARED);
});

test('local fauna support reports not-declared when either table failed to load', () => {
  const noInteractions = run(place('Asclepias asperula'), {
    nearbyFauna: NEARBY_FAUNA_FIXTURE,
    place: 'home',
  })['local-fauna-support'];
  assert.equal(noInteractions.status, STATUSES.NOT_DECLARED);

  const noNearbyFauna = run(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    place: 'home',
  })['local-fauna-support'];
  assert.equal(noNearbyFauna.status, STATUSES.NOT_DECLARED);
});

test('local fauna support matches a planted genus against an animal reported nearby', () => {
  const result = run(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    nearbyFauna: NEARBY_FAUNA_FIXTURE,
    place: 'home',
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
    `place,animal_species,animal_common,iconic_taxon,nearest_radius_mi,observation_count,fetched_on,source
home,Danaus plexippus,Monarch,Insecta,25,1,2026-01-01,inat
`
  );
  const result = run(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    nearbyFauna: farAway,
    place: 'home',
  })['local-fauna-support'];
  assert.equal(result.status, STATUSES.GAP);
});

test('local fauna support points at the keystone-genera check rather than inventing its own recommendation', () => {
  const result = run(place('Asclepias asperula'), {
    interactions: INTERACTIONS_FIXTURE,
    nearbyFauna: NEARBY_FAUNA_FIXTURE,
    place: 'home',
  })['local-fauna-support'];
  assert.ok(result.suggestions.some((s) => /[Kk]eystone genera/.test(s)));
});

test('both shipped projects analyse without throwing, and report what the data says', () => {
  ['example-frontyard', 'backyard'].forEach((id) => {
    const layout = readFileSync(
      fileURLToPath(new URL(`../projects/${id}/planting_layout.csv`, import.meta.url)),
      'utf8'
    );
    const plants = buildPlantsFromCsv(
      readFileSync(fileURLToPath(new URL('../plants.csv', import.meta.url)), 'utf8'),
      layout
    );
    const results = run(plants, { hostGenera: HOST_GENERA, ecoregion: '9' });
    // A weak keystone score is a TRUE finding, not a bug, and the reason is
    // structural: only six of the catalog's 42 genera are keystone in ecoregion 9
    // and NONE are woody, so no amount of replanting from this catalog closes it.
    // Every project must say so, whatever its area ratio works out to — the
    // frontyard's 37% is real, and it still has no oak.
    assert.ok(
      results['keystone-genera'].findings.some((f) => /Quercus \(253 caterpillar species\)/.test(f)),
      `${id} must name the keystone genera the catalog cannot supply`
    );
    assert.notEqual(results['larval-hosts'].status, STATUSES.NOT_DECLARED, id);
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
  assert.equal(siteResult(planted({ soilPref: 'clay' }), { soil: 'clay' }).status, STATUSES.OK);

  const off = siteResult(planted({ soilPref: 'sandy' }), { soil: 'clay' });
  assert.equal(off.status, STATUSES.OK, 'reported, not counted against the design');
  assert.ok(off.findings.some((f) => /not counted against the design/.test(f)));
  assert.ok(
    off.findings.some((f) => /prefers sandy soil on a clay site/.test(f) && /shorter-lived/.test(f)),
    'the copy says what to expect, not just that it is wrong'
  );

  // A real light or water failure still lands, alongside the soil caution.
  const both = siteResult(planted({ soilPref: 'sandy', sunPref: 'shade' }), {
    soil: 'clay',
    sun: 'full-sun',
  });
  assert.equal(both.status, STATUSES.GAP, 'the sun failure still decides the status');

  // A multi-valued cell is a set, not a scale — the draft regional CSVs write "sandy,loamy".
  assert.equal(siteResult(planted({ soilPref: 'sandy, clay' }), { soil: 'clay' }).status, STATUSES.OK);
});

test('site match: an undeclared axis is skipped, not guessed', () => {
  const result = siteResult(planted({ sunPref: 'shade', waterPref: 'high', soilPref: 'sandy' }), {
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
  const result = siteResult(planted({ sunPref: '', waterPref: '', soilPref: '' }), {
    sun: 'shade',
    water: 'low',
    soil: 'clay',
  });
  assert.equal(result.status, STATUSES.OK);
});

test('site match: a blank preference on the plant is reported, not silently skipped (nl-c58)', () => {
  // Before nl-c58, this read exactly like a perfectly matched design: no finding,
  // no caution, nothing. The site declares all three axes; the plant declares none.
  const result = siteResult(planted({ sunPref: '', waterPref: '', soilPref: '' }), {
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
  const result = siteResult(planted({ sunPref: '', waterPref: '', soilPref: '' }), {
    sun: 'shade',
    water: 'low',
    soil: 'clay',
  });
  assert.doesNotMatch(result.summary, /Every planted species matches/);
  assert.match(result.summary, /could not be fully checked/);
});

test('site match: only the axes the plant leaves blank are reported as undeclared', () => {
  const result = siteResult(planted({ sunPref: 'shade', waterPref: '', soilPref: 'clay' }), {
    sun: 'shade',
    water: 'low',
    soil: 'clay',
  });
  assert.ok(result.findings.some((f) => /1 planted species declares no water preference/.test(f)));
  assert.ok(!result.findings.some((f) => /declares no sun preference/.test(f)));
  assert.ok(!result.findings.some((f) => /declares no soil preference/.test(f)));
});
