# Goals analysis: what data gauges fitness for Dallas County

Deliverable for **nl-41o.1**. Analysis only — nothing here collects or writes plant data.

Every claim below is marked **MEASURED** (I ran it against the source or the data in
this repo, this session) or **BELIEF** (taken from documentation and not yet checked).
The distinction is the point: nl-41o.9 exists to convert beliefs into measurements,
and a plan built on unmarked beliefs is how a column gets filled by guesswork later.

Date of measurements: 2026-08-27.

---

## 1. Decision: fitness is a PROFILE, not a score

**Decided: profile.** No composite fitness number, now or later.

The nl-jsm epic already rejected a composite ecology score because the weights would be
invented, and AGENTS.md records that as settled. The same argument applies with more
force here, for a reason specific to this epic: a fitness score would have to weigh
*data quality* against *plant quality*, and those are not commensurable. A species with
excellent measured traits and one missing field would score the same as a mediocre
species with complete data, and nothing in the number would say which situation the
reader is in.

Consequence for the data model (**nl-41o.4**): there is no `fitness` column. Fitness is
whatever the per-dimension rules report, plus a per-species *assessability* statement
from nl-41o.6 — "this species can/cannot be judged on dimension X, because field Y is
absent". That is a count, which is defensible; a weighted index is not.

---

## 2. Required fields

Derived by reading `src/analysis/rules/*.js` directly, not from summaries of them.

"Blank tolerable" answers a narrow question: **if this field is empty, does the app
report that honestly, or does it invent a value and grade on the invention?** Section 5
shows this is currently broken for several fields — which is itself a required-fields
finding, because a field that silently defaults can never be safely left blank.

| # | Field | Consuming question | Granularity needed | Acceptable provenance | Blank tolerable? |
|---|---|---|---|---|---|
| 1 | `growing_season_months` | R6 — defines the window bloom is judged against | species | any sourced | **Yes** — rule returns `not-declared` |
| 2 | `flowering_season_months` | R6 — what blooms when | species, regional timing | regional source preferred; USDA `Bloom Period` is coarse (season words) | **Yes** — `not-declared` |
| 3 | `fruit_season_months` | R7 — fall/winter bird food | species, regional timing | regional preferred | **Yes** — `not-declared` |
| 4 | `fruit_load` | R7 — weights a month's crop | species | any sourced | **No** — see §5, `low` and blank both collapse to "sparse" |
| 5 | `height_ft` | R11 via `classifyPlantLayer` | species, mature | any sourced | **No** — defaults to 1 ft, silently bucketing the plant as groundcover |
| 6 | `growth_shape` | R11 via `classifyPlantLayer` | species | any sourced | **No** — defaults to `mound`, a fabricated shape |
| 7 | `width_ft` | R4/R10 footprint area; R9/R12 (deferred) | species, mature | any sourced | **Partly** — R4/R10 excludes blanks from *both* sides of the ratio and says how many (correct). Disqualifying for R9/R12. |
| 8 | genus (from `botanical_name`) | R4/R5/R10 join key into `host-genera.csv` | species | taxonomic authority | **No** — disqualifying, it is the join key |
| 9 | `sun_pref` (light **requirement**) | R8 | species | any sourced | **No** — blank is skipped *silently*, never surfaced |
| 10 | `water_pref` (requirement) | R8 | species | any sourced | **No** — same silent skip |
| 11 | `soil_pref` (accepted set) | R8 | species | any sourced | **No** — same silent skip |
| 12 | sun / water / soil **tolerance breadth** | R8 — separates "will not grow" from "grows, just smaller" | species | any sourced | **Yes** — absent today; rule 8 is stopgapped to a caution (commit a93ed52) |
| 13 | **county presence** | Scopes the whole catalog to Dallas County | **county** | authoritative distribution dataset | **No** — gates the plantable set (nl-41o.7) |
| 14 | **county nativity** (native vs adventive) | Separates desert willow from Mexican plum; makes a *local* keystone count possible | **county** | must distinguish native from introduced | **No** — this is the epic's headline field |
| 15 | `lep_host_species`, `bee_specialist_species` | R4/R10 | genus × ecoregion (today); genus × **county** wanted | NWF keystone lists | **Yes** — genus absent from table is handled |
| 16 | `larval_hosts` | R5 — deliberately separate from keystone counts | genus | documented relationship | **Yes** |
| 17 | `synonym_of` | Identity; R4/R5 resolution | species | taxonomic authority | **Yes** — but a missing synonym silently loses a plant (the Packera/Senecio case) |
| 18 | commercial availability | Suggestion ranking — an unbuyable recommendation wastes the slot | ideally metro; national is usable | trade source or USDA | **Yes** — degrades ranking only |

Fields 13 and 14 are stated separately on purpose. The epic treats "county-level
nativity" as one field and calls it the highest-leverage single item. **It is two
fields with completely different availability**, and §3 shows one of them is solved and
the other is not.

---

## 3. Availability audit

### 3.1 County distribution — the headline result

**MEASURED. USDA publishes county-level distribution, machine-readable, and this repo's
own README says it does not.**

`tools/usda-plants/README.md` states: *"There is **no distribution endpoint** in the API
(all 42 paths checked); `PlantsDistributionResults` on a profile comes back `null`."*

Both halves of that are literally true and the conclusion drawn from them is wrong. The
profile field *is* `null` — but the profile also carries `HasDistributionData: true`,
and the endpoint exists under a misleading name:

```
POST /api/PlantProfile/getDownloadDistributionDocumentation
Content-Type: application/json
{"masterId": 70468}
```

It returns `text/csv`, not documentation:

```
Distribution Data
Symbol,Country,State,State FIP,County,County FIP
QUSH,United States,Texas,48,Dallas,113
QUSH,United States,Texas,48,Tarrant,439
```

It was almost certainly skipped in the earlier sweep because the name reads as a
docs download. Measured results:

| Species | Id | Total rows | TX counties | In Dallas Co. (FIPS 48113) |
|---|---|---|---|---|
| *Quercus shumardii* | 70468 | 682 | 27 | **yes** |
| *Chilopsis linearis* (desert willow) | 49196 | 78 | 37 | **yes** |
| *Prunus mexicana* (Mexican plum) | 90602 | 507 | 42 | **yes** |
| *Packera obovata* | 38436 | 719 | 32 | **yes** |

Access shape: one POST per species, keyed by the numeric plant `Id` (`masterId`).
`{"unfilteredPlantIds":[70468]}` returns headers only — `masterId` is the working key.
Rows with an empty County column are state-level records; both kinds come back in one
response and must be separated on parse.

**Verdict for field 13 (county presence): AVAILABLE.** Machine-readable, from a US
Government source, at exactly the needed granularity.

### 3.2 County nativity — still unsourced, and the epic's premise needs amending

**MEASURED, and it is the uncomfortable half.** The distribution CSV has exactly six
columns — `Symbol, Country, State, State FIP, County, County FIP`. **There is no
nativity flag anywhere in it.** It records *presence*, not *native-ness*.

So the epic's own worked example does not resolve: **desert willow appears in Dallas
County exactly as Mexican plum does**, and nothing in the response distinguishes them.
Whatever the reason for the occurrence, the data cannot separate native from introduced.
Filtering on county presence alone would keep both — the precise failure the epic set out
to fix.

This is the distinction the epic already flagged BONAP as having ("distinguishes native
from ADVENTIVE per county — a distinction USDA blurs"). That flag was right, and it is
now measured rather than assumed.

**Verdict for field 14 (county nativity): NOT AVAILABLE from USDA.** BONAP remains the
only identified candidate and is the licensing-hard one — a question for **nl-41o.2**,
which must settle it before nl-41o.7 can define the plantable set.

**Net effect on the epic's premise:** the highest-leverage field splits in two. One half
is solved outright and unblocks a great deal (catalog scoping, the plantable set, a
county-restricted keystone count). The other half is the genuinely hard one, and it is
now correctly located — in licensing, not in access.

### 3.3 Tolerance breadth — true for soil, weaker than claimed for light and water

The epic asserts "USDA already publishes the breadth". **MEASURED** against
`blackland-prairie-natives.csv` (469 rows) and one live profile:

| Field | Fill | Distinct values | Real breadth? |
|---|---|---|---|
| `usda_soil_coarse` | 100% | Yes 324 / No 145 | **Yes** — three booleans give a genuine accepted-set |
| `usda_soil_medium` | 100% | Yes 456 / No 13 | |
| `usda_soil_fine` | 100% | Yes 327 / No 142 | |
| `usda_shade_tolerance` | 100% | High 226 / Med 127 / Low 115 | **No** — one ordinal, an optimum, not a range |
| `usda_drought_tolerance` | 100% | Low 162 / Med 133 / High 98 / None 76 | Partly — behaves as a *lower bound* |
| `usda_moisture_use` | 99% | Med 214 / High 142 / Low 106 | Partly — behaves as an *optimum* |

Three things follow:

1. **Soil tolerance is already solved and already in the right shape.** The triple is
   collapsed into a comma-separated accepted set (`sandy,loamy,clay` — 196 of 469 rows),
   and `siteMatch.js` already treats `soil_pref` as set membership. Rule 8's soil
   stopgap can be lifted for any species carried in that CSV, without new collection.
   `plants.csv` by contrast holds a single value (`clay` 28, `loamy` 13, `sandy` 5) —
   so the gap is a *migration*, not an acquisition.
2. **Light breadth is not available.** `sun_pref` in that CSV is a 1:1 re-reading of the
   single `Shade Tolerance` ordinal — the value counts match exactly (226/127/115), which
   is what a pure mapping looks like. USDA publishes no light *range*. Rule 8's light
   check therefore stays a point comparison whatever we collect from USDA.
3. **Water breadth is derivable but only as a pair.** `Drought Tolerance` and
   `Moisture Use` together bracket a range; neither alone is one. `mapCharacteristics.js`
   currently collapses them with `Moisture Use || Drought Tolerance`, discarding the
   bracket. Recoverable without new collection.

A caution carried forward, not re-litigated: `mapCharacteristics.js:96-113` documents
that USDA's live `Shade Tolerance` values run *opposite* to its own Swagger enum, verified
against 15 species (14/15 correct read as a light requirement, 0/15 as shade tolerance).
That inversion has bitten this repo once already (commit `ed9d75c`). Any new source
touching light must be checked the same way before it is trusted.

### 3.4 Mature width — genuinely absent, one weak proxy

**MEASURED.** A full characteristics fetch for *Quercus shumardii* returns **81
characteristics**. None is width, spread, or crown diameter. `width_ft` is 0% filled
across all 469 rows of `blackland-prairie-natives.csv` and 0% across
`dfw-nctx-natives.csv` — consistent with there being no USDA field to map.

The only proxy present is `Planting Density per Acre` (Min 300 / Max 800 for Shumard oak),
which inverts to roughly 54–145 ft² per plant, or an ~8–13 ft equivalent diameter. For a
tree that reaches 100 ft that is a *planting* spacing, not a mature crown, so it is the
wrong quantity for rules 4/10/9/12.

**Verdict: NOT AVAILABLE from USDA.** Width must come from horticultural sources — which
puts it squarely in **nl-41o.3**'s book corpus, and makes that bead load-bearing for
un-deferring rules 9 and 12 rather than a nice-to-have.

### 3.5 Fields USDA publishes that nobody had counted on

**MEASURED** — from the same 81-characteristic response. `mapCharacteristics.js` reads
only 26 of the 81, so these are already reachable at zero collection cost:

| Characteristic | Value (QUSH) | Answers |
|---|---|---|
| `Commercial Availability` | `Routinely Available` | "Is this buyable?" — field 18, national granularity |
| `Toxicity` | `None` | Front-yard fitness |
| `Lifespan` | `Long` | Longevity |
| `Vegetative Spread Rate` | `None` | "Will it take the bed?" |
| `Seed Spread Rate` | `Slow` | Reseeder risk |
| `Resprout Ability` | `No` | Aggressiveness |
| `Fruit/Seed Persistence` | `No` | **Directly sharpens R7** — whether winter fruit actually holds |
| `Growth Rate` | `Moderate` | Establishment expectations |
| `Height at 20 Years, Maximum` | `35` (vs mature `100`) | Realistic near-term height for R11 |

`Fruit/Seed Persistence` is the most valuable of these: rule 7 currently infers winter
food from a month range, and persistence is the direct signal.

**Verdict: AVAILABLE, unbudgeted.** Widening the existing mapper is cheaper than any new
source and should rank ahead of new-source work in **nl-41o.7**.

### 3.6 Local insect associations — now MEASURED as unavailable

Swagger lists `/api/PlantPollinator/{plantId}`, which would be a *species*-level insect
signal — exactly what NWF's genus × ecoregion data cannot give, and the fix for the
attribution problem `keystoneGenera.js` has to disclaim. It had to be tested rather than
assumed empty from one oak.

**MEASURED: it returns `[]` for every species tried**, including the strongest possible
positive controls — both milkweeds and a passionflower:

| Species | Id | `/api/PlantPollinator/{id}` |
|---|---|---|
| *Asclepias asperula* | 43487 | `[]` |
| *Asclepias viridis* | 43632 | `[]` |
| *Passiflora incarnata* | 69379 | `[]` |
| *Salix nigra* | 68068 | `[]` |
| *Quercus shumardii* | 70468 | `[]` |

If milkweed has no pollinator record, nothing does. **Verdict: the endpoint exists and is
unpopulated.** §3.6 moves from BELIEF to MEASURED, and NWF's genus × ecoregion table
remains the only source. The plan should stop treating a species-level insect signal as
something a probe might still turn up.

What *is* now different: with county presence available (§3.1), a **county-restricted
keystone count** becomes computable for the first time — intersect a genus's species list
with those present in Dallas County, rather than importing an ecoregion-wide number.
That does not fix the attribution problem (the count is still per genus, and per §3.2 the
species set is presence not nativity), but it narrows it from "anywhere in the Great
Plains" to "recorded in this county", which is a real improvement over what
`keystoneGenera.js` currently has to disclaim.

### 3.6b Vertebrate forage — a real table nobody had counted on

`/api/PlantWildlife/{id}` is populated, unlike its pollinator sibling. **MEASURED** across
13 species:

| Sample | Hit rate |
|---|---|
| Woody fruiting species (*Ilex vomitoria*, *Callicarpa americana*, *Juniperus virginiana*, *Celtis laevigata*, *Rhus glabra*, *Morus rubra*) | **6 / 6** |
| *Prunus mexicana*, *Quercus stellata* | 0 / 2 |
| Herbaceous / other (*Asclepias* ×2, *Salix nigra*, *Quercus shumardii*) | 0 / 4 |
| *Passiflora incarnata* | 1 / 1 |

Shape: `{Food: [{Source, LargeMammals, SmallMammals, WaterBirds, TerrestrialBirds}], Cover, Sources}`,
values on a `Minor / Low / Moderate` scale.

This bears directly on **rule 7**, which currently infers bird food from a month range and
`fruit_load`. `TerrestrialBirds` is a *documented forage value* — a stronger signal than
crop size, and independent of it.

**Two structural gifts, worth more than the field itself:**

1. **Every record carries a `Source`** (`Miller`, `Martin`, `Yarrow`) with a bibliographic
   entry in `Sources`. This is the claim-with-provenance shape **nl-41o.4** is designing,
   arriving pre-formed from a real source.
2. ***Callicarpa americana* returns two sources that disagree** — `Martin` says
   `LargeMammals: Minor`, `Miller` says `Moderate`, on the same field for the same species.
   **nl-41o.5 now has a live conflict to design against instead of a hypothetical one**, and
   it is the instructive kind: neither source is wrong, and no precedence rule derived from
   "which source is better" resolves it.

**Verdict: available, sparse, and skewed to woody species.** Useful as corroboration for
rule 7, not as a primary field. A broader fill-rate sniff belongs to nl-41o.9.

### 3.6c Synonyms — the identity problem has a source

**MEASURED.** `/api/PlantSynonyms/{id}` returns, for *Packera obovata* (38436):

```
[{"Id":38437,"Symbol":"SEOB2","ScientificName":"<i>Senecio obovatus</i> Muhl. ex Willd.", ...}]
```

That is **exactly** the mapping `ecology/host-genera.csv` carries by hand in its
`synonym_of` column — the load-bearing one, without which the frontyard's ragwort is
silently missed by rules 4 and 5. USDA supplies it programmatically.

*Quercus shumardii* and *Ilex vomitoria* return `[]`, so the endpoint is selective rather
than empty — it answers when a synonym exists.

**Verdict: available.** Significant for **nl-41o.4**: the synonym half of the identity
problem has an authoritative machine-readable source, and only cultivars (§ field 17,
`'Nana'`, `'Undaunted'`) remain unaddressed — no botanical database indexes those.

### 3.7 Summary — one row per required field

Numbered to match §2, so the AC's "verdict per field" is answerable field by field.

| # | Field | Verdict | Source | Evidence |
|---|---|---|---|---|
| 1 | `growing_season_months` | **Available** | USDA `Active Growth Period` — coarse (season words, e.g. "Spring and Summer"), 100% filled | MEASURED |
| 2 | `flowering_season_months` | **Available, coarse** | USDA `Bloom Period` ("Early Spring"), 99% filled. Month-precision needs a regional source | MEASURED / BELIEF for regional |
| 3 | `fruit_season_months` | **Available, coarse** | USDA `Fruit/Seed Period Begin`/`End`, 98–99% filled | MEASURED |
| 4 | `fruit_load` | **Available** | USDA `Fruit/Seed Abundance`, already mapped; 97% filled | MEASURED |
| 5 | `height_ft` | **Available** | USDA `Height, Mature (feet)`, 98% filled. `Height at 20 Years` also present — arguably the more useful number for R11 | MEASURED |
| 6 | `growth_shape` | **Available, weak** | USDA Growth Habit is coarse (Tree/Shrub/Forb/…); the mapper's own comment flags it as best-effort needing correction | MEASURED |
| 7 | `width_ft` | **Not available** | None of USDA's 81 characteristics. Needs books (nl-41o.3) | MEASURED |
| 8 | genus | **Available** | Parsed from `botanical_name`; USDA `ScientificNameComponents` corroborates | MEASURED |
| 9 | `sun_pref` | **Available** | USDA `Shade Tolerance`, 100% filled — but see the inversion caution in §3.3 | MEASURED |
| 10 | `water_pref` | **Available** | USDA `Moisture Use` (99%) / `Drought Tolerance` (100%) | MEASURED |
| 11 | `soil_pref` | **Available, already collected** | USDA soil triple, 100% filled, already collapsed to an accepted set | MEASURED |
| 12 | Tolerance breadth — soil | **Available** | The triple is a genuine accepted-set | MEASURED |
| 12 | Tolerance breadth — light | **Not available** | One ordinal, an optimum, not a range | MEASURED |
| 12 | Tolerance breadth — water | **Derivable** | Drought + Moisture as a *pair*; the mapper currently discards the bracket | MEASURED |
| 13 | County presence | **Available** | USDA distribution CSV (§3.1) | MEASURED |
| 14 | County nativity | **Not available** | BONAP only candidate; blocker is licensing | MEASURED (absence) |
| 15 | Keystone counts | **Available, genus × ecoregion only** | NWF lists, already in `host-genera.csv`. Species-level ruled out — §3.6 | MEASURED |
| 16 | `larval_hosts` | **Not available programmatically** | Hand-curated in `host-genera.csv`; `/api/PlantPollinator` is empty | MEASURED |
| 17 | `synonym_of` | **Available** | `/api/PlantSynonyms/{id}` (§3.6c). Cultivars remain unaddressed | MEASURED |
| 18 | Commercial availability | **Available** (national) | USDA `Commercial Availability` | MEASURED |
| — | Toxicity / spread / lifespan / persistence | **Available, unbudgeted** | USDA, unmapped (§3.5) | MEASURED |
| — | Vertebrate forage value | **Available, sparse** | `/api/PlantWildlife/{id}` (§3.6b) | MEASURED |

**Only three required fields have no source: county nativity, mature width, and
species-level insect associations.** The third is settled — it does not exist and the plan
should stop looking. The first two have identified routes (BONAP; the book corpus), and
both routes are licensing- or effort-bound rather than blocked.

### 3.8 Which rules are ever fully computable

The bead asks what this audit "determines about which ecology rules are ever fully
computable and which stay partial forever". With §3.7 complete, that is answerable:

| Rule | Verdict | Binding constraint |
|---|---|---|
| **R6 bloom succession** | **Fully computable** | Needs only month fields, all sourced. Month-precision wants a regional source; USDA's season words are coarse but workable |
| **R7 bird food** | **Fully computable, and improvable** | Month + load both sourced. `Fruit/Seed Persistence` and `PlantWildlife.TerrestrialBirds` would strengthen it beyond what it does today |
| **R11 vertical layers** | **Fully computable** | Height sourced. `growth_shape` is weak from USDA and wants correction, but is not blocked |
| **R5 larval hosts** | **Partial, permanently** | Depends on hand-curated `larval_hosts`. No source publishes it per species (§3.6); it grows only by manual research |
| **R4/R10 keystone genera** | **Partial, permanently — but improvable once** | Counts are irreducibly genus × ecoregion. County presence allows a *county-restricted* count, which narrows the disclaimer without removing it. Also needs `width_ft` (§3.4) before the area ratio means anything |
| **R8 site match** | **Partial, permanently on light; fixable on soil and water** | Soil tolerance is already collected — the a93ed52 stopgap can be lifted now. Water breadth is derivable. **Light breadth does not exist at any source**, so the light comparison stays a point check forever |
| R9 drifts, R12 spacing (deferred) | **Blocked on one field** | Both need mature width, which only the book corpus can supply — making nl-41o.3 the bead that un-defers them |

Two conclusions the downstream beads should read directly:

- **Three of six shipped rules are fully computable today or nearly so.** The data gap is
  narrower than the epic assumed, because §3.1 and §3.3 moved two fields from "missing" to
  "already in hand".
- **Two dimensions stay partial no matter how much is collected** — R5 and R4/R10, both
  for the same reason: insect association data does not exist at species granularity. That
  is a permanent property of the domain, not a backlog item. nl-41o.6 should report it as
  such rather than as incomplete coverage, or the metrics will show a gap that never closes.

---

## 4. Candidate new questions: in or out

The bead asks for an explicit ruling. Each added column is a per-species sourcing cost,
so the bar is: does a source publish it, and does a rule consume it?

**IN — free, already in a response we fetch (§3.5):**

- Commercial availability (national)
- Toxicity — real for a front yard
- Aggressiveness / reseeding — `Vegetative Spread Rate`, `Seed Spread Rate`, `Resprout Ability`
- Longevity — `Lifespan`
- Fruit persistence — sharpens an existing rule

**IN — expensive but load-bearing:**

- Mature width. Two deferred rules (nl-jsm.7) need it and §3.4 shows it needs the book
  corpus. Accepted as a real cost.

**OUT — for now, with reasons:**

- **Deer resistance.** No authoritative source; every list is anecdotal and they
  contradict each other. Sourcing it would mean inventing data.
- **Allergen load.** Sources exist (OPALS) but are proprietary, and no rule consumes it.
- **Bloom colour and floral structure for specialist bees.** Genuinely valuable and
  genuinely hard — the useful form is a bee-to-floral-trait mapping this project does not
  have. Revisit only if the host-genera table grows a specialist-bee dimension.
- **Nectar vs pollen value.** Same problem, no per-species source at this granularity.
- **Needs division.** Horticultural detail with no consuming rule.

**Deferred to nl-41o.2, not decided here:** commercial availability *near Dallas*. USDA's
national flag is in scope and free; a metro-specific version means nursery inventory
sources, whose licensing is unknown.

---

## 5. Blank vs. default: the app currently cannot tell them apart

**MEASURED** by reading `src/data/plantParser.js`. This is nl-41o.6's question, answered
early because it changes the "blank tolerable" column above and therefore belongs to the
required-fields spec.

The four-status enum has `not-declared` for exactly this, and several fields never reach
it — they get a fabricated value instead:

| Field | Blank becomes | Consequence |
|---|---|---|
| `growth_shape` | `'mound'` | R11 buckets the plant on an invented shape |
| `height_ft` | `1` (in `createPlantFromSpecies`) | R11 buckets a missing-height plant as groundcover |
| `width_ft` | `1` | R4/R10 **correctly excludes** these and reports the count — the one field handled right |
| `sun_pref` / `water_pref` / `soil_pref` | `''` → `step()` returns `null` | R8 skips the plant **silently**; the panel never says a plant was unchecked |
| `fruit_load` | `''` | Weighted `?? 1` = sparse |
| `flower_color` | `'#d95f5f'` | Rendered as a real colour |
| month fields | `[]` | Handled correctly — rule returns `not-declared` |

Two extra defects found while checking:

- **Vocabulary drift.** `plants.csv` carries `fruit_load: low` on one row, which
  `normalizeFruitLoad` does not recognise (it maps `light`, not `low`) — it becomes `''`,
  indistinguishable from blank. Likewise `soil_pref: clay-loam` on one row: `checkSoil`
  splits on `[,/|]` only, so `clay-loam` never matches site soil `clay` and raises a
  caution against a plant that is fine. Both are single rows today; both are the class of
  bug that scales badly at 469 rows.
- **`width_ft` is 0% filled in both regional CSVs**, so adopting either as the catalog
  would take rule 4/10's exclusion path for *every* plant and report a 0% keystone share.
  A migration blocker, and it belongs in nl-41o.7's ordering.

**Recommendation to nl-41o.4 and nl-41o.6:** the store must distinguish *absent* from
*asserted-empty*, and the CSV export must preserve that distinction, or the app cannot
route thin data to `not-declared` no matter what the metrics say. No fifth status is
needed — the existing one is simply unreachable for these fields today.

---

## 6. What nl-41o.9 should probe next

Ordered by how much a wrong assumption would cost:

1. **BONAP** — can county-level *nativity* be obtained at all, and on what terms? §3.2
   makes this the single unresolved blocker on the epic's headline field. Expect the
   answer to be about licensing, not access.
2. **The distribution endpoint at scale.** §3.1 measured four species. Confirm it holds
   for a few hundred, and establish the polite rate. One POST per species means ~500
   requests for the Blackland list.
3. **LBJ NPIN** — regional bloom and fruit timing, and mature width. The only identified
   candidate for §3.4's gap that is not a book.
4. **The other 55 characteristics.** §3.5 sampled one species. Confirm the useful ones
   are populated broadly, not just for a well-studied oak.
5. **`/api/PlantWildlife` fill rate.** §3.6b measured 13 species and found a strong skew
   to woody fruiting ones (6/6, vs 0/4 herbaceous). Establish whether it is worth wiring
   into rule 7 or too sparse to bother.
6. **`/api/characteristicSearchResults` and `/…Download`.** The bulk endpoint known to
   time out is `plants-search-results`; these are a *different* bulk path that may not
   share the fault. If either works, it replaces per-species fetching wholesale. Cheap to
   check and high upside.

---

## 7. Corrections owed to existing documentation

Not applied — analysis-only bead. Filed so they are not lost:

- `tools/usda-plants/README.md`: "There is no distribution endpoint in the API (all 42
  paths checked)" is **wrong**. See §3.1. The README should also record that county data
  carries no nativity flag (§3.2), since that is the trap the correction otherwise invites.
- `AGENTS.md` "Plant Data (CSV)" describes `soil_pref` as a single preference; the
  regional CSVs already use it as a comma-separated accepted set, and `siteMatch.js`
  already parses it that way. The doc trails the code.
