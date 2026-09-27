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
