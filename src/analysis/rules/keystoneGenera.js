import { STATUSES } from '../ecology.js';
import { getGenus } from '../../utils/speciesKey.js';

/**
 * Rules 4 and 10 — plant the keystone genera for this ecoregion, and give them
 * real space rather than one token specimen.
 *
 * They are one rule because they are one question asked twice: rule 4 asks
 * whether the genera are present at all, rule 10 asks whether the yard's area is
 * actually invested in them. Reporting them apart would let a design pass rule 4
 * on a single plant while nothing else changed.
 *
 * **Space, not head-count.** A yard is a budget of ground, and a keystone oak
 * feeding 253 caterpillar species earns its footprint in a way a keystone
 * perennial planted once does not. So the ratio is over footprint area,
 * pi*(width/2)^2.
 *
 * A weak score here is the expected result, not a bug: only six of the catalog's
 * 42 genera are keystone in ecoregion 9 and none of them are woody. The copy
 * reads as a gap to close.
 */
const AMPLE_SHARE = 0.25;
const SOME_SHARE = 0.1;

export default {
  id: 'keystone-genera',
  title: 'Keystone genera',

  evaluate(ctx) {
    if (!ctx.ecoregion || !ctx.hostGenera.size) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: ctx.ecoregion
          ? 'The keystone genus table did not load, so this check could not run.'
          : 'This project declares no ecoregion, and the keystone lists are per ecoregion.',
      };
    }
    if (!ctx.plants.length) {
      return { status: STATUSES.NOT_DECLARED, summary: 'Nothing is planted yet.' };
    }

    const present = [...ctx.placedGenera]
      .map((genus) => ({ genus, row: ctx.hostGenera.lookup(genus) }))
      .filter(({ row }) => row && (row.lepHostSpecies !== null || row.beeSpecialistSpecies !== null))
      .sort((a, b) => rank(b.row) - rank(a.row));
    const keystoneNames = new Set(present.map(({ genus }) => genus));

    const { keystoneArea, totalArea, excluded } = measureArea(ctx, keystoneNames);
    const share = totalArea > 0 ? keystoneArea / totalArea : 0;

    const findings = [];
    findings.push(
      present.length
        ? `Keystone genera planted: ${present.map(({ genus, row }) => `${genus} (${describeRow(row)})`).join(', ')}.`
        : `No planted genus is on the ecoregion ${ctx.ecoregion} keystone lists.`
    );
    if (totalArea > 0) {
      findings.push(
        `${Math.round(share * 100)}% of the planted footprint (${round(keystoneArea)} of ${round(totalArea)} sq ft) sits in keystone genera.`
      );
    }
    if (excluded) {
      // createPlantFromSpecies defaults width to 1, so a species with a blank
      // width_ft would quietly contribute 1 sq ft — harmless for a perennial,
      // badly wrong for a tree. Such plants are dropped from BOTH sides of the
      // ratio rather than counted at a made-up size.
      findings.push(
        `${excluded} plant${excluded === 1 ? ' declares' : 's declare'} no width and ${excluded === 1 ? 'is' : 'are'} left out of the area figures entirely.`
      );
    }

    // The share can look healthy while the yard still misses the genera that
    // carry the most life. Only six of the catalog's 42 genera are keystone in
    // ecoregion 9 and NONE of them are woody — no Quercus (253 caterpillar
    // species), no Prunus, no Salix — so this gap cannot be closed from the
    // catalog at all, and saying so is more use than a percentage.
    const absent = topAbsent(ctx, keystoneNames);
    if (absent.length) {
      findings.push(
        `The heaviest-hitting keystone genera for this ecoregion are still missing, and the catalog carries no species in them: ${absent
          .map((row) => `${row.genus} (${row.lepHostSpecies} caterpillar species)`)
          .join(', ')}.`
      );
    }

    const status = !present.length
      ? STATUSES.GAP
      : share >= AMPLE_SHARE
        ? STATUSES.OK
        : share >= SOME_SHARE
          ? STATUSES.PARTIAL
          : STATUSES.GAP;

    const summary = !present.length
      ? `Nothing planted here is a keystone genus for ecoregion ${ctx.ecoregion} — the genera that carry the most insect life are missing.`
      : share >= AMPLE_SHARE
        ? `Keystone genera hold ${Math.round(share * 100)}% of the planted footprint.`
        : `${present.length} keystone gen${present.length === 1 ? 'us is' : 'era are'} present but hold only ${Math.round(share * 100)}% of the planted footprint.`;

    return { status, summary, findings, suggestions: suggest(ctx, keystoneNames) };
  },
};

/**
 * Footprint area on both sides of the ratio, skipping any plant whose species
 * declares no width. Excluding rather than defaulting is the point: a defaulted
 * width does not just add noise, it moves the ratio in whichever direction the
 * undeclared plant happens to fall on.
 */
function measureArea(ctx, keystoneNames) {
  let keystoneArea = 0;
  let totalArea = 0;
  let excluded = 0;
  ctx.plants.forEach((plant) => {
    const declared = ctx.species.find((entry) => entry.botanicalKey === plant.botanicalKey);
    const width = Number(declared?.width);
    if (!(width > 0)) {
      excluded += 1;
      return;
    }
    const area = Math.PI * (width / 2) ** 2;
    totalArea += area;
    if (keystoneNames.has(getGenus(plant))) keystoneArea += area;
  });
  return { keystoneArea, totalArea, excluded };
}

function suggest(ctx, keystoneNames, limit = 4) {
  return ctx.unplacedSpecies
    .map((entry) => ({ entry, genus: getGenus(entry), row: ctx.hostGenera.lookup(getGenus(entry)) }))
    .filter(
      ({ genus, row }) =>
        row && !keystoneNames.has(genus) && (row.lepHostSpecies !== null || row.beeSpecialistSpecies !== null)
    )
    .sort((a, b) => rank(b.row) - rank(a.row))
    .slice(0, limit)
    .map(
      ({ entry, genus, row }) =>
        `${entry.commonName} (${entry.botanicalName}) brings the keystone genus ${genus} — ${describeRow(row)}.`
    );
}

/**
 * The top keystone genera this ecoregion wants that the CATALOG cannot supply —
 * a different kind of finding from "you did not plant it", and the one that
 * actually explains why both shipped projects are thin on woody keystones.
 */
function topAbsent(ctx, keystoneNames, limit = 3) {
  const catalogGenera = new Set(ctx.species.map((entry) => getGenus(entry)));
  return [...ctx.hostGenera.byGenus.values()]
    .filter(
      (row) =>
        row.lepHostSpecies !== null && !keystoneNames.has(row.genus) && !catalogGenera.has(row.genus)
    )
    .sort((a, b) => b.lepHostSpecies - a.lepHostSpecies)
    .slice(0, limit);
}

/** Caterpillars are the currency birds feed on, so the lep count leads the ranking. */
function rank(row) {
  return (row.lepHostSpecies ?? 0) * 2 + (row.beeSpecialistSpecies ?? 0);
}

function describeRow(row) {
  const parts = [];
  if (row.lepHostSpecies !== null) parts.push(`${row.lepHostSpecies} caterpillar species`);
  if (row.beeSpecialistSpecies !== null) parts.push(`${row.beeSpecialistSpecies} specialist bees`);
  const listed = row.resolvedFrom ? ` — listed as ${row.resolvedFrom}` : '';
  return `${parts.join(', ')}${listed}`;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
