/**
 * ecology/anchors.csv read/write helpers shared by fetch-nhd-creeks.mjs and
 * fetch-osm-greenspace.mjs (nl-3hi.7, stages 1 and 2).
 *
 * One table for every anchor kind, not one file per source: stage 5
 * (nl-3hi.7.5, "let local knowledge promote candidates to anchors") is a
 * `status` edit on an existing row, not a file merge, and stages 3/4 add
 * columns or rows to this same table rather than new files.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ANCHORS_CSV = `${ROOT}ecology/anchors.csv`;

export const ANCHORS_HEADER = [
  'place',
  'kind',
  'name',
  'status',
  'distance_mi',
  'detail',
  'fetched_on',
  'source',
];

/**
 * Replace this place's rows of one `kind` (e.g. re-running the NHD fetch
 * only touches `kind=stream` rows for that place) and write the whole file
 * back, sorted for a stable diff.
 */
export function mergeAnchorRows(place, kind, newRows) {
  const existing = existsSync(ANCHORS_CSV) ? parseCsv(readFileSync(ANCHORS_CSV, 'utf8')) : [];
  const untouched = existing.filter((row) => !(row.place === place && row.kind === kind));
  const rows = [...untouched, ...newRows];
  writeFileSync(ANCHORS_CSV, toAnchorsCsv(rows));
  return rows;
}

export function toAnchorsCsv(rows) {
  const lines = [ANCHORS_HEADER.join(',')];
  rows
    .slice()
    .sort(
      (a, b) =>
        String(a.place).localeCompare(String(b.place)) ||
        String(a.kind).localeCompare(String(b.kind)) ||
        Number(a.distance_mi) - Number(b.distance_mi) ||
        String(a.name).localeCompare(String(b.name))
    )
    .forEach((row) => {
      lines.push(ANCHORS_HEADER.map((key) => escapeCell(row[key])).join(','));
    });
  return lines.join('\n') + '\n';
}

function escapeCell(value) {
  const str = String(value ?? '');
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}
