// Flora nativity extraction (nl-scx.4), implementing
// docs/data-acquisition/03-document-corpus.md §2-6 and
// docs/data-acquisition/04-data-model.md §3.3's three-valued status.
//
// Consumes nl-scx.3's name_reconciliations table (matched_via/flora_taxa_id)
// rather than re-reconciling names. Writes one nativity_nctx claim per
// plantable_core taxon:
//   matched_via='unmatched'         -> status='unknown', value=NULL
//   'I' symbol at the treatment end -> status='asserted', value='introduced'
//   origin-phrase or escape/cultivation screen fires -> status='review', no value
//     (03 §4: "prose match => queue for review, never auto-assign" — a
//     candidate value here would just be a stored excerpt by another name,
//     which 03 §2's licensing rule forbids)
//   otherwise (silence)             -> status='asserted', value='native'
//
// LICENSING: only extracted values plus a page citation are ever written —
// never a snippet of flora prose (03 §2). Screen regexes below are published
// in 03 §4/§4.1 and are not themselves excerpted text.
import { matchHeadingBlock, loadCorpusVolumes, DEFAULT_CORPUS_DIR } from './floraCorpus.js';
import { parseCatalogName } from './nameReconciliation.js';
import { headingKey } from './floraCorpus.js';
import { SOURCE } from './precedence.js';

const CITATION_AUTHORS = "Diggs, Lipscomb & O'Kennon 1999";

// 03 §6a: a heading only counts if it follows a blank line — matchHeadingBlock
// already requires this because it's tested per blank-line-delimited block.
// 03 §6b: bound the span at the next heading OR at a genus-level heading or a
// REFERENCES: block, so a genus synopsis (or the next genus's) never bleeds
// into this treatment. A genus-heading block's first line is all-caps prose
// with no digits (e.g. "ENGELMANNIA ENGELMANN'S DAISY, CUT-LEAF DAISY"),
// distinct from a running header (carries a page number) and from a plate
// caption (mixed-case binomials before their bracket tags).
const GENUS_HEADING_FIRST_LINE_RE = /^[A-ZÀ-Ÿ][A-ZÀ-Ÿ' -]*(?:,\s*[A-ZÀ-Ÿ][A-ZÀ-Ÿ' -]*)*$/;
const REFERENCES_RE = /^REFERENCES:/;

// pdftotext renders the flora's drop-cap opening of a genus synopsis as a
// doubled "AA"/"AAn" ("AA genus of 200 species...", "AAn Old World genus...")
// — a second, independent signal from the all-caps line above it, needed
// because a monotypic genus's heading can be the genus name alone with no
// common name ("DACTYLIS"), which a word-count check can't distinguish from
// page furniture.
const GENUS_SYNOPSIS_OPENING_RE = /^AAn?\s/;

function isGenusHeadingBlock(blockText) {
  const lines = blockText.trim().split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  if (!GENUS_HEADING_FIRST_LINE_RE.test(firstLine)) return false;
  if (firstLine.split(/\s+/).length >= 2) return true;
  return GENUS_SYNOPSIS_OPENING_RE.test(lines[1]?.trim() ?? '');
}

function isReferencesBlock(blockText) {
  return REFERENCES_RE.test(blockText.trim());
}

/** Split `text` like `text.split(/\n\s*\n+/)` but keep each block's start offset in `text`. */
function splitBlocksWithOffsets(text) {
  const blocks = [];
  const re = /\n\s*\n+/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text))) {
    blocks.push({ text: text.slice(lastIndex, match.index), start: lastIndex });
    lastIndex = re.lastIndex;
  }
  blocks.push({ text: text.slice(lastIndex), start: lastIndex });
  return blocks;
}

/** Count of `\f` (page break) characters in `text` before `offset` — 03 §2's exact page arithmetic. */
function formfeedsBefore(formfeedOffsets, offset) {
  let lo = 0;
  let hi = formfeedOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (formfeedOffsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Running headers ("718 FAGACEAE/QUERCUS", "ILLUSTRATED FLORA OF NORTH
// CENTRAL TEXAS 771") and plate captions ("Quercus muehlenbergii [SA3]") are
// mid-treatment noise (03 §7.1) that must not affect the 'I'-symbol check at
// a span's tail — strip the lines, keep the rest, per line rather than per
// block since either can share a block with real treatment text.
const RUNNING_HEADER_LINE_RE = /^\s*(?:\d+\s+[A-ZÀ-Ÿ][A-ZÀ-Ÿ/ ]*|ILLUSTRATED FLORA OF NORTH CENTRAL TEXAS\s+\d+)\s*$/;
const PLATE_CAPTION_LINE_RE = /^(?:\s*[A-Z][a-zà-ÿ.-]+\s+[a-zà-ÿ.-]+(?:\s+(?:var|subsp)\.\s+\S+)?\s*\[[^\]]+\]\s*)+$/;

function stripPageNoise(text) {
  return text
    .split('\n')
    .filter((line) => !RUNNING_HEADER_LINE_RE.test(line) && !PLATE_CAPTION_LINE_RE.test(line))
    .join('\n');
}

/**
 * A block that is *entirely* running-header/plate-caption lines is page
 * furniture, not treatment content — 03 §7.1's fix. Skip it outright rather
 * than letting it reach matchHeadingBlock: a caption's bracketed tag can
 * itself carry a comma ("Quercus marilandica [LYN, SA3]"), which false-
 * matches the heading regex and truncates whatever span is open, silently
 * dropping the rest of that species' text (the same wrong-verdict shape as
 * the Alnus/Lonicera hazard, just a different trigger).
 */
function isNoiseBlock(blockText) {
  const lines = blockText.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => RUNNING_HEADER_LINE_RE.test(line) || PLATE_CAPTION_LINE_RE.test(line));
}

/**
 * Two treatments occasionally print back-to-back with no blank line between
 * them (measured: Parthenocissus quinquefolia / P. tricuspidata) — pdftotext
 * layout noise, not a blank-line omission this project controls. Because
 * matchHeadingBlock only looks at a block's own start, such a pair reads as
 * one block and the second species' trailing 'I' bleeds onto the first
 * (same wrong-verdict shape as 03 §6a, a different trigger).
 *
 * Rescanning every line for a heading is unsafe on its own — ordinary prose
 * routinely starts a line with "Cap word, lowercase word, ...," and a comma
 * soon after ("Along creeks, wooded areas...") is enough to satisfy
 * matchHeadingBlock. Gate the split on `genusDictionary` (03 §6's own
 * glued-name dictionary, built from the catalog's real genera) so only a
 * genuine botanical name can split a block, not an incidental sentence.
 */
function splitEmbeddedHeadings(blockText, genusDictionary) {
  const lines = blockText.split('\n');
  const segments = [];
  let segStart = 0;
  let offset = 0;
  const lineOffsets = [0];
  for (const line of lines) {
    offset += line.length + 1;
    lineOffsets.push(offset);
  }
  for (let i = 1; i < lines.length; i += 1) {
    const heading = matchHeadingBlock(lines.slice(i).join('\n'));
    if (heading && genusDictionary.has(heading.genus)) {
      segments.push({ text: lines.slice(segStart, i).join('\n'), offset: lineOffsets[segStart] });
      segStart = i;
    }
  }
  segments.push({ text: lines.slice(segStart).join('\n'), offset: lineOffsets[segStart] });
  return segments;
}

// A treatment with more than one infraspecific taxon states the first in
// full ("Genus species (Auth.) subsp. epithet1 (Auth.), ...") and each later
// one as a bare continuation paragraph with no repeated genus+species
// ("subsp. epithet2 including ...", "var. epithet2 (Auth.), ..." —
// Bothriochloa ischaemum var. songarica's own heading (03 §6c) plus the
// Quercus sinuata var. breviloba/sinuata and Prunella vulgaris
// subsp. lanceolata/vulgaris couplets). matchHeadingBlock can't see this
// (no genus token), so a bare continuation reads as more of the PRIOR
// taxon's text — including its 'I' — unless it's split out here (03 §7's
// Prunella vulgaris misattribution: subsp. vulgaris's introduced-Old-World
// 'I' otherwise bleeds onto the NCTX-occurring subsp. lanceolata).
const BARE_INFRA_HEADING_RE = /^(var\.|subsp\.)\s+([a-zà-ÿ-]+)\b/;

/**
 * Build Map<headingKey, { key, page, text }> — one entry per treatment found
 * across every volume, `text` cleaned of page noise (03 §7.1) and `page`
 * computed exactly from the volume's own form-feed offsets (03 §2). First
 * occurrence of a key wins, matching buildFloraIndex's own rule.
 *
 * `genusDictionary` (buildGenusDictionary's output, same as buildFloraIndex
 * takes) gates splitEmbeddedHeadings — required, not defaulted, so a caller
 * can't accidentally run this over a genus set unrelated to today's catalog.
 */
export function buildTreatmentIndex(genusDictionary, dir = DEFAULT_CORPUS_DIR) {
  const treatments = new Map();

  for (const volume of loadCorpusVolumes(dir)) {
    const blocks = splitBlocksWithOffsets(volume.text);
    const formfeedOffsets = [];
    for (let i = 0; i < volume.text.length; i += 1) {
      if (volume.text[i] === '\f') formfeedOffsets.push(i);
    }

    let current = null;
    let currentGenusSpecies = null;
    const flush = () => {
      if (!current) return;
      if (!treatments.has(current.key)) {
        treatments.set(current.key, {
          key: current.key,
          page: volume.firstPage + formfeedsBefore(formfeedOffsets, current.start),
          text: stripPageNoise(current.parts.join('\n\n')),
        });
      }
      current = null;
    };

    for (const block of blocks) {
      if (isNoiseBlock(block.text)) continue;

      for (const sub of splitEmbeddedHeadings(block.text, genusDictionary)) {
        const start = block.start + sub.offset;
        const heading = matchHeadingBlock(sub.text);
        if (heading) {
          flush();
          current = { key: heading.key, start, parts: [sub.text] };
          currentGenusSpecies = { genus: heading.genus, species: heading.species };
          continue;
        }
        if (isGenusHeadingBlock(sub.text)) {
          flush();
          currentGenusSpecies = null;
          continue;
        }
        if (isReferencesBlock(sub.text)) {
          flush();
          continue;
        }
        const bareInfra = currentGenusSpecies && BARE_INFRA_HEADING_RE.exec(sub.text.trim());
        if (bareInfra) {
          flush();
          const rank = bareInfra[1] === 'var.' ? 'variety' : 'subspecies';
          const key = headingKey(currentGenusSpecies.genus, currentGenusSpecies.species, rank, bareInfra[2]);
          current = { key, start, parts: [sub.text] };
          continue;
        }
        if (current) current.parts.push(sub.text);
      }
    }
    flush();
  }

  return treatments;
}

// 03 §3: the editorial 'I' flag, reliable but continental — a lone token at
// the very end of the (noise-stripped) treatment.
const INTRODUCED_SYMBOL_RE = /(?:^|[\s.])I$/;
// 03 §4: an origin-statement screen ("native of/from/to/in ..."), never an
// auto-classifier on its own.
const ORIGIN_PHRASE_RE = /\bnative\s+(?:of|from|to|in)\b/i;
// 03 §4.1: escape/cultivation language, the screen that closes the 11.6%
// silence-implies-native leak — fires even with no origin phrase present.
const ESCAPE_LANGUAGE_RE = /\bescapes?\b|\badventive\b|\bcultivated and\b|\blong persists?\b|\bnaturaliz/i;

/**
 * Classify one treatment's cleaned text per 03 §4.1's routing. Returns only a
 * status/value/screen name — never a stored excerpt (03 §2's licensing rule).
 */
export function classifyNativity(treatmentText) {
  const trimmed = treatmentText.trim();
  if (INTRODUCED_SYMBOL_RE.test(trimmed)) {
    return { status: 'asserted', value: 'introduced', screen: 'introduced-symbol' };
  }
  if (ORIGIN_PHRASE_RE.test(trimmed)) {
    return { status: 'review', value: null, screen: 'origin-phrase' };
  }
  if (ESCAPE_LANGUAGE_RE.test(trimmed)) {
    return { status: 'review', value: null, screen: 'escape-language' };
  }
  return { status: 'asserted', value: 'native', screen: 'silence' };
}

function citationFor(page) {
  return `${CITATION_AUTHORS}, p. ${page}`;
}

/**
 * Ingest nativity_nctx claims for every taxa_id with a name_reconciliations
 * row (06 §5) — 'unmatched' writes status='unknown' (03 §5's third value);
 * everything else looks up its flora_taxa_id's own treatment (which may be a
 * species-level heading standing in for a variety/subspecies, 06 §4's
 * partial match) and classifies it per 03 §4.1.
 */
export function ingestFloraNativity(db, treatmentIndex) {
  const retrievedAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO claims (species_id, field, value, status, source, citation, retrieved_at)
     VALUES (?, 'nativity_nctx', ?, ?, ?, ?, ?)`,
  );

  const rows = db
    .prepare(
      `SELECT nr.taxa_id AS taxa_id, nr.matched_via AS matched_via, ft.scientific_name AS flora_name
       FROM name_reconciliations nr
       LEFT JOIN taxa ft ON ft.id = nr.flora_taxa_id
       WHERE nr.corpus = 'nctx-flora-1999'`,
    )
    .all();

  const counts = { asserted_native: 0, asserted_introduced: 0, review: 0, unknown: 0 };

  for (const row of rows) {
    if (row.matched_via === 'unmatched' || !row.flora_name) {
      insert.run(row.taxa_id, null, 'unknown', SOURCE.NCTX_FLORA, null, retrievedAt);
      counts.unknown += 1;
      continue;
    }

    const parsed = parseCatalogName(row.flora_name);
    const key = headingKey(parsed.genus, parsed.species, parsed.rank, parsed.infraEpithet);
    const treatment = treatmentIndex.get(key);
    if (!treatment) {
      // The reconciliation named a heading that buildTreatmentIndex's span
      // walk didn't independently confirm — treat as unresolved rather than
      // guess a value.
      insert.run(row.taxa_id, null, 'unknown', SOURCE.NCTX_FLORA, null, retrievedAt);
      counts.unknown += 1;
      continue;
    }

    const { status, value } = classifyNativity(treatment.text);
    insert.run(row.taxa_id, value, status, SOURCE.NCTX_FLORA, citationFor(treatment.page), retrievedAt);
    if (status === 'review') counts.review += 1;
    else if (value === 'introduced') counts.asserted_introduced += 1;
    else counts.asserted_native += 1;
  }

  return counts;
}
