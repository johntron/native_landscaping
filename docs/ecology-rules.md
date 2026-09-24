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
ecology/nearby-fauna.csv         place-keyed, local (iNaturalist) — local-fauna-support
src/analysis/ecology.js          the registry; analyzeEcology(ctx) -> one result per rule
src/analysis/hostGenera.js       parse + index the table, resolving synonym_of
src/analysis/faunaMatches.js     parse + index the two fauna tables and join them
src/analysis/months.js           month-set helpers ("Oct-Feb", not "Oct, Nov, Dec, …")
src/analysis/rules/*.js          one file per rule: { id, title, evaluate(ctx) }
src/render/ecologyPanel.js       the panel above the species table — presentation only
tools/fetch-plant-animal-interactions.mjs  offline fetch for the interactions CSV
tools/fetch-nearby-fauna.mjs      offline fetch for the nearby-fauna CSV
tools/fetch-nhd-creeks.mjs        offline fetch for anchors.csv streams (NHD)
tools/fetch-osm-greenspace.mjs    offline fetch for anchors.csv green space (OSM/Overpass)
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

## Local fauna support: `ecology/plant-animal-interactions.csv` and `ecology/nearby-fauna.csv`

The other six dimensions grade against ecoregion-wide lists. This one asks a
different question — which animals are ALREADY reported near this specific site,
and would a planted genus plausibly serve them — and does it with the same
"fetch offline, commit a sourced CSV, keep `src/analysis/` pure" pattern as
`host-genera.csv`, split into two tables because the two facts have different
lifetimes:

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
- `ecology/nearby-fauna.csv` — place-keyed, local, from iNaturalist's
  `species_counts` endpoint. Columns: `place, animal_species, animal_common,
  iconic_taxon, nearest_radius_mi, observation_count, fetched_on, source`.
  `nearest_radius_mi` is the smallest of five fetch-tool distance bands (1, 3,
  8, 15, 25 mi) the species was found within — a proxy for "how close is
  confirmed presence", since `species_counts` gives a count per radius, not a
  per-observation distance. Regenerate with `node tools/fetch-nearby-fauna.mjs
  --project <id>` (`--smoke` for one taxon/radius, no write).

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

**Exact coordinates never reach either CSV or git.** A project's `place` field
(next to `ecoregion` and `site` in `project.json`) is a short label like
`"home"` — committable, and two projects on the same property share one label
and one fetch. The address or lat/lng behind that label lives in `app.db`
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

A project with no `place` (or no location set yet) reports `not-declared` on this one
dimension, the same "absent means undeclared, never guessed" contract as
`ecoregion`.

## Habitat anchors: `ecology/anchors.csv`

Part of the pivot away from a per-parcel habitat score (nl-3hi) toward
observable facts: what real corridors and green space sit near the site, and
how far away — never a connectivity score or gradient. One table for every
anchor kind (not one file per source), because stage 5 of the epic is a
human promoting a row from `candidate` to `anchor`, which is a `status` edit,
not a file merge. Columns: `place, kind, name, status, distance_mi, detail,
fetched_on, source`. `kind` is `stream`, `park`, `cemetery`, `forest`,
`nature_reserve`, or `golf_course`; `status` is `anchor` (NHD hydrology —
the epic's "best ecological signal", a fact) or `candidate` (OSM
leisure/landuse tags — administrative, not ecological: a live test returned
"Texas State Fair Grounds" and "Old East Dallas Work Yard" as `leisure=park`,
so nothing from OSM is ever written as `anchor`). `distance_mi` is straight-line
distance to the nearest point on the actual feature geometry — not a
centroid, and rounded to the nearest quarter mile as a privacy floor, since a
named creek plus an exact distance is more locating than the coarse distance
*bands* `nearby-fauna.csv` gets away with.

Regenerate with `node tools/fetch-nhd-creeks.mjs --project <id>` (streams,
via USGS NHD's `hydro.nationalmap.gov` flowline layer) and
`node tools/fetch-osm-greenspace.mjs --project <id>` (green space, via
OpenStreetMap/Overpass, with a `MIN_ACRES` size floor so pocket-park- and
traffic-island-scale features don't pollute the candidate list — an
authored judgment call, like `AMPLE_SHARE` in `rules/keystoneGenera.js`, not
a sourced fact). Both take `--smoke` to print without writing and `--force`
to bypass the probe cache. Same offline-fetch/checked-in-CSV/gitignored-coords
pattern as `nearby-fauna.csv` above; geometry math (point-to-line distance,
polygon area) lives in `tools/geoShared.mjs`, tested in
`tests/geoShared.test.js`.

**Shown on the "What's nearby" page** (`ecosystem.html`, section "Habitat nearby"):
`src/analysis/anchors.js` groups the rows (pure, unit-tested) and the page lists
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
