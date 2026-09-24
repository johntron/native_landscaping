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
 * **A mismatch against a single-value `soil_pref` is a CAUTION, not a
 * failure, and deliberately does not drive the status.** `nl-9a6` measured
 * that USDA's soil_coarse/medium/fine triple exists for only 23 of
 * `plants.csv`'s 56 species (the rest have no USDA characteristics record at
 * all, not a fetch failure — USDA covers ~2,200 species nationwide). For
 * those 23, `soil_pref` is a real measured accepted SET and a mismatch against
 * it is reported at the same weight as sun/water (see below). For everything
 * else, `soil_pref` still holds one PREFERRED soil with no tolerance data —
 * most North Central Texas natives grow across a range, so a plant that
 * prefers sandy on a clay site is very often fine, just shorter-lived or
 * wanting sharper drainage. Reporting that at real-failure weight made this
 * check punitive and taught the reader to ignore it, so an unknown is still
 * reported as an unknown until more of the catalog gets measured data.
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
      if (ctx.site.soil && !soilList(plant).length) {
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

/**
 * The soils a plant takes, as src/data/plantParser.js parsed them: an array
 * of SITE_VOCABULARY soils, split and checked once there (nl-3s5.21), never
 * re-split here. Anything else (a legacy snapshot whose species left the
 * catalog still carries the old string) counts as undeclared, which the rule
 * reports rather than guessing at.
 * @returns {string[]}
 */
function soilList(plant) {
  return Array.isArray(plant.soilPref) ? plant.soilPref : [];
}

/**
 * Soil is set membership: a plant lists the soils it will take. A
 * multi-value `soil_pref` is a MEASURED accepted set (nl-9a6: USDA's
 * soil_coarse/medium/fine triple) — a mismatch against it is a real gap,
 * same weight as sun/water. A single value is still just a preference with no
 * tolerance data behind it, so a mismatch there stays a caution (see the
 * comment atop this file).
 */
function checkSoil(plant, siteSoil) {
  if (!siteSoil) return null;
  const listed = soilList(plant);
  const measured = listed.length > 1;
  const accepted = listed.flatMap((value) => [value, ...(SOIL_COMPOUND_EQUIVALENTS[value] || [])]);
  if (!accepted.length || accepted.includes(siteSoil)) return null;
  if (measured) {
    return {
      severity: 'real',
      text: `takes ${listed.join(' or ')} soil, not the ${siteSoil} this site has — expect it to struggle.`,
    };
  }
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

/**
 * The same sun/water/soil comparators this rule grades placed plants with,
 * exposed so a SUGGESTION (rule 4's keystone genera, rule 5's larval hosts)
 * can be graded before it is ever offered — recommending a plant this site
 * will scorch or drought is not a smaller version of the mistake, it is the
 * same mistake one step earlier. Returns the raw problem list (empty when
 * the candidate is a clean fit, or when the project declares no site).
 */
export function siteFitProblems(plant, site) {
  if (!site) return [];
  return [checkSun(plant, site.sun), checkWater(plant, site.water), checkSoil(plant, site.soil)].filter(
    Boolean
  );
}

/**
 * Rank candidates so a clean site fit always beats a mismatch, however good
 * the ecological number on the mismatch is — a recommendation panel that
 * ranks a full-sun plant above a part-sun one on a part-sun site teaches the
 * reader to ignore the site-match check entirely. Only when there are not
 * enough clean candidates to fill `limit` do flawed ones fill the rest, so a
 * genus the catalog can only offer through a mismatched species still gets
 * surfaced — with the caveat attached — rather than silently dropped.
 */
export function pickSiteAware(candidates, rank, limit) {
  const bySeverity = (list) => [...list].sort((a, b) => rank(b) - rank(a));
  const clean = bySeverity(candidates.filter((c) => !c.problems.length));
  const flawed = bySeverity(candidates.filter((c) => c.problems.length));
  return [...clean, ...flawed].slice(0, limit);
}

/** " This is a partial match: it wants full sun but this site gives part sun — ..." or '' for a clean fit. */
export function describeSiteFit(problems) {
  if (!problems.length) return '';
  const joined = problems.map((problem) => `it ${problem.text}`).join('; ');
  return ` This is a partial match: ${joined}`;
}
