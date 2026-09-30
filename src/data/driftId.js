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
 * Drop the driftId label from EVERY drift in `plants` that has fewer than two
 * members (nl-o47.6.9's "a drift always has >= 2 members" rule, enforced for
 * a whole plants list at once rather than one drift at a time): a CSV import
 * (src/data/plantParser.js's buildPlantsFromCsv, for hand-edited or legacy
 * planting_layout.csv files) and plants rebuilt from saved history
 * (plantsFromPlacements — undo/redo and every page load) both call this, so
 * an undersized drift a still-earlier bead's edits left behind never survives
 * a reload with its "-" enabled and ready to delete the last plant.
 * src/state/driftEdits.js re-exports this for its own callers, and its own
 * pruneUndersizedDrift is the same rule for one drift at a time. Lives here,
 * in src/data/, rather than beside pruneUndersizedDrift in src/state/, so
 * plantParser.js can reach it without reaching into src/state/ (see this
 * file's own module comment on that layering rule). Every drift with 2+
 * members is untouched.
 * @param {Array<object>} plants
 * @returns {Array<object>}
 */
export function dropUndersizedDrifts(plants) {
  if (!Array.isArray(plants)) return plants;
  const counts = new Map();
  plants.forEach((plant) => {
    if (!plant?.driftId) return;
    counts.set(plant.driftId, (counts.get(plant.driftId) || 0) + 1);
  });
  const undersized = new Set([...counts.entries()].filter(([, count]) => count < 2).map(([id]) => id));
  if (!undersized.size) return plants;
  return plants.map((plant) => {
    if (!plant?.driftId || !undersized.has(plant.driftId)) return plant;
    const next = { ...plant };
    delete next.driftId;
    return next;
  });
}
