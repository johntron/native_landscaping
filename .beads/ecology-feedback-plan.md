# Ecological feedback for a planting design

## Context

The app draws a native planting through the year but says nothing about whether the
design is any *good* ecologically. We explored two concepts and rejected the first:
Floristic Quality Assessment grades how intact a remnant's existing flora is, its FQI
metric rewards species richness (directly contradicting the drift/concentration rules),
and no verified North Central Texas C-value list is in hand — implementing it would mean
inventing plant data. So: a rules engine, reporting **per dimension with no composite
score**, and suggesting fixes from the existing `plants.csv` catalog.

Six rules in scope:

| # | Rule | Data needed |
|---|---|---|
| 6 | Bloom succession across the season | have it |
| 7 | Berry/seed food for birds into fall & winter | have it |
| 11 | Vertical layering | have it |
| 4/10 | Ecoregion keystone genera, and space concentrated in them | new genus table + `ecoregion` |
| 5 | At least one larval host plant | new genus table |
| 8 | Plants match actual site conditions | new `site` block |

Out of scope: rules 14–16 are maintenance practices and phasing intent, not properties of
a layout — folding them into this engine would be fake precision. **Rule 9 (drifts) and
rule 12 (mature-size spacing) are also out**, though both are computable from data already
in hand and would drop straight into the registry built here — rule 9 in particular has a
finding waiting for it (`example-frontyard`'s largest clump is 3, against the 5–10+ the
rule wants). Say the word and they go in; the plan below assumes they don't.

`tests/run-tests.cjs` discovers by glob (`readdir` + `.test.js`/`.test.cjs` filter), so
new test files run automatically — no manifest to update.

## Decisions taken

- **Per-dimension status only.** No 0–100 roll-up; the weights would be invented.
- **Suggestions drawn from `plants.csv`** (48 curated species) only. The untracked
  regional CSVs (`blackland-prairie-natives.csv` &c.) stay out of scope — they are
  uncommitted and partly unpopulated (`dfw-needs-manual-data.txt`).
- **Panel sits beside the species table**, collapsible. No new toolbar mode.
- **Site conditions go in `project.json`** as a `site` block.

## What the data already shows

Worth knowing before building, because it sets expectations for the first run:

- Both projects have **zero bloom Dec–Feb** and only one species blooming in November.
- `example-frontyard` has **no fruit at all Nov–May**; `backyard` is strong (7 species
  fruiting in October, 2–4 through winter).
- `example-frontyard` is nearly one-of-everything: 17 plants across 12 species, largest
  clump 3. `backyard` concentrates properly: 64 plants, largest clump 19.
- **Only 5 of the catalog's 42 genera are keystone in ecoregion 9** — `Helianthus`,
  `Solidago`, `Symphyotrichum`, `Verbesina`, `Vernonia` — and **none are woody**. Both
  projects will report weak on rule 4/10. That is a true finding, not a bug; the panel
  copy should read as a gap to close, not an error.

## Data sources (real, verified)

Dallas / Blackland Prairie sits in **EPA Level I ecoregion 9, Great Plains**. NWF
publishes the keystone genus lists per Level I ecoregion, from Tallamy's caterpillar-host
research and Fowler's pollen-specialist-bee research:

<https://www.nwf.org/-/media/Documents/PDFs/Garden-for-Wildlife/Keystone-Plants/NWF-GFW-keystone-plant-list-ecoregion-9-great-plains.pdf>

Both top-30 tables extract cleanly (`pdftotext -layout`) and were read in full during
planning — 30 lepidoptera-host genera with counts (Quercus 253 … Helianthus 58) and 30
pollen-specialist-bee genera with counts (Helianthus 89 … Helenium 10).

## Approach

### 1. One genus-keyed reference table — `ecology/host-genera.csv`

Rules 4, 5, and 10 all reduce to "what does this genus do for insects", so they share one
checked-in file rather than three. Per-species columns on `plants.csv` were rejected:
48 rows of hand-researched booleans is expensive and invites invention.

```
genus,ecoregion,lep_host_species,bee_specialist_species,larval_hosts,synonym_of,source
Quercus,9,253,,,,nwf-ecoregion-9
Helianthus,9,58,89,,,nwf-ecoregion-9
Asclepias,9,,,"monarch (Danaus plexippus)",,<cited during implementation>
Packera,9,,,,Senecio,nwf-ecoregion-9
```

- Seed the keystone columns **verbatim** from the ecoregion-9 PDF.
- `larval_hosts` covers well-documented obligate relationships that the keystone lists
  miss — `Asclepias`→monarch, `Passiflora`→gulf fritillary, native bunchgrasses→skippers.
  **Every row carries a `source`; a genus with nothing sourced stays blank rather than
  guessed** (AGENTS.md: don't invent plant data).
- `synonym_of` is load-bearing: NWF lists `Senecio`, but the catalog and both layouts use
  `Packera obovata` (segregated from *Senecio obovatus*). Without it the frontyard's
  ragwort is silently missed.
- `ecoregion` is a column now so a second region is a data change, not a code change.

### 2. `src/analysis/` — pure, no DOM

- `src/analysis/ecology.js` — registry + `analyzeEcology(context)`, returning one result
  object per rule: `{ id, title, status, summary, findings[], suggestions[] }`.
  **`status` is a closed set of four** — `ok` (nothing to do), `partial` (works, has a
  hole), `gap` (the dimension is essentially unmet), and `not-declared` (the input this
  rule needs is absent — no `site`, no `ecoregion`, or `host-genera.csv` failed to load).
  No other value; the panel maps exactly four chips and nothing else.
- `src/analysis/rules/*.js` — one file per rule, each exporting `{ id, title, evaluate(ctx) }`,
  matching the repo's focused-module style.
- `src/analysis/hostGenera.js` — parse + index the CSV, resolving `synonym_of`.

`ctx` is built once: `{ plants, species, hostGenera, site, ecoregion }`. `plants` are the
objects `createPlantFromSpecies` already mints — the analysis must never build its own
plant shape.

Reuse rather than reimplement:

- `classifyPlantLayer` (`src/state/layers.js`) for rule 11 — it already buckets
  trees / sculptural / accents / groundcover. Do not re-bucket by height.
- `parseMonthField` semantics in `src/data/plantParser.js` — `addRange` already wraps
  correctly, so `fruit_season_months: 10-2` yields `{10,11,12,1,2}`. Rules 6 and 7 consume
  `plant.floweringMonths` / `plant.fruitMonths` and get wrap-around for free.
- `getSpeciesKey` (`src/utils/speciesKey.js`) — add a sibling `getGenus(plant)` there
  (first whitespace-delimited token of `botanicalName`) rather than inlining the split.

Per-rule logic:

- **6 Bloom succession** — species count per month. The target window is the union of the
  placed plants' `growingMonths` (data-driven, so it doesn't hardcode a Texas season);
  months inside that window with zero bloom are gaps, with one species are thin.
- **7 Bird food** — species count per month from `fruitMonths`, weighted by `fruitLoad`,
  emphasizing Sep–Feb. Suggestions rank catalog species by how much of the gap they cover.
- **11 Vertical layers** — counts per `classifyPlantLayer` bucket; an empty layer is a finding.
- **4/10 Keystone** — join placed genera to the table. Report which keystone genera are
  present, and the **share of planted footprint area** (`π(width/2)²`) sitting in keystone
  genera, since rule 10 is about space, not head-count. Suggest unplanted catalog species
  in keystone genera. Note `createPlantFromSpecies` defaults `width ?? 1`, so a species
  with a blank `width_ft` silently contributes 1 ft² — harmless for a perennial, badly
  wrong for a tree. **Exclude plants with no declared width from both sides of the area
  ratio** and say how many were excluded.
- **5 Larval host** — at least one placed genus with a non-empty `larval_hosts` or
  `lep_host_species`. Name the hosts found; suggest catalog additions when none.
- **8 Site match** — compare each species' `sunPref` / `waterPref` / `soilPref` against
  the project `site`. Vocabularies in the catalog: sun `full-sun|part-sun|shade`,
  water `low|medium`, soil `clay|clay-loam|loamy|sandy`. Soil is set membership. Sun and
  water are ordered scales, and **the comparison is asymmetric, not a distance** — see
  below. Report `not-declared` when `project.json` has no `site`.

  **`sun_pref` is a light *requirement*, not a shade tolerance.** Commit `ed9d75c` fixed
  exactly this inversion once already: little bluestem, Indiangrass and switchgrass are
  `full-sun` (high light requirement), *Carex blanda* and inland sea oats are `shade`
  (low). So the two directions are not equivalent:

  - plant needs **more** light than the site gives → real failure (it will not bloom or
    will flop), flag at one step, hard at two;
  - plant needs **less** light than the site gives → scorch risk, mild at one step
    (`part-sun` plant in a `full-sun` yard is usually fine), real at two (a shade sedge
    in full sun).

  `water_pref` is likewise a requirement — a `high` plant on a `low`-water site droughts
  out, a `low` plant on a `high`-water site rots. Both directions are findings, but they
  are *different* findings and the copy should say which. Encode the direction in the rule
  module with a comment pointing at `ed9d75c`, and cover both directions in the tests.

### 3. `project.json` — `ecoregion` and `site`

```json
"ecoregion": "9",
"site": { "sun": "part-sun", "water": "medium", "soil": "clay" }
```

Thread through `normalizeProjectConfig` **and** `serializeProjectConfig`
(`src/data/projectConfig.js`). **`serializeProjectConfig` whitelists fields** — a field
added only to the normalizer is silently dropped the first time Setup mode saves. Cover
that with a round-trip assertion in `tests/projectConfig.test.js`.

Both fields optional: a project without them gets "not declared" on rules 8 and 4/10
rather than an error.

### 4. UI — `src/render/ecologyPanel.js`

- `index.html`: a `<div class="ecology-check" id="ecologyCheck">` immediately above
  `.species-table`, with a collapse toggle following the `settings-drawer` pattern.
- `renderEcologyPanel(results, container)` builds one row per dimension: status chip,
  one-line summary, and an expandable body with findings and suggestions — mirroring the
  species table's existing `Details` disclosure.
- Hook it into `refreshSpeciesTable` in `src/app.js` (~line 318), **not** `render()`. That
  comment is explicit about why: `render()` fires on every month-slider input event, and
  rebuilding this DOM mid-drag would orphan held elements.
- Load `ecology/host-genera.csv` with `fetchCsv` alongside `plants.csv` in the
  `Promise.all` at `src/app.js:1171`. Failure to load it should degrade the three
  genus-dependent rules to "unavailable", not break the app.

## Files

New: `ecology/host-genera.csv`, `src/analysis/ecology.js`,
`src/analysis/hostGenera.js`, `src/analysis/rules/{bloomSuccession,birdFood,verticalLayers,keystoneGenera,larvalHosts,siteMatch}.js`,
`src/render/ecologyPanel.js`, `tests/ecology.test.js`, `tests/hostGenera.test.js`.

Modified: `src/app.js` (load + hook), `src/data/projectConfig.js` (normalize + serialize),
`src/utils/speciesKey.js` (`getGenus`), `index.html`, `styles.css`,
`projects/*/project.json`, `tests/projectConfig.test.js`, `AGENTS.md`.

## Verification

1. `npm test` — the gate. New unit tests per rule against hand-built fixtures, including:
   a wrap-around fruit range (`10-2`) counting as winter food; `Packera obovata` resolving
   through `synonym_of` to `Senecio`; a project with no `site` reporting "not declared"
   rather than throwing; and the `project.json` round-trip keeping `site`/`ecoregion`.
2. `npm run serve`, open both projects, confirm the panel reports what the data above
   predicts — frontyard `gap` on bird food (no fruit Nov–May) and on keystone genera,
   backyard `ok` on bird food; both `gap` on bloom for Dec–Feb.
3. `npm run test:e2e` with a new spec asserting the panel renders and expands. **Add the
   project it targets to `SCRATCH_PROJECTS` in `tests-e2e/scratch-fixture.mjs`** — a spec
   pointed at a project missing from that list silently falls back to `drag-plan` and
   asserts against the wrong yard.
4. Per repo policy: commit and `docker compose restart web`, verifying the restart with
   `docker inspect … {{.State.StartedAt}} {{.State.Pid}}` before and after.

## Suggested sequencing

1. `host-genera.csv` + `hostGenera.js` + tests — the data foundation, and the only step
   with external research in it.
2. The three zero-new-data rules (6, 7, 11) + `ecology.js` registry + tests.
3. `ecologyPanel.js` + `index.html`/`styles.css` + the `app.js` hook — visible end to end.
4. `project.json` `site`/`ecoregion` plumbing, then rules 4/10, 5, 8.
