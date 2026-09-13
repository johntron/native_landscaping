#!/usr/bin/env node
/**
 * Extract FNCT Appendix Ten — "Larval Host Plants of Lepidoptera of North
 * Central Texas", compiled by JoAnn Karges, pp. 1394-1403.
 *
 * This is the best plant/insect source in the repo and it was already on disk.
 * Unlike NWF's keystone counts (EPA Level I ecoregion 9 — continental, which is
 * how Larix ends up recommended for Dallas) and unlike GloBI (global, and its
 * verbs are source-dependent), this table is North Central Texas specific,
 * names the animal, and cites a page. It is also the same currency Part 1's
 * argument runs on: larval hosts, not nectar visits.
 *
 * Two sections, both taken: I. butterflies (pp. 1394-1400), II. moths
 * (pp. 1400-1403).
 *
 * LAYOUT. Three whitespace columns — family, plant, lepidopteran — with
 * carry-forward on each: a blank family means "same family", a blank plant
 * column means "another animal on the same plant". Column positions shift
 * page to page, so the split is found by locating the animal on the right
 * rather than by a fixed offset.
 *
 * FOUR IRREGULAR FORMS, all real records:
 *   "Celtis spp., Ulmus spp." + "The following are on both Celtis and Ulmus:"
 *        one prose sentence governing several plants. Emitted as one row per
 *        (plant, animal) pair, with the sentence kept verbatim.
 *   "UNDERWINGS (Catocala species): C. delilah, C. micronympha"
 *        abbreviated genus, comma-separated, spacing inconsistent in the source.
 *   "Catocala muliercula"
 *        a bare scientific name with no common name at all.
 *   "PAINTED LADy", "Chlyosyne gorgone", "FABACEACE"
 *        typos in the printed flora. Preserved verbatim; see `species_verbatim`.
 *
 * Nothing here corrects the source silently. Where this tool infers something
 * — expanding "C." to "Catocala" — the inference goes in its own column and is
 * labelled as the tool's, not the flora's.
 *
 * Usage: node tools/fnct-lepidoptera-hosts.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOLUME = `${ROOT}docs/data-acquisition/corpus/FNCT_1353-1456-Appendices-Glossary.txt`;
const OUT_CSV = `${ROOT}ecology/fnct-lepidoptera-hosts.csv`;

const START_MARKER = /^APPENDIX TEN\s*$/;
const END_MARKER = /^\s*LEPIDOPTERA REFERENCES\s*$/;
const MOTH_SECTION = /^\s*II\.\s+LARVAL HOST PLANTS OF NORTH CENTRAL TEXAS MOTHS/;

/** Running headers carry the page: "1396 APPENDIX TEN/..." or "...APPENDIX TEN 1397". */
const PAGE_VERSO = /^\s*(\d{4})\s+APPENDIX TEN\//;
const PAGE_RECTO = /APPENDIX TEN\s+(\d{4})\s*$/;

const COLUMN_HEADER = /^\s*PLANT\s+(BUTTERFLY|MOTH)\s*$/;

/** "GRAY HAIRSTREAK (Strymon melinus)" — common name then binomial. */
const NAMED_LEP = /(\p{Lu}[\p{Lu}\p{M}'’.\- ]{2,}?)\s*\((\p{Lu}\p{Ll}+(?:\s+\p{Ll}+){1,2})\)/gu;
/** "UNDERWINGS (Catocala species): C. delilah, C.micronympha" and "UNDERWINGS: Catocala junctura". */
const UNDERWING_LEAD = /UNDERWINGS?\s*(?:\(Catocala species\))?\s*:?\s*\(?/i;
const CATOCALA_ITEM = /\b(?:C\.\s*|Catocala\s+)([a-z]{3,})\b/g;
/**
 * A bare continuation of an underwing list: "C. micronympha, C. amica, C. ilia".
 * These lines carry no lead word, so without this the second and later lines of
 * every Catocala run are lost — 4 of Quercus's 5, 8 of Carya's 11.
 */
const CATOCALA_CONTINUATION = /^\s*(?:C\.\s*[a-z]{3,}|Catocala\s+[a-z]{3,})(?:\s*,\s*(?:C\.\s*[a-z]{3,}|Catocala\s+[a-z]{3,}))*\s*,?\s*$/;

/** "UNDERWINGS (Catocala species)" names no taxon — it introduces the list that follows. */
const NOT_A_TAXON = /^Catocala\s+species$/i;

/** A grouping sentence governs every plant accumulated so far. */
const GROUPING_PROSE = /\bThe (?:following|species below)\b[^:]*:?/i;

/**
 * Grouping sentences wrap onto a second line whose right column is just
 * "Asteraceae taxa:" or "Fabaceae genera:". That tail carries no "The
 * following", so without it the words land in the plant column and
 * "Brassicaceae genera:" is emitted as a host plant.
 */
const GROUPING_TAIL = /\b\p{Lu}\p{Ll}+aceae\s+(?:taxa|genera|species|spp\.)\s*:?\s*$/u;

function sliceAppendix(lines) {
  const start = lines.findIndex((l) => START_MARKER.test(l));
  const end = lines.findIndex((l, i) => i > start && END_MARKER.test(l));
  if (start < 0 || end < 0) throw new Error('Appendix Ten bounds not found');
  return { start, end };
}

/** Plant cells: "Celtis spp., Ulmus spp." -> ["Celtis spp.", "Ulmus spp."] */
function parsePlants(text) {
  return text
    .split(',')
    .map((s) => s.trim().replace(/[,;]$/, ''))
    .filter((s) => /^\p{Lu}\p{Ll}+/u.test(s))
    // Prose fragments look superficially like a binomial. A real plant cell is
    // "Genus spp." or "Genus epithet"; anything ending in a colon, or naming a
    // family plus a rank word, is the tail of a grouping sentence.
    .filter((s) => !/:$/.test(s))
    .filter((s) => !/\p{Lu}\p{Ll}+aceae\s+(?:taxa|genera|species)/u.test(s))
    .filter((s) => /^\p{Lu}\p{Ll}+(?:\s+(?:spp\.|\p{Ll}+))?$/u.test(s))
    .filter(Boolean);
}

function parseFamily(text) {
  const m = /^\s*([A-Z]{4,}(?:CEAE|CEACE))\b/.exec(text);
  return m ? m[1] : null;
}

function main() {
  const check = process.argv.includes('--check');
  const lines = readFileSync(VOLUME, 'utf8').split('\n');
  const { start, end } = sliceAppendix(lines);

  const rows = [];
  let page = 1394;
  let section = 'butterflies';
  let family = '';
  let plants = [];        // the plant(s) the current animal list applies to
  let pendingPlants = []; // accumulating across lines until an animal appears
  let groupingNote = '';
  let inUnderwingRun = false;
  // The moth section opens with a prose paragraph ("Many moths, like Automeris
  // io, are polyphagous..."). It is not a table row, but it parses as one, and
  // "Many moths" then captured the whole Salicaceae group — costing Populus and
  // Salix all eight of their moths. Skip until the section's column header.
  let awaitingColumnHeader = false;

  const emit = (common, species, verbatim, inferred) => {
    const targets = plants.length ? plants : pendingPlants;
    targets.forEach((plant) => {
      rows.push({
        section,
        family,
        plant,
        plant_genus: (plant.match(/^([A-Z][a-z]+)/) || [])[1] || '',
        lep_common: common,
        lep_species: species,
        species_verbatim: verbatim,
        name_inferred: inferred ? 'yes' : '',
        grouping_note: groupingNote,
        fnct_page: page,
      });
    });
  };

  for (let i = start; i < end; i += 1) {
    // The flora sets "spp." lowercase everywhere except "Panicum SPP." (p.
    // 1395). Left alone, the capitals read as the start of the animal's common
    // name and the skipper came out as "SPP. LEAST SKIPPER". This is a
    // typographic normalisation, not a change of name.
    const line = lines[i].replace(/\bSPP\./g, 'spp.');
    const verso = PAGE_VERSO.exec(line);
    const recto = PAGE_RECTO.exec(line);
    if (verso) { page = Number(verso[1]); continue; }
    if (recto) { page = Number(recto[1]); continue; }
    if (COLUMN_HEADER.test(line)) { awaitingColumnHeader = false; continue; }
    if (awaitingColumnHeader) continue;

    // Continuation of a Catocala run started on an earlier line.
    if (inUnderwingRun && CATOCALA_CONTINUATION.test(line)) {
      CATOCALA_ITEM.lastIndex = 0;
      let cont;
      while ((cont = CATOCALA_ITEM.exec(line))) {
        emit('UNDERWING', `Catocala ${cont[1]}`, cont[0].trim(), /^C\./.test(cont[0].trim()));
      }
      continue;
    }
    if (MOTH_SECTION.test(line)) {
      section = 'moths';
      family = '';
      plants = [];
      pendingPlants = [];
      awaitingColumnHeader = true;
      continue;
    }
    if (!line.trim()) continue;

    // Where does the animal column start on this line?
    NAMED_LEP.lastIndex = 0;
    const named = [...line.matchAll(NAMED_LEP)];
    const underwing = UNDERWING_LEAD.exec(line);
    const grouping = GROUPING_PROSE.exec(line);
    // A bare scientific name in the right column, e.g. "Catocala muliercula".
    const bare = /^(.*?)\s{4,}(\p{Lu}\p{Ll}+\s+\p{Ll}{3,})\s*$/u.exec(line);

    let splitAt = line.length;
    if (named.length) splitAt = Math.min(splitAt, named[0].index);
    if (underwing) splitAt = Math.min(splitAt, underwing.index);
    if (grouping) splitAt = Math.min(splitAt, grouping.index);
    const tail = GROUPING_TAIL.exec(line);
    if (tail) splitAt = Math.min(splitAt, tail.index);
    if (!named.length && !underwing && !grouping && bare) splitAt = bare[1].length;

    const left = line.slice(0, splitAt);
    const right = line.slice(splitAt);

    const fam = parseFamily(left);
    if (fam) family = fam;
    const leftPlants = parsePlants(fam ? left.replace(fam, '') : left);

    const hasAnimal = Boolean(named.length || underwing || (bare && !named.length && !grouping));

    if (leftPlants.length) {
      if (hasAnimal || grouping) {
        // This line closes the plant group and starts its animal list.
        plants = [...pendingPlants, ...leftPlants];
        pendingPlants = [];
        if (!grouping) groupingNote = '';
      } else {
        pendingPlants.push(...leftPlants);
      }
    } else if (hasAnimal && pendingPlants.length) {
      plants = [...pendingPlants];
      pendingPlants = [];
    }

    if (grouping) {
      groupingNote = grouping[0].trim();
      if (!plants.length && pendingPlants.length) { plants = [...pendingPlants]; pendingPlants = []; }
    }

    named.forEach((m) => {
      const common = m[1].replace(/\s+/g, ' ').trim();
      const species = m[2].replace(/\s+/g, ' ').trim();
      if (NOT_A_TAXON.test(species)) return;
      emit(common, species, species, false);
    });

    inUnderwingRun = Boolean(underwing);
    if (underwing) {
      const tail = right.slice(underwing.index - splitAt + underwing[0].length);
      CATOCALA_ITEM.lastIndex = 0;
      let m;
      while ((m = CATOCALA_ITEM.exec(tail))) {
        emit('UNDERWING', `Catocala ${m[1]}`, m[0].trim(), /^C\./.test(m[0].trim()));
      }
    } else if (!named.length && bare && !grouping) {
      const sp = bare[2].trim();
      if (/^\p{Lu}\p{Ll}+\s+\p{Ll}+$/u.test(sp)) emit('', sp, sp, false);
    }
  }

  // A continuation line of an underwing list has no lead word; catch those by
  // re-scanning lines that are pure "C. x, C. y" runs.
  console.log(`Extracted ${rows.length} plant-lepidopteran rows from FNCT Appendix Ten`);
  const genera = new Set(rows.map((r) => r.plant_genus));
  console.log(`  ${genera.size} plant genera, ${new Set(rows.map((r) => r.lep_species)).size} lepidopteran taxa`);
  console.log(`  butterflies=${rows.filter((r) => r.section === 'butterflies').length} moths=${rows.filter((r) => r.section === 'moths').length}`);

  if (check) {
    const show = (genus) => {
      console.log(`\n--- ${genus} ---`);
      rows.filter((r) => r.plant_genus === genus).forEach((r) =>
        console.log(`  [${r.section}] ${r.plant} -> ${r.lep_common || '(no common name)'} / ${r.lep_species} (p.${r.fnct_page})${r.grouping_note ? ' {' + r.grouping_note.slice(0, 40) + '}' : ''}`)
      );
    };
    ['Quercus', 'Celtis', 'Ulmus', 'Aster', 'Prunus'].forEach(show);
    return;
  }

  const header = ['section','family','plant','plant_genus','lep_common','lep_species','species_verbatim','name_inferred','grouping_note','fnct_page','source'];
  const out = [header.join(',')];
  rows.forEach((r) => {
    out.push(header.map((k) => escapeCell(k === 'source'
      ? "Diggs, Lipscomb & O'Kennon 1999, Appendix Ten (Larval Host Plants of Lepidoptera of North Central Texas, compiled by JoAnn Karges)"
      : r[k])).join(','));
  });
  writeFileSync(OUT_CSV, out.join('\n') + '\n');
  console.log(`\nWrote ${rows.length} rows to ${OUT_CSV}`);
}

function escapeCell(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

main();
