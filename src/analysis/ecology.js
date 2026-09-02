import { getGenus, getSpeciesKey } from '../utils/speciesKey.js';
import { emptyHostGeneraIndex } from './hostGenera.js';
import { emptyInteractionsIndex, emptyNearbyFaunaIndex } from './faunaMatches.js';
import bloomSuccession from './rules/bloomSuccession.js';
import birdFood from './rules/birdFood.js';
import verticalLayers from './rules/verticalLayers.js';
import keystoneGenera from './rules/keystoneGenera.js';
import larvalHosts from './rules/larvalHosts.js';
import siteMatch from './rules/siteMatch.js';
import localFaunaSupport from './rules/localFaunaSupport.js';

/**
 * Grade a planting design against ecological rules, **per dimension with no
 * composite score** — a 0-100 roll-up would need weights nobody can justify, so
 * each dimension reports for itself and the reader decides what to fix first.
 *
 * Everything here is pure: no DOM, no fetch. The panel in src/render/ turns
 * these results into markup and nothing else.
 */

/**
 * Every rule returns one of exactly FOUR statuses. The panel maps four chips and
 * nothing else, so a new value would render as an unstyled blank rather than
 * fail loudly — keep this closed.
 */
export const STATUSES = Object.freeze({
  OK: 'ok', // nothing to do
  PARTIAL: 'partial', // works, has a hole
  GAP: 'gap', // the dimension is essentially unmet
  NOT_DECLARED: 'not-declared', // the input this rule needs is absent
});

const STATUS_VALUES = new Set(Object.values(STATUSES));

/** Registry order is display order. */
export const RULES = [
  bloomSuccession,
  birdFood,
  verticalLayers,
  keystoneGenera,
  larvalHosts,
  siteMatch,
  localFaunaSupport,
];

/**
 * Build the single context every rule reads.
 *
 * `plants` MUST be the objects createPlantFromSpecies already minted — the
 * analysis never builds its own plant shape, or the two paths drift and a rule
 * silently grades a plant the renderer would draw differently.
 *
 * @param {{ plants?: Array, species?: Array, hostGenera?: object, site?: object, ecoregion?: string }} input
 */
export function buildEcologyContext({
  plants = [],
  species = [],
  hostGenera,
  site,
  ecoregion,
  interactions,
  nearbyFauna,
  place,
} = {}) {
  const placed = plants.filter(Boolean);
  const placedSpeciesKeys = new Set(placed.map((plant) => getSpeciesKey(plant)));
  return {
    plants: placed,
    species: species.filter(Boolean),
    // One entry per distinct species actually in the yard: rules that ask "how
    // many things bloom in June" mean species, not individual plants, or a drift
    // of nineteen asters would read as nineteen answers to the same question.
    placedSpecies: dedupeBySpecies(placed),
    placedSpeciesKeys,
    unplacedSpecies: species.filter(
      (entry) => entry && !placedSpeciesKeys.has(getSpeciesKey(entry))
    ),
    placedGenera: new Set(placed.map((plant) => getGenus(plant)).filter(Boolean)),
    hostGenera: hostGenera || emptyHostGeneraIndex(),
    site: site || null,
    ecoregion: ecoregion ? String(ecoregion) : '',
    interactions: interactions || emptyInteractionsIndex(),
    nearbyFauna: nearbyFauna || emptyNearbyFaunaIndex(),
    place: place ? String(place) : '',
  };
}

/**
 * Run every rule against one context.
 *
 * A rule that throws becomes a `not-declared` row naming the failure rather than
 * taking the panel — and the app — down with it. The analysis is advisory; it
 * must never be the reason a yard stops rendering.
 *
 * @param {ReturnType<typeof buildEcologyContext>} ctx
 * @returns {Array<{id: string, title: string, status: string, summary: string, findings: string[], suggestions: string[]}>}
 */
export function analyzeEcology(ctx) {
  return RULES.map((rule) => {
    try {
      return normalizeResult(rule, rule.evaluate(ctx));
    } catch (err) {
      return {
        id: rule.id,
        title: rule.title,
        status: STATUSES.NOT_DECLARED,
        summary: `This check could not run: ${err.message}`,
        findings: [],
        suggestions: [],
      };
    }
  });
}

function normalizeResult(rule, result) {
  const status = STATUS_VALUES.has(result?.status) ? result.status : STATUSES.NOT_DECLARED;
  return {
    id: rule.id,
    title: rule.title,
    status,
    summary: String(result?.summary || ''),
    findings: (result?.findings || []).map(String),
    suggestions: (result?.suggestions || []).map(String),
  };
}

function dedupeBySpecies(plants) {
  const byKey = new Map();
  plants.forEach((plant) => {
    const key = getSpeciesKey(plant);
    if (!byKey.has(key)) byKey.set(key, plant);
  });
  return [...byKey.values()];
}
