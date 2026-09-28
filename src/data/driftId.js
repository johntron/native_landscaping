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
 * result always satisfies isValidDriftId. Shared by
 * src/state/plantIds.js's buildDriftId (which walks past a collision by
 * adding a numeric suffix) and src/state/driftEdits.js's renameDrift (which
 * refuses one instead).
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
 * A drift's display label, when it has not been given one of its own
 * (nl-o47.6.2, orchestrator decision 2026-09-27): there is no separate
 * "named" flag distinguishing a species-minted id ("winecup-2") from a
 * person's own rename ("front-edge") — both are plain slugs, so the label is
 * always just the CURRENT driftId humanized, hyphens to spaces and the first
 * letter capitalised, with nothing else. "winecup-2" reads "Winecup 2";
 * "front-edge" reads "Front edge". The caller appends the member count
 * (src/ui/selectionBar.js); this only ever humanizes the id itself.
 * @param {string} driftId
 * @returns {string}
 */
export function humanizeDriftId(driftId) {
  const text = String(driftId || '').replace(/-/g, ' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}
