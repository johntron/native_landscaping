// Name reconciliation (nl-scx.3), implementing
// docs/data-acquisition/06-name-reconciliation.md §3's algorithm, steps 1, 2,
// and 6 only. Steps 3-5 (the USDA-synonym network path) are deliberately not
// built here — 06 §3's MEASUREMENT GATE requires counting how much of the
// gap step 2 alone closes before that path is built. A name step 1/2 can't
// place lands at matched_via='unmatched', status='unknown', same as a
// genuine no-treatment case (03 §5) — not a guess.
//
// 06 §6's two OPEN control-set rows, per nl-scx.3's AC: the infraspecific
// partial-match row is now filled from a real corpus hit (see
// tests/nameReconciliation.test.js's Aristida purpurea var. longiseta case).
// The ambiguous-USDA-name row (06 §3 step 3: alternatives but no exact
// match) genuinely needs the network path this bead does not build — it
// stays OPEN, deferred to whichever bead builds steps 3-5 next, per the
// measurement-gate reasoning above rather than fabricated here.
import { headingKey, speciesKeyOf } from './floraCorpus.js';
import { ensureTaxon } from './taxaSeed.js';

const NAME_RE = /^(\S+)\s+(\S+)(?:\s+(var\.|subsp\.)\s+(\S+))?/;

/** Parse a catalog botanical_name into the pieces reconcile() and headingKey() need. */
export function parseCatalogName(botanicalName) {
  const match = botanicalName.trim().match(NAME_RE);
  if (!match) return null;
  const [, genus, species, rankToken, infraEpithet] = match;
  const rank = rankToken === 'var.' ? 'variety' : rankToken === 'subsp.' ? 'subspecies' : 'species';
  return { genus, species, rank, infraEpithet: infraEpithet ?? null };
}

/**
 * reconcile(catalog_name, rank, infra_epithet) -> { flora_key, matched_via, status }
 * per 06 §3. Rank-aware (step 1), then the flora's own synonym crosswalk
 * (step 2), falling back to the species-level heading for an infraspecific
 * name with no infraspecific treatment (§4's partial match — status
 * 'review', never silently 'asserted'), and finally 'unmatched'/'unknown'
 * (step 6, steps 3-5 not built).
 */
export function reconcile(catalogName, rank, infraEpithet, floraIndex) {
  const parsed = parseCatalogName(catalogName);
  if (!parsed) return { flora_key: null, matched_via: 'unmatched', status: 'unknown' };
  const { genus, species } = parsed;
  const key = headingKey(genus, species, rank, infraEpithet);

  if (floraIndex.headingIndex.has(key)) {
    return { flora_key: key, matched_via: 'direct', status: 'asserted' };
  }
  if (floraIndex.synonymIndex.has(key)) {
    return { flora_key: floraIndex.synonymIndex.get(key).key, matched_via: 'flora-synonym', status: 'asserted' };
  }

  if (rank !== 'species') {
    const spKey = speciesKeyOf(key);
    if (floraIndex.headingIndex.has(spKey)) {
      return { flora_key: spKey, matched_via: 'direct', status: 'review' };
    }
    if (floraIndex.synonymIndex.has(spKey)) {
      return { flora_key: floraIndex.synonymIndex.get(spKey).key, matched_via: 'flora-synonym', status: 'review' };
    }
  }

  return { flora_key: null, matched_via: 'unmatched', status: 'unknown' };
}

function scientificNameFor(record) {
  if (record.rank === 'species') return `${record.genus} ${record.species}`;
  const abbrev = record.rank === 'variety' ? 'var.' : 'subsp.';
  return `${record.genus} ${record.species} ${abbrev} ${record.infraEpithet}`;
}

/**
 * Ensure a taxa row exists for the flora heading `record` resolved, and
 * point it at the catalog's canonical row (06 §5's worked example: the old
 * name is its own taxa row with resolves_to set, not the other way around).
 * A same-name match (direct, no synonymy) needs no separate row — returns
 * canonicalTaxaId unchanged.
 */
function ensureFloraNameTaxon(db, record, canonicalTaxaId, canonicalKey, usdaSymbolByName) {
  if (record.key === canonicalKey) return canonicalTaxaId;
  const name = scientificNameFor(record);
  const floraTaxaId = ensureTaxon(db, name, usdaSymbolByName);
  if (floraTaxaId !== canonicalTaxaId) {
    db.prepare('UPDATE taxa SET resolves_to = ? WHERE id = ? AND resolves_to IS NULL').run(canonicalTaxaId, floraTaxaId);
  }
  return floraTaxaId;
}

/**
 * Run reconcile() over every non-cultivar row of `catalogRows` (06 §7:
 * cultivars are out of scope — no taxonomic work treats one) and write one
 * name_reconciliations row per taxon, corpus = 'nctx-flora-1999' (06 §5).
 * Ensures a taxa row for every catalog entry, independent of
 * plantable_core membership, same reasoning as correctionsReplay's
 * catalog-wide taxon resolution.
 */
export function reconcileCatalog(db, catalogRows, floraIndex) {
  const usdaSymbolByName = new Map();
  for (const row of catalogRows) {
    if (row.usda_symbol) usdaSymbolByName.set(row.botanical_name.trim(), row.usda_symbol);
  }

  const counts = { direct: 0, 'flora-synonym': 0, unmatched: 0, review: 0 };
  const insert = db.prepare(
    `INSERT INTO name_reconciliations (taxa_id, corpus, matched_via, flora_taxa_id, reviewed)
     VALUES (?, 'nctx-flora-1999', ?, ?, 0)
     ON CONFLICT (taxa_id, corpus) DO UPDATE SET matched_via = excluded.matched_via, flora_taxa_id = excluded.flora_taxa_id`,
  );

  for (const row of catalogRows) {
    const parsed = parseCatalogName(row.botanical_name);
    if (!parsed) continue;
    const { rank } = parsed;
    if (rank === 'cultivar') continue;
    // classifyName (taxaSeed.js) is the authority on cultivar-vs-not; this
    // module's own NAME_RE never returns 'cultivar', but botanical_name may
    // still carry a cultivar suffix ("Ilex vomitoria 'Nana'") that NAME_RE
    // simply doesn't have a var./subsp. token for — skip those explicitly.
    if (row.botanical_name.includes("'")) continue;

    const canonicalTaxaId = ensureTaxon(db, row.botanical_name.trim(), usdaSymbolByName);
    const canonicalKey = headingKey(parsed.genus, parsed.species, parsed.rank, parsed.infraEpithet);
    const result = reconcile(row.botanical_name, parsed.rank, parsed.infraEpithet, floraIndex);

    let floraTaxaId = null;
    if (result.matched_via !== 'unmatched') {
      // Every flora_key reconcile() returns is a heading's own key, and every
      // heading is registered in headingIndex under that same key (both by
      // buildFloraIndex directly, and via synonymIndex pointing at the same
      // record) — so this lookup always succeeds for a non-'unmatched' result.
      const record = floraIndex.headingIndex.get(result.flora_key);
      floraTaxaId = ensureFloraNameTaxon(db, record, canonicalTaxaId, canonicalKey, usdaSymbolByName);
    }

    insert.run(canonicalTaxaId, result.matched_via, floraTaxaId);
    counts[result.matched_via] += 1;
    if (result.status === 'review') counts.review += 1;
  }

  return counts;
}
