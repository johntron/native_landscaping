#!/usr/bin/env node
/**
 * Screen the keystone-genus table against the flora, so a Dallas planting list
 * cannot recommend a larch.
 *
 * ecology/host-genera.csv carries NWF's top-30 keystone genera for EPA Level I
 * ecoregion 9. A Level I ecoregion is continental — whichever one this is, it
 * cannot resolve a city, and this one reaches from Texas to the aspen parkland.
 * So it recommends Betula (189 caterpillar species), Larix, Tsuga, Abies and
 * Picea for a Blackland Prairie yard.
 *
 * The screen: does *Shinners & Mahler's Illustrated Flora of North Central
 * Texas* (Diggs, Lipscomb & O'Kennon 1999) give the genus a TREATMENT? A
 * treatment means the flora accepts the genus as growing in nc TX and is the
 * strongest offline evidence in this repo. A genus that appears only in a key,
 * a family discussion or a comparative aside does not qualify — that is the
 * distinction a raw grep cannot make and this tool exists for.
 *
 * Treatments head as an all-caps genus followed by an all-caps common name
 * ("QUERCUS OAK"), centred on the page. Page numbers come from the running
 * headers, which are "712 FAGACEAE/QUERCUS" on versos and
 * "QUERCUS/FAGACEAE 713" on rectos.
 *
 * Writes ecology/fnct-genus-screen.csv. Every row is checkable: it carries the
 * page and the verbatim heading, so a reader who disagrees can open the flora.
 *
 * Usage: node tools/fnct-genus-screen.mjs [--genus Quercus]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/data/csvLoader.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORPUS_DIR = `${ROOT}docs/data-acquisition/corpus`;
const HOST_GENERA = `${ROOT}ecology/host-genera.csv`;
const OUT_CSV = `${ROOT}ecology/fnct-genus-screen.csv`;

/** "712 FAGACEAE/QUERCUS" (verso) or "QUERCUS/FAGACEAE 713" (recto). */
const VERSO_HEADER = /^\s*(\d{1,4})\s+([A-Z][A-Z-]+(?:\/[A-Z][A-Z-]+)*)\s*$/;
const RECTO_HEADER = /^\s*([A-Z][A-Z-]+(?:\/[A-Z][A-Z-]+)*)\s+(\d{1,4})\s*$/;

/**
 * A treatment heading is a CENTRED, all-caps genus, optionally followed by the
 * all-caps common names the flora lists for it. Three shapes occur, and all
 * three are real treatments:
 *
 *   "QUERCUS OAK"                                  genus + one common name
 *   "ASCLEPIAS MILKWEED, SILKWEED"                 comma-separated names
 *   "CERCIS"                                       genus alone
 *
 * The indent is load-bearing. Bare "CERCIS" is indistinguishable from a key
 * line by content alone, so the discriminator is that a treatment heading is
 * centred and a key line is not. Running headers ("276 ASCLEPIADACEAE/
 * ASCLEPIAS") are excluded by refusing digits and slashes.
 */
const MIN_HEADING_INDENT = 15;

/**
 * Headings are CENTRED, so a longer one starts further left: "QUERCUS OAK"
 * sits at 39 spaces while "VERBESINA CROWN-BEARD, FLAT-SEED-SUNFLOWER,
 * WINGSTEM" starts at 8. Indent therefore cannot be a single threshold.
 *
 * Instead the indent requirement depends on what follows the genus. A heading
 * that carries common names is already unmistakable, so 6 spaces is enough; a
 * bare "CERCIS" is indistinguishable from a key line by content, so it must be
 * deeply centred. Common names may be accented — "POPULUS COTTONWOOD, ÁLAMO,
 * POPLAR, ASPEN" — hence the Unicode class rather than A-Z.
 */
function treatmentHeading(genus) {
  const g = genus.toUpperCase();
  return {
    // U+2019 as well as ASCII ': the flora sets "TURK’S-CAP" typographically.
    withNames: new RegExp(`^\\s{6,}${g}\\s+\\p{Lu}[\\p{Lu}\\p{M}'\u2019,.\\- ]*$`, 'u'),
    bare: new RegExp(`^\\s{${MIN_HEADING_INDENT},}${g}\\s*$`, 'u'),
  };
}

function isTreatmentHeading(patterns, line) {
  return patterns.withNames.test(line) || patterns.bare.test(line);
}

function loadCorpus() {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((file) => ({ file, lines: readFileSync(`${CORPUS_DIR}/${file}`, 'utf8').split('\n') }));
}

/** Page in effect at each line, carried forward from the last running header. */
function pageIndex(lines) {
  const pages = new Array(lines.length).fill(null);
  let current = null;
  lines.forEach((line, i) => {
    const verso = VERSO_HEADER.exec(line);
    const recto = RECTO_HEADER.exec(line);
    if (verso) current = Number(verso[1]);
    else if (recto) current = Number(recto[2]);
    pages[i] = current;
  });
  return pages;
}

/** Any centred all-caps line starts the NEXT treatment and so ends this one. */
const ANY_HEADING = /^\s{6,}\p{Lu}{3,}(?:\s+\p{Lu}[\p{Lu}\p{M}'\u2019,.\- ]*)?$/u;

/**
 * "Treated in the flora" and "grows in a Dallas yard" are different claims,
 * and conflating them is how a river birch ends up recommended for the
 * Blackland Prairie. Betula is the case that forced this: FNCT does treat it
 * (p. 439), but with a single species, B. nigra, "along streams and in low
 * woods; Lamar Co. in Red River drainage ... mainly se and e TX" — no Dallas
 * County record and not an upland prairie plant. NWF's 189 caterpillar species
 * for Betula is still the wrong number for this city, for a subtler reason
 * than "does not occur".
 *
 * So the block a treatment occupies is mined for ONE thing a reader can check:
 * whether the flora names Dallas County anywhere in it. That claim is exactly
 * as narrow as it sounds — some species of this genus has a Dallas record, not
 * that any particular one does — and the sentence is quoted verbatim so the
 * reader can judge it.
 *
 * Habitat was mined here too and the column was removed. Keyword matching on
 * flora prose could not tell substrate from county (Betula's "Henderson and
 * Limestone cos." read as limestone soil) and, once that was fixed, offered
 * "Acorn cups 16-25 mm broad" as Quercus's habitat, because it picks the first
 * sentence containing the word and key couplets are long. Habitat is a
 * judgement call, and per the project's own standard it has to be visibly the
 * author's rather than laundered through a regex.
 */
function mineTreatmentBlock(lines, start) {
  const block = [];
  for (let i = start + 1; i < lines.length && block.length < 400; i += 1) {
    if (ANY_HEADING.test(lines[i])) break;
    block.push(lines[i]);
  }
  const text = block.join(' ').replace(/\s+/g, ' ');
  const dallas = /\bDallas\b/.test(text);
  const sentence = (re) => {
    const match = text.split(/(?<=\.)\s+/).find((s) => re.test(s));
    return match ? match.trim().slice(0, 300) : '';
  };
  return {
    dallasRecord: dallas ? 'yes' : 'no',
    dallasEvidence: dallas ? sentence(/\bDallas\b/) : '',
  };
}

function screenGenus(genus, corpus) {
  const heading = treatmentHeading(genus);
  for (const { file, lines } of corpus) {
    const pages = pageIndex(lines);
    for (let i = 0; i < lines.length; i += 1) {
      if (isTreatmentHeading(heading, lines[i])) {
        return {
          genus,
          treated: 'yes',
          page: pages[i] ?? '',
          heading: lines[i].trim(),
          volume: file,
          ...mineTreatmentBlock(lines, i),
          mentions: null,
        };
      }
    }
  }
  return {
    genus,
    treated: 'no',
    page: '',
    heading: '',
    volume: '',
    dallasRecord: '',
    dallasEvidence: '',
    mentions: 0,
  };
}

function countMentions(genus, corpus) {
  const wordRe = new RegExp(`\\b${genus}\\b`, 'i');
  let n = 0;
  for (const { lines } of corpus) for (const line of lines) if (wordRe.test(line)) n += 1;
  return n;
}

function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--genus') ? args[args.indexOf('--genus') + 1] : null;

  const corpus = loadCorpus();
  console.log(`Corpus: ${corpus.length} volumes, ${corpus.reduce((n, v) => n + v.lines.length, 0)} lines`);

  const genera = only
    ? [only]
    : [...new Set(parseCsv(readFileSync(HOST_GENERA, 'utf8')).map((r) => String(r.genus || '').trim()))].filter(Boolean);

  const rows = genera.map((genus) => {
    const result = screenGenus(genus, corpus);
    result.mentions = countMentions(genus, corpus);
    return result;
  });

  const treated = rows.filter((r) => r.treated === 'yes');
  const withDallas = treated.filter((r) => r.dallasRecord === 'yes');
  console.log(`\nTreated in the flora: ${treated.length} of ${rows.length}`);
  console.log(`  of those, naming Dallas Co.: ${withDallas.length}`);
  rows
    .filter((r) => r.treated === 'no')
    .forEach((r) => console.log(`  NOT TREATED  ${r.genus.padEnd(16)} (${r.mentions} passing mentions)`));

  if (only) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const header = [
    'genus',
    'fnct_treated',
    'fnct_page',
    'fnct_heading',
    'fnct_dallas_record',
    'fnct_dallas_evidence',
    'fnct_volume',
    'corpus_mentions',
    'source',
  ];
  const lines = [header.join(',')];
  rows
    .slice()
    .sort((a, b) => a.genus.localeCompare(b.genus))
    .forEach((r) => {
      lines.push(
        [
          r.genus,
          r.treated,
          r.page,
          r.heading,
          r.dallasRecord,
          r.dallasEvidence,
          r.volume,
          r.mentions,
          'Diggs, Lipscomb & O\'Kennon 1999, Shinners & Mahler\'s Illustrated Flora of North Central Texas',
        ]
          .map(escapeCell)
          .join(',')
      );
    });
  writeFileSync(OUT_CSV, lines.join('\n') + '\n');
  console.log(`\nWrote ${rows.length} rows to ${OUT_CSV}`);
}

function escapeCell(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

main();
