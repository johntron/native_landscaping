// Identity seeding for the plantable core (04 §2.2, 10 §2.2). This is not claim
// ingestion — it gives the plantable set rows to *be* a set of, from the two
// already-curated catalogs the doc measured (plants.csv, and
// blackland-prairie-natives.csv rows with npsot_dfw_recommended='yes'). Real
// per-field claims (USDA, NPIN, the flora) are nl-scx.2/.4's job.
import { readFileSync } from 'node:fs';
import { parseCsv } from '../../src/data/csvLoader.js';

const CULTIVAR_RE = /^(.*?)\s*'([^']+)'\s*$/;
const INFRA_RE = /^(.+?)\s+(?:var|subsp)\.\s+\S+/;

/**
 * Classify a catalog botanical_name string into { rank, parentName }.
 * parentName is the species-level binomial a cultivar or variety/subspecies
 * hangs off of (04 §2.2: parent_id always points at the species row, even for
 * a named cultivar of a named variety — the intermediate variety is not
 * separately modeled unless it appears as its own catalog row).
 */
export function classifyName(botanicalName) {
  const name = botanicalName.trim();
  const cultivarMatch = name.match(CULTIVAR_RE);
  if (cultivarMatch) {
    const withoutCultivar = cultivarMatch[1].trim();
    const infraMatch = withoutCultivar.match(INFRA_RE);
    const parentName = infraMatch ? infraMatch[1].trim() : withoutCultivar;
    return { rank: 'cultivar', parentName };
  }
  const infraMatch = name.match(INFRA_RE);
  if (infraMatch) {
    return { rank: name.includes(' subsp. ') ? 'subspecies' : 'variety', parentName: infraMatch[1].trim() };
  }
  return { rank: 'species', parentName: null };
}

/** Ensure a taxa row exists for `scientificName`, creating parent rows first as needed. Returns the taxa id. */
function ensureTaxon(db, scientificName, usdaSymbolByName) {
  const existing = db.prepare('SELECT id FROM taxa WHERE scientific_name = ?').get(scientificName);
  if (existing) return existing.id;

  const { rank, parentName } = classifyName(scientificName);
  const parentId = parentName ? ensureTaxon(db, parentName, usdaSymbolByName) : null;
  const usdaSymbol = usdaSymbolByName.get(scientificName) ?? null;

  const result = db
    .prepare('INSERT INTO taxa (scientific_name, rank, parent_id, usda_symbol) VALUES (?, ?, ?, ?)')
    .run(scientificName, rank, parentId, usdaSymbol);
  return Number(result.lastInsertRowid);
}

/**
 * Seed taxa + plantable_core from plants.csv and blackland-prairie-natives.csv,
 * reproducing 10 §2.2's derivation: plants.csv ∪ {blackland rows with
 * npsot_dfw_recommended='yes'}, de-duplicated by exact botanical_name (the
 * doc's own measurement dedups at the name-string level, not the species-concept
 * level, so a variety/cultivar counts as its own plantable_core member).
 */
export function seedPlantableCore(db, { plantsCsvPath, blacklandCsvPath }) {
  const plants = parseCsv(readFileSync(plantsCsvPath, 'utf8'));
  const blackland = parseCsv(readFileSync(blacklandCsvPath, 'utf8'));
  const npsotYes = blackland.filter((row) => row.npsot_dfw_recommended === 'yes');

  const usdaSymbolByName = new Map();
  for (const row of blackland) {
    if (row.usda_symbol) usdaSymbolByName.set(row.botanical_name.trim(), row.usda_symbol);
  }

  const bySource = new Map(); // botanical_name -> source label
  for (const row of plants) bySource.set(row.botanical_name.trim(), 'plants.csv');
  for (const row of npsotYes) {
    const name = row.botanical_name.trim();
    if (!bySource.has(name)) bySource.set(name, 'npsot_dfw_recommended');
  }

  for (const [name, source] of bySource) {
    const taxaId = ensureTaxon(db, name, usdaSymbolByName);
    db.prepare('INSERT OR IGNORE INTO plantable_core (taxa_id, source) VALUES (?, ?)').run(taxaId, source);
  }

  return bySource.size;
}
