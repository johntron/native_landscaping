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
- **`usda_probe`** — `{ plantId: 70468 }`. Source probe for nl-41o.9/nl-41o.1/nl-41o.2's
  investigation, not for collection: returns USDA's RAW profile and characteristics for one
  species (unnormalized — the point is seeing exactly what the source said) plus a report on
  which of a target-field list (county nativity, soil/light/water tolerance, mature width,
  commercial availability) actually came back populated. Cached in `data/probe-cache.db`
  (gitignored); pass `force: true` to bypass the cache and re-check a source. Never writes
  `plants.csv` or any claim store.
- **`usda_probe_target_fields`** — no input. Lists the current sniff targets with their
  caveats (e.g. why a populated `NativeStatuses` value is still not county nativity).

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
node tools/usda-plants/cli.js probe "Quercus shumardii"                   # or a numeric plant id
```

Flags: `--out=<path>` (default `usda-plants-intermediate.csv`),
`--delay-ms=1000` (min gap between USDA requests), `--cache-path=<path>`
(probe only, default `data/probe-cache.db`), `--force=true` (probe only,
bypass the cache).

## Source probe (nl-41o.9)

`usda_probe` / `cli.js probe` is the introspection tool the plant-data-acquisition
epic ([docs/data-acquisition](../../docs/data-acquisition/)) uses to *measure*
what a source publishes instead of trusting its documentation — the Alnus
case (nl-jsm.1, cited in
[03-document-corpus.md §6](../../docs/data-acquisition/03-document-corpus.md))
is the precedent: a clean-looking extraction silently dropped a row, and only
a second, raw look caught it. It returns USDA's RAW `PlantProfile` and `PlantCharacteristics`
responses untouched, plus a sniff report over
[`probe.js`](probe.js)'s `USDA_TARGET_FIELDS` list — fields already known
missing or in doubt (county nativity, soil/light/water tolerance breadth,
mature width, commercial availability). Responses are cached by
`(source, endpoint, id)` in a small SQLite file at `data/probe-cache.db`
(gitignored, rebuildable, `node:sqlite`, no dependency) so re-probing the
same species across sittings doesn't re-fetch or re-hammer USDA's server.

This is deliberately the **one implementation bead** in an otherwise
analysis-only epic — it extends this server rather than sitting beside it,
per the epic's "two servers with overlapping vocabulary is the bad outcome"
rule. It never writes `plants.csv` or any claim store; collection is a later
epic (nl-41o.4's data model, not yet built).

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

## Narrowing a fetch to one region

A statewide fetch is far too big to hand to the app — Texas yields 903 species
with characteristics. Narrowing it needs a source USDA does not have:

- Native status is **regional** (`L48`, `AK`, `HI`, `PR`, `VI`, `CAN`) — never
  state or county.
- `POST /api/plants-search-results` and its `/download` sibling both return a
  server-side SQL timeout for a county payload.
- There is **no distribution endpoint** in the API (all 42 paths checked);
  `PlantsDistributionResults` on a profile comes back `null`.
- `/api/NoxiousInvasiveSearch/GetInvasiveByState?state=Texas` returns zero rows,
  so USDA cannot flag Texas invasives either. Per-plant
  `GET /api/PlantInvasiveStatus/{id}` does work, reporting other states' listings.

Filtering on soil, pH, and drought instead **does not work** and fails quietly:
the Blackland Prairie is alkaline clay, but so is much of West Texas, so
desertbroom (Sonoran) and desert ceanothus (Trans-Pecos) pass a filter built to
select for Dallas.

So bring the geography from a regional planting list and match by name:

```bash
node tools/usda-plants/regionFilter.js texas-usda-plants.csv names.txt --out=dfw.csv
```

Sources for `names.txt` (one botanical name per line):

- **NPSOT plant lists by ecoregion** —
  <https://www.npsot.org/our-work/class-schedule/plant-lists-by-ecoregion/>.
  The "North Central Texas Area" PDF covers Dallas/Fort Worth/Denton and is
  curated for landscaping. Extract with `pdftotext -layout`.
- **Lady Bird Johnson Wildflower Center**, Texas Blackland Prairies collection
  (`er32`) — <https://www.wildflower.org/collections/printable.php?collection=er32>.
  ~2,340 species, the full floristic list for the ecoregion, natives only. The
  page does not render its results for a plain `curl`; save the *printable*
  view from a browser instead. Names sit in `<i>` tags in one plain table, so
  `grep -ao '<i>[^<]*</i>'` gets the list — use `-a`, since a saved `.mht` is
  binary to grep and `-o` silently prints nothing without it.

The two kinds of list answer different questions and are best used together: an
ecoregion flora says what actually grows here, a landscaping list says what is
worth planting. Intersecting the DFW landscaping list with the Blackland flora
found 4 of 59 recommendations that are not Blackland natives at all — common
sotol (Chihuahuan Desert), Texas mountain laurel (Edwards Plateau), purple
coneflower and American wisteria (eastern US). All are legitimate garden plants
locally; none is a local native.

Extraction from a PDF list is the weak link: the NPSOT table packs two species
into one row behind `1.` / `2.` prefixes, and a column-anchored regex silently
drops the second — that alone cost Shumard oak, live oak, eastern redcedar and
four more. Probe any extraction against a species you know belongs (is it in the
names file? is it in the intermediate CSV?) before trusting the count.

Genus+species matching also drags in every USDA infraspecific record under a
binomial, and the extras skew western — "Celtis laevigata" pulls in var.
*reticulata*, the netleaf hackberry of West Texas. The filter keeps the nominate
record plus any variety the list names outright, and falls back to whatever
exists when USDA has no nominate record.

Two things the filter reports, both worth reading:

- Species on the list that USDA has **no characteristics record** for. USDA
  covers only ~2,200 species nationwide, so this is large — 97 of ~160 for the
  DFW list. Those need their attributes sourced by hand.
- Species on the list that are **not native to the L48**. Regional lists often
  carry an "invasives to remove" section in the same table; the filter holds
  those back rather than passing them into a planting recommendation.

## Merging into plants.csv

This tool never writes `plants.csv` directly. Once the intermediate CSV is
augmented (LLM or by hand), review it and append/merge the rows yourself —
keeping `id` values unique per `AGENTS.md`'s rule that every `planting_layout.csv`
`id` must be unique and `plants.csv` `botanical_name` values must match what
layouts reference.
