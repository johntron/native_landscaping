#!/usr/bin/env node
// Narrows an intermediate CSV (see fetchDetails.js) to the species on a
// regional planting list, then drops anything not native to the Lower 48.
//
// Why this exists: USDA's characteristics data has no geography in it. Native
// status is regional (L48/AK/HI/PR/VI/CAN — never state or county), the
// location-search endpoint returns a server-side SQL timeout, and there is no
// distribution endpoint in the API at all. So "which of these belong in a yard
// in Dallas?" cannot be answered from USDA alone. Filtering on soil/pH/drought
// instead is worse than useless — Blackland Prairie is alkaline clay, and so is
// much of the Chihuahuan Desert, so desertbroom and desert ceanothus sail
// through a filter meant to select for Dallas.
//
// The geography therefore has to come from outside: a regional planting list,
// matched by botanical name. tools/usda-plants/README.md names the sources.
//
//   node tools/usda-plants/regionFilter.js <intermediate.csv> <names.txt> --out=<path>
//
// names.txt is one botanical name per line; blank lines and lines starting with
// '#' are ignored. Matching is on genus + species, so a USDA infraspecific
// record (Rhus aromatica var. serotina) still matches a list's bare binomial.

import { readFileSync, writeFileSync } from "node:fs";

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function toCsvValue(value) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Genus + species only. A regional list says "Rhus aromatica"; USDA's record
// for the plant actually growing here is "Rhus aromatica var. serotina".
export function genusSpecies(botanicalName) {
  return (botanicalName || "").trim().toLowerCase().split(/\s+/).slice(0, 2).join(" ");
}

export function filterToRegion(csvText, names) {
  const lines = csvText.trim().split("\n");
  const header = parseCsvLine(lines[0]);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = lines.slice(1).map(parseCsvLine);

  const wanted = new Set(names.map(genusSpecies).filter(Boolean));
  // Full names the list spells out, including infraspecific ones ("Cercis
  // canadensis var. texensis"). A list that bothers to name the variety means
  // that variety.
  const namedInFull = new Set(names.map((n) => (n || "").trim().toLowerCase()).filter(Boolean));
  const matches = rows.filter((r) => wanted.has(genusSpecies(r[col.botanical_name])));

  // Genus+species matching pulls in every USDA infraspecific record under a
  // binomial, and the extra ones skew western: a list saying "Celtis laevigata"
  // (sugarberry) also drags in var. reticulata, the netleaf hackberry of West
  // Texas. Keep the nominate record, plus any variety the list named outright;
  // fall back to whatever exists when USDA has no nominate record at all
  // (Rhus aromatica is only ever var. serotina here).
  const byBinomial = new Map();
  for (const r of matches) {
    const key = genusSpecies(r[col.botanical_name]);
    if (!byBinomial.has(key)) byBinomial.set(key, []);
    byBinomial.get(key).push(r);
  }
  const onList = [];
  for (const [key, group] of byBinomial) {
    const full = (r) => (r[col.botanical_name] || "").trim().toLowerCase();
    const kept = group.filter((r) => full(r) === key || namedInFull.has(full(r)));
    onList.push(...(kept.length ? kept : group));
  }

  // A regional planting list is not only a list of things to plant — the DFW
  // one carries an "invasives to remove" section in the same table. Nativity
  // separates them cleanly: every introduced species in that intersection was
  // an avoid-entry, and every USDA invasive-status flag landed on one.
  const isNative = (r) => /L48:N/.test(r[col.usda_native_status] || "");
  const native = onList.filter(isNative);
  const introduced = onList.filter((r) => !isNative(r));

  const matched = new Set(onList.map((r) => genusSpecies(r[col.botanical_name])));
  const unmatched = [...wanted].filter((n) => !matched.has(n));

  return { header, native, introduced, unmatched };
}

function render(header, rows) {
  return [header, ...rows].map((r) => r.map(toCsvValue).join(",")).join("\n") + "\n";
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const [csvPath, namesPath] = args.filter((a) => !a.startsWith("--"));
  const outArg = args.find((a) => a.startsWith("--out="));
  if (!csvPath || !namesPath) {
    console.error("usage: regionFilter.js <intermediate.csv> <names.txt> [--out=path]");
    process.exit(1);
  }
  const names = readFileSync(namesPath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const { header, native, introduced, unmatched } = filterToRegion(readFileSync(csvPath, "utf8"), names);
  const out = outArg ? outArg.slice("--out=".length) : "region-filtered.csv";
  writeFileSync(out, render(header, native));

  console.log(`${native.length} native species -> ${out}`);
  console.log(`${introduced.length} on the list but not native to the L48 (held back; likely avoid-entries)`);
  console.log(`${unmatched.length} list names with no USDA characteristics record — USDA covers only ~2,200 species`);
}
