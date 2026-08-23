#!/usr/bin/env node
// MCP server exposing the USDA plant lookup tool over stdio.
//
// Point an MCP client at this file (e.g. `node tools/usda-plants/mcpServer.js`)
// to search USDA's PLANTS database by location or name, then fetch full
// characteristics for matches and write them to an intermediate CSV — ready
// for an LLM (or a human) to fill in the fields USDA doesn't have
// (foliage_color per season, width_ft, inflorescence, flower_zone, etc.)
// before merging into plants.csv. See README.md in this directory.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { UsdaClient } from "./usdaClient.js";
import { searchByLocationCriteria, searchByNames } from "./search.js";
import { fetchPlantDetails } from "./fetchDetails.js";
import { rowsToCsv } from "./csvWriter.js";
import { INTERMEDIATE_CSV_COLUMNS } from "./mapCharacteristics.js";

const client = new UsdaClient({ requestDelayMs: 1000 });

const server = new McpServer({ name: "usda-plants", version: "1.0.0" });

function textResult(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

server.registerTool(
  "usda_search_by_location",
  {
    title: "Search USDA PLANTS by location",
    description:
      'Find species candidates for a state or county, e.g. "Texas" or "Dallas County, Texas". ' +
      "Best-effort: USDA's own location-filter endpoint is known to fail server-side with a SQL " +
      "timeout regardless of the query. On failure this returns an error explaining that and " +
      "suggesting usda_search_by_name instead. Returns candidates only (no characteristics yet) " +
      "to keep this call cheap — pass the results to usda_fetch_details next.",
    inputSchema: { criteria: z.string().describe('e.g. "Dallas County, Texas" or "Texas"') },
  },
  async ({ criteria }) => {
    try {
      const { state, county, results } = await searchByLocationCriteria(client, criteria);
      return textResult({
        resolvedState: state.PlantLocationName,
        resolvedCounty: county?.PlantLocationName ?? null,
        results,
      });
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
  },
);

server.registerTool(
  "usda_search_by_name",
  {
    title: "Search USDA PLANTS by name",
    description:
      "Resolve a list of common or botanical names (or USDA symbols) to USDA plant records. " +
      "Reliable — use this when you already have specific species in mind, or as the fallback " +
      "when usda_search_by_location's endpoint fails. Returns an exact match per name when found, " +
      "otherwise up to 5 close alternatives to disambiguate.",
    inputSchema: { names: z.array(z.string()).describe("Common names, botanical names, or USDA symbols") },
  },
  async ({ names }) => {
    const matches = await searchByNames(client, names);
    return textResult(matches);
  },
);

server.registerTool(
  "usda_fetch_details",
  {
    title: "Fetch full USDA characteristics for plants",
    description:
      "Given USDA internal plant ids (the .Id field from usda_search_by_location or " +
      "usda_search_by_name results), fetch full characteristics for each — rate-limited to " +
      "one request/second per plant (two requests: profile + characteristics) to be a good " +
      "citizen of USDA's server — map them into the intermediate CSV schema matching plants.csv " +
      "plus raw usda_* columns for reference, and write the result to outputPath. Large lists take " +
      "a while by design; this is a background/batch operation, not interactive.",
    inputSchema: {
      plantIds: z.array(z.number().int()).describe("USDA internal plant ids to fetch"),
      outputPath: z.string().describe("Path to write the intermediate CSV to"),
    },
  },
  async ({ plantIds, outputPath }) => {
    const { rows, errors } = await fetchPlantDetails(
      client,
      plantIds.map((id) => ({ Id: id })),
    );
    await writeFile(outputPath, rowsToCsv(INTERMEDIATE_CSV_COLUMNS, rows));
    return textResult({
      wroteRows: rows.length,
      outputPath,
      errors,
      note:
        "This CSV covers plants.csv columns USDA can supply deterministically, plus usda_* raw " +
        "columns. Fields USDA has no equivalent for (width_ft, per-season foliage colors, " +
        "inflorescence, flower_count_hint, flower_zone) are left blank for the LLM/human pass.",
    });
  },
);

server.registerTool(
  "usda_download_plant_list",
  {
    title: "Search by location and fetch details in one step",
    description:
      "Convenience: runs usda_search_by_location then usda_fetch_details on every result. " +
      "Only use this once usda_search_by_location has confirmed it returns results for your " +
      "criteria — since it's rate-limited per plant, this can take minutes for a large county " +
      "species list.",
    inputSchema: {
      criteria: z.string().describe('e.g. "Dallas County, Texas"'),
      outputPath: z.string().describe("Path to write the intermediate CSV to"),
    },
  },
  async ({ criteria, outputPath }) => {
    let state, county, results;
    try {
      ({ state, county, results } = await searchByLocationCriteria(client, criteria));
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
    const { rows, errors } = await fetchPlantDetails(
      client,
      results.map((r) => ({ Id: r.Id ?? r.id })),
    );
    await writeFile(outputPath, rowsToCsv(INTERMEDIATE_CSV_COLUMNS, rows));
    return textResult({
      resolvedState: state.PlantLocationName,
      resolvedCounty: county?.PlantLocationName ?? null,
      wroteRows: rows.length,
      outputPath,
      errors,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
