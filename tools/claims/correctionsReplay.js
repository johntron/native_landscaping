// Replay of manual-corrections.tsv (09 §2/§2.1). Runs LAST in a rebuild, after
// every sourced claim is ingested — replaying first would let a fresh crawl
// re-claim the top of the precedence order and silently undo a correction.
//
// File format (09 §2), tab-separated, header row, one correction per physical
// line, no embedded newlines in any field:
//   usda_symbol  field  value  reason  author  date  supersedes_source
// A cultivar correction keys on "SYMBOL 'CultivarName'" (04 §2.3's pairing).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../src/data/csvLoader.js';
import { ensureTaxon } from './taxaSeed.js';

const REQUIRED_COLUMNS = ['usda_symbol', 'field', 'value', 'reason', 'author', 'date', 'supersedes_source'];

const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('../../catalog/blackland-prairie-natives.csv', import.meta.url));

/**
 * A correction can target a species outside today's plantable_core (10 §2.2) —
 * e.g. one of these 7 seed corrections says a species should NOT be in the
 * core, so it was never seeded into `taxa` by seedPlantableCore in the first
 * place. The catalog (blackland-prairie-natives.csv, 469 rows with
 * usda_symbol) is the wider identity source: build a symbol -> botanical_name
 * lookup from it, lazily, only when a correction's symbol isn't already a
 * taxa row.
 */
function loadCatalogNameBySymbol(catalogPath) {
  if (!existsSync(catalogPath)) return { nameBySymbol: new Map(), usdaSymbolByName: new Map() };
  const rows = parseCsv(readFileSync(catalogPath, 'utf8'));
  const nameBySymbol = new Map();
  const usdaSymbolByName = new Map();
  for (const row of rows) {
    if (!row.usda_symbol) continue;
    nameBySymbol.set(row.usda_symbol, row.botanical_name.trim());
    usdaSymbolByName.set(row.botanical_name.trim(), row.usda_symbol);
  }
  return { nameBySymbol, usdaSymbolByName };
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line, i) => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((key, idx) => (row[key] = (cells[idx] ?? '').trim()));
    row.__line = i + 2; // 1-indexed, plus the header row
    return row;
  });
}

/**
 * Resolve a manual-correction's usda_symbol column to a taxa row. Rejects,
 * never guesses — except that a plain (non-cultivar) symbol not yet in
 * `taxa` is created from the wider catalog if it's a known species there,
 * since a correction may target a species outside today's plantable_core.
 */
function resolveTaxon(db, usdaSymbol, catalog) {
  const cultivarMatch = usdaSymbol.match(/^(\S+)\s+'([^']+)'$/);
  if (cultivarMatch) {
    const [, symbol, cultivarName] = cultivarMatch;
    return db
      .prepare("SELECT id FROM taxa WHERE usda_symbol = ? AND rank = 'cultivar' AND scientific_name LIKE ?")
      .get(symbol, `% '${cultivarName}'`);
  }

  const existing = db.prepare('SELECT id FROM taxa WHERE usda_symbol = ?').get(usdaSymbol);
  if (existing) return existing;

  const catalogName = catalog.nameBySymbol.get(usdaSymbol);
  if (!catalogName) return undefined;
  const id = ensureTaxon(db, catalogName, catalog.usdaSymbolByName);
  return { id };
}

/**
 * Replay manual-corrections.tsv into `claims`. A missing file is a no-op (the
 * file doesn't exist yet in this repo — nl-scx.1 wires the ordering, it does
 * not author the file). Any invalid row throws with every problem found,
 * rather than importing an unattributed or unresolvable edit (09 §2).
 */
export function replayManualCorrections(db, correctionsPath, catalogPath = DEFAULT_CATALOG_PATH) {
  if (!existsSync(correctionsPath)) return { applied: 0 };

  const catalog = loadCatalogNameBySymbol(catalogPath);
  const rows = parseTsv(readFileSync(correctionsPath, 'utf8'));
  const errors = [];
  const retrievedAt = new Date().toISOString();

  db.exec('BEGIN');
  try {
    let applied = 0;
    for (const row of rows) {
      for (const col of REQUIRED_COLUMNS) {
        if (col === 'supersedes_source') continue; // optional: a field with no prior claim has nothing to supersede
        if (col === 'date') continue; // provenance only, not load-bearing
        if (!row[col]) errors.push(`line ${row.__line}: missing required column "${col}"`);
      }
      if (errors.length) continue;

      const taxon = resolveTaxon(db, row.usda_symbol, catalog);
      if (!taxon) {
        errors.push(`line ${row.__line}: usda_symbol "${row.usda_symbol}" does not resolve to any taxa row`);
        continue;
      }

      let targetClaim = null;
      if (row.supersedes_source) {
        targetClaim = db
          .prepare(
            'SELECT id FROM claims WHERE species_id = ? AND field = ? AND source = ? AND superseded_by IS NULL',
          )
          .get(taxon.id, row.field, row.supersedes_source);
        if (!targetClaim) {
          errors.push(
            `line ${row.__line}: supersedes_source "${row.supersedes_source}" names no un-superseded claim for ` +
              `(${row.usda_symbol}, ${row.field})`,
          );
          continue;
        }
      }

      const inserted = db
        .prepare(
          `INSERT INTO claims (species_id, field, value, status, source, citation, retrieved_at)
           VALUES (?, ?, ?, 'asserted', 'manual-correction', ?, ?)`,
        )
        .run(taxon.id, row.field, row.value, `${row.reason} — ${row.author}`, retrievedAt);

      if (targetClaim) {
        db.prepare('UPDATE claims SET superseded_by = ? WHERE id = ?').run(Number(inserted.lastInsertRowid), targetClaim.id);
      }
      applied += 1;
    }

    if (errors.length) throw new Error(`manual-corrections.tsv is invalid:\n${errors.join('\n')}`);

    db.exec('COMMIT');
    return { applied };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
