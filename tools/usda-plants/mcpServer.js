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
import { probeUsda, USDA_TARGET_FIELDS } from "./probe.js";
import { openProbeCache } from "./probeCache.js";
import { openClaimsStore } from "../claims/claimsStore.js";
import {
  claimsCoverage,
  claimsProvenance,
  claimsConflicts,
  claimsSources,
  claimsCorrect,
  claimsDryRun,
} from "../claims/claimsTools.js";

const client = new UsdaClient({ requestDelayMs: 1000 });

// Opened lazily, on the first usda_probe call — not every MCP server start
// should create data/ and a SQLite file on disk, only ones that actually probe.
let probeCache = null;
function getProbeCache() {
  if (!probeCache) probeCache = openProbeCache();
  return probeCache;
}

// Opened lazily on the first claims_* call, same reasoning as probeCache
// above — a server start that never queries the claim store shouldn't touch
// data/claims.db (which may not exist yet in a fresh checkout: nl-scx.1's
// rebuild.js is what creates it).
let claimsDb = null;
function getClaimsDb() {
  if (!claimsDb) claimsDb = openClaimsStore();
  return claimsDb;
}

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

server.registerTool(
  "usda_probe",
  {
    title: "Probe USDA for one species' raw data, unnormalized",
    description:
      "For nl-41o.9/nl-41o.1/nl-41o.2's investigation, not for collection: fetches a USDA " +
      "plant's RAW profile and characteristics (no normalization, no plants.csv mapping — " +
      "the point is seeing exactly what the source said, so a parse bug stays distinguishable " +
      "from a real source gap) and reports which of a target-field list (county nativity, " +
      "soil/light/water tolerance, mature width, commercial availability) it actually " +
      "populated for this species. Responses are cached in data/probe-cache.db, so repeated " +
      "probes of the same species don't re-fetch — pass force:true to bypass the cache and " +
      "re-check whether a source has changed. Read-only: never writes plants.csv or any " +
      "claim store.",
    inputSchema: {
      plantId: z.number().int().describe("USDA internal plant id, from usda_search_by_name"),
      force: z.boolean().optional().describe("Bypass the cache and re-fetch"),
    },
  },
  async ({ plantId, force }) => {
    try {
      const result = await probeUsda(client, getProbeCache(), plantId, { force: !!force });
      return textResult(result);
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
  },
);

server.registerTool(
  "usda_probe_target_fields",
  {
    title: "List the fields usda_probe sniffs for",
    description:
      "Returns the current target-field list usda_probe checks population against, with the " +
      "reasoning/caveats for each (e.g. why a populated NativeStatuses value is still not " +
      "county nativity). Call this before reading a lot of usda_probe results, since the list " +
      "grows as nl-41o.1's required-fields audit names new fields to check.",
    inputSchema: {},
  },
  async () => textResult(USDA_TARGET_FIELDS.map(({ key, label, note }) => ({ key, label, note }))),
);

// ---------------------------------------------------------------------------
// Phase 2 (nl-scx.9): six claims_* tools querying data/claims.db, per
// docs/data-acquisition/07-mcp-introspection.md §3. Extending this server
// rather than adding a second one is §1's explicit decision — the server
// keeps the name "usda-plants" even though these tools have nothing
// USDA-specific about them (see §1's reasoning). Five read tools, one write
// tool (claims_correct) — see 07 §4.
// ---------------------------------------------------------------------------

server.registerTool(
  "claims_coverage",
  {
    title: "Claim coverage: asserted / review / unknown / missing, per species and field",
    description:
      "Coverage over the claim store (07 §3.1 / 05 §4's completeness and Missing queries in one " +
      "tool). For each (species, field) in scope: status is 'asserted' (a real, usable value), " +
      "'review' (a claim exists but needs a human), 'unknown' (a source was checked and had " +
      "nothing), or 'missing' (no source has been checked at all) — 'unknown' and 'missing' are " +
      "kept distinct on purpose, they mean different next actions. A cultivar with no own claim " +
      "reports its parent species' status, not 'missing' (04 §2.3). Omit both arguments for a " +
      "full coverage sweep across every species and every field any claim has ever been written " +
      "for (there is no separate 'required fields' list to scope against yet).",
    inputSchema: {
      field: z.string().optional().describe("Limit to one field; omit for every field ever claimed"),
      species: z.string().optional().describe("USDA symbol or taxa.id; omit for every species"),
    },
  },
  async ({ field, species }) => {
    try {
      return textResult(claimsCoverage(getClaimsDb(), { field, species }));
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
  },
);

server.registerTool(
  "claims_provenance",
  {
    title: "Every claim for one (species, field), and which one wins",
    description:
      "Answers 'what did each source actually say for this field, and why did one win' (07 §3.2). " +
      "Returns every claim row ever written for (species, field) — including superseded ones, so " +
      "the full history is visible — plus the precedence resolution over the currently-active " +
      "claims (nl-scx.5's rule) and the reason it won. resolved is null when there is nothing " +
      "active to resolve, or when the active claims are tied and routed to review.",
    inputSchema: {
      species: z.string().describe("USDA symbol or taxa.id"),
      field: z.string().describe("Claim field, e.g. sun_pref"),
    },
  },
  async ({ species, field }) => {
    try {
      return textResult(claimsProvenance(getClaimsDb(), { species, field }));
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
  },
);

server.registerTool(
  "claims_conflicts",
  {
    title: "The adjudication queue: review rows and disagreeing sources",
    description:
      "The human review queue (07 §3.3 / 05 §4's Adjudication metric): every (species, field) with " +
      "either a status='review' claim or two or more active asserted claims that disagree in " +
      "value. Both causes are bucketed together deliberately — both need a human, whether the " +
      "disagreement is source-vs-source or a screen that already fired on one source. Read-only: " +
      "this only surfaces conflicts, it never resolves one — call claims_correct for that.",
    inputSchema: {
      field: z.string().optional().describe("Limit to one field; omit for every field"),
    },
  },
  async ({ field }) => {
    try {
      return textResult(claimsConflicts(getClaimsDb(), { field }));
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
  },
);

server.registerTool(
  "claims_sources",
  {
    title: "Per-source health: claim counts, freshness, and license grant",
    description:
      "Per source (07 §3.4): claimCount, claimCountByField (also answers 'what would re-crawling " +
      "source X touch' without the dry-run machinery), retrievedAtMin/Max and avgAgeDays (05 §4's " +
      "freshness query), and the license grant that source's claims were extracted under " +
      "(grant/condition/citationRequired) — null when the source carries no license row (e.g. " +
      "manual-correction).",
    inputSchema: {
      source: z.string().optional().describe("Limit to one source, e.g. npin; omit for every source"),
    },
  },
  async ({ source }) => {
    try {
      return textResult(claimsSources(getClaimsDb(), { source }));
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
  },
);

server.registerTool(
  "claims_correct",
  {
    title: "Write a manual correction (the only write tool in this surface)",
    description:
      "Appends a correction to catalog/manual-corrections.tsv (07 §3.5) — it does NOT " +
      "write data/claims.db directly, so the effect is only visible after the next rebuild " +
      "(tools/claims/rebuild.js); claims_provenance will not reflect this correction immediately. " +
      "reason and author are required with no optional path around either — a correction without " +
      "both is indistinguishable from a silent edit (04 §3.4). A manual correction outranks every " +
      "other source by construction (09 §2.1), so it takes effect on the next rebuild regardless " +
      "of what else exists for this (species, field).",
    inputSchema: {
      species: z.string().describe("USDA symbol or taxa.id"),
      field: z.string().describe("Claim field, e.g. sun_pref"),
      value: z.string().describe("The corrected value"),
      reason: z.string().describe("Required. Why the correction is right — this becomes the claim's citation."),
      author: z.string().describe("Required. Who is making this correction."),
    },
  },
  async ({ species, field, value, reason, author }) => {
    try {
      return textResult(claimsCorrect(getClaimsDb(), { species, field, value, reason, author }));
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
  },
);

server.registerTool(
  "claims_dry_run",
  {
    title: "Preview an export or a re-crawl without writing anything",
    description:
      "Two modes (07 §3.6). 'export': diffs what a plants.csv export would produce right now " +
      "against the committed file — added (a field newly populated), changed ({species, field, " +
      "from, to}), newlyExcluded (a value that would drop out because its license grant no longer " +
      "covers it). 'recrawl' (requires source): does NOT perform a live fetch — no per-source " +
      "fetch pipeline is wired into this tool, and fabricating what a fresh value would say would " +
      "violate this store's invent-nothing rule. It reports only the subset 07 §3.6 itself calls " +
      "answerable without a live fetch: currently-missing (species, field) pairs this source is " +
      "eligible to fill, per precedence.js. 'changed' and 'newlyExcluded' are always empty in " +
      "recrawl mode, with a note explaining why. Read-only either way — this never writes.",
    inputSchema: {
      mode: z.enum(["export", "recrawl"]).describe('"export" or "recrawl"'),
      source: z.string().optional().describe('Required when mode is "recrawl", e.g. npin'),
    },
  },
  async ({ mode, source }) => {
    try {
      return textResult(claimsDryRun(getClaimsDb(), { mode, source }));
    } catch (err) {
      return { ...textResult(`Error: ${err.message}`), isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
