/**
 * Turning what a person actually knows about their yard's ecoregion into the
 * EPA Level I code `project.json`'s `ecoregion` field wants.
 *
 * The keystone-genus lists in `ecology/host-genera.csv` are keyed by Level I
 * ecoregion — one or two digits, 15 of them exist continent-wide, and today
 * the catalog only carries data for "9" (Great Plains, which is what Dallas
 * and the Blackland Prairie sit in). A person is far more likely to know a
 * finer classification — "32a", the Level IV Northern Blackland Prairie code
 * shown on EPA's own maps — or nothing more specific than a ZIP code. Both
 * are real answers; neither is the code this field needs.
 *
 * What this module will and will not guess:
 *
 * - A Level III/IV code IS translated, but only the handful this project can
 *   already source and stand behind — the Texas Blackland Prairies (32) and
 *   its Level IV subdivisions, the ecoregion this codebase already asserts
 *   Dallas sits in (see AGENTS.md and `hostGenera.js`). Extending that table
 *   to the rest of the country needs the same sourcing, not a guess.
 * - A ZIP code is NOT translated. Ecoregions are polygons, not ZIP-aligned,
 *   and Texas alone spans three Level I ecoregions (Piney Woods East Texas is
 *   8, the Trans-Pecos is 10) — a ZIP-prefix table would be confidently wrong
 *   for real addresses. Rather than fabricate that mapping, this points the
 *   reader at EPA's own map instead. See commit 504b86d: this project's
 *   ecology rules are graded on data, not invented values, and a guessed
 *   ecoregion is exactly that.
 */

/** Level I codes this project actually has keystone-genus data for, and their names. */
export const KNOWN_ECOREGIONS = Object.freeze({
  9: 'Great Plains',
});

/**
 * EPA Level III codes, and their Level IV subdivisions, that fall inside a
 * KNOWN_ECOREGIONS entry — sourced, not guessed; extend it only with the same
 * sourcing (an EPA/TPWD/TCEQ reference, as the codebase's other ecoregion
 * claims carry).
 */
export const ECOREGION_CROSSWALK = Object.freeze({
  32: '9', // Texas Blackland Prairies (Level III)
  '32a': '9', // Northern Blackland Prairie
  '32b': '9', // Floodplains and Low Terraces
  '32c': '9', // Southern Blackland Prairie
});

const ZIP_PATTERN = /^\d{5}$/;

/**
 * @param {string} raw what the person typed
 * @returns {{ value: string|null, note: string|null }} `value` is what to
 *   save — untouched unless a sourced translation applies — and `note` is a
 *   status message to show, or null when the input needs no comment.
 */
export function resolveEcoregionInput(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { value: null, note: null };
  if (Object.prototype.hasOwnProperty.call(KNOWN_ECOREGIONS, trimmed)) {
    return { value: trimmed, note: null };
  }

  const key = trimmed.toLowerCase();
  const mapped = ECOREGION_CROSSWALK[key];
  if (mapped) {
    const name = KNOWN_ECOREGIONS[mapped];
    return {
      value: mapped,
      note:
        `"${trimmed}" is a more detailed EPA ecoregion code; this project grades against ` +
        `the Level I code it sits inside, so it was saved as ${mapped}${name ? ` (${name})` : ''}.`,
    };
  }

  if (ZIP_PATTERN.test(trimmed)) {
    return {
      value: trimmed,
      note:
        `"${trimmed}" looks like a ZIP code, not an EPA Level I ecoregion, and there is no ` +
        'ZIP lookup here — ecoregions are drawn as polygons, not ZIP boundaries, and guessing ' +
        'one would grade this planting against the wrong ground. Saved as typed; look yours up ' +
        'at epa.gov/eco-research/ecoregions and enter the Level I number.',
    };
  }

  const known = Object.keys(KNOWN_ECOREGIONS).join(', ');
  return {
    value: trimmed,
    note:
      `"${trimmed}" is not one of the ecoregions this project has keystone-genus data for ` +
      `(${known}) and isn't in the short list of finer codes it can translate. Saved as ` +
      'typed, but the keystone-genus checks will report it as not declared.',
  };
}
