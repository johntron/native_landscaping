# Ecological analysis

Deep dive for the rules engine (`src/analysis/`), the ecology tables in `ecology/`,
and the offline fetch tools that fill them. [AGENTS.md](../AGENTS.md) is the map.

## Overview

The app grades a planting against ecological rules and reports **per dimension with
no composite score** — a 0–100 roll-up would need weights nobody can justify, so
each dimension reports for itself and the reader decides what to fix first. Nine
dimensions ship: bloom succession (6), fall/winter bird food (7), vertical layers
(11), keystone genera (4/10), larval hosts (5), site match (8), local fauna
support (below), drifts (9), and mature-size spacing (12).

```
ecology/host-genera.csv          one genus-keyed table, shared by rules 4, 5, 10
ecology/plant-animal-interactions.csv  genus-keyed, global (GloBI) — local-fauna-support
a yard's nearby fauna            per yard, data/ecosystem.db (iNaturalist) — local-fauna-support
ecology/region-fauna.csv         region-keyed, a county (iNaturalist) — the public keystone screen
src/analysis/ecology.js          the registry; analyzeEcology(ctx) -> one result per rule
src/analysis/hostGenera.js       parse + index the table, resolving synonym_of
src/analysis/faunaMatches.js     parse + index the two fauna tables and join them
src/analysis/months.js           month-set helpers ("Oct-Feb", not "Oct, Nov, Dec, …")
src/analysis/rules/*.js          one file per rule: { id, title, evaluate(ctx) }
src/render/ecologyPanel.js       the panel above the species table — presentation only
tools/fetch-plant-animal-interactions.mjs  offline fetch for the interactions CSV
tools/fetch-nearby-fauna.mjs      a yard's nearby fauna (iNaturalist), per yard
tools/fetch-nhd-creeks.mjs        a yard's streams (NHD), per yard
tools/fetch-osm-greenspace.mjs    a yard's green space (OSM/Overpass), per yard
tools/fetch-region-fauna.mjs      a county's Lepidoptera, for the public page
```

**`src/analysis/` is pure.** No DOM, no fetch, no judgement made outside it. Every
threshold and verdict lives in a rule module; `ecologyPanel.js` renders what it is
handed and must not invent a status of its own.

**`status` is a closed set of four** — `ok` (nothing to do), `partial` (works, has a
hole), `gap` (the dimension is essentially unmet), `not-declared` (the input this
rule needs is absent). The panel maps exactly four chips, so a fifth value would
render as an unstyled blank rather than fail loudly. `analyzeEcology` normalizes
anything else to `not-declared`, and a rule that **throws** becomes a
`not-declared` row naming the failure: the analysis is advisory and must never be
the reason a yard stops rendering.

`ctx` is built once by `buildEcologyContext` — `{ plants, species, placedSpecies,
unplacedSpecies, placedGenera, hostGenera, site, ecoregion }`. `plants` are the
objects `createPlantFromSpecies` already minted; **the analysis never builds its own
plant shape**, or the two paths drift and a rule grades a plant the renderer would
draw differently. Rules count by *species*, not by plant: a drift of nineteen asters
is one answer to "what blooms in October", not nineteen. Rule 11 reuses
`classifyPlantLayer` rather than re-bucketing by height, for the same reason.

## `ecology/host-genera.csv`

Rules 4, 5, and 10 all reduce to "what does this genus do for insects", so they
share **one checked-in table** rather than three. Per-species columns on
`plants.csv` were rejected: 48 rows of hand-researched booleans is expensive and
invites invention.

Columns: `genus, ecoregion, lep_host_species, bee_specialist_species, larval_hosts,
synonym_of, source`.

- The keystone counts are the NWF *Keystone Native Plants* top-30 lists for **EPA
  Level I ecoregion 9, Great Plains** — where Dallas and the Blackland Prairie sit —
  transcribed verbatim from
  <https://www.nwf.org/-/media/Documents/PDFs/Garden-for-Wildlife/Keystone-Plants/NWF-GFW-keystone-plant-list-ecoregion-9-great-plains.pdf>.
  Extract with `pdftotext -layout` and **check twice**: the two-column layout drops
  `Alnus` (164) from a line-wise read of the caterpillar column, and wrapped rows put
  the count on the following line. `Salix`, `Solidago`, and `Helianthus` appear on
  both lists and are ONE row with both columns filled.
- `larval_hosts` covers documented relationships the keystone lists miss —
  `Asclepias`→monarch, `Passiflora`→gulf fritillary. **Rule 5 reads this column, not
  the keystone counts**: `Asclepias` is on neither top-30 list, so deriving rule 5
  from keystone membership would report a monarch garden as hostless.
- `synonym_of` is load-bearing. NWF files ragwort under `Senecio`; the catalog and
  both layouts use `Packera obovata`. Without the mapping the frontyard's ragwort is
  silently missed.
- `ecoregion` is a column, so **a second region is a data change, not a code change**.
  Parts of DFW east of Dallas fall in EPA Level I ecoregion **8**, not 9, so a project
  there needs its own rows.
- **Every row carries a `source`, and a genus with nothing sourced stays blank rather
  than guessed** — see "Rules that hold everywhere" in AGENTS.md.

## Local fauna support: `ecology/plant-animal-interactions.csv` and the yard's nearby fauna

The other six dimensions grade against ecoregion-wide lists. This one asks a
different question — which animals are ALREADY reported near this specific yard,
and would a planted genus plausibly serve them — with the same "fetch offline,
keep `src/analysis/` pure" pattern as `host-genera.csv`, split into two tables
because the two facts have different lifetimes (and, since nl-3s5.31, different
privacy: one is about the world, the other about one person's yard):

- `ecology/plant-animal-interactions.csv` — genus-keyed, global, from
  [GloBI](https://www.globalbioticinteractions.org/). Columns: `genus,
  animal_species, animal_common, category, interaction_type, synonym_of,
  source`. `category` is only `pollinator` or `feeds-on` — **not a finer split**,
  because the underlying data does not reliably support one: a smoke test
  against *Achillea* showed foraging bees and true herbivores both filed under
  GloBI's generic `eatenBy` verb, with no `pollinatedBy`/`flowersVisitedBy`
  records at all for that genus. Read the raw `interaction_type` when the
  distinction matters. Regenerate with
  `node tools/fetch-plant-animal-interactions.mjs` (or `--genus X` for one
  genus, `--smoke` for a quick check — both print to stdout instead of writing).
- **The yard's nearby fauna** — per yard, the `fauna` layer in
  `data/ecosystem.db` (`project_nearby_fauna`; see "Site layers" below), from
  iNaturalist's `species_counts` endpoint. Columns: `iconic_taxon,
  animal_species, animal_common, nearest_radius_mi, observation_count,
  establishment_means, fetched_on, source`. `nearest_radius_mi` is the smallest
  of five distance bands (1, 3, 8, 15, 25 mi) the species was found within — a
  proxy for "how close is confirmed presence", since `species_counts` gives a
  count per radius, not a per-observation distance. The design tool reads it
  from `GET /api/ecosystem/site` (`src/data/yardSite.js`). Until nl-3s5.31 it was
  the committed, place-keyed `ecology/nearby-fauna.csv`, which put the owner's
  site in this public repo. Refresh by hand with `node tools/fetch-nearby-fauna.mjs
  --project <slug>` (`--smoke` for one taxon/radius, no write).

**Keep the two tables' genera in step.** `plant-animal-interactions.csv` must cover
every `host-genera.csv` genus, not only the ones in `plants.csv`. A genus with no GloBI
rows joins to zero animals and silently ranks last in the ecosystem plant matches. After
adding a genus, run `node tools/fetch-plant-animal-interactions.mjs --genus X --merge`.
Large genera (Quercus, Salix) can 500 in a batch, so retry them one at a time. Pass
genus lists literally or from a file rather than through a shell variable, and check the
CSV diff afterwards: the tool's echoed argument list once looked right while it fetched
the wrong genera.

**The join is genus↔species, same asymmetry as `host-genera.csv`**: interactions
are genus-keyed because that is how the literature records them (monarch is
documented against *Asclepias*, not *Asclepias tuberosa*), animals are
species-keyed because that is what the user actually wants named.
`src/analysis/faunaMatches.js` does the join — pure, no network — comparing each
matched animal's `nearest_radius_mi` against `RANGE_THRESHOLD_MI`, a reasoned
per-taxon-group distance judgment (3mi for insects/reptiles/amphibians, 8mi for
mammals, 15mi for birds), the same kind of authored threshold as
`AMPLE_SHARE`/`SOME_SHARE` in `rules/keystoneGenera.js` rather than a sourced
biological fact. **No likelihood score is computed anywhere in this path** —
iNaturalist counts carry heavy observer bias (monarchs wildly over-reported
relative to native bees), so both the per-plant detail-sheet section and the
`local-fauna-support` rule report presence + distance band + counts and leave
judgement to the reader. The rule's own `suggestions` deliberately point at the
keystone-genera check rather than re-deriving a ranked list of catalog species,
since keystone status is a far more reliable signal than what iNaturalist
happened to have observations for.

**Exact coordinates never reach git, and neither does anything derived from
one yard's site** (nl-3s5.31). A project's `place` field is a short label like
`"home"`; nothing is keyed by it any more except the feed's rarity lane, which
resolves it among the caller's own yards. The address or lat/lng lives in `app.db`
(`projects.location_json`, nl-3s5.3; it was the gitignored `location.json`), and is
read by the `tools/` fetch scripts (through `tools/projectSite.mjs`) and, server-side
only, by `GET /api/ecosystem`. With `?project=`, that route returns the yard's
`{lat, lng}`, to its owner only, so outbound iNaturalist links can be
location-scoped (a deliberate, owner-requested exception). The coordinates still
never reach git or a committed file. Set them with:

```bash
node tools/project-location.mjs --project backyard --address "123 Main St, Dallas, TX 75204"
node tools/project-location.mjs --project backyard --lat 32.81 --lng -96.79
```

A yard with no location set yet, or whose fauna layer is still being fetched, reports
`not-declared` on this one dimension, the same "absent means undeclared, never guessed"
contract as `ecoregion`. A place label is not needed.

**The public "Start here" page** (index.html, its keystone screen) never reads a yard.
Its "In county" column is `ecology/region-fauna.csv`: every butterfly and moth species
with a research-grade, wild iNaturalist record in Dallas County (iNaturalist place 1281),
fetched by `node tools/fetch-region-fauna.mjs` and committed with a `source`. The county
is our judgement (it is the county the flora column already checks), and the claim it
supports is "recorded in the county", never a distance. Until nl-3s5.31 that column was
the owner's own site's fauna, which put the owner's surroundings on a public page.

## The nearby-species index: `data/ecosystem.db`

The "What's nearby" page, its drawer, and the feed's rarity lane read species
reported on iNaturalist near a yard from `data/ecosystem.db`, a gitignored,
rebuildable cache (`tools/ecosystemIndexDb.js`). Since nl-3s5.6 it is **keyed by
yard**, app.db `projects.id`, not by the `place` label, which any owner can set to
anything:

- `project_species_observations`: one row per (yard, iconic taxon, species), at
  the nearest radius band it was found in.
- `project_index_builds`: one row per yard, `building | ready | failed`, with a
  one-way fingerprint of the location it was built for (`locationKey`, never the
  location itself). A yard whose location changes is due again, and its old
  site's rows stop showing at once.

**Site layers (nl-3s5.31).** The same database holds each yard's habitat anchors and
nearby fauna, which were committed place-keyed CSVs until they put the owner's site in
this public repo: `project_anchors` (layers `streams` and `greenspace`),
`project_nearby_fauna` (layer `fauna`), and `project_layer_builds`, one row per (yard,
layer) with the same states and location fingerprint as `project_index_builds`. No row
holds a coordinate. They reach a browser only through `GET /api/ecosystem/site?project=`,
resolved exactly like `/api/ecosystem` (401 anonymous, the same 404 for a yard that is
missing or someone else's, the example reads its source yard's rows, no location sent).
The old CSV rows were moved into the owner's yards once, by a one-time import tool
(nl-3s5.31) that has since been run, verified and deleted; the CSVs were purged from
git history (nl-3s5.33).

**Built without manual steps.** `feed-poller` runs the queue
(`tools/ecosystemIndexQueue.js`) after the saved-area poll on every tick: every
yard with a location and no index (or no site layer) for it, oldest first. The
politeness budget is per upstream: one network-touching build a tick for
iNaturalist (shared by the index and the fauna layer), one for NHD and one for
Overpass, so a new yard's layers are all in within two ticks. At the default
30-minute tick that is at most 48 Overpass queries a day, under the 100 a day the
OpenStreetMap wiki gives for regular use of the public instance; the other limits
are our judgement. The queue is derived from
the two databases, not stored, so nothing has to enqueue a job when a location is
saved. Judgement calls, labelled as such in the module: at most one build that
touched the network per tick (a build served entirely from the probe cache costs
iNaturalist nothing and does not count), a failed build retried after 1 h,
doubling to a day, and a `building` row older than an hour treated as abandoned.
`GET /api/ecosystem?project=` returns `index: { state, fetchedOn }`, with state
`no-location | queued | building | ready | failed`; the page and drawer say
"no location set" or "Building…" instead of showing an empty table. A forced
refresh is still `node tools/fetch-ecosystem-index.mjs --project <slug> --force`.

**The rarity lane** resolves a saved area's `filters.place` among the area
owner's own yards only (case-insensitive), taking the oldest with a built index.
`GET /api/ecosystem/places` lists the caller's own indexed place labels.

**The example yard** has no location, so no index or site layers of its own. It
shows the index and the layers of the owner's yard it was refreshed from (the
`projectId` that `tools/refresh-example-yard.mjs` records in
`app_meta.example_yard`), with `location: null`.

The pre-nl-3s5.6 place-keyed table, `species_observations`, is retired (nl-3s5.32):
`openEcosystemDb` drops it on open if a database still has it. The one-time
migration tool that copied its rows to yards, `tools/rekey-ecosystem-index.mjs`, has
been run against every owner's data and is deleted; there is nothing left to migrate.

## Habitat anchors: a yard's `streams` and `greenspace` layers

Part of the pivot away from a per-parcel habitat score (nl-3hi) toward
observable facts: what real corridors and green space sit near the site, and
how far away — never a connectivity score or gradient. One table for every
anchor kind (not one file per source), because stage 5 of the epic is a
human promoting a row from `candidate` to `anchor`, which is a `status` edit,
not a file merge. Per yard since nl-3s5.31 (`project_anchors` in `data/ecosystem.db`;
it was the committed, place-keyed `ecology/anchors.csv`). Columns: `kind, name, status,
distance_mi, detail, fetched_on, source`, plus the layer. `kind` is `stream`, `park`, `cemetery`, `forest`,
`nature_reserve`, or `golf_course`; `status` is `anchor` (NHD hydrology —
the epic's "best ecological signal", a fact) or `candidate` (OSM
leisure/landuse tags — administrative, not ecological: a live test returned
"Texas State Fair Grounds" and "Old East Dallas Work Yard" as `leisure=park`,
so nothing from OSM is ever written as `anchor`). `distance_mi` is straight-line
distance to the nearest point on the actual feature geometry — not a
centroid, and rounded to the nearest quarter mile as a privacy floor, since a
named creek plus an exact distance is more locating than the coarse distance
*bands* the fauna layer gets away with.

`feed-poller` builds both layers for every yard with a location. Refresh by hand with
`node tools/fetch-nhd-creeks.mjs --project <slug>` (streams,
via USGS NHD's `hydro.nationalmap.gov` flowline layer) and
`node tools/fetch-osm-greenspace.mjs --project <slug>` (green space, via
OpenStreetMap/Overpass, with a `MIN_ACRES` size floor so pocket-park- and
traffic-island-scale features don't pollute the candidate list — an
authored judgment call, like `AMPLE_SHARE` in `rules/keystoneGenera.js`, not
a sourced fact). Both take `--smoke` to print without writing and `--force`
to bypass the probe cache. Same pattern as the fauna layer above; geometry math (point-to-line distance,
polygon area) lives in `tools/geoShared.mjs`, tested in
`tests/geoShared.test.js`.

**Shown on the "What's nearby" page** (`ecosystem.html`, section "Habitat nearby"):
`src/analysis/anchors.js` groups the yard's rows from `/api/ecosystem/site` (pure,
unit-tested) and the page lists
streams and unchecked green space by name and straight-line distance, with the
USGS and OpenStreetMap credits (`ecology/NOTICE.md`; licensing checked under
nl-3hi.7.6 item 3). Still not built: no `src/analysis/` rule grades against it,
and stages 3/4 (PAD-US protection status, named barriers) add more rows first.
The page makes no claim that waits on nl-3hi.7.6's open items (GAP code
meanings, cemeteries as prairie remnants, the EMST caveat).

## `project.json`: `ecoregion` and `site`

```json
"ecoregion": "9",
"site": { "sun": "part-sun", "water": "medium", "soil": "clay" }
```

Both optional, and a partial `site` is allowed: what is undeclared is reported as
undeclared, never guessed. Vocabularies are `SITE_VOCABULARY` in
`src/data/projectConfig.js`. **`serializeProjectConfig` whitelists fields** — a field
added only to the normalizer survives in memory and vanishes the first time Setup
mode saves, with no error, so both halves must be touched and
`tests/projectConfig.test.js` asserts the round trip.

## `sun_pref` and `water_pref` are REQUIREMENTS, not tolerances

Commit `ed9d75c` fixed exactly this inversion once already. `full-sun` means *needs a
lot of light* (little bluestem, Indiangrass); `shade` means *needs little* (Carex
blanda, inland sea oats). So rule 8's comparison is **asymmetric, not a distance**:

| direction | failure |
|---|---|
| wants more light than the site gives | weak bloom, stems flopping — real at one step, hard at two |
| wants less light than the site gives | scorch — mild at one step, real at two |
| wants more water than the site gives | droughts out |
| wants less water than the site gives | rots |

Soil is set membership, not a scale: `soil_pref` holds a comma-separated list of
accepted soils, and a site's declared soil only has to appear in that list, not
match it exactly. Both directions on both scales are covered in
`tests/ecology.test.js`; keep them covered.

## Two results that look like bugs and are not

- **Keystone genera can read weak even though the catalog now has them.** Seven of
  the catalog's 49 genera are keystone in ecoregion 9: `Quercus` (five oaks, added
  after this rule shipped, and alone the host of 253 caterpillar species),
  `Helianthus`, `Solidago`, `Symphyotrichum`, `Verbesina`, `Vernonia`, and `Packera`
  (via `Senecio`). A yard that has not *placed* them still reports the gap. The rule
  names the missing heavy hitters as a gap to close, not as an error.
- **Rule 4/10 measures footprint AREA**, `π(width/2)²`, not head-count: rule 10 is
  about how the yard's ground is spent. `createPlantFromSpecies` defaults `width` to
  1, so a species with a blank `width_ft` would silently contribute 1 ft² — harmless
  for a perennial, badly wrong for a tree. Such plants are excluded from **both**
  sides of the ratio and the finding says how many.

## Why FQA was rejected

Floristic Quality Assessment grades how intact a **remnant's existing flora** is —
the wrong instrument for a design. Its FQI metric rewards species richness, which
directly contradicts the drift and concentration rules; and no verified North Central
Texas C-value list is in hand, so implementing it would mean inventing plant data.
Don't re-propose it.


---
