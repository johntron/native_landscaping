// Which backup snapshots to keep and which to prune (nl-3s5.13). Pure: no
// rclone, no fs, so tests/backupRetention.test.js exercises it without a remote.
//
// A snapshot is a folder named by its UTC start time, `YYYY-MM-DDTHHMMSSZ`
// (see snapshotName). It is "complete" once its MANIFEST.json exists: the job
// uploads the manifest last, so a folder without one is a run that failed
// part-way.
//
// The policy, restic-style (`--keep-daily 14 --keep-weekly 8`), counted over
// complete snapshots only:
//   * daily:  the newest snapshot of each of the 14 most recent UTC days that
//             have one. Days with no snapshot (the host was off) do not use up
//             a slot, so a gap never shortens the history.
//   * weekly: the newest snapshot of each of the 8 most recent ISO weeks that
//             have one.
// A snapshot kept by either rule stays. Incomplete folders older than the
// newest complete snapshot are leftovers of failed runs and are pruned; a newer
// incomplete folder may still be uploading and is left alone. A name that does
// not match the pattern is never touched: this function only prunes what the
// job itself created. `protect` names a snapshot that must survive whatever the
// policy says (the one this run just uploaded).

export const SNAPSHOT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * @param {Date} date
 * @returns {string} e.g. 2026-09-24T033012Z
 */
export function snapshotName(date) {
  return date.toISOString().replace(/[:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @param {string} name
 * @returns {Date|null} the snapshot's time, or null when the name is not one of ours
 */
export function parseSnapshotName(name) {
  const m = SNAPSHOT_PATTERN.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Reject impossible dates (2026-02-31) rather than letting Date roll them over.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/**
 * ISO 8601 week key, e.g. 2026-W39. The week belongs to the year of its
 * Thursday, so 2027-01-01 (a Friday) is in 2026-W53.
 * @param {Date} date
 * @returns {string}
 */
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Monday=1 .. Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // the Thursday of this week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * @param {{ name: string, complete: boolean }[]} snapshots every folder under the snapshots root
 * @param {object} [options]
 * @param {number} [options.daily] default 14
 * @param {number} [options.weekly] default 8
 * @param {string} [options.protect] a name never to delete
 * @returns {{ keep: string[], prune: string[], ignored: string[] }} keep and prune newest first;
 *   ignored holds names that are not snapshots of ours
 */
export function planRetention(snapshots, { daily = 14, weekly = 8, protect } = {}) {
  if (!Number.isInteger(daily) || daily < 1) throw new Error(`daily must be a positive integer, got ${daily}`);
  if (!Number.isInteger(weekly) || weekly < 0) throw new Error(`weekly must be a non-negative integer, got ${weekly}`);

  const ignored = [];
  const parsed = [];
  for (const s of snapshots) {
    const at = parseSnapshotName(s.name);
    if (at) parsed.push({ ...s, at });
    else ignored.push(s.name);
  }
  // Newest first; the name sorts the same as the time.
  parsed.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

  const keep = new Set();
  const complete = parsed.filter((s) => s.complete);

  const keepNewestPerBucket = (keyOf, limit) => {
    const seen = new Set();
    for (const s of complete) {
      const key = keyOf(s.at);
      if (seen.has(key)) continue;
      if (seen.size >= limit) break;
      seen.add(key);
      keep.add(s.name);
    }
  };
  keepNewestPerBucket((at) => at.toISOString().slice(0, 10), daily);
  keepNewestPerBucket(isoWeekKey, weekly);

  const newestComplete = complete[0]?.name;
  for (const s of parsed) {
    if (s.complete) continue;
    // Still possibly uploading, or nothing complete exists yet to supersede it.
    if (!newestComplete || s.name > newestComplete) keep.add(s.name);
  }
  if (protect) keep.add(protect);

  const names = parsed.map((s) => s.name);
  return {
    keep: names.filter((n) => keep.has(n)),
    prune: names.filter((n) => !keep.has(n)),
    ignored,
  };
}
