import { parseCsv } from '../data/csvLoader.js';
import { normalizeGenus } from './hostGenera.js';
import { classifySource, bestTier, tierInfo } from './provenance.js';

/**
 * Assemble the screened keystone table: for one plant genus, what the
 * continental keystone list claims, what the regional flora actually says, and
 * which of the flora's animals are confirmed near this site.
 *
 * The argument this table exists to make is a DISAGREEMENT between sources.
 * NWF's Native Plant Finder is keyed to EPA Level I ecoregion 9, which runs
 * from Texas to the Canadian aspen parkland; it therefore recommends Betula,
 * Larix, Tsuga, Abies and Picea for a Blackland Prairie yard. The flora is the
 * screen: where the two disagree the flora wins, and the rejects are shown as
 * rejects rather than quietly dropped, because a screened list whose failures
 * are visible is easier to trust — and to correct — than a clean one.
 *
 * Five inputs, deliberately kept separate rather than pre-joined into one file
 * so each keeps its own provenance:
 *   host-genera.csv             NWF counts               agency
 *   fnct-genus-screen.csv       does the flora treat it  primary
 *   fnct-lepidoptera-hosts.csv  named larval hosts       primary
 *   nearby-fauna.csv            what is actually here    aggregator
 *   the plant catalog           growth habit and height  agency (USDA)
 */

/** Coarsest-to-finest, so a genus with both Tree and Shrub species reads as Tree. */
const HABIT_ORDER = ['Tree', 'Shrub', 'Subshrub', 'Vine', 'Graminoid', 'Forb/herb'];

/**
 * Growth-habit tiers, which is the axis a participant actually chooses along:
 * how much room they have. Ordered by the space a mature specimen claims.
 */
export const GROWTH_TIERS = Object.freeze({
  Tree: { label: 'Canopy tree', order: 1, room: 'Needs a yard' },
  Shrub: { label: 'Shrub / small tree', order: 2, room: 'Needs a corner' },
  Subshrub: { label: 'Subshrub', order: 3, room: 'Needs a bed' },
  Vine: { label: 'Vine', order: 4, room: 'Needs a fence' },
  Graminoid: { label: 'Grass / sedge', order: 5, room: 'Fits a strip' },
  'Forb/herb': { label: 'Forb', order: 6, room: 'Fits anywhere' },
});

/**
 * Height above which a woody plant is a canopy tree here regardless of what
 * USDA's growth-habit field says.
 *
 * USDA PLANTS files Celtis laevigata and Prunus serotina as "Shrub" and then
 * gives both a mature height of 80 ft. An 80-foot shrub is not a thing, and
 * printing one in front of Master Naturalists spends credibility on somebody
 * else's data-entry decision. Height is a measurement and habit is a
 * category, so where they contradict each other the measurement wins.
 *
 * This is an authored judgement, not a fact from any source, which is why
 * `resolveGrowthTier` reports `conflict` — the UI shows the disagreement and
 * whose call it was, instead of quietly presenting the corrected value.
 */
export const CANOPY_HEIGHT_FT = 25;

/**
 * The growth tier to plant against, plus whether it disagrees with USDA.
 * Vines, grasses and forbs are taken at their habit: a 16-ft passionflower is
 * a vine, and height says nothing useful about it.
 */
export function resolveGrowthTier(habit, heightFt) {
  const woody = habit === 'Shrub' || habit === 'Subshrub';
  if (woody && Number.isFinite(heightFt) && heightFt >= CANOPY_HEIGHT_FT) {
    return {
      habit: 'Tree',
      usdaHabit: habit,
      conflict: `USDA PLANTS files this as ${habit} and also gives it ${heightFt} ft. Calling it a canopy tree is my read of the height, not USDA's classification.`,
    };
  }
  return { habit, usdaHabit: habit, conflict: '' };
}

const animalKey = (name) =>
  String(name || '').trim().toLowerCase().split(/\s+/).slice(0, 2).join(' ');

/** @returns {Map<string, {treated: boolean, page: string, heading: string, dallas: boolean, dallasEvidence: string}>} */
export function buildFnctScreenIndex(csvText) {
  const byGenus = new Map();
  parseCsv(csvText || '').forEach((row) => {
    const genus = String(row.genus || '').trim();
    if (!genus) return;
    byGenus.set(normalizeGenus(genus), {
      genus,
      treated: row.fnct_treated === 'yes',
      page: String(row.fnct_page || '').trim(),
      heading: String(row.fnct_heading || '').trim(),
      dallas: row.fnct_dallas_record === 'yes',
      dallasEvidence: String(row.fnct_dallas_evidence || '').trim(),
      source: String(row.source || '').trim(),
    });
  });
  return byGenus;
}

/**
 * Genera the flora carries under a different name.
 *
 * Without this, Symphyotrichum reads as "not in the flora" alongside larch and
 * spruce — and every aster in North Central Texas grows in Dallas, so that is
 * the one row in the table a room full of Master Naturalists would reject on
 * sight. FNCT is explicit about it: it acknowledges the segregation and keeps
 * the plants under Aster pending consensus. That is a 1999 nomenclature
 * decision, not an absence, and the two must not render the same way.
 *
 * Curated and sourced, deliberately: this is a small set of known 1999-to-now
 * changes, not an attempt at general synonymy.
 *
 * @returns {Map<string, {fnctGenus: string, note: string, source: string}>}
 */
export function buildNameChangeIndex(csvText) {
  const byGenus = new Map();
  parseCsv(csvText || '').forEach((row) => {
    const current = String(row.current_genus || '').trim();
    const fnct = String(row.fnct_genus || '').trim();
    if (!current || !fnct) return;
    byGenus.set(normalizeGenus(current), {
      fnctGenus: fnct,
      note: String(row.note || '').trim(),
      source: String(row.source || '').trim(),
    });
  });
  return byGenus;
}

/** @returns {Map<string, Array<object>>} plant genus -> its Appendix Ten records */
export function buildLepHostIndex(csvText) {
  const byGenus = new Map();
  parseCsv(csvText || '').forEach((row) => {
    const genus = String(row.plant_genus || '').trim();
    if (!genus) return;
    const key = normalizeGenus(genus);
    if (!byGenus.has(key)) byGenus.set(key, []);
    byGenus.get(key).push({
      plant: String(row.plant || '').trim(),
      section: String(row.section || '').trim(),
      common: String(row.lep_common || '').trim(),
      species: String(row.lep_species || '').trim(),
      nameInferred: row.name_inferred === 'yes',
      groupingNote: String(row.grouping_note || '').trim(),
      page: String(row.fnct_page || '').trim(),
      source: String(row.source || '').trim(),
    });
  });
  return byGenus;
}

/**
 * Growth habit and mature height per genus, from the catalog's USDA columns.
 *
 * **Height, not footprint, and that is a real limitation.** The argument for
 * mixing growth forms is that a canopy oak and a forb differ by orders of
 * magnitude in the caterpillar biomass they can carry, and biomass tracks
 * volume far better than it tracks stem count. Canopy WIDTH is what that
 * calculation would need, and the 469-row catalog has it for none of them
 * (plants.csv carries width for its 56, which is not this list). Deriving a
 * width from a height would be inventing the number the whole argument turns
 * on, so this reports the height the catalog actually holds and the growth
 * tier, and leaves the weighting to the reader.
 */
export function buildGrowthIndex(csvText) {
  const byGenus = new Map();
  parseCsv(csvText || '').forEach((row) => {
    const botanical = String(row.botanical_name || '').trim();
    const genus = botanical.split(/\s+/)[0];
    if (!genus) return;
    const key = normalizeGenus(genus);
    const habit = String(row.usda_growth_habit || '').trim();
    const height = Number(row.usda_height_mature_ft || row.height_ft || '');
    const existing = byGenus.get(key);
    const rank = HABIT_ORDER.indexOf(habit);
    if (!existing) {
      byGenus.set(key, {
        genus,
        habit,
        habitRank: rank < 0 ? HABIT_ORDER.length : rank,
        maxHeightFt: Number.isFinite(height) ? height : null,
        speciesCount: 1,
        examples: [botanical],
      });
      return;
    }
    existing.speciesCount += 1;
    if (existing.examples.length < 4) existing.examples.push(botanical);
    if (rank >= 0 && rank < existing.habitRank) {
      existing.habit = habit;
      existing.habitRank = rank;
    }
    if (Number.isFinite(height) && (existing.maxHeightFt === null || height > existing.maxHeightFt)) {
      existing.maxHeightFt = height;
    }
  });
  return byGenus;
}

/**
 * One row per genus in `hostGenera`, plus any genus the flora's own host table
 * names that NWF never listed — Celtis is the reason that clause exists.
 *
 * @returns {Array<object>} sorted: flora-backed and locally confirmed first
 */
export function screenKeystoneGenera({
  hostGenera,
  fnctScreen,
  lepHosts,
  growth,
  nearbyFauna,
  place,
  nameChanges = new Map(),
}) {
  const nearby = nearbyFauna?.forPlace ? nearbyFauna.forPlace(place) : new Map();
  const genera = new Set();
  hostGenera?.byGenus?.forEach((row, key) => genera.add(key));
  lepHosts.forEach((_rows, key) => genera.add(key));

  const rows = [];
  genera.forEach((key) => {
    const nwf = hostGenera?.lookup ? hostGenera.lookup(key) : null;
    let flora = fnctScreen.get(key) || null;
    // Resolve through a known name change only when the genus's own name draws
    // a blank, so a genus the flora treats directly always answers for itself.
    let renamed = null;
    if (!flora?.treated) {
      const change = nameChanges.get(key);
      const under = change ? fnctScreen.get(normalizeGenus(change.fnctGenus)) : null;
      if (under?.treated) {
        renamed = { ...change, page: under.page, heading: under.heading };
        flora = under;
      }
    }
    const hosts = lepHosts.get(key) || [];
    const size = growth.get(key) || null;
    const resolved = size ? resolveGrowthTier(size.habit, size.maxHeightFt) : null;

    // Which of the flora's named lepidopterans are recorded near this site.
    const seen = new Set();
    const confirmed = [];
    hosts.forEach((host) => {
      const local = nearby.get(animalKey(host.species));
      if (!local) return;
      if (seen.has(host.species)) return;
      seen.add(host.species);
      confirmed.push({
        ...host,
        nearestRadiusMi: local.nearestRadiusMi,
        establishmentMeans: local.establishmentMeans,
        observationCount: local.observationCount,
      });
    });
    confirmed.sort((a, b) => a.nearestRadiusMi - b.nearestRadiusMi);

    const tiers = [];
    if (flora?.treated) tiers.push('primary-flora');
    if (hosts.length) tiers.push(classifySource(hosts[0].source));
    if (nwf) tiers.push(classifySource(nwf.source));
    if (confirmed.length) tiers.push('aggregator');

    rows.push({
      genus: nwf?.genus || flora?.genus || hosts[0]?.plant.split(/\s+/)[0] || key,
      genusKey: key,
      // What NWF claims
      lepHostSpecies: nwf?.lepHostSpecies ?? null,
      beeSpecialistSpecies: nwf?.beeSpecialistSpecies ?? null,
      nwfSource: nwf?.source || '',
      curatedLarvalHosts: nwf?.larvalHosts || '',
      // What the flora says
      fnctTreated: Boolean(flora?.treated),
      fnctUnderName: renamed ? renamed.fnctGenus : '',
      renamedNote: renamed ? renamed.note : '',
      renamedSource: renamed ? renamed.source : '',
      fnctPage: flora?.page || '',
      fnctHeading: flora?.heading || '',
      fnctDallas: Boolean(flora?.dallas),
      fnctDallasEvidence: flora?.dallasEvidence || '',
      // Named larval hosts from the flora's own appendix
      lepHosts: hosts,
      lepHostCount: new Set(hosts.map((h) => h.species)).size,
      lepHostPages: [...new Set(hosts.map((h) => h.page))].sort(),
      // Confirmed nearby
      confirmedNearby: confirmed,
      confirmedCount: confirmed.length,
      // Space budget
      habit: resolved?.habit || '',
      usdaHabit: resolved?.usdaHabit || '',
      habitConflict: resolved?.conflict || '',
      growthTier: GROWTH_TIERS[resolved?.habit] || null,
      maxHeightFt: size?.maxHeightFt ?? null,
      catalogSpecies: size?.speciesCount || 0,
      catalogExamples: size?.examples || [],
      // **Whether this is a RECOMMENDATION or merely a record.** Appendix Ten
      // documents what Lepidoptera were observed using, which includes plants
      // nobody should plant: Stenotaphrum (St. Augustine turf grass), Daucus,
      // Trifolium and Sisymbrium all carry confirmed local butterflies. The
      // clouded skipper really does use St. Augustine, and saying so to a
      // native plant society as though it were advice would be the single
      // worst error this page could make. The native catalog
      // (blackland-prairie-natives.csv) is the screen that separates the two,
      // and the UI must never present a genus it does not carry as a planting
      // suggestion.
      inCatalog: Boolean(size),
      // Provenance
      tier: bestTier(tiers),
      tierInfo: tierInfo(bestTier(tiers)),
      // The verdict this table exists to deliver
      verdict: renamed ? 'renamed' : verdictFor({ flora, hosts, confirmed, nwf }),
    });
  });

  return rows.sort(
    (a, b) =>
      b.confirmedCount - a.confirmedCount ||
      b.lepHostCount - a.lepHostCount ||
      (a.growthTier?.order ?? 9) - (b.growthTier?.order ?? 9) ||
      a.genus.localeCompare(b.genus)
  );
}

/**
 * Four verdicts, each a statement about EVIDENCE rather than about the plant.
 * "rejected" is the one that does the work: it is what the continental list
 * recommends and the regional flora does not carry.
 */
export function verdictFor({ flora, hosts, confirmed, nwf }) {
  if (!flora?.treated) {
    return nwf ? 'rejected' : 'unscreened';
  }
  if (confirmed.length) return 'confirmed-local';
  if (hosts.length) return 'flora-hosts';
  return 'in-flora';
}

export const VERDICTS = Object.freeze({
  'confirmed-local': {
    label: 'Confirmed here',
    note: 'The flora treats it, names larval hosts for it, and at least one of those animals is recorded near this site.',
  },
  'flora-hosts': {
    label: 'Flora-cited hosts',
    note: 'The flora treats it and names larval hosts, but none of those animals has turned up near this site in the local records.',
  },
  'in-flora': {
    label: 'In the flora',
    note: 'The flora treats it, but its host-plant appendix names no Lepidoptera for it.',
  },
  renamed: {
    label: 'Renamed since 1999',
    note: 'The flora carries these plants under an older genus name. Present here, not absent — the keystone list and the 1999 flora simply disagree about what to call them.',
  },
  rejected: {
    label: 'Not in the flora',
    note: 'On the continental keystone list, but the regional flora gives it no treatment. Recommending it here would be a mistake.',
  },
  unscreened: {
    label: 'Unscreened',
    note: 'Named by the flora\'s host table but absent from the keystone list, and not screened as a keystone genus.',
  },
});
