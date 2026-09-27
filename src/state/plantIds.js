import { DRIFT_ID_MAX_LENGTH, isValidDriftId } from '../data/driftId.js';

// Re-exported so every caller that mints or checks a drift id can reach both
// through "the plant-id module" (this file), as the rest of this file's ids
// are minted; the shape itself is owned by src/data/driftId.js (see there).
export { DRIFT_ID_MAX_LENGTH, isValidDriftId };

/**
 * A driftId as a slug: lower-cased, non-alphanumeric runs collapsed to one
 * hyphen, leading/trailing hyphens trimmed, cut to DRIFT_ID_MAX_LENGTH. Never
 * empty: a label with no usable characters slugs to 'drift'.
 * @param {string} label
 * @returns {string}
 */
function slugForDrift(label) {
  return (
    String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, DRIFT_ID_MAX_LENGTH) || 'drift'
  );
}

/**
 * Build an id for a drift that cannot collide with one already in the yard:
 * a readable slug of `label` (the name the person gave it, or else the
 * species' common or botanical name — the caller decides which), walking past
 * collisions the way buildNewPlantId does. Unlike a plant id, a drift id may
 * need to shrink to make room for a numeric suffix, since DRIFT_ID_MAX_LENGTH
 * is enforced.
 * @param {Iterable<string>} existingDriftIds every driftId already used in the yard
 * @param {string} label the name, or species label, to derive the slug from
 * @returns {string}
 */
export function buildDriftId(existingDriftIds, label) {
  const existing = new Set(Array.from(existingDriftIds || [], String));
  const base = slugForDrift(label);
  if (!existing.has(base)) return base;
  let counter = 2;
  let candidate = withCollisionSuffix(base, counter);
  while (existing.has(candidate)) {
    counter += 1;
    candidate = withCollisionSuffix(base, counter);
  }
  return candidate;
}

/** `${base}-${counter}`, shortening `base` first if the suffix would not otherwise fit. */
function withCollisionSuffix(base, counter) {
  const suffix = `-${counter}`;
  const room = DRIFT_ID_MAX_LENGTH - suffix.length;
  const trimmedBase = room > 0 ? base.slice(0, room) : base.slice(0, DRIFT_ID_MAX_LENGTH);
  return `${trimmedBase}${suffix}`;
}

/**
 * Build an id for a new plant that cannot collide with one already placed.
 * Every path that adds a plant must route through this: ids address plants for
 * dragging, cloning, and highlighting, and parsePlantLayoutCsv rejects layouts
 * that repeat one, so a collision here would write a file that will not load.
 * @param {Array<{id: string}>} existingPlants
 * @param {string} baseId
 * @returns {string}
 */
export function buildCloneId(existingPlants, baseId) {
  const existing = new Set((existingPlants || []).map((p) => String(p.id)));
  const base = String(baseId || 'plant');
  let candidate = `${base}-copy`;
  let counter = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-copy-${counter}`;
    counter += 1;
  }
  return candidate;
}

/**
 * Build an id for a plant newly placed from the species catalog. Same
 * collision guarantee as buildCloneId, but named after the species rather than
 * an original — a plant added from the catalog has no plant it is a copy of, so
 * `salvia-greggii-1` reads better than `salvia-greggii-copy` in the CSV.
 * @param {Array<{id: string}>} existingPlants
 * @param {string} botanicalName
 * @returns {string}
 */
export function buildNewPlantId(existingPlants, botanicalName) {
  const existing = new Set((existingPlants || []).map((p) => String(p.id)));
  const base =
    String(botanicalName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'plant';
  let counter = 1;
  let candidate = `${base}-${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
}
