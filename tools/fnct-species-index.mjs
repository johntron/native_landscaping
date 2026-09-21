#!/usr/bin/env node
/**
 * Build a searchable index of every species-rank treatment in *Shinners &
 * Mahler's Illustrated Flora of North Central Texas* (Diggs, Lipscomb &
 * O'Kennon 1999) — one row per species/variety/subspecies the flora treats,
 * with its scientific name, common name(s) and page citation.
 *
 * Reuses tools/claims/floraNativity.js's buildTreatmentIndex for the hard
 * part (blank-line block splitting, running-header/plate-caption noise
 * stripping, embedded-heading and bare-infraspecific-heading recovery,
 * form-feed page arithmetic) rather than re-deriving any of it — see that
 * file and docs/data-acquisition/03-document-corpus.md §2-7 for why each of
 * those matters. This tool only adds: a bootstrap genus dictionary (so the
 * whole flora is covered, not just today's catalog's genera) and common-name
 * extraction from each treatment's opening sentence.
 *
 * Per NOTICE.md, only extracted facts plus a page citation are written —
 * never flora prose. A common name is a fact (the flora's own label for the
 * plant), not an excerpt of its descriptive text.
 *
 * COMMON NAME EXTRACTION. A treatment opens "Genus species Author(s), (short
 * etymology), COMMON NAME, OTHER COMMON NAME. Description starts here." —
 * the common-name list is the ALL-CAPS run between the (optional) etymology
 * parenthetical and the period that starts descriptive prose. Some
 * treatments carry no common name at all (period follows the etymology
 * directly); that's a real, expected gap, not a parse failure.
 *
 * KNOWN LIMITATION: pdftotext -layout hard-wraps mid-word ("COMMON RAG-\nWEED"),
 * which this tool rejoins by dropping the hyphen+newline whenever both sides
 * are letters. A genuinely hyphenated common name that happens to wrap at its
 * own hyphen ("FORKED-\nLEAF") loses that hyphen too — cosmetic only, the name
 * is still searchable.
 *
 * Usage: node tools/fnct-species-index.mjs [--check]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCorpusVolumes, matchHeadingBlock, DEFAULT_CORPUS_DIR } from './claims/floraCorpus.js';
import { buildTreatmentIndex } from './claims/floraNativity.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_CSV = `${ROOT}ecology/fnct-species-index.csv`;
const CITATION_AUTHORS = "Diggs, Lipscomb & O'Kennon 1999";

/** Every genus the flora treats, found with the same heading rule buildTreatmentIndex uses — needed as its own gating dictionary. */
function bootstrapGenusDictionary(dir) {
  const genera = new Set();
  for (const volume of loadCorpusVolumes(dir)) {
    for (const block of volume.text.split(/\n\s*\n+/)) {
      const heading = matchHeadingBlock(block);
      if (heading) genera.add(heading.genus);
    }
  }
  return genera;
}

/** "quercus sinuata var. breviloba" -> { genus: 'Quercus', species: 'sinuata', rank: 'variety', infraEpithet: 'breviloba' }. */
function parseKey(key) {
  const m = /^([a-zà-ÿ-]+)\s+([a-zà-ÿ-]+)(?:\s+(var\.|subsp\.)\s+([a-zà-ÿ-]+))?$/.exec(key);
  if (!m) return null;
  const [, genusLower, species, rankToken, infraEpithet] = m;
  const genus = genusLower[0].toUpperCase() + genusLower.slice(1);
  const rank = rankToken === 'var.' ? 'variety' : rankToken === 'subsp.' ? 'subspecies' : 'species';
  return { genus, species, rank, infraEpithet: infraEpithet ?? null };
}

function scientificName({ genus, species, rank, infraEpithet }) {
  if (rank === 'species') return `${genus} ${species}`;
  const abbrev = rank === 'variety' ? 'var.' : 'subsp.';
  return `${genus} ${species} ${abbrev} ${infraEpithet}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// HEADING_RE (floraCorpus.js) tolerates up to 80 chars of anything before its
// terminal comma, which occasionally matches ordinary prose that happens to
// scan as "Cap word, lowercase word, ..., " at a block's start (03 §6's own
// documented hazard — "Abundant weed in disturbed sites," reads as genus
// "Abundant", species "weed"). A real heading's gap between the epithet and
// that comma is always an author citation, which never opens with a
// lowercase word — reject anything that does.
// The same hazard occasionally produces a "species" epithet that is really
// an English function word ("Escobaria in", "Key to") — a real epithet is
// never one of these, so reject them outright rather than trust the
// author-gap check alone.
const ENGLISH_STOPWORDS = new Set([
  'and', 'the', 'to', 'of', 'in', 'on', 'is', 'was', 'are', 'were', 'a', 'an',
  'at', 'by', 'from', 'with', 'or', 'nc', 'tx', 'for', 'as',
]);

function looksLikeAuthorCitation(treatmentText, parsed) {
  if (ENGLISH_STOPWORDS.has(parsed.species) || (parsed.infraEpithet && ENGLISH_STOPWORDS.has(parsed.infraEpithet))) {
    return false;
  }
  const flat = treatmentText.replace(/\s+/g, ' ').trim();
  const abbrev = parsed.rank === 'variety' ? 'var\\.' : parsed.rank === 'subspecies' ? 'subsp\\.' : null;
  const fullPrefixRe = new RegExp(
    `^${escapeRe(parsed.genus)}\\s+(?:×\\s*)?${escapeRe(parsed.species)}\\s*` +
      (abbrev && parsed.infraEpithet ? `(?:${abbrev}\\s+${escapeRe(parsed.infraEpithet)}\\s*)?` : ''),
  );
  const barePrefixRe = abbrev && parsed.infraEpithet ? new RegExp(`^${abbrev}\\s+${escapeRe(parsed.infraEpithet)}\\s*`) : null;

  const fullMatch = fullPrefixRe.exec(flat);
  const bareMatch = !fullMatch && barePrefixRe ? barePrefixRe.exec(flat) : null;
  const prefixLength = fullMatch ? fullMatch[0].length : bareMatch ? bareMatch[0].length : 0;
  if (!fullMatch && !bareMatch) return false;

  const rest = flat.slice(prefixLength);
  const commaIdx = rest.indexOf(',');
  const gap = (commaIdx === -1 ? rest : rest.slice(0, commaIdx)).trim();
  return gap === '' || /^[A-ZÀ-Þ0-9(×]/.test(gap);
}

const COMMON_NAME_RE =
  /^.{1,120}?,\s*(?:\([^)]{0,400}\)\s*,\s*)?([A-ZÀ-Þ][A-ZÀ-Þ0-9'’.\-, ]{1,300}?)\.\s+[A-ZÀ-Þ][a-zà-ÿ]/;

function extractCommonNames(treatmentText) {
  const flat = treatmentText
    .replace(/([A-ZÀ-Þa-zà-ÿ])-\n([A-ZÀ-Þa-zà-ÿ])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  const match = COMMON_NAME_RE.exec(flat);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(titleCase);
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s-])([a-zà-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

function escapeCell(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function main() {
  const check = process.argv.includes('--check');
  const genusDictionary = bootstrapGenusDictionary(DEFAULT_CORPUS_DIR);
  const treatments = buildTreatmentIndex(genusDictionary, DEFAULT_CORPUS_DIR);

  const rows = [];
  for (const [key, treatment] of treatments) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (!looksLikeAuthorCitation(treatment.text, parsed)) continue;
    const commonNames = extractCommonNames(treatment.text);
    rows.push({
      genus: parsed.genus,
      species: parsed.species,
      rank: parsed.rank,
      infra_epithet: parsed.infraEpithet ?? '',
      scientific_name: scientificName(parsed),
      common_names: commonNames.join('; '),
      fnct_page: treatment.page,
      source: `${CITATION_AUTHORS}, p. ${treatment.page}`,
    });
  }
  rows.sort((a, b) => a.scientific_name.localeCompare(b.scientific_name));

  const withNames = rows.filter((r) => r.common_names).length;
  console.log(`Extracted ${rows.length} treatments (${genusDictionary.size} genera), ${withNames} with a common name`);

  if (check) {
    ['Quercus alba', 'Ambrosia artemisiifolia', 'Quercus sinuata var. breviloba', 'Quercus sinuata'].forEach((name) => {
      const row = rows.find((r) => r.scientific_name === name);
      console.log(`  ${name}: ${row ? row.common_names || '(no common name)' : '(not found)'}`);
    });
    return;
  }

  const header = ['genus', 'species', 'rank', 'infra_epithet', 'scientific_name', 'common_names', 'fnct_page', 'source'];
  const out = [header.join(',')];
  rows.forEach((r) => out.push(header.map((k) => escapeCell(r[k])).join(',')));
  writeFileSync(OUT_CSV, out.join('\n') + '\n');
  console.log(`Wrote ${rows.length} rows to ${OUT_CSV}`);
}

main();
