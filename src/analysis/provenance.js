/**
 * How much weight a claim's source carries — as a field, not as prose.
 *
 * The ecology tables record `source` as free text, and it currently holds
 * "nwf-ecoregion-9", "globalbioticinteractions.org, fetched 2026-09-13" and
 * "Wikipedia, Danaus plexippus" at identical visual weight. For an audience of
 * Master Naturalists the tier IS the information: a page citation in the
 * regional flora and a Wikipedia article are not the same kind of claim, and
 * rendering them the same way invites exactly the objection this project is
 * trying to earn its way past.
 *
 * Four tiers, strongest first. The ordering is a judgement about
 * REGIONAL AUTHORITY, not about scientific quality in general — GloBI is an
 * excellent aggregator and still ranks below the flora here, because the
 * question is always "is this true in North Central Texas".
 */
export const TIERS = Object.freeze({
  'primary-flora': {
    rank: 1,
    label: 'Regional flora',
    short: 'FNCT',
    note: 'Shinners & Mahler\'s Illustrated Flora of North Central Texas (Diggs, Lipscomb & O\'Kennon 1999), cited to the page. The botanical authority for this region.',
  },
  'agency-database': {
    rank: 2,
    label: 'Agency dataset',
    short: 'Agency',
    note: 'A government or national-organisation dataset (USDA PLANTS, NWF Native Plant Finder). Authoritative, but keyed to units far larger than a city.',
  },
  aggregator: {
    rank: 3,
    label: 'Aggregated records',
    short: 'Aggregate',
    note: 'Occurrence and interaction records pooled from many contributors (GloBI, iNaturalist). Broad coverage, uneven provenance, observer bias.',
  },
  tertiary: {
    rank: 4,
    label: 'Tertiary source',
    short: 'Tertiary',
    note: 'An encyclopaedia or secondary summary. Kept only where nothing better was found, and flagged so it can be replaced.',
  },
});

export const UNKNOWN_TIER = Object.freeze({
  rank: 5,
  label: 'Unattributed',
  short: 'None',
  note: 'No source recorded. Treat as a claim nobody has stood behind yet.',
});

/**
 * Classify a free-text `source` string.
 *
 * A fallback, not the preferred path: a table that can carry an explicit
 * `source_tier` column should, so the tier is data rather than the result of
 * matching substrings. This exists because three tables already in the repo
 * record only prose, and because a new row can always arrive with a source
 * nobody has taught this function about — which is what UNKNOWN_TIER is for.
 * It never guesses upward: an unrecognised source is unattributed, not
 * tertiary.
 */
export function classifySource(source) {
  const text = String(source || '').toLowerCase();
  if (!text.trim()) return 'unknown';
  if (/\bfnct\b|diggs|shinners|illustrated flora|appendix ten/.test(text)) return 'primary-flora';
  if (/\bnwf\b|native plant finder|usda|plants\.usda|ecoregion-\d/.test(text)) return 'agency-database';
  if (/globalbioticinteractions|globi|inaturalist|gbif|api\./.test(text)) return 'aggregator';
  if (/wikipedia|xerces|via wikipedia/.test(text)) return 'tertiary';
  return 'unknown';
}

/** @param {string} tierKey */
export function tierInfo(tierKey) {
  return TIERS[tierKey] || UNKNOWN_TIER;
}

/** Sort helper: strongest provenance first, then by whatever the caller passes. */
export function byTier(a, b) {
  return tierInfo(a).rank - tierInfo(b).rank;
}

/**
 * The strongest tier among several sources — what a row backed by both the
 * flora and an aggregator should be badged with. Returns 'unknown' for none.
 */
export function bestTier(tierKeys) {
  let best = 'unknown';
  for (const key of tierKeys) {
    if (tierInfo(key).rank < tierInfo(best).rank) best = key;
  }
  return best;
}
