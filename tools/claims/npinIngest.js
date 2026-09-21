// NPIN ingest (nl-scx.8): the fields LBJ/NPIN is primary for, implementing
// docs/data-acquisition/02-source-inventory.md §2.3 (field list, access
// verdict), docs/data-acquisition/04-data-model.md §3.1/§3.2 (citation and
// license shape) and docs/data-acquisition/10-prioritization.md §3.3
// (ordered after the free USDA work because it needs per-species fetches at
// an unknown rate).
//
// Six claim fields, all keyed on the species page's own labeled rows
// (`<strong>Label:</strong> value`):
//   sun_pref             <- "Light Requirement", a genuine SET (Sun/Part
//                           Shade/Shade), unlike USDA's single Shade
//                           Tolerance optimum (mapCharacteristics.js).
//   water_pref           <- "Water Use" (Low/Medium/High), same vocabulary
//                           USDA's Moisture Use already writes.
//   soil_pref            <- "Soil Description" is prose, not USDA's
//                           structured coarse/medium/fine booleans — this
//                           ingest extracts the same sandy/loamy/clay
//                           vocabulary from that prose by keyword match, so
//                           the field stays comparable across sources. A
//                           description that never says sand/loam/clay
//                           writes no claim, not a guess.
//   bloom_month          <- "Bloom Time", already month-precision text
//                           ("Apr, May, Jun") — no season-phrase inference
//                           needed, unlike USDA's Active/Bloom Period.
//   deer_resistance      <- "Deer Resistant", free text, slugified.
//   larval_host_species  <- "Larval Host", curated prose, stored verbatim
//                           (02 §2.3: unstructured, of unknown coverage, but
//                           the same kind of curated claim host-genera.csv
//                           already carries).
//
// Pure-insert, same discipline as usdaIngest.js: every write is an INSERT,
// never an UPDATE/DELETE.
import { SOURCE } from './precedence.js';

// ---------------------------------------------------------------------------
// HTML parsing — NPIN's species page renders each fact as
// `<strong>Label:</strong>  value ,  value <br />` inside a `<div
// class="section">`, sometimes with glossary-link `<a>` tags wrapping a
// value. Confirmed 2026-09-21 against CHLI2 (Chilopsis linearis), ILVO (Ilex
// vomitoria) and PRME (Prunus mexicana) — the exact three symbols 02 §2.3
// measured (QUSH itself 302-redirects to the search page; the NPIN id for
// Quercus shumardii is not literally its USDA symbol, a coverage gap noted
// below, not assumed away).

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

function extractField(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<strong>${escaped}:</strong>([\\s\\S]*?)(?:<br\\s*/?>|</div>)`, 'i');
  const match = re.exec(html);
  if (!match) return null;
  const text = stripTags(match[1]).replace(/\s+/g, ' ').trim();
  return text || null;
}

function extractListField(html, label) {
  const text = extractField(html, label);
  if (!text) return null;
  const items = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

/**
 * A symbol NPIN doesn't recognize 302-redirects to the plain search page,
 * which `fetch` follows to a 200 with no species content — so the HTTP
 * status can't tell a resolved page from an unresolved one; the presence of
 * the species-only section headings can.
 */
export function isResolvedSpeciesPage(html) {
  return /<h4>Growing Conditions<\/h4>/i.test(html) || /<h4>Benefit<\/h4>/i.test(html);
}

/** Raw label -> text/array extraction, before any value mapping. */
export function parseNpinFields(html) {
  return {
    bloomTime: extractListField(html, 'Bloom Time'),
    lightRequirement: extractListField(html, 'Light Requirement'),
    waterUse: extractField(html, 'Water Use'),
    soilDescription: extractField(html, 'Soil Description'),
    deerResistant: extractField(html, 'Deer Resistant'),
    larvalHost: extractField(html, 'Larval Host'),
  };
}

// ---------------------------------------------------------------------------
// Value mapping — each function returns a claims.value string, or null when
// the source page had nothing usable for that field (a "no claim" silence,
// not an "unknown" status — see insertClaim call sites below for the
// distinction, same as usdaIngest.js's `continue` on a blank characteristic).

// The complete published NPIN "Light Requirement" enum (three values), same
// full-sun/part-sun/shade vocabulary mapPlantToIntermediateRow's
// SHADE_TOLERANCE_TO_SUN_PREF already writes for USDA — kept separate rather
// than imported because USDA's map answers a different question (an inverted
// ordinal) and importing it here would silently couple the two.
const LIGHT_TO_SUN_PREF = { sun: 'full-sun', 'part shade': 'part-sun', shade: 'shade' };

const WATER_LEVEL = { low: 'low', medium: 'medium', high: 'high' };

const MONTH_NUMBER = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Sun_pref as a comma-joined SET (04's "same convention as plants.csv" for multi-valued fields), order of first appearance, deduped. */
export function sunPrefFromLight(lightList) {
  if (!lightList?.length) return null;
  const slugs = [];
  for (const raw of lightList) {
    const slug = LIGHT_TO_SUN_PREF[raw.toLowerCase()];
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs.length ? slugs.join(',') : null;
}

export function waterPrefFromWaterUse(waterUse) {
  if (!waterUse) return null;
  return WATER_LEVEL[waterUse.toLowerCase()] ?? null;
}

/**
 * soil_pref from NPIN's free-text "Soil Description" by keyword match against
 * the same sandy/loamy/clay vocabulary USDA's structured booleans produce
 * (mapCharacteristics.js's soilPref) — a texture word appearing anywhere in
 * the prose ("sands", "sandy loam", "loams", "clays") counts, per 02 §2.3
 * naming this field corroborating-grade prose, not a structured value NPIN
 * states directly. No match means no claim, never an invented soil type.
 */
export function soilPrefFromDescription(text) {
  if (!text) return null;
  const found = [];
  if (/\bsand/i.test(text)) found.push('sandy');
  if (/\bloam/i.test(text)) found.push('loamy');
  if (/\bclay/i.test(text)) found.push('clay');
  return found.length ? found.join(',') : null;
}

/**
 * bloom_month from NPIN's already month-precision "Bloom Time" list. Same
 * dedupe/sort/contiguous-collapse convention as
 * tools/usda-plants/seasonMonths.js's parseSeasonPhrase tail (kept as its
 * own small function rather than imported — that module parses *season*
 * phrases like "Mid Summer", a different input shape than a literal month
 * list, and coupling the two would make either harder to change alone).
 * Faithfully carries over that convention's same limitation: months are
 * sorted ascending before the contiguity check, so a Dec-Jan wraparound
 * (e.g. a "Nov, Dec, Jan, Feb" bloom window) does not collapse to a range —
 * it falls through to the comma list, same as it would in
 * parseSeasonPhrase today.
 */
export function bloomMonthFromBloomTime(bloomTime) {
  if (!bloomTime?.length) return null;
  const months = [...new Set(bloomTime.map((m) => MONTH_NUMBER[m.slice(0, 3).toLowerCase()]).filter(Boolean))].sort(
    (a, b) => a - b,
  );
  if (!months.length) return null;
  if (months.length === 1) return String(months[0]);
  // Ascending sort means a Dec-Jan wrap never satisfies "prev===12 && m===1"
  // here (12 is always last, never immediately before 1) — see the doc
  // comment above; this mirrors parseSeasonPhrase's own behavior rather than
  // fixing it independently.
  const contiguous = months.every((m, i) => i === 0 || m === months[i - 1] + 1);
  return contiguous ? `${months[0]}-${months[months.length - 1]}` : months.join(',');
}

/** deer_resistance is free text on NPIN ("Moderate", "No") — slugified, not mapped to a controlled vocabulary NPIN doesn't publish. */
export function deerResistanceSlug(raw) {
  if (!raw) return null;
  return raw.toLowerCase().trim().replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------
// Ingest

export const NPIN_CLAIM_FIELDS = ['sun_pref', 'water_pref', 'soil_pref', 'bloom_month', 'deer_resistance', 'larval_host_species'];

function citationFor(symbolOrNote) {
  return `npin:result.php:${symbolOrNote}`;
}

/** Find or create the single NPIN license row (04 §3.2), the conditional grant permission-requests.md §2 records (2026-08-28 reply). */
function ensureNpinLicense(db) {
  const existing = db.prepare("SELECT id FROM licenses WHERE source = 'npin'").get();
  if (existing) return existing.id;
  const result = db
    .prepare('INSERT INTO licenses (source, "grant", condition, citation_required) VALUES (?, ?, ?, ?)')
    .run('npin', 'personal-noncommercial', 'void if project becomes commercial', 'Courtesy of Lady Bird Johnson Wildflower Center');
  return Number(result.lastInsertRowid);
}

function insertClaim(db, { speciesId, field, value, status, citation, retrievedAt, licenseId }) {
  db.prepare(
    `INSERT INTO claims (species_id, field, value, status, source, citation, retrieved_at, license_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(speciesId, field, value ?? null, status, SOURCE.NPIN, citation ?? null, retrievedAt, licenseId);
}

function writeUnknownForAllFields(db, { speciesId, citation, retrievedAt, licenseId }) {
  for (const field of NPIN_CLAIM_FIELDS) {
    insertClaim(db, { speciesId, field, value: null, status: 'unknown', citation, retrievedAt, licenseId });
  }
  return NPIN_CLAIM_FIELDS.length;
}

/**
 * Ingest NPIN-sourced claims for every taxon in plantable_core (04 §3.1, 02
 * §2.3, 10 §3.3). Pure-insert: never touches an existing claims row.
 *
 * `client` needs fetchSpeciesPage(usdaSymbol) -> html text (npinClient.js's
 * NpinClient contract) and, optionally, a `requestDelayMs` property this
 * function reads back into the crawl-rate report (AC3) — a stub satisfying
 * just fetchSpeciesPage is enough to test this without the network (see
 * tests/npinIngest.test.js).
 *
 * Cultivars are skipped outright (02 §4: NPIN keys on the species, same as
 * USDA) — a cultivar inherits by the read-time walk (04 §2.3), not a copied
 * row here. A taxon with no `usda_symbol` yet (USDA ingest hasn't resolved
 * it, or never will) can't be looked up at all — NPIN's URL keys on that
 * symbol directly, no name-matching fallback exists (02 §2.3's own strongest
 * finding) — so it gets an explicit `unknown`, not a skip.
 */
export async function ingestNpinClaims(db, { client, now = () => new Date().toISOString() } = {}) {
  const licenseId = ensureNpinLicense(db);

  const taxa = db
    .prepare(
      `SELECT t.id AS id, t.scientific_name AS scientific_name, t.rank AS rank, t.usda_symbol AS usda_symbol
       FROM plantable_core pc JOIN taxa t ON t.id = pc.taxa_id`,
    )
    .all();

  const counts = {
    speciesTotal: taxa.length,
    cultivarsSkipped: 0,
    noSymbol: 0,
    fetchFailed: 0,
    pageUnresolved: 0,
    pageResolved: 0,
    claimsInserted: 0,
    requestDelayMs: client?.requestDelayMs ?? null,
  };

  const startedAt = Date.now();

  for (const taxon of taxa) {
    // 02 §4: NPIN, like USDA, keys on the species — a cultivar has no page
    // of its own to resolve.
    if (taxon.rank === 'cultivar') {
      counts.cultivarsSkipped += 1;
      continue;
    }

    if (!taxon.usda_symbol) {
      counts.noSymbol += 1;
      counts.claimsInserted += writeUnknownForAllFields(db, {
        speciesId: taxon.id,
        citation: citationFor(`no-usda-symbol:${taxon.scientific_name}`),
        retrievedAt: now(),
        licenseId,
      });
      continue;
    }

    const retrievedAt = now();
    let html;
    try {
      html = await client.fetchSpeciesPage(taxon.usda_symbol);
    } catch {
      // A fetch failure is "we couldn't check", never "no field exists" —
      // same reasoning as usdaIngest.js's county-presence catch block.
      counts.fetchFailed += 1;
      counts.claimsInserted += writeUnknownForAllFields(db, {
        speciesId: taxon.id,
        citation: citationFor(taxon.usda_symbol),
        retrievedAt,
        licenseId,
      });
      continue;
    }

    if (!html || !isResolvedSpeciesPage(html)) {
      // The symbol 302-redirected to the search page (or NPIN's id for this
      // species just isn't its USDA symbol — measured to happen, see the
      // module header) — NPIN has no page reachable by this key, not "no
      // record for this field."
      counts.pageUnresolved += 1;
      counts.claimsInserted += writeUnknownForAllFields(db, {
        speciesId: taxon.id,
        citation: citationFor(`unresolved:${taxon.usda_symbol}`),
        retrievedAt,
        licenseId,
      });
      continue;
    }

    counts.pageResolved += 1;
    const citation = citationFor(taxon.usda_symbol);
    const fields = parseNpinFields(html);

    const values = {
      sun_pref: sunPrefFromLight(fields.lightRequirement),
      water_pref: waterPrefFromWaterUse(fields.waterUse),
      soil_pref: soilPrefFromDescription(fields.soilDescription),
      bloom_month: bloomMonthFromBloomTime(fields.bloomTime),
      deer_resistance: deerResistanceSlug(fields.deerResistant),
      larval_host_species: fields.larvalHost,
    };

    for (const field of NPIN_CLAIM_FIELDS) {
      const value = values[field];
      // Page resolved but this one field is genuinely absent from it — no
      // claim asserted, not 'unknown' (usdaIngest.js's same convention for a
      // blank characteristic on an otherwise-present record).
      if (value === null || value === undefined || value === '') continue;
      insertClaim(db, { speciesId: taxon.id, field, value: String(value), status: 'asserted', citation, retrievedAt, licenseId });
      counts.claimsInserted += 1;
    }
  }

  counts.elapsedMs = Date.now() - startedAt;
  const attempted = counts.speciesTotal - counts.cultivarsSkipped - counts.noSymbol;
  // AC3: record the crawl rate used and whether it sufficed for the volume —
  // a human-readable summary alongside the counts, not a pass/fail bool,
  // since "sufficed" is a judgment call (elapsed time vs. how often this
  // needs to re-run) rather than something this function can decide.
  counts.crawlSummary =
    `${counts.pageResolved}/${attempted} species pages fetched in ${counts.elapsedMs}ms ` +
    `at ${counts.requestDelayMs ?? 'unknown'}ms/request; ${counts.fetchFailed} fetch failures, ` +
    `${counts.pageUnresolved} symbols that didn't resolve to a page.`;

  return { ...counts, licenseId };
}
