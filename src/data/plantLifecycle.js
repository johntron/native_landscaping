/**
 * A plant's lifecycle on its placement (nl-3s5.22): whether it is only in the
 * plan or already in the ground, when it went in, and where it came from.
 *
 *   status     'planted', or absent for 'planned' (the default). Absent, not
 *              'planned', so every placement saved before this bead already
 *              has its canonical form and no revision changes shape.
 *   plantedOn  'YYYY-MM-DD', only on a planted placement; optional even then.
 *   source     { name, ref? }: `name` is free text and may name anywhere
 *              ("neighbour's division", "Big Box #123"). `ref` is set only
 *              when the person picked a suggestion from sourcing/, and
 *              names that row by its own values, because those tables carry
 *              no id column:
 *                { table: 'nurseries', name }
 *                { table: 'plant-sales', organizer, event, startDate }
 *              A ref that no longer resolves (sale rows are pruned every
 *              season) is normal: the name alone is shown.
 *
 * Two checks, deliberately different:
 *
 * - normalizeLifecycle is STRUCTURAL and never throws or reads the clock. It
 *   runs inside toPlacement (src/data/placements.js), so on every save the
 *   client makes, on the server's reduction of a POST /api/layout body, and on
 *   every history read. A value it cannot use is dropped rather than refused,
 *   because a throw on a read would make a yard unloadable.
 * - validateLifecycle is STRICT (adds "not in the future") and is what the
 *   editing panel runs before it commits, so a person is told, not corrected.
 *
 * A new status (for example a 'removed' state) must be added to
 * LIFECYCLE_STATUSES before anything writes it; until then the normalizer
 * drops it and the plant reads as planned.
 *
 * Pure: no DOM, no fetch. The server imports it through placements.js.
 */

export const STATUS_PLANNED = 'planned';
export const STATUS_PLANTED = 'planted';
export const LIFECYCLE_STATUSES = Object.freeze([STATUS_PLANNED, STATUS_PLANTED]);

/** The placement keys this module owns. */
export const LIFECYCLE_KEYS = Object.freeze(['status', 'plantedOn', 'source']);

/** Longest free-text source kept, in characters; longer text is cut, not refused. */
export const SOURCE_NAME_MAX = 120;

/** The sourcing/ tables a ref may name, with the row values that identify a row. */
export const SOURCE_REF_TABLES = Object.freeze({
  nurseries: Object.freeze(['name']),
  'plant-sales': Object.freeze(['organizer', 'event', 'startDate']),
});

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// C0 and C1 controls, DEL, and the Unicode line and paragraph separators.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Whether `value` is a real calendar date written YYYY-MM-DD.
 * @param {unknown} value
 */
export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Today in the viewer's own time zone, as YYYY-MM-DD. Not toISOString(),
 * which is UTC and so already tomorrow on a Texas evening.
 * @param {Date} [now]
 */
export function localIsoDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Free text as it is stored: controls and line breaks become one space, runs of
 * spaces collapse, the ends are trimmed, and it is cut to SOURCE_NAME_MAX.
 * Nothing else is changed: it is escaped when rendered, never here.
 * @param {unknown} value
 * @returns {string}
 */
export function cleanSourceName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, SOURCE_NAME_MAX).trim();
}

/**
 * A ref as stored, or null when it is not one of the two shapes. Every field
 * is a non-empty string, capped like a name; a plant-sales startDate must be
 * a calendar date.
 * @param {unknown} ref
 */
export function normalizeSourceRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const fields = SOURCE_REF_TABLES[ref.table];
  if (!fields) return null;
  const out = { table: ref.table };
  for (const field of fields) {
    const value = cleanSourceName(ref[field]);
    if (!value) return null;
    out[field] = value;
  }
  if (out.table === 'plant-sales' && !isIsoDate(out.startDate)) return null;
  return out;
}

/**
 * A source as stored, or null. A ref without a name is dropped with it: the
 * free text is the source; a ref only annotates it.
 * @param {unknown} source
 */
export function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const name = cleanSourceName(source.name);
  if (!name) return null;
  const ref = normalizeSourceRef(source.ref);
  return ref ? { name, ref } : { name };
}

/**
 * The lifecycle fields of `placement` in canonical form: only the keys that
 * hold a usable value. Structural only; see the module comment.
 * @param {object} placement
 * @returns {{ status?: 'planted', plantedOn?: string, source?: object }}
 */
export function normalizeLifecycle(placement) {
  const out = {};
  if (!placement || typeof placement !== 'object') return out;
  if (placement.status === STATUS_PLANTED) {
    out.status = STATUS_PLANTED;
    if (isIsoDate(placement.plantedOn)) out.plantedOn = placement.plantedOn;
  }
  const source = normalizeSource(placement.source);
  if (source) out.source = source;
  return out;
}

/**
 * The lifecycle of a plant or placement for display: always a status.
 * @param {object} plant
 * @returns {{ status: 'planned'|'planted', plantedOn: string, source: object|null }}
 */
export function lifecycleOf(plant) {
  const normalized = normalizeLifecycle(plant);
  return {
    status: normalized.status || STATUS_PLANNED,
    plantedOn: normalized.plantedOn || '',
    source: normalized.source || null,
  };
}

/**
 * The strict check the editing panel runs before a commit. Returns the
 * problems, in words a person can act on; [] means it may be saved.
 * @param {{ status?: string, plantedOn?: string, source?: object|null }} fields
 * @param {{ today?: string }} [options] YYYY-MM-DD in the viewer's zone; defaults to localIsoDate()
 * @returns {string[]}
 */
export function validateLifecycle(fields, { today = localIsoDate() } = {}) {
  const problems = [];
  const status = fields?.status ?? STATUS_PLANNED;
  if (!LIFECYCLE_STATUSES.includes(status)) {
    problems.push(`Status must be ${LIFECYCLE_STATUSES.join(' or ')}.`);
  }
  const plantedOn = fields?.plantedOn ?? '';
  if (plantedOn !== '') {
    if (status !== STATUS_PLANTED) {
      problems.push('A planting date belongs only to a planted plant.');
    } else if (!isIsoDate(plantedOn)) {
      problems.push('The planting date must be a real date (YYYY-MM-DD).');
    } else if (plantedOn > today) {
      problems.push('The planting date cannot be in the future.');
    }
  }
  const source = fields?.source;
  if (source !== undefined && source !== null) {
    if (typeof source.name !== 'string') {
      problems.push('The source must be text.');
    } else if (source.name.length > SOURCE_NAME_MAX) {
      problems.push(`The source is limited to ${SOURCE_NAME_MAX} characters.`);
    }
    if (source.ref !== undefined && source.ref !== null && !normalizeSourceRef(source.ref)) {
      problems.push('The linked nursery or sale is not one this page knows how to name.');
    }
  }
  return problems;
}

/**
 * A copy of `plant` with its lifecycle replaced by `fields`, canonical:
 * planned drops `status` and `plantedOn`, an empty source drops `source`.
 * Every other key is kept as it was.
 * @param {object} plant
 * @param {{ status?: string, plantedOn?: string, source?: object|null }} fields
 */
export function withLifecycle(plant, fields) {
  const next = { ...plant };
  LIFECYCLE_KEYS.forEach((key) => delete next[key]);
  return { ...next, ...normalizeLifecycle(fields) };
}

/**
 * The display label of a ref, whether or not it still resolves.
 * @param {{ table: string, name?: string, organizer?: string, event?: string, startDate?: string }} ref
 */
export function describeSourceRef(ref) {
  if (!ref) return '';
  if (ref.table === 'nurseries') return ref.name;
  if (ref.table === 'plant-sales') return `${ref.organizer}: ${ref.event} (${ref.startDate})`;
  return '';
}

/**
 * Whether a ref names this row of its table.
 * @param {object} ref a normalized ref
 * @param {Record<string, string>} row a parsed CSV row of that table
 */
export function refMatchesRow(ref, row) {
  if (!ref || !row) return false;
  if (ref.table === 'nurseries') return cleanSourceName(row.name) === ref.name;
  if (ref.table === 'plant-sales') {
    return (
      cleanSourceName(row.organizer) === ref.organizer &&
      cleanSourceName(row.event) === ref.event &&
      String(row.start_date || '').trim() === ref.startDate
    );
  }
  return false;
}

/**
 * The row a ref names, or null when that row is gone (the normal case for a
 * sale once it is pruned) or the table is not loaded.
 * @param {object|null} ref
 * @param {{ nurseries?: Array<object>, sales?: Array<object> }} tables parsed sourcing/ CSVs
 */
export function resolveSourceRef(ref, tables) {
  if (!ref) return null;
  const rows = ref.table === 'nurseries' ? tables?.nurseries : tables?.sales;
  return (rows || []).find((row) => refMatchesRow(ref, row)) || null;
}

/**
 * Suggestions for what a person has typed: rows of sourcing/nurseries.csv and
 * sourcing/plant-sales.csv whose name (or organizer, event, or city) contains
 * the text, case-insensitively. A suggestion is only ever offered; the panel
 * links one only when it is picked, so no typed text is ever matched for them.
 * @param {string} text
 * @param {{ nurseries?: Array<object>, sales?: Array<object> }} tables
 * @param {{ limit?: number, minLength?: number }} [options]
 * @returns {Array<{ label: string, detail: string, ref: object, url: string }>}
 */
export function suggestSources(text, tables, { limit = 6, minLength = 2 } = {}) {
  const needle = cleanSourceName(text).toLowerCase();
  if (needle.length < minLength) return [];
  const out = [];
  const contains = (...values) => values.some((value) => String(value || '').toLowerCase().includes(needle));
  (tables?.nurseries || []).forEach((row) => {
    if (!contains(row.name, row.city)) return;
    const ref = normalizeSourceRef({ table: 'nurseries', name: row.name });
    if (!ref) return;
    out.push({
      label: ref.name,
      detail: ['nursery', row.city].filter(Boolean).join(', '),
      ref,
      url: row.website || '',
    });
  });
  (tables?.sales || []).forEach((row) => {
    if (!contains(row.organizer, row.event, row.city)) return;
    const ref = normalizeSourceRef({
      table: 'plant-sales',
      organizer: row.organizer,
      event: row.event,
      startDate: String(row.start_date || '').trim(),
    });
    if (!ref) return;
    out.push({
      label: `${ref.organizer}: ${ref.event}`,
      detail: ['sale', ref.startDate, row.city].filter(Boolean).join(', '),
      ref,
      url: row.url || '',
    });
  });
  return out.slice(0, limit);
}

/**
 * The lifecycle columns planting_layout.csv carries after the core four
 * (src/data/layoutExporter.js). A ref is spread over one column per row value
 * rather than one JSON cell, because the CSV reader (src/data/csvLoader.js)
 * drops the doubled quotes JSON would need inside a quoted cell.
 */
export const LIFECYCLE_CSV_COLUMNS = Object.freeze([
  'status',
  'planted_on',
  'source',
  'source_nursery',
  'source_sale_organizer',
  'source_sale_event',
  'source_sale_date',
]);

/**
 * A plant's lifecycle as planting_layout.csv cells, in LIFECYCLE_CSV_COLUMNS
 * order. A planned plant writes 'planned', so the column is never blank.
 * @param {object} plant
 * @returns {string[]}
 */
export function lifecycleCsvCells(plant) {
  const { status, plantedOn, source } = lifecycleOf(plant);
  const ref = source?.ref;
  const nursery = ref?.table === 'nurseries' ? ref : null;
  const sale = ref?.table === 'plant-sales' ? ref : null;
  return [
    status,
    plantedOn,
    source?.name || '',
    nursery?.name || '',
    sale?.organizer || '',
    sale?.event || '',
    sale?.startDate || '',
  ];
}

/**
 * A planting_layout.csv row's lifecycle, normalized. A file from before these
 * columns has none of them and reads as planned with no source.
 * @param {Record<string, string>} row a parsed CSV row
 */
export function lifecycleFromCsvRow(row) {
  const nursery = row.source_nursery ? { table: 'nurseries', name: row.source_nursery } : null;
  const sale = row.source_sale_organizer
    ? {
        table: 'plant-sales',
        organizer: row.source_sale_organizer,
        event: row.source_sale_event,
        startDate: row.source_sale_date,
      }
    : null;
  return normalizeLifecycle({
    status: String(row.status || '').trim().toLowerCase(),
    plantedOn: String(row.planted_on || '').trim(),
    source: { name: row.source, ref: nursery || sale },
  });
}
