# Prioritization: which species and which fields first

Deliverable for **nl-41o.7**. Analysis only — no CSV is written and no code changes here.

Same discipline as [01](01-goals-and-required-fields.md)–[09](09-conflict-resolution.md):
every claim is **MEASURED** (run against the repo this session) or **DECIDED** (a call made
here, with the reasons that make it revisable later). Date of measurements: 2026-09-18.

---

## 1. The bead's own menu is stale — say why before answering

nl-41o.7's NOTES offer three options for the plantable set, written when county nativity
looked like a dead end: (a) ask BONAP, (b) presence + `npsot_dfw_recommended` as a curated
proxy, (c) presence only, accepting desert willow. **None of the three is the answer.**
Between that NOTES entry and this bead, [03](03-document-corpus.md)–[05](05-quality-metrics.md)
[09](09-conflict-resolution.md) landed NCTX-level nativity from the flora — free, already
extracted, already reviewed for 17 of the catalog's prose-origin hits, and already given a
precedence rule over USDA's continental flag ([09 §1](09-conflict-resolution.md): "these
disagree by design; the flora is more specific and should win at NCTX scale"). Option (a)
is moot — BONAP is no longer the only route and its email stays unsent for exactly the
reason [permission-requests.md](permission-requests.md) already gives. Options (b)/(c) are
superseded, not chosen.

But the flora is **not a classifier you can gate on**. [03 §4](03-document-corpus.md) is
explicit: "prose match ⇒ queue for review, never auto-assign," and §4.1 measured an 11.6%
leak on the converse (silence does not reliably imply native). Only 7 of 469 catalog rows
have a confirmed NCTX-non-native verdict today ([03 §7.1](03-document-corpus.md)); the
other 462 have no verdict at all, not a "native" verdict. Defining plantable as
`nativity_nctx = native` would therefore exclude almost the whole catalog for lack of
review effort, not for lack of nativity — the opposite failure from the one BONAP-blocking
was trying to avoid.

**§2 answers this with a gate/exclude/rank structure instead of one filter.**

---

## 2. The plantable set

### 2.1 Structure: a gate, an exclusion list, and ranking signals — not one filter

| Layer | Field | Role | Completeness needed |
|---|---|---|---|
| **Gate** | USDA county presence, Dallas Co. (FIPS 48113) | Species must clear this to be considered at all | Complete — [01 §3.1](01-goals-and-required-fields.md) measured this available for every species tried, at the exact needed granularity |
| **Exclude** | Flora nativity screen ([03](03-document-corpus.md)): the `I` symbol, plus per-taxon-reviewed prose-origin hits confirmed non-native to NCTX | Removes species the gate alone cannot: *Chilopsis linearis* passes county presence but is confirmed non-native at NCTX scale ([03 §7.1](03-document-corpus.md)) | **Not** complete, and does not need to be — an exclusion list is correct even when partial, because everything not yet reviewed simply hasn't been excluded yet, not wrongly admitted |
| **Rank, never gate** | `npsot_dfw_recommended`; USDA `Commercial Availability`; keystone-genus membership (`host-genera.csv`); already in `plants.csv`; already planted in a project | Orders the plantable set for collection priority (§3) and, later, for suggestion ranking | Whatever exists today; each is corroborating, not authoritative, per [02](02-source-inventory.md) |

The residual claim about any species that clears the gate and isn't on the exclusion list
is **"not known to be non-native to NCTX,"** not **"confirmed native."** That distinction
must survive into [nl-41o.6](05-quality-metrics.md)'s metrics as a named limitation, not be
rounded off — the 11.6% leak measured in [03 §4.1](03-document-corpus.md) is real and
un-fixed. Restating the two scales in play, because they don't match and pretending they do
is the failure mode: county presence is **county**-grained (Dallas Co., FIPS 48113); the
flora's nativity read is **NCTX-region**-grained (~40,000 sq mi including Blackland and
Grand Prairie). For a Dallas yard the region-level read is arguably the right scope anyway
(nl-41o.7.1's DESIGN note makes the same call for anchor-kind prioritization), but it is a
different question than "native to this county," and the doc should say so rather than
imply county precision it doesn't have.

### 2.2 A measured floor for "the plantable set is not 469 rows"

`blackland-prairie-natives.csv` (467 rows post-nl-41o.11) is a *regional native candidate
list*, not a *plantable-for-this-project* list — most of it has never been reviewed,
sourced, or planted. Two cheap, already-curated signals bound a much smaller candidate core
without new collection:

**MEASURED**, this session:

```
plants.csv species:                          61
npsot_dfw_recommended = yes (blackland CSV):  57
plants.csv ∪ npsot_yes (by botanical_name):  101
species actually planted in any project
  (projects/*/planting_layout.csv):           32, all 32 already inside the 101
dfw-needs-manual-data.txt (15 names):         all 15 already inside the 101
```

So **101 species** — everything currently live in the app, plus everything NPSOT names as
DFW-recommended — is a defensible starting core for "plantable," and it already contains
every species this project has actually planted and every species on the manual-data
checkpoint list. It is not the final definition (a species could be plantable and simply
absent from both lists, and NPSOT's "no" is a recommendation, not a nativity ruling), but it
is a number, and a number is checkable in a way "narrow it down later" is not.

**DECIDED:** the plantable set for the *next* collection pass is the 101-species core from
§2.2, gated by §2.1's county-presence check and screened against §2.1's exclusion list as it
grows. Species outside the 101 remain in `blackland-prairie-natives.csv` as regional
candidates, collected opportunistically (§4), not on the collection critical path.

---

## 3. Field ordering — by which rules it unblocks, not by ease

This reuses [01 §2](01-goals-and-required-fields.md)'s "Blank tolerable?" column directly —
that column is already the blocking-field partition, measured against `plantParser.js`
rather than argued from scratch. **No** rows are the blocking set this ordering serves.

### 3.1 Rank 0 — `width_ft`, ahead of any new source

**Migration blocker, not new collection.** [01 §3.4](01-goals-and-required-fields.md) and
[03 §8](03-document-corpus.md) both measured `width_ft` at 0% fill across
`blackland-prairie-natives.csv` (0/469) *and* `dfw-nctx-natives.csv` (0/61), and confirmed
it is absent from all 81 USDA characteristics **and** from the NCTX flora (a taxonomic
flora states height, not spread — §8's correction to the epic's earlier belief). Adopting
either regional CSV as-is would send every plant down R4/R10's exclusion path and report a
0% keystone share catalog-wide — worse than today's 48-species status quo. It also solely
gates the deferred R9/R12 ([nl-jsm.7](01-goals-and-required-fields.md)). No source
catalogued by this epic supplies it; it needs the horticultural-book class of source
[03 §8](03-document-corpus.md) leaves unresolved. Ranked first not because it is easy — it
is the opposite, unsourced today — but because leaving it unranked lets a later step build
on the missing-catalog silently.

### 3.2 Rank 1 — free, already-fetched, zero new source

In order of rule leverage, all costing widening an existing mapper or migrating an existing
column rather than new collection:

1. **Widen `mapCharacteristics.js` from 26 to the useful subset of USDA's 81 characteristics**
   ([nl-yud](01-goals-and-required-fields.md), already a standalone bead). Unlocks, at zero
   new source: `Fruit/Seed Persistence` (sharpens R7 directly), `Height at 20 Years` (a
   better R11 input than mature height for near-term layering), `Commercial Availability`,
   `Toxicity`, `Lifespan`, spread/resprout rates.
2. **Soil tolerance migration** — [nl-9a6](01-goals-and-required-fields.md) already closed
   this for 23 of `plants.csv`'s 56 species (17 via the blackland CSV, 3 fresh USDA fetches,
   2 nominate-species fallback), lifting rule 8's `a93ed52` stopgap for those rows and
   filing the remaining 33 (no USDA characteristics record at all) as
   [nl-z5p](01-goals-and-required-fields.md). Carried here only to place it in the ordering:
   it is done for the reachable species, tracked separately for the rest.
3. **Water tolerance breadth** — `mapCharacteristics.js` currently collapses `Drought
   Tolerance` and `Moisture Use` with `||`, discarding the bracket the pair forms
   ([01 §3.3](01-goals-and-required-fields.md)). Recoverable from data already fetched, no
   new source.

### 3.3 Rank 2 — light breadth, cleared but rate-unknown

USDA has no light *range*, only an optimum (with a documented sign inversion,
[01 §3.3](01-goals-and-required-fields.md)). NPIN publishes light as a genuine set (`Sun,
Part Shade, Shade` for *Ilex vomitoria*) and, as of the 2026-08-28 response recorded in
[permission-requests.md](permission-requests.md), **non-commercial use with citation is
affirmatively cleared** — this is no longer a permission question, only a rate/volume one
(NPIN's terms-pages were unreadable behind Cloudflare; the email is what got the actual
answer). Ranked after §3.2 because it requires new per-species fetches against an unknown
polite rate, where §3.2 requires none.

### 3.4 Rank 3 — the flora nativity review queue

Extending [03 §7.1](03-document-corpus.md)'s per-taxon review beyond the 17 already done,
and eventually attacking the harder residual [03 §10](03-document-corpus.md) names:
reading NCTX-nativity out of the flora's *distribution sentence* (`mainly se, e, and sc
Texas`) rather than the origin-statement screen. Ranked last of the four because it is
manual, per-taxon, exact-binomial review — [nl-41o.11](01-goals-and-required-fields.md)
measured a 50% misattribution rate on a "hand-verified" 4-row sample before the same-genus
guard was added, so it cannot be batched safely. It directly grows the exclusion list in
§2.1, so it is real progress on the plantable set, just the most expensive kind per species.

### 3.5 Deliberately not re-ranked here

Mature width (§3.1) and species-level insect associations
([01 §3.6](01-goals-and-required-fields.md), confirmed absent from every API tried) are the
two genuinely blocked fields; §3.1 already covers the one that's actionable (stop building
on the missing column) and the other has no action to rank.

---

## 4. Stopping condition

"All of it" is explicitly ruled out by the AC. Two clauses, both checkable, plus the
register the metrics doc already names for the case neither clause resolves:

> **Every species in the §2.3 plantable set (currently 101, growing as review work extends
> the exclusion list) has, for every blocking field in [01 §2](01-goals-and-required-fields.md)'s
> "No" column, either a sourced claim or a recorded reason it cannot be sourced.**
> Everything else — the remaining ~366 rows of `blackland-prairie-natives.csv`, ranking-only
> fields, corroborating sources — is opportunistic, collected as time allows and never a
> blocker on shipping.

The second clause is load-bearing. Without it, `width_ft` (§3.1) and species-level insect
data ([01 §3.6](01-goals-and-required-fields.md)) keep the stopping condition permanently
unreachable, when [01 §3.7](01-goals-and-required-fields.md) already estabished that both
are genuinely unsourced rather than under-collected — and [01 §3.8](01-goals-and-required-fields.md)
separately warns that R4/R10's keystone counts stay partial *forever*, a domain property,
not a backlog item. The "no source found, here is the evidence" register is
[08-known-gaps.md](08-known-gaps.md)'s job to carry; this bead's job is only to require that
every unfilled blocking field land in one of the two states, not silently in neither.

**Checkable today**, per [04 §5](04-data-model.md)'s "missing" lookup — species with no
claim of any status for a given field — once the claim store exists: query the plantable
set × blocking fields, and the stopping condition is reached when that query returns only
rows explained by §3.1/§3.5's unsourceable register.

**The test case named in nl-41o.7's own NOTES**: the 15 species in
`dfw-needs-manual-data.txt` are exactly the checkpoint the bead reserved rather than
hand-clearing. §2.2 already confirmed all 15 sit inside the 101-species plantable core. If
the designed pipeline (USDA + NPIN + flora, per [02](02-source-inventory.md)) still cannot
fill their blocking fields once built, that is the real finding the NOTES anticipated —
evidence about source coverage, filed to [08-known-gaps.md](08-known-gaps.md), not a chore
that was skipped.

---

## 5. Answers to the bead's acceptance criteria

| AC | Answer |
|---|---|
| An explicit definition of the plantable set for Dallas County | §2.1's three-layer gate/exclude/rank structure, with the residual claim stated honestly as "not known to be non-native to NCTX." §2.2's measured 101-species core (`plants.csv` ∪ `npsot_dfw_recommended=yes`) is the near-term working set |
| A field ordering justified by which rules each unblocks | §3: `width_ft` first (blocks R9/R12 outright and corrupts R4/R10 catalog-wide if skipped), then the free `mapCharacteristics` widening + soil/water migrations (R7, R11, R8), then NPIN light breadth (R8, cleared for use, rate unknown), then the flora review queue (grows §2.1's exclusion list) |
| A stated stopping condition, not "all of it" | §4: every plantable-set species has a sourced claim or a recorded unsourceable reason, for every blocking field — checkable via [04 §5](04-data-model.md)'s missing-claim lookup, tested against the 15-species manual-data checkpoint |

---

## 6. What this settles for nl-41o.7.1

nl-41o.7.1 asks whether anchor `kind` (stream, park, cemetery) from `ecology/anchors.csv`
should feed species prioritization. Per §2.1's structure, the answer is: **it is a §2.1
ranking signal, never a gate** — consistent with `nl-3hi`'s own HARD BOUNDARY that
connectivity/anchor-derived scoring is a heuristic model layered on facts, not a fact
itself. It joins the existing rank tier (`npsot_dfw_recommended`, commercial availability,
keystone membership) rather than restricting the plantable set in §2.2. Separately: per
[04 §5](04-data-model.md)'s lookup table, there is currently no "species by
moisture/habitat class" lookup — the join nl-41o.7.1 proposes (`usda_moisture_use` / soil
columns as a riparian-vs-upland proxy) would be a new one, not a reuse of an existing six.
That is nl-41o.7.1's design question to answer, not this bead's.
