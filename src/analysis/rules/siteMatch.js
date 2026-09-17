import { STATUSES } from '../ecology.js';
import { SITE_VOCABULARY } from '../../data/projectConfig.js';

/**
 * Rule 8 — every plant here should want the ground this yard actually has.
 *
 * READ THIS BEFORE CHANGING THE COMPARATOR. The direction has been wrong once
 * already: commit ed9d75c ("Fix inverted sun_pref: Low/Medium/High is light
 * requirement") fixed exactly this inversion. `sun_pref` is a LIGHT REQUIREMENT,
 * not a shade tolerance — little bluestem, Indiangrass and switchgrass are
 * `full-sun` because they need a lot of light; Carex blanda and inland sea oats
 * are `shade` because they need little.
 *
 * So this is NOT a distance. The two directions fail differently and the copy
 * has to say which:
 *
 *   plant needs MORE light than the site gives  -> it will not bloom, or it will
 *       flop reaching for light. Real at one step, hard at two.
 *   plant needs LESS light than the site gives  -> scorch. Mild at one step (a
 *       part-sun plant in a full-sun yard is usually fine), real at two (a shade
 *       sedge in full sun is not).
 *
 * `water_pref` is a requirement in the same way, and both of ITS directions are
 * real: a high-water plant on a low-water site droughts out, a low-water plant
 * on a high-water site rots. Different failures, different sentences.
 *
 * Soil is set membership, not a scale — clay is not "more" than sandy.
 *
 * **Soil mismatches are CAUTIONS, not failures, and deliberately do not drive
 * the status.** `soil_pref` holds one PREFERRED soil; the catalog records no
 * tolerance at all. Most North Central Texas natives grow across a range, so a
 * plant that prefers sandy on a clay site is very often fine — just shorter-lived,
 * or wanting sharper drainage. Reporting that at the same weight as a real
 * failure made this check punitive and taught the reader to ignore it. Until the
 * catalog carries tolerance (USDA's soil_coarse/medium/fine triple would give it;
 * see the data-collection epic), an unknown is reported as an unknown.
 */

const SUN = SITE_VOCABULARY.sun; // shade < part-sun < full-sun
const WATER = SITE_VOCABULARY.water; // low < medium < high

const SUN_LABEL = { shade: 'shade', 'part-sun': 'part sun', 'full-sun': 'full sun' };

export default {
  id: 'site-match',
  title: 'Site match',

  evaluate(ctx) {
    if (!ctx.site) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary:
          'This project declares no site conditions, so there is nothing to check each plant against.',
        findings: ['Add a "site" block to project.json with sun, water, and soil.'],
      };
    }
    if (!ctx.placedSpecies.length) {
      return { status: STATUSES.NOT_DECLARED, summary: 'Nothing is planted yet.' };
    }

    const problems = [];
    const cautions = [];
    // A plant that declares no preference on an axis the site DOES declare must
    // not read as a silent match — that is the failure this rule exists to
    // avoid (see nl-c58). Counted per axis and reported, the same way rule 4/10
    // excludes and reports plants with no declared width rather than guessing.
    const plantUndeclared = { sun: 0, water: 0, soil: 0 };
    const plantsNotFullyChecked = new Set();
    ctx.placedSpecies.forEach((plant) => {
      const name = `${plant.commonName} (${plant.botanicalName})`;
      const checked = [];
      if (ctx.site.sun && !declaresAxis(plant.sunPref)) {
        plantUndeclared.sun += 1;
        plantsNotFullyChecked.add(name);
      } else checked.push(checkSun(plant, ctx.site.sun));
      if (ctx.site.water && !declaresAxis(plant.waterPref)) {
        plantUndeclared.water += 1;
        plantsNotFullyChecked.add(name);
      } else checked.push(checkWater(plant, ctx.site.water));
      if (ctx.site.soil && !declaresAxis(plant.soilPref)) {
        plantUndeclared.soil += 1;
        plantsNotFullyChecked.add(name);
      } else checked.push(checkSoil(plant, ctx.site.soil));
      checked
        .filter(Boolean)
        .map((problem) => ({ ...problem, text: `${name} ${problem.text}` }))
        .forEach((problem) => (problem.severity === 'caution' ? cautions : problems).push(problem));
    });

    const undeclared = Object.keys(SITE_VOCABULARY).filter((key) => !ctx.site[key]);
    const findings = problems.map((problem) => problem.text);
    if (cautions.length) {
      findings.push(
        `Worth watching, but not counted against the design — the catalog records a preferred soil and no tolerance, so these are unknowns rather than known mismatches:`
      );
      findings.push(...cautions.map((caution) => `  ${caution.text}`));
    }
    if (undeclared.length) {
      findings.push(
        `The site declares no ${undeclared.join(' or ')}, so that was not checked.`
      );
    }
    Object.entries(plantUndeclared)
      .filter(([, count]) => count > 0)
      .forEach(([axis, count]) => {
        findings.push(
          `${count} planted species declare${count === 1 ? 's' : ''} no ${axis} preference and ${
            count === 1 ? 'was' : 'were'
          } not checked against this site's ${axis}.`
        );
      });
    if (!problems.length) {
      findings.unshift(
        `No planted species is mismatched to the light or water this site offers (${describeSite(ctx.site)}).`
      );
    }

    const hard = problems.filter((problem) => problem.severity === 'hard');
    const status = hard.length ? STATUSES.GAP : problems.length ? STATUSES.PARTIAL : STATUSES.OK;
    // "Every planted species matches" is a claim about axes that were actually
    // checked. If some plants declare no preference on an axis the site does
    // declare, that claim is false even when zero problems were found — this
    // exact overclaim is what nl-c58 named as the worst case, because it was the
    // headline the panel shows without expanding details.
    const summary = hard.length
      ? `${hard.length} planted species ${hard.length === 1 ? 'is' : 'are'} badly mismatched to this site.`
      : problems.length
        ? `${problems.length} planted species ${problems.length === 1 ? 'sits' : 'sit'} slightly off what this site offers.`
        : plantsNotFullyChecked.size
          ? `No known mismatch, but ${plantsNotFullyChecked.size} planted species ${
              plantsNotFullyChecked.size === 1 ? 'declares' : 'declare'
            } no preference on one or more axes and could not be fully checked — see details.`
          : `Every planted species matches the declared site (${describeSite(ctx.site)}).`;

    return { status, summary, findings, suggestions: [] };
  },
};

function declaresAxis(value) {
  return Boolean(String(value || '').trim());
}

/** Positive: the plant wants MORE than the site gives. Negative: less. */
function step(scale, want, have) {
  const wantIdx = scale.indexOf(want);
  const haveIdx = scale.indexOf(have);
  if (wantIdx === -1 || haveIdx === -1) return null;
  return wantIdx - haveIdx;
}

function checkSun(plant, siteSun) {
  if (!siteSun) return null;
  const delta = step(SUN, String(plant.sunPref || '').toLowerCase(), siteSun);
  if (delta === null || delta === 0) return null;
  const wants = SUN_LABEL[plant.sunPref] || plant.sunPref;
  const has = SUN_LABEL[siteSun] || siteSun;
  if (delta > 0) {
    // Needs more light than there is: it will not bloom, or it will flop reaching.
    return {
      severity: delta >= 2 ? 'hard' : 'real',
      text: `wants ${wants} but this site gives ${has} — too little light: expect weak bloom and stems flopping toward it.`,
    };
  }
  return {
    severity: delta <= -2 ? 'hard' : 'mild',
    text:
      delta <= -2
        ? `wants ${wants} but this site gives ${has} — far too much light: expect scorched, bleached foliage.`
        : `wants ${wants} but this site gives ${has} — a little more light than it asks for, usually fine here.`,
  };
}

function checkWater(plant, siteWater) {
  if (!siteWater) return null;
  const delta = step(WATER, String(plant.waterPref || '').toLowerCase(), siteWater);
  if (delta === null || delta === 0) return null;
  if (delta > 0) {
    return {
      severity: delta >= 2 ? 'hard' : 'real',
      text: `wants ${plant.waterPref} water on a ${siteWater}-water site — it will drought out without irrigation.`,
    };
  }
  return {
    severity: delta <= -2 ? 'hard' : 'real',
    text: `wants ${plant.waterPref} water on a ${siteWater}-water site — the ground stays wetter than its roots tolerate: expect rot.`,
  };
}

/**
 * A compound soil texture sits between its named components, so a plant
 * listed against one also takes a site declared as either half (nl-5c8):
 * 'clay-loam' read as one token never matched a 'clay' site, raising a
 * caution against a plant that is fine there. SITE_VOCABULARY's soil list is
 * short; add here as regional CSVs bring more compound textures.
 */
const SOIL_COMPOUND_EQUIVALENTS = Object.freeze({
  'clay-loam': Object.freeze(['clay', 'loamy']),
});

/** Soil is set membership: a plant lists the soils it will take, comma separated. */
function checkSoil(plant, siteSoil) {
  if (!siteSoil) return null;
  const listed = String(plant.soilPref || '')
    .toLowerCase()
    .split(/[,/|]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const accepted = listed.flatMap((value) => [value, ...(SOIL_COMPOUND_EQUIVALENTS[value] || [])]);
  if (!accepted.length || accepted.includes(siteSoil)) return null;
  return {
    severity: 'caution',
    text: `prefers ${listed.join(' or ')} soil on a ${siteSoil} site — many natives take a wider range than the catalog records, so expect a smaller or shorter-lived plant rather than a failure, and give it sharper drainage if you can.`,
  };
}

function describeSite(site) {
  return Object.keys(SITE_VOCABULARY)
    .filter((key) => site[key])
    .map((key) => `${site[key]} ${key === 'sun' ? '' : key}`.trim())
    .join(', ');
}
