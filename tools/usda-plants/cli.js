#!/usr/bin/env node
// Standalone CLI for the USDA plant lookup tool — the same logic the MCP
// server (mcpServer.js) exposes, usable directly without an MCP client.
//
// Usage:
//   node tools/usda-plants/cli.js search-by-location "Dallas County, Texas"
//   node tools/usda-plants/cli.js search-by-name "Abies concolor" "yaupon holly"
//   node tools/usda-plants/cli.js download "Dallas County, Texas" --out plants-dallas.csv
//   node tools/usda-plants/cli.js download-names names.txt --out plants.csv
//
// Flags: --delay-ms=1000 (min gap between USDA requests), --out=<path>

import { writeFile, readFile } from "node:fs/promises";
import { UsdaClient } from "./usdaClient.js";
import { searchByLocationCriteria, searchByNames } from "./search.js";
import { fetchPlantDetails } from "./fetchDetails.js";
import { rowsToCsv } from "./csvWriter.js";
import { INTERMEDIATE_CSV_COLUMNS } from "./mapCharacteristics.js";

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else positional.push(arg);
  }
  return { flags, positional };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  const client = new UsdaClient({ requestDelayMs: Number(flags["delay-ms"] || 1000) });

  if (command === "search-by-location") {
    const { state, county, results } = await searchByLocationCriteria(client, positional[0]);
    console.log(`Resolved: state=${state.PlantLocationName} county=${county?.PlantLocationName ?? "(none)"}`);
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (command === "search-by-name") {
    const matches = await searchByNames(client, positional);
    console.log(JSON.stringify(matches, null, 2));
    return;
  }

  if (command === "download" || command === "download-names") {
    let candidates;
    if (command === "download") {
      const { results } = await searchByLocationCriteria(client, positional[0]);
      candidates = results.map((r) => ({ Id: r.Id ?? r.id }));
    } else {
      const namesFile = await readFile(positional[0], "utf8");
      const names = namesFile.split("\n").map((s) => s.trim()).filter(Boolean);
      const matches = await searchByNames(client, names);
      const unresolved = matches.filter((m) => !m.match);
      if (unresolved.length) {
        console.error("Could not resolve exactly:");
        for (const u of unresolved) {
          console.error(
            `  "${u.query}" — ${u.alternatives.length ? `did you mean: ${u.alternatives.map((a) => a.Symbol).join(", ")}?` : "no matches"}`,
          );
        }
      }
      candidates = matches.filter((m) => m.match).map((m) => ({ Id: m.match.Id }));
    }

    console.log(`Fetching details for ${candidates.length} species (rate-limited)...`);
    const { rows, errors } = await fetchPlantDetails(client, candidates, {
      onProgress: (done, total, c) => process.stdout.write(`\r${done}/${total} (plant id ${c.Id})   `),
    });
    process.stdout.write("\n");
    if (errors.length) {
      console.error(`${errors.length} lookups failed:`);
      for (const e of errors) console.error(`  id ${e.candidate.Id}: ${e.error}`);
    }

    const outPath = flags.out || "usda-plants-intermediate.csv";
    await writeFile(outPath, rowsToCsv(INTERMEDIATE_CSV_COLUMNS, rows));
    console.log(`Wrote ${rows.length} rows to ${outPath}`);
    return;
  }

  console.error(
    "Usage: cli.js <search-by-location|search-by-name|download|download-names> ... [--out=path] [--delay-ms=1000]",
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
