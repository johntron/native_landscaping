// USDA ingest (nl-scx.2): turns tools/usda-plants's existing fetch path into
// claim rows in data/claims.db, implementing
// docs/data-acquisition/04-data-model.md §3.1 (citation shape), §3.2 (license
// row), docs/data-acquisition/02-source-inventory.md §2.1 (USDA is PRIMARY
// for county distribution and the 81 characteristics), and
// docs/data-acquisition/10-prioritization.md §2.1 (county presence is a
// gate, never a ranking signal).
//
// Pure-insert (AC2): every write here is an INSERT into claims, never an
// UPDATE or DELETE. Re-running this module against an already-ingested store
// adds a fresh set of rows, dated by their own retrieved_at, rather than
// touching what is already there — exactly the "nothing overwritten on
// ingest" rule 04 §3.1 states for the whole table.
import { searchByNames } from '../usda-plants/search.js';
import { mapPlantToIntermediateRow } from '../usda-plants/mapCharacteristics.js';
import { parseCsv } from '../../src/data/csvLoader.js';
import { SOURCE } from './precedence.js';

// Identity fields: already modeled in `taxa`, not claims.
const IDENTITY_KEYS = new Set(['id', 'common_name', 'botanical_name', 'usda_symbol', 'usda_scientific_name_full']);

// mapPlantToIntermediateRow hardcodes these to null — there is no USDA
// content behind them (they exist for the LLM/human augmentation pass
// mapCharacteristics.js documents, not for this ingest).
const PLACEHOLDER_KEYS = new Set([
  'width_ft',
  'foliage_color_spring',
  'foliage_color_fall',
  'foliage_color_winter',
  'inflorescence',
  'flower_count_hint',
  'flower_zone',
]);

// nl-yud's own caveat: these 9 fields were sampled on ONE species (Quercus
// shumardii) and must not be asserted as claims until a broad-population
// probe confirms they're actually filled, not mostly-empty (nl-scx.2's
// comment thread). This ingest run doubles as that probe — see
// `NL_YUD_FIELDS` below and the fill-rate counters — but does not assert
// from them.
const NL_YUD_DEFERRED_KEYS = new Set([
  'usda_commercial_availability',
  'usda_toxicity',
  'usda_lifespan',
  'usda_vegetative_spread_rate',
  'usda_seed_spread_rate',
  'usda_resprout_ability',
  'usda_fruit_seed_persistence',
  'usda_growth_rate',
  'usda_height_20yr_max_ft',
]);

// The USDA characteristic names nl-yud added, for the fill-rate probe.
const NL_YUD_FIELDS = [
  'Commercial Availability',
  'Toxicity',
  'Lifespan',
  'Vegetative Spread Rate',
  'Seed Spread Rate',
  'Resprout Ability',
  'Fruit/Seed Persistence',
  'Growth Rate',
  'Height at 20 Years, Maximum',
];

// mapPlantToIntermediateRow's remaining keys come from one of two USDA
// endpoints. Everything not listed here defaults to 'characteristics' —
// PlantCharacteristics is where the bulk of the 81-field response lives.
const PROFILE_DERIVED_KEYS = new Set(['growth_shape', 'usda_growth_habit', 'usda_native_status']);

/** Ordered list of claim fields this ingest can assert, for the "no record" unknown pass. */
export const CLAIM_FIELDS = Object.keys(mapPlantToIntermediateRow({ GrowthHabits: [] }, [])).filter(
  (key) => !IDENTITY_KEYS.has(key) && !PLACEHOLDER_KEYS.has(key) && !NL_YUD_DEFERRED_KEYS.has(key),
);

function endpointFor(field) {
  return PROFILE_DERIVED_KEYS.has(field) ? 'profile' : 'characteristics';
}

function citationFor(endpoint, symbolOrName) {
  const endpointName = { profile: 'PlantProfile', characteristics: 'PlantCharacteristics', county: 'getDownloadDistributionDocumentation' }[
    endpoint
  ];
  return `usda-plants:${endpointName}:${symbolOrName}`;
}

/** Find or create the single USDA license row (04 §3.2): unrestricted, no condition — public domain, 02 §2.1. */
function ensureUsdaLicense(db) {
  const existing = db.prepare("SELECT id FROM licenses WHERE source = 'usda-plants'").get();
  if (existing) return existing.id;
  const result = db
    .prepare('INSERT INTO licenses (source, "grant", condition, citation_required) VALUES (?, ?, NULL, NULL)')
    .run('usda-plants', 'unrestricted');
  return Number(result.lastInsertRowid);
}

/**
 * Dallas Co., TX (FIPS 48113 = State FIP 48 + County FIP 113) presence, from
 * the getDownloadDistributionDocumentation CSV (01 §3.1). Matches on the
 * numeric FIP columns, not the county/state name strings.
 */
export function hasDallasCounty(distributionCsvText) {
  // First line is a title ("Distribution Data"), not a header — drop it.
  const withoutTitle = distributionCsvText.replace(/^[^\n]*\n/, '');
  const rows = parseCsv(withoutTitle);
  return rows.some((row) => row['State FIP']?.trim() === '48' && row['County FIP']?.trim() === '113');
}

function insertClaim(db, { speciesId, field, value, status, source, citation, retrievedAt, licenseId }) {
  db.prepare(
    `INSERT INTO claims (species_id, field, value, status, source, citation, retrieved_at, license_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(speciesId, field, value ?? null, status, source, citation ?? null, retrievedAt, licenseId);
}

/**
 * Ingest USDA-sourced claims for every taxon in plantable_core (04 §3.1, 02
 * §2.1, 10 §2.1). Pure-insert: never touches an existing claims row.
 *
 * `client` needs getProfile(id)/getCharacteristics(id)/getDistributionCsv(id)
 * and search.js's searchByNames(client, names) contract — a stub satisfying
 * that shape is enough to test this without the network (see
 * tests/usdaIngest.test.js).
 */
export async function ingestUsdaClaims(db, { client, now = () => new Date().toISOString() } = {}) {
  const licenseId = ensureUsdaLicense(db);

  const taxa = db
    .prepare(
      `SELECT t.id AS id, t.scientific_name AS scientific_name, t.rank AS rank, t.usda_symbol AS usda_symbol
       FROM plantable_core pc JOIN taxa t ON t.id = pc.taxa_id`,
    )
    .all();

  const counts = {
    speciesTotal: taxa.length,
    cultivarsSkipped: 0,
    unresolved: 0,
    noCharacteristicsRecord: 0,
    withCharacteristics: 0,
    claimsInserted: 0,
    countyPresent: 0,
    countyAbsent: 0,
    countyUnknown: 0,
  };
  const nlYudFillRates = Object.fromEntries(NL_YUD_FIELDS.map((name) => [name, 0]));

  for (const taxon of taxa) {
    // 04 §2.3: USDA, NPIN, BONAP, and GBIF all key on the species — a
    // cultivar has no USDA record to resolve. It inherits its parent's
    // claims by the read-time walk, not by a copied or fabricated row here.
    if (taxon.rank === 'cultivar') {
      counts.cultivarsSkipped += 1;
      continue;
    }

    const retrievedAt = now();
    const searchTerm = taxon.usda_symbol || taxon.scientific_name;
    const [match] = await searchByNames(client, [searchTerm]);

    if (!match?.match) {
      counts.unresolved += 1;
      const citation = citationFor('characteristics', `unresolved:${searchTerm}`);
      for (const field of CLAIM_FIELDS) {
        insertClaim(db, {
          speciesId: taxon.id,
          field,
          value: null,
          status: 'unknown',
          source: SOURCE.USDA_CHARACTERISTICS,
          citation,
          retrievedAt,
          licenseId,
        });
        counts.claimsInserted += 1;
      }
      insertClaim(db, {
        speciesId: taxon.id,
        field: 'county_presence_48113',
        value: null,
        status: 'unknown',
        source: SOURCE.USDA_COUNTY,
        citation: citationFor('county', `unresolved:${searchTerm}`),
        retrievedAt,
        licenseId,
      });
      counts.claimsInserted += 1;
      counts.countyUnknown += 1;
      continue;
    }

    const symbol = match.match.Symbol;
    const plantId = match.match.Id;
    if (!taxon.usda_symbol) {
      db.prepare('UPDATE taxa SET usda_symbol = ? WHERE id = ?').run(symbol, taxon.id);
    }

    const profile = await client.getProfile(plantId);
    const characteristics = await client.getCharacteristics(plantId);

    if (characteristics.length === 0) {
      counts.noCharacteristicsRecord += 1;
      const citation = citationFor('characteristics', symbol);
      for (const field of CLAIM_FIELDS) {
        if (endpointFor(field) !== 'characteristics') continue; // profile still answered; handled below
        insertClaim(db, {
          speciesId: taxon.id,
          field,
          value: null,
          status: 'unknown',
          source: SOURCE.USDA_CHARACTERISTICS,
          citation,
          retrievedAt,
          licenseId,
        });
        counts.claimsInserted += 1;
      }
    } else {
      counts.withCharacteristics += 1;
      for (const name of NL_YUD_FIELDS) {
        const has = characteristics.some((c) => c.PlantCharacteristicName === name && c.PlantCharacteristicValue);
        if (has) nlYudFillRates[name] += 1;
      }
    }

    // Profile- and (if present) characteristics-derived fields, via the
    // existing mapper — one place that knows USDA's raw field names, not
    // duplicated here (fetchDetails.js/mapCharacteristics.js already own it).
    const row = mapPlantToIntermediateRow(profile, characteristics);
    for (const field of CLAIM_FIELDS) {
      const endpoint = endpointFor(field);
      if (endpoint === 'characteristics' && characteristics.length === 0) continue; // already written unknown above
      const value = row[field];
      if (value === null || value === undefined || value === '') continue; // no claim asserted for a field this record just doesn't have
      insertClaim(db, {
        speciesId: taxon.id,
        field,
        value: String(value),
        status: 'asserted',
        source: SOURCE.USDA_CHARACTERISTICS,
        citation: citationFor(endpoint, symbol),
        retrievedAt,
        licenseId,
      });
      counts.claimsInserted += 1;
    }

    // County presence (10 §2.1's gate) — its own endpoint, independent of
    // whether a characteristics record exists.
    try {
      const csvText = await client.getDistributionCsv(plantId);
      const present = hasDallasCounty(csvText);
      insertClaim(db, {
        speciesId: taxon.id,
        field: 'county_presence_48113',
        value: present ? 'present' : 'absent',
        status: 'asserted',
        source: SOURCE.USDA_COUNTY,
        citation: citationFor('county', symbol),
        retrievedAt,
        licenseId,
      });
      counts.claimsInserted += 1;
      if (present) counts.countyPresent += 1;
      else counts.countyAbsent += 1;
    } catch (err) {
      // A fetch failure is "we couldn't check", never "absent" — the
      // plantable_set gate only excludes on an asserted 'absent' value, so a
      // network hiccup here must not silently drop a species from the set.
      insertClaim(db, {
        speciesId: taxon.id,
        field: 'county_presence_48113',
        value: null,
        status: 'unknown',
        source: SOURCE.USDA_COUNTY,
        citation: citationFor('county', symbol),
        retrievedAt,
        licenseId,
      });
      counts.claimsInserted += 1;
      counts.countyUnknown += 1;
    }
  }

  return { ...counts, licenseId, nlYudFillRates };
}
