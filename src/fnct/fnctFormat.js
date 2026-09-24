/**
 * Human-friendly rendering of raw plants.csv cell values for the FNCT detail
 * panel. plants.csv stores machine-shaped values (hyphen/slash-joined codes,
 * hex colors, 1-12 month numbers, a literal "none"/"0" for "doesn't apply")
 * — this turns those into words, without changing what's in the CSV itself.
 * Kept pure and DOM-free so it's unit-testable.
 */

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/** A value that carries no real information for display purposes — skip the row rather than show "None"/"0". */
export function isEmptyCatalogValue(value) {
  const v = (value ?? '').trim().toLowerCase();
  return v === '' || v === 'none' || v === '0';
}

/** "part-sun" -> "Part Sun". Splits on hyphens/underscores and title-cases each word. */
function humanizeToken(token) {
  return token
    .trim()
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** "sandy,loamy" -> "Sandy, Loamy"; "spike/raceme" -> "Spike / Raceme"; combines both. */
export function humanizeWords(value) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split('/').map(humanizeToken).join(' / '))
    .join(', ');
}

/** "4-11" -> "April–November"; "9" -> "September". Non-month-shaped input passes through unchanged. */
export function formatMonthRange(value) {
  const parts = value.split('-').map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isInteger(n) || n < 1 || n > 12)) return value;
  if (parts.length === 1) return MONTH_NAMES[parts[0]];
  return `${MONTH_NAMES[parts[0]]}–${MONTH_NAMES[parts[1]]}`;
}

/**
 * Format one plants.csv cell for display, by field kind. Returns either a
 * plain string, or `{ swatch, text }` for a color field — swatch is the raw
 * CSS color to paint a preview chip, text is what to print beside it.
 */
export function formatCatalogValue(kind, value) {
  switch (kind) {
    case 'color':
      return HEX_COLOR_RE.test(value) ? { swatch: value, text: value.toUpperCase() } : humanizeWords(value);
    case 'months':
      return formatMonthRange(value);
    case 'feet':
      return `${value} ft`;
    case 'number':
      return value;
    case 'words':
    default:
      return humanizeWords(value);
  }
}

// Every plants.csv column worth showing, in display order, with how to
// format it. `id` and `botanical_name` are covered elsewhere in the panel
// (the catalog-match note / the species heading) so they're left out here.
// plants.csv holds claim-backed botany only (nl-3s5.21); how the design tool
// DRAWS a species (hex colours, inflorescence, flower count and zone) is an
// authored judgement in plant-drawing.csv, and a reference page does not
// present it as a catalog fact.
export const CATALOG_FIELD_LABELS = [
  ['common_name', 'Catalog name', 'words'],
  ['growth_shape', 'Growth shape', 'words'],
  ['growing_season_months', 'Growing season', 'months'],
  ['flowering_season_months', 'Bloom season', 'months'],
  ['sun_pref', 'Sun', 'words'],
  ['water_pref', 'Water', 'words'],
  ['soil_pref', 'Soil', 'words'],
  ['width_ft', 'Width', 'feet'],
  ['height_ft', 'Height', 'feet'],
  ['fruit_season_months', 'Fruit season', 'months'],
  ['fruit_load', 'Fruit load', 'words'],
];
