/**
 * Habitat anchors near a yard (nl-3hi.7): its 'streams' and 'greenspace' layers
 * from /api/ecosystem/site (per yard since nl-3s5.31; they were the committed,
 * place-keyed ecology/anchors.csv).
 *
 * Location and distance are facts; "how connected the yard is" would be a
 * model, and this module deliberately computes nothing of the kind: no score,
 * no weighting, no ranking beyond distance. It only splits the rows into the
 * two things they are:
 *
 * - `anchors`: status "anchor", today only USGS NHD streams. Where water runs
 *   is a mapped fact about the ground.
 * - `candidates`: status "candidate", OpenStreetMap parks, cemeteries, and the
 *   like. An OSM tag records what land is CALLED, not whether it is habitat
 *   (a live test returned the State Fair grounds as leisure=park), so these are
 *   places to go and look, never presented as habitat.
 *
 * Pure: no DOM, no fetch. The page fetches one yard's rows and renders what
 * this returns.
 */

/**
 * @param {Array<Record<string, any>>} rows  one yard's anchor rows
 * @returns {{ anchors: object[], candidates: object[], fetchedOn: string }}
 */
export function groupAnchors(rows) {
  const entries = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      kind: String(row.kind || '').trim(),
      name: String(row.name || '').trim(),
      status: String(row.status || '').trim(),
      // Blank must stay unknown: Number('') is 0, which would read "0 mi" away.
      distanceMi: String(row.distance_mi ?? '').trim() === '' ? NaN : Number(row.distance_mi),
      detail: String(row.detail || '').trim(),
      fetchedOn: String(row.fetched_on || '').trim(),
      source: String(row.source || '').trim(),
    }))
    // A row with no usable distance or name cannot be shown honestly.
    .filter((entry) => entry.name && Number.isFinite(entry.distanceMi))
    .sort((a, b) => a.distanceMi - b.distanceMi || a.name.localeCompare(b.name));

  const fetchedOn = entries.map((entry) => entry.fetchedOn).filter(Boolean).sort().pop() || '';
  return {
    anchors: entries.filter((entry) => entry.status === 'anchor'),
    candidates: entries.filter((entry) => entry.status === 'candidate'),
    fetchedOn,
  };
}

const KIND_LABELS = {
  stream: 'stream',
  park: 'park',
  cemetery: 'cemetery',
  forest: 'forest',
  nature_reserve: 'nature reserve',
  golf_course: 'golf course',
};

/** "0.75 mi", "1 mi". Distances are already rounded to a quarter mile at fetch time. */
export function formatDistance(distanceMi) {
  return `${Number(distanceMi)} mi`;
}

/** Human label for an anchor kind; an unknown kind is shown as written, never guessed. */
export function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind || '').replace(/_/g, ' ');
}

/**
 * The size an OSM candidate's detail carries ("leisure=park, ~8 acres" -> "~8 acres"),
 * or '' when there is none. The tag itself is not repeated: the kind already says it.
 */
export function candidateSize(detail) {
  const match = String(detail || '').match(/~\s*[\d.]+\s*acres?/i);
  return match ? match[0].replace(/\s+/g, ' ') : '';
}
