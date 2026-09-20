// Flora header/synonym-crosswalk parsing (nl-scx.3), implementing
// docs/data-acquisition/06-name-reconciliation.md §2-3 step 1-2 and
// docs/data-acquisition/03-document-corpus.md §6's header-scan rules.
//
// The corpus is docs/data-acquisition/corpus/FNCT_*.txt — pdftotext -layout
// dumps of Diggs, Lipscomb & O'Kennon 1999. A treatment is one blank-line-
// delimited block starting with a rank-aware heading ("Genus species (Auth.),
// ... COMMON NAME." or the var./subsp. form); its trailing bracketed name
// list is the flora's own synonym crosswalk (06 §2).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CORPUS_DIR = fileURLToPath(new URL('../../docs/data-acquisition/corpus/', import.meta.url));

export function loadCorpusText(dir = DEFAULT_CORPUS_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort();
  return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n\n');
}

const VOLUME_FILENAME_RE = /^FNCT_(\d+)-(\d+)-/;

/**
 * Load each volume separately, keeping the filename's first-page number (03
 * §2: `page = first_page_in_filename + formfeed_index`) — needed for
 * floraNativity's citation, which loadCorpusText's single joined string
 * throws away.
 */
export function loadCorpusVolumes(dir = DEFAULT_CORPUS_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort();
  return files.map((f) => {
    const match = VOLUME_FILENAME_RE.exec(f);
    if (!match) throw new Error(`corpus file ${f} does not match the FNCT_<first>-<last>-... naming convention`);
    return { filename: f, firstPage: Number(match[1]), text: readFileSync(join(dir, f), 'utf8') };
  });
}

/** A heading key is rank-aware and case/whitespace-normalized for lookup. */
export function headingKey(genus, species, rank, infraEpithet) {
  const base = `${genus} ${species}`.toLowerCase();
  if (rank === 'species') return base;
  const abbrev = rank === 'variety' ? 'var.' : 'subsp.';
  return `${base} ${abbrev} ${infraEpithet.toLowerCase()}`;
}

/** The species-rank key for a variety/subspecies key — used for §4's partial-match check. */
export function speciesKeyOf(key) {
  return key.split(/\s+(?:var\.|subsp\.)\s+/)[0];
}

// A heading starts a block: "Genus species [var./subsp. epithet] (author or
// parenthetical or common name)". Matched against the block's first ~400
// chars with internal newlines collapsed to spaces, so a wrapped heading
// (03 §6's hazard — "Bothriochloa ischaemum (L.) Keng var. songarica
// (Rupr. ex ...) Celerier &\nHarlan, ...") still matches.
const HEADING_RE =
  /^([A-Z][a-zà-ÿ]+)\s+(?:×\s*)?([a-z][a-zà-ÿ-]+)(?:[^,]{0,60}?\s(var\.|subsp\.)\s([a-z][a-zà-ÿ-]+))?[^,]{0,80}?,\s/;

function classifyRank(rankToken) {
  if (rankToken === 'var.') return 'variety';
  if (rankToken === 'subsp.') return 'subspecies';
  return 'species';
}

/**
 * Build the genus dictionary used to split a glued genus+species synonym
 * (03 §6 / 06 §2's measured hazard, e.g. "Symphyotrichumlateriflorum") —
 * derived from the catalog's own botanical names, since a glued name only
 * matters here if it resolves to a genus this project already tracks.
 */
export function buildGenusDictionary(catalogRows) {
  const genera = new Set();
  for (const row of catalogRows) {
    const genus = row.botanical_name?.trim().split(/\s+/)[0];
    if (genus && /^[A-Z][a-z]+$/.test(genus)) genera.add(genus);
  }
  return genera;
}

/** Split a glued "Symphyotrichumlateriflorum"-shaped token via the genus dictionary. Longest genus wins. */
function splitGlued(token, genusDictionary) {
  let best = null;
  for (const genus of genusDictionary) {
    if (token.startsWith(genus) && token.length > genus.length + 2) {
      if (!best || genus.length > best.length) best = genus;
    }
  }
  if (!best) return null;
  const species = token.slice(best.length);
  if (!/^[a-zà-ÿ-]+$/.test(species)) return null;
  return { genus: best, species };
}

/**
 * Extract every synonym name (rank-aware) from one treatment block's
 * bracketed lists (06 §2 step 2). Brackets may appear mid-block (a trailing
 * remark can follow, e.g. Aster lateriflorus's "... Löve] Because of
 * intergradation ..."), so every `[...]` in the block is scanned, not just
 * the last. An abbreviated genus ("A. hesperius") expands to the block's own
 * heading genus, matching the flora's own convention of abbreviating within
 * a treatment it belongs to.
 */
function extractSynonyms(blockText, headingGenus, genusDictionary) {
  const synonyms = [];
  const bracketRe = /\[([^\]]+)\]/g;
  let bracketMatch;
  while ((bracketMatch = bracketRe.exec(blockText))) {
    const content = bracketMatch[1].replace(/\s+/g, ' ');
    // Full "Genus species [var./subsp. epithet]" or abbreviated "G. species ...".
    const nameRe =
      /\b([A-Z][a-zà-ÿ]+|[A-Z])\.?\s+([a-z][a-zà-ÿ-]+)(?:\s+(var\.|subsp\.)\s+([a-z][a-zà-ÿ-]+))?/g;
    let nameMatch;
    while ((nameMatch = nameRe.exec(content))) {
      const [, genusToken, species, rankToken, infraEpithet] = nameMatch;
      const genus = genusToken.length === 1 ? headingGenus : genusToken;
      if (genusToken.length === 1 && !headingGenus.startsWith(genus)) continue;
      synonyms.push({ genus, species, rank: classifyRank(rankToken), infraEpithet: infraEpithet ?? null });
    }
    // Glued genus+species tokens the spaced regex above cannot see, e.g.
    // "Symphyotrichumlateriflorum" — scan long capitalized runs separately.
    const gluedRe = /\b[A-Z][a-zà-ÿ]{9,}\b/g;
    let gluedMatch;
    while ((gluedMatch = gluedRe.exec(content))) {
      const split = splitGlued(gluedMatch[0], genusDictionary);
      if (split) synonyms.push({ genus: split.genus, species: split.species, rank: 'species', infraEpithet: null });
    }
  }
  return synonyms;
}

/**
 * Test whether `blockText` opens a treatment (03 §6's heading rule, applied
 * to a blank-line-delimited block). Shared by buildFloraIndex (06 §3 step 1)
 * and floraNativity's span builder (03 §4/§6) so the two never drift apart
 * on what counts as a heading.
 */
export function matchHeadingBlock(blockText) {
  const flatStart = blockText.slice(0, 400).replace(/\s+/g, ' ').trim();
  const match = HEADING_RE.exec(flatStart);
  if (!match) return null;
  const [, genus, species, rankToken, infraEpithet] = match;
  const rank = classifyRank(rankToken);
  return { genus, species, rank, infraEpithet: infraEpithet ?? null, key: headingKey(genus, species, rank, infraEpithet) };
}

/**
 * Parse the corpus into { headingIndex, synonymIndex }, both
 * Map<headingKey, { key, genus, species, rank, infraEpithet }> — the
 * treatment's own key. headingIndex is the direct-match index (06 §3 step
 * 1); synonymIndex is the flora's own crosswalk (step 2): every bracketed
 * name maps to the treatment that cites it, not to itself.
 */
export function buildFloraIndex(text, genusDictionary) {
  const headingIndex = new Map();
  const synonymIndex = new Map();
  const blocks = text.split(/\n\s*\n+/);

  for (const block of blocks) {
    const heading = matchHeadingBlock(block);
    if (!heading) continue;
    const { key, genus } = heading;
    const record = { key, genus: heading.genus, species: heading.species, rank: heading.rank, infraEpithet: heading.infraEpithet };
    // First heading wins on a duplicate key (e.g. running headers reprinted) —
    // do not let a later false-positive block clobber a real treatment.
    if (!headingIndex.has(key)) headingIndex.set(key, record);

    for (const syn of extractSynonyms(block, genus, genusDictionary)) {
      const synKey = headingKey(syn.genus, syn.species, syn.rank, syn.infraEpithet);
      if (!synonymIndex.has(synKey)) synonymIndex.set(synKey, record);
    }
  }

  return { headingIndex, synonymIndex };
}
