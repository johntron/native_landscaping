/**
 * A drift id's shape (nl-o47.6.1): the same conservative slug a project or
 * view id is held to (src/data/projectConfig.js's PROJECT_ID_PATTERN,
 * src/data/projectPaths.js) — lowercase letters, digits, hyphen and
 * underscore, starting with one of the first two. A drift id travels through
 * the layout CSV as a bare cell and addresses a drift the way a plant id
 * addresses a plant, so it is held to the same shape, never free text.
 *
 * This lives in src/data/, not beside the minting function in
 * src/state/plantIds.js, so that every module that reduces or parses a
 * placement (src/data/placements.js, src/data/layoutExporter.js,
 * src/data/plantParser.js) can validate a driftId without reaching into
 * src/state/: tools/deploy.sh restarts feed-poller on any change under
 * src/data/ because server/db/projectStore.js already loads all of it
 * (through src/data/placements.js), and no such rule watches src/state/.
 * src/state/plantIds.js imports isValidDriftId and DRIFT_ID_MAX_LENGTH back
 * from here to mint one.
 *
 * Pure: no DOM, no fetch.
 */
import { lifecycleOf, withLifecycle } from './plantLifecycle.js';

const DRIFT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Longest drift id kept, in characters. A judgement call, not a technical
 * limit: the same bound src/data/projectConfig.js's isValidProjectId uses,
 * generous for a slug minted from a name or a species.
 */
export const DRIFT_ID_MAX_LENGTH = 64;

/**
 * Whether `value` is a driftId placements.js will keep on a placement: a slug
 * within DRIFT_ID_MAX_LENGTH. Anything else — not a string, empty, too long,
 * or holding a character the pattern disallows — is not one, and the caller
 * drops it rather than storing it (src/data/placements.js toPlacement,
 * src/data/plantParser.js parsePlantLayoutCsv).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidDriftId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DRIFT_ID_MAX_LENGTH &&
    DRIFT_ID_PATTERN.test(value)
  );
}

/**
 * A label as a driftId slug: lower-cased, non-alphanumeric runs collapsed to
 * one hyphen, leading/trailing hyphens trimmed, cut to DRIFT_ID_MAX_LENGTH.
 * Never empty: a label with no usable characters slugs to 'drift'. The
 * result always satisfies isValidDriftId. Used by src/state/plantIds.js's
 * buildDriftId (which walks past a collision by adding a numeric suffix) to
 * mint an id from a species name — the id itself is invisible once minted
 * (nl-o47.6.11: a drift's on-screen label is driftLabel,
 * src/render/labels.js, not this slug humanized), so only its shape still
 * matters, not its wording.
 * @param {string} label
 * @returns {string}
 */
export function slugifyDriftLabel(label) {
  return (
    String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, DRIFT_ID_MAX_LENGTH) || 'drift'
  );
}

/**
 * Enforce every rule a drift's own members must satisfy, for a whole plants
 * list at once (nl-o47.6.12): at least two members, one species (a member
 * whose speciesId does not match the FIRST member sharing that driftId, by
 * `plants`' own array order, leaves the drift — it keeps its position and
 * every other field, just no longer this driftId), and one lifecycle (every
 * surviving member's status/plantedOn/source/localEcotype is unified onto
 * the first member's, src/data/plantLifecycle.js's lifecycleOf/withLifecycle
 * — nl-o47.6.10's "one planting status per drift" invariant, which every
 * interactive edit already keeps, so this only ever has visible work to do on
 * older data or an import; see the GATE CLEARED note on nl-o47.6.12 for the
 * owner's own review of this consequence). The two checks interact in one
 * pass: a member the species check drops cannot also anchor or receive a
 * lifecycle unification, and dropping it can itself take a drift below two
 * members, which drops the label from whoever is left too.
 *
 * The one place every drift-shape rule lives, replacing dropUndersizedDrifts
 * and driftEdits.js's own pruneUndersizedDrift: every edit in
 * src/state/driftEdits.js that can leave a drift undersized, mixed-species,
 * or mixed-lifecycle does a plain edit and then calls this on the whole list,
 * and so does every load — src/data/plantParser.js's buildPlantsFromCsv (a
 * hand-edited or legacy planting_layout.csv) and plantsFromPlacements (every
 * undo/redo and page load, through src/history/layoutHistoryController.js's
 * own toPlants). Lives here, in src/data/, rather than in src/state/, so
 * plantParser.js can reach it without reaching into src/state/ (see this
 * file's own module comment on that layering rule) — plantLifecycle.js is
 * already part of the same src/data/ closure the server loads through
 * placements.js, so this adds nothing new to it.
 *
 * Returns the SAME array reference when nothing needed fixing (every drift
 * already has 2+ members, one species, and one lifecycle), so a caller that
 * short-circuits on an unchanged reference (dirty-checking, memoization)
 * still can.
 * @param {Array<object>} plants
 * @returns {Array<object>}
 */
export function normalizeDrifts(plants) {
  if (!Array.isArray(plants)) return plants;

  const membersById = new Map(); // driftId -> [{ plant, index }], in `plants`' own order
  plants.forEach((plant, index) => {
    if (!plant?.driftId) return;
    const list = membersById.get(plant.driftId) || [];
    list.push({ plant, index });
    membersById.set(plant.driftId, list);
  });

  const dropLabelAt = new Set(); // index -> drop this member's driftId
  const unifyLifecycleAt = new Map(); // index -> the lifecycle fields to apply

  membersById.forEach((entries) => {
    // The first member (by array order, not driftId-membership order) is the
    // anchor for BOTH checks below: it always matches its own species
    // trivially, so it is always one of `matching`.
    const speciesId = entries[0].plant.speciesId;
    const matching = entries.filter((entry) => entry.plant.speciesId === speciesId);
    entries.forEach((entry) => {
      if (!matching.includes(entry)) dropLabelAt.add(entry.index);
    });
    if (matching.length < 2) {
      matching.forEach((entry) => dropLabelAt.add(entry.index));
      return;
    }
    const targetLifecycle = lifecycleOf(matching[0].plant);
    const targetKey = JSON.stringify(targetLifecycle);
    matching.forEach((entry) => {
      if (JSON.stringify(lifecycleOf(entry.plant)) !== targetKey) {
        unifyLifecycleAt.set(entry.index, targetLifecycle);
      }
    });
  });

  if (!dropLabelAt.size && !unifyLifecycleAt.size) return plants;

  return plants.map((plant, index) => {
    if (dropLabelAt.has(index)) {
      const next = { ...plant };
      delete next.driftId;
      return next;
    }
    if (unifyLifecycleAt.has(index)) {
      return withLifecycle(plant, unifyLifecycleAt.get(index));
    }
    return plant;
  });
}
