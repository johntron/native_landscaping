# Anchor-kind-driven species prioritization

Deliverable for **nl-41o.7.1**. Analysis only — no CSV is written and no code changes here.
Same discipline as [01](01-goals-and-required-fields.md)–[10](10-prioritization.md): every
claim is **MEASURED** (run against the repo this session) or **DECIDED** (a call made here,
with the reasons that make it revisable later). Date of measurements: 2026-09-18.

---

## 1. What this settles and what it doesn't

[10 §6](10-prioritization.md) already answered the shape of this: anchor `kind` is a
[§2.1](10-prioritization.md) **ranking signal, never a gate**, joined into the existing rank
tier alongside `npsot_dfw_recommended`, commercial availability, keystone membership, and
already-planted status. This doc answers the two things §6 left open: what the join column
actually is, and where in the rank tier it sits. It does not touch the plantable-set
definition or the field ordering — those stay exactly as [10](10-prioritization.md) left
them.

It also stays inside `nl-3hi`'s HARD BOUNDARY by the same logic §6 already applied: nearest
anchor and its distance are facts (`ecology/anchors.csv`); "this yard should lean riparian"
is a model layered on top, and must be labeled a heuristic everywhere it surfaces — in code
comments, in any UI that shows it, and in this doc — never presented as a validated
ecological instrument.

---

## 2. Nearest-anchor kind per place

**DECIDED:** "this place's anchor lean" = the `kind` of the single row in the yard's anchors (then `ecology/anchors.csv`)
with the smallest `distance_mi` for that `place`. Not "the nearest of each kind" — one anchor,
the closest one overall, because a project sits at one point and the closest habitat edge is
the one most plausibly reachable by the wildlife the design is for (pollinators' typical
forage range, per `nl-3hi`'s own 73–121m/mean citation, is far smaller than a mile — at these
distances none of the three kinds is truly "connected," so picking the closest is a
tie-breaking convention, not a claim of ecological reach).

**MEASURED**, this session, the anchors of the one yard with data at the time (they were
`ecology/anchors.csv`, `place=home`; per yard in `data/ecosystem.db` since nl-3s5.31, and the
feature names are left out here because together with distances they locate the yard):

```
stream   nearest: <a named creek>     0.75 mi
park     nearest: <a named park>      0.25 mi
cemetery nearest: <a named cemetery>  0.75 mi
```

Overall nearest = **a park, kind=park, 0.25 mi**. `home`'s own numbers already show why
ties are the expected case here, not a rare edge: `distance_mi` is rounded to the nearest
quarter mile as a deliberate precision floor (`tools/geoShared.mjs:85`), and `stream` and
`cemetery` are already tied with each other at 0.75 mi — only `park`'s 0.25 mi breaks the
three-way tie for *overall* nearest. On a quarter-mile grid, two kinds landing in the same
bucket as each other, or even matching the true overall-minimum bucket, will happen often
once more places are added, not occasionally.

**DECIDED:** when the *overall minimum* distance is shared by more than one kind, skip the
anchor-lean boost entirely for that place, and treat that as a deliberate, expectedly-frequent
no-op — not a bug to route around with an arbitrary tiebreaker (e.g. alphabetical on `kind`),
which would manufacture a signal the quantized data doesn't actually support. `home` itself
doesn't hit this case (only `park` sits at the true minimum), but the next place added should
expect to.

---

## 3. The join column has to exist on both sides of the plantable set

[10 §2.2](10-prioritization.md) defined the plantable core as `plants.csv` (61 rows) ∪
`npsot_dfw_recommended = yes` rows of `blackland-prairie-natives.csv` (467 rows). Any join
column this design picks must be populated on **both** sides, or the boost silently only
ever applies to half the core.

**MEASURED**, this session:

| Candidate column | In `plants.csv`? | In `blackland-prairie-natives.csv`? |
|---|---|---|
| `usda_moisture_use` (the bead's own DESIGN note suggested this) | **No** — not one of `mapCharacteristics.js`'s 26 exported fields ([nl-yud](01-goals-and-required-fields.md)) | Yes — 460/467 filled (High 142, Medium 212, Low 106, blank 7) |
| `usda_growth_habit` | **No**, same reason | Yes — clean 6-value enum (Forb/herb, Graminoid, Shrub, Tree, Vine, Subshrub) once parsed with real CSV quoting (a naive `awk -F,` misreads this file — several rows carry commas inside quoted scientific-name fields) |
| `water_pref` | Yes — 60/61 filled (low 36, medium 24) | Yes — 465/467 filled (medium 213, high 143, low 109, blank 2) |
| `soil_pref` | Yes — 60/61 filled, but a **different cardinality**: single free-form values (`clay`, `clay-loam`) alongside multi-value lists (`sandy,loamy,clay`) | Yes — almost entirely multi-value texture lists (194/467 are the single value `sandy,loamy,clay`) |

**DECIDED:** the join column is `water_pref` (low/medium/high), not the bead's own suggested
`usda_moisture_use`/soil columns. `usda_moisture_use` is a better-populated, better-behaved
field in isolation, but it lives only in `blackland-prairie-natives.csv` — widening it into
`plants.csv`'s export is exactly [nl-yud](01-goals-and-required-fields.md)'s job (widen
`mapCharacteristics.js` from 26 to the useful subset of USDA's 81), already ranked in
[10 §3.2](10-prioritization.md) and not redone here. Building this design on a column that
doesn't reach half the plantable set would mean every one of the 61 `plants.csv` species —
the ones actually plantable today, already reviewed, already in the app — gets no anchor-lean
boost at all until nl-yud ships. `water_pref` gets the same three-bucket signal (low/medium/high)
without that dependency. `soil_pref` is demoted to **corroborating, never required** per the
same "corroborating, not authoritative" rule [10 §2.1](10-prioritization.md) already applies
to the other rank signals — its cardinality mismatch (single value vs. multi-value list) means
"does this species tolerate clay" is a query, not a clean three-way match like `water_pref`.

---

## 4. Kind → lean mapping

| Nearest anchor kind | Boosted `water_pref` | Reasoning, held to the heuristic label |
|---|---|---|
| `stream` | `high`, partial credit to `medium` | Streamside/riparian corridor — the one anchor kind where a moisture lean is directly named by the anchor itself |
| `park` | `low`, `medium` | DFW parks in this anchor set are mapped from OSM `leisure=park` — mown turf and shade trees, not remnant prairie. Boosting toward "not moisture-demanding" is the defensible floor; boosting toward "prairie species" specifically would claim ecological knowledge the anchor fact (a park exists nearby) doesn't support |
| `cemetery` | `low`, `medium` | Same reasoning as `park` — OSM `landuse=cemetery` says nothing about whether the grounds are mown lawn or unmown remnant, which nl-3hi.7.5 ("let local knowledge promote candidates to anchors") is the mechanism for correcting, not this rule |

Both `park` and `cemetery` resolve to the same boost because the anchor fact available today
(OSM land-use tag) cannot distinguish "manicured" from "remnant prairie" without a human
looking at it — collapsing them is honest about what the data supports, rather than
manufacturing a distinction the source can't back. A future nl-3hi.7.5 ("let local knowledge
promote candidates to anchors") status promotion — a cemetery corner confirmed as unmown
remnant — is the mechanism to split them, not a guess made here.

---

## 5. Where this sits in the rank tier

[10 §2.1](10-prioritization.md) lists the rank signals in the order they were introduced,
not yet a priority order among themselves. **DECIDED**, adding this one at the end:

1. `npsot_dfw_recommended` — curated by a regional native-plant society chapter
2. USDA `Commercial Availability` — sourceable fact about whether it can be bought
3. Keystone-genus membership (`host-genera.csv`) — sourced from FNCT/host records
4. Already in `plants.csv` / already planted in a project — direct evidence of local success
5. **Anchor-kind lean (this doc)** — a heuristic derived from one nearby land-use tag and a
   three-bucket moisture field

Anchor-kind lean goes **last**, as a tie-breaker among species that are otherwise equal on
1–4, not a signal that reorders past them. It is also the only signal in the list that is
**per-project** rather than catalog-wide (a different `place` can flip the boosted bucket),
which is a second reason to keep it from outranking the catalog-wide signals: a species
excellent by every catalog-wide measure shouldn't drop in priority because one project's
nearest anchor happens to be a park.

---

## 6. Lookup: not a new stored structure

[04 §5](04-data-model.md) asks whether this join needs a new entry in the claims index's
lookup table. **DECIDED: no new persisted lookup.** The two inputs this rule actually joins —
`water_pref` per species (already the claims-index "by field" lookup) and
`ecology/anchors.csv`'s nearest-row-per-place (§2, computed live, one small CSV) — are cheap
to join at query time; nothing here needs its own index the way [04 §5](04-data-model.md)'s
six named lookups do. `04 §5` should stay unchanged; this section is the answer that closes
the question 10 §6 raised, not an eighth lookup to add.

---

## 7. Worked example

For that yard (nearest anchor: a park, `kind=park`, §2): the boosted bucket is
`water_pref ∈ {low, medium}`. The number that matters is the `water_pref` distribution across
the actual plantable core §3 requires this join to reach — [10 §2.2](10-prioritization.md)'s
101-species union of `plants.csv` and `npsot_dfw_recommended=yes`, joined by `botanical_name`
(preferring `plants.csv`'s own value where a species appears in both) — not `plants.csv`
alone.

**MEASURED**, this session, over the 101-species union:

```
water_pref = low:     48
water_pref = medium:  42
water_pref = high:    10
blank:                 1
```

So for `home`, the park-lean boost is **not** a no-op: it demotes the 10 `water_pref=high`
species in the plantable core relative to the other 90, ahead of whichever future collection
pass actually reads this ranking. Correcting the earlier draft's `plants.csv`-only count
(which read `high` as 0/61 and called that a null result) — the true count is 10/101, all of
them `npsot_dfw_recommended=yes` candidates from `blackland-prairie-natives.csv` not yet in
`plants.csv`. Whether demoting those 10 for a park-adjacent yard is the *right* call is
exactly the heuristic judgment §1 and §4 already flag as unvalidated; this section's job is
only to state that the rule has a real, measurable effect today, not to defend the effect.

---

## 8. Answers to the bead's DESIGN note

| Question the DESIGN note asked | Answer |
|---|---|
| Should anchor `kind` feed prioritization, and how | Yes, as a §2.1 rank signal (last, a tie-breaker), never a gate — confirmed, not re-litigated here |
| Which columns to join on | `water_pref` (§3), not `usda_moisture_use`/soil as first suggested — those aren't exported to `plants.csv` yet, and the join must reach both halves of the plantable core |
| Whether a new `04 §5` lookup is needed | No — §6, computed at query time from lookups that already exist |
