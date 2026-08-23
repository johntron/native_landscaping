# USDA plant lookup

Searches the USDA PLANTS Database and fetches full species characteristics
into an intermediate CSV, ready for an LLM (or a human) to fill in the
fields USDA doesn't have before merging into the repo's `plants.csv`. See
`AGENTS.md` "Plant Data (CSV)" for the target schema.

Talks to `plantsservices.sc.egov.usda.gov`, USDA's own unauthenticated
backend API (confirmed against its public Swagger spec at
`/swagger/v1/swagger.json`). No API key. Requests are rate-limited
client-side (default: 1 request/second) — be a good citizen of a government
server with no documented rate limit of its own.

## Setup

```bash
npm install   # already includes @modelcontextprotocol/sdk and zod
```

## As an MCP server

```bash
node tools/usda-plants/mcpServer.js
```

Point your MCP client at that command over stdio. Tools exposed:

- **`usda_search_by_location`** — `{ criteria: "Dallas County, Texas" }`. Best-effort;
  see **Known limitation** below.
- **`usda_search_by_name`** — `{ names: ["Ilex vomitoria", "yaupon"] }`. Reliable.
  Returns an exact match per name, or up to 5 alternatives to disambiguate.
- **`usda_fetch_details`** — `{ plantIds: [15316, 74982], outputPath: "out.csv" }`.
  Rate-limited fetch + CSV write.
- **`usda_download_plant_list`** — `{ criteria, outputPath }`. Convenience:
  search-by-location then fetch-details in one call.

Typical flow: `usda_search_by_location` (or `usda_search_by_name`) to get
candidate `.Id`s, review them, then `usda_fetch_details` on the ones you
actually want — so an LLM driving this doesn't burn tokens or USDA rate
budget fetching species you'll discard.

## As a CLI

```bash
node tools/usda-plants/cli.js search-by-location "Dallas County, Texas"
node tools/usda-plants/cli.js search-by-name "Ilex vomitoria" "Abies concolor"
node tools/usda-plants/cli.js download "Dallas County, Texas" --out=plants-dallas.csv
node tools/usda-plants/cli.js download-names names.txt --out=plants.csv   # one name per line
```

Flags: `--out=<path>` (default `usda-plants-intermediate.csv`),
`--delay-ms=1000` (min gap between USDA requests).

## Known limitation: location search is unreliable

USDA's own bulk location-filter endpoint (`POST /api/plants-search-results`,
which the site's "Advanced Filters" location checkboxes use) returned a
server-side SQL timeout (`HTTP 500 "Execution Timeout Expired"`) for every
payload shape tried during development — state-level, county-level, with and
without extra fields — so this looks like a bug or capacity issue on USDA's
end, not something fixable by changing the request. The response schema on
success is consequently **unverified**; if it starts working, sanity-check
`search.js`'s handling of the result shape before trusting it downstream.

`usda_search_by_location` surfaces that failure as a clear error rather than
retrying in a loop (retrying a broken endpoint just hammers it) or silently
returning nothing. When it fails, fall back to `usda_search_by_name` with a
species list picked manually from https://plants.usda.gov/state-search or
https://plants.usda.gov/characteristics-search (state/county checkboxes with
result counts, no login needed) — then feed those names in.

Separately: even when location search works, USDA's own native-status data
(`NativeStatuses` on `/api/PlantProfile/{id}`) is **regional**, not
state-specific — buckets like `L48` (the entire Lower 48), `AK`, `HI`, `PR`,
`VI`, `CAN`. True county-level presence/absence lives only in the site's
interactive Esri map layer and per-species distribution download, not in a
queryable "which species are in county X" API.

## What's in the intermediate CSV

Every `plants.csv` column (see `mapCharacteristics.js`), populated where
USDA's characteristics data maps to it deterministically:

- Direct: `common_name`, `botanical_name`, `height_ft`, `sun_pref`,
  `water_pref`, `soil_pref`, `flower_color`, `fruit_color`, `fruit_load`,
  `growing_season_months`, `flowering_season_months`, `fruit_season_months`.
- Best-effort default, meant to be corrected: `growth_shape` (mapped from
  USDA's coarse Growth Habit — Tree/Shrub/Subshrub/Forb/Graminoid/Vine —
  which misses a lot of real variety; check against `usda_growth_form` and
  `usda_shape_and_orientation`).

Left blank — no USDA equivalent, needs the LLM/human augmentation pass:
`width_ft`, `foliage_color_spring`, `foliage_color_fall`,
`foliage_color_winter` (USDA has one `Foliage Color`, mapped to
`foliage_color_summer` only), `inflorescence`, `flower_count_hint`,
`flower_zone`.

Plus `usda_*` columns carrying the raw source values (growth form, shape,
foliage texture/porosity, conspicuousness flags, pH range, etc.) so the
augmentation pass has real source material instead of guessing from nothing.

Colors are converted from USDA's category words (e.g. "Yellow", "Brown") to
an approximate hex swatch via a fixed lookup table (`colorNames.js`) —
treat these as a starting point, not ground truth.

## Merging into plants.csv

This tool never writes `plants.csv` directly. Once the intermediate CSV is
augmented (LLM or by hand), review it and append/merge the rows yourself —
keeping `id` values unique per `AGENTS.md`'s rule that every `planting_layout.csv`
`id` must be unique and `plants.csv` `botanical_name` values must match what
layouts reference.
