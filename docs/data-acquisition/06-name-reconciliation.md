# Name reconciliation: resolving a catalog name to the flora's 1999 name set

Deliverable for **nl-41o.10**. Analysis only — no code changes here. This is the algorithm
the implementation epic builds against.

Same discipline as [01](01-goals-and-required-fields.md), [03](03-document-corpus.md),
[04](04-data-model.md), and [05](05-quality-metrics.md): every design choice states the
finding it answers to, and anything not settled by evidence is marked **OPEN**.

---

## 1. The problem, restated

[03 §5](03-document-corpus.md#5-no-treatment-is-a-third-value-and-conflating-it-invents-data)
measured 119 of 469 `blackland-prairie-natives.csv` rows matching no treatment in the NCTX
flora, and traced the cause to 1999 nomenclature: `Symphyotrichum oblongifolium` is treated,
but only under `Aster oblongifolius`. [03 §6c](03-document-corpus.md#6-two-silent-truncation-hazards-both-hit-both-of-the-alnus-class)
separately measured that a binomial-only header match misses infraspecific taxa —
`Bothriochloa ischaemum var. songarica` reads as untreated though the flora carries it,
headed `Bothriochloa ischaemum (L.) Keng var. songarica (Rupr. ex Fisch. & C.A. Mey.)
Celerier & ...`.

Until both gaps close, "no treatment" is uninterpretable: it conflates *renamed-since* with
*genuinely-absent*, and per [04 §3.3](04-data-model.md#33-three-valued-fields-need-a-status-not-just-a-value)
that is exactly the ambiguity a `status = 'unknown'` claim exists to keep out of `native`.
This bead designs the resolution step that must run **before** any flora lookup, for
nativity and for every future book-sourced field — the flora is not the only in-copyright
source this project will eventually add, and 1999-vs-current naming is a property of
*any* older taxonomic work, not a flora-specific quirk.

---

## 2. What already exists to build on

- **The flora publishes its own synonym crosswalk, in-text, per treatment — MEASURED, and
  the better primary source.** Every treatment paragraph ends its description with a
  bracketed list of the names the current source treats as synonymous, e.g. the *Aster
  oblongifolius* treatment itself: `Aster oblongifolius Nutt., (oblong-leaved), AROMATIC
  ASTER, ... [Symphyotrichum oblongifolium(Nutt.) G.L. Nesom]` (`corpus/FNCT_0210-0617-Acanth-Euph.txt:5047-5052`).
  This is exactly the mapping reconciliation needs, already sitting in the corpus already
  in hand — no network round trip, no USDA dependency, available for every treated species
  simultaneously as a byproduct of the same header-scan pass [03 §6](03-document-corpus.md#6-two-silent-truncation-hazards-both-hit-both-of-the-alnus-class)
  already has to do. **Hazard, also measured in the same paragraphs**: the PDF extraction
  drops the space between genus and species in several of these bracket citations —
  `Symphyotrichumlateriflorum`, `Symphyotrichumpratense`, `Symphyotrichumsericeum`,
  `Symphyotrichumdivaricatum` all appear glued with no space (same file, lines 5043,
  5111, 5119, 5127). A bracket-list parser that assumes `Genus species` has a space will
  silently drop these — another hazard "of the Alnus class" [03 §6] and worth a dedicated
  control-set row (§6).
- **USDA's synonym endpoint is a real, confirmed fallback — but not free of its own trap.**
  `/api/PlantSynonyms/{id}` returns, for *Symphyotrichum oblongifolium* (USDA id 40799,
  confirmed live 2026-08-28), seven synonym records including `Aster oblongifolius Nutt.`
  (id 40801) — the exact pair this bead's headline case rests on, now measured end to end
  rather than assumed. It also returns two *Aster oblongifolius* varieties and two other
  genus placements (`Lasallea oblongifolia`, `Virgulus oblongifolius`), confirming the
  endpoint can return more than one synonym (§7's prior "untested" flag is now closed: try
  each returned name against the flora header index, first match wins — the flora only
  carries a heading for the plain `Aster oblongifolius` binomial among those seven). The
  trap: the record returned by `usda_search_by_name` reports `"HasSynonyms": false` for
  this same species even though the dedicated endpoint returns 7 rows — that field is not
  populated by the lightweight search endpoint (same pattern as its always-`false`
  `HasCharacteristics`, known already from [01](01-goals-and-required-fields.md)). **Do not
  gate on `HasSynonyms`; always call `PlantSynonyms` directly.**
- **Name → id resolution already exists in code.** `tools/usda-plants/search.js`'s
  `searchByNames` takes a list of query strings, calls USDA's name search, and returns an
  exact match (by binomial, full scientific name, common name, or symbol) or up to 5
  alternatives. This is the step that turns a catalog string into the id `PlantSynonyms`
  needs — there is no direct name-to-synonym endpoint.
- **The flora's header grammar is known and control-tested.** [03 §6](03-document-corpus.md#6-two-silent-truncation-hazards-both-hit-both-of-the-alnus-class)
  fixed two silent-truncation bugs (a wrapped common name mistaken for the next heading; a
  genus synopsis bleeding into the next taxon) by requiring a heading to follow a blank
  line and bounding each span at the next heading or a `REFERENCES:` block. A production
  header regex must be rank-aware — `Genus species (Auth.) Auth., (` for a plain species,
  `Genus species (Auth.) Auth. var. epithet (Auth.) Auth., (` for an infraspecific taxon —
  confirmed against the `Bothriochloa ischaemum ... var. songarica ...` header above.
- **The `taxa` table already has the shape to hold the result.** [04 §2.2](04-data-model.md#22-the-scheme)
  models `resolves_to` for exactly this: a synonym row's claims are stored against the
  resolved id, so a flora extraction that matches under `Aster oblongifolius` writes claims
  against the `Symphyotrichum oblongifolium` row without the rest of the system ever
  needing to know the flora used the old name.

This bead's job is narrower than any of those: **the procedure that walks from a catalog
name to a flora header match, in what order, with what fallback, and what it does when
every step fails.**

---

## 3. The algorithm

Runs once per catalog species, ahead of and separate from the flora extraction pass in
[03](03-document-corpus.md) — reconciliation produces a name mapping; extraction consumes
it. Keeping them separate steps means the mapping is reusable by any future book source,
not re-derived per source.

```
reconcile(catalog_name, rank, infra_epithet?) -> { flora_key, matched_via, status }
```

1. **Direct match, rank-aware.** Try the catalog name against the flora header index as-is.
   If `rank` is variety/subspecies, try the infraspecific header first
   (`Genus species ... var./subsp. epithet ...`); only fall back to the plain-species header
   if no infraspecific heading exists in the flora at all (§4 covers what a *partial* match
   — species heading present, infraspecific epithet absent — means). Most current-nomenclature
   names that the flora *also* uses (no synonymy involved) resolve here with no lookup at
   all. `matched_via = 'direct'`.
2. **Flora's own synonym crosswalk, offline, no network.** Build this index once, as a
   byproduct of the same header-scan pass §2 measured: for every treatment, parse the
   trailing bracketed name list (tolerant of the glued-genus-species hazard §2 measured) and
   record each bracketed name → the treatment's own heading. If the catalog name (rank-
   aware) appears in *any* treatment's bracket list, that treatment is the match.
   `matched_via = 'flora-synonym'`. This is preferred over step 3 because it costs nothing
   per lookup once built and reflects the flora's *own* stated synonymy rather than a
   third party's — the two do not always agree, and when they disagree the flora's own
   statement about what it considers the same taxon is the one that determines whether its
   treatment applies at all.
3. **Resolve to a USDA id.** If steps 1–2 find nothing, call `searchByNames([catalog_name])`
   (§2).
   - No match and no alternatives at all: USDA doesn't recognize the string either — skip to
     step 6.
   - Alternatives returned but no exact match (an ambiguous name): do **not** guess among
     them. `status = 'review'`, carrying the alternatives list as the candidate set — same
     "a human must confirm" rule as [04 §3.3](04-data-model.md#33-three-valued-fields-need-a-status-not-just-a-value),
     stop here.
   - Exact match: continue to step 4.
4. **Fetch synonyms.** Call `/api/PlantSynonyms/{id}` on the resolved id — **not**
   `usda_search_by_name`'s `HasSynonyms` flag, which §2 measured as unpopulated regardless
   of the true answer. An empty array is a real answer (USDA has no synonym on record for
   this name), not a failure — proceed to step 6.
5. **Match each synonym, rank-aware, same header rules as step 1.** Try every returned
   `ScientificName` (stripped of the italic markup, author citation kept for now since the
   flora's own headers carry authors too — comparison should be on the parsed binomial/
   trinomial, not a raw string equals). First header match wins — confirmed necessary, not
   hypothetical: *Symphyotrichum oblongifolium* (USDA id 40799) returns seven synonym
   records, of which only the plain binomial `Aster oblongifolius` has a flora heading; the
   two returned varieties and the two other-genus placements (`Lasallea oblongifolia`,
   `Virgulus oblongifolius`) do not. `matched_via = 'usda-synonym:<ScientificName>'`.
6. **No match after all of the above → `status = 'unknown'`.** Per [03 §5](03-document-corpus.md#5-no-treatment-is-a-third-value-and-conflating-it-invents-data),
   this is not evidence of absence. It stays blank, exactly like a genuine no-treatment
   case, because after step 5 the two are indistinguishable without a human look — see §6.

Steps 3–5 are the network-bound path, needed only for the fraction step 2's offline
crosswalk doesn't cover. [03 §5](03-document-corpus.md) measured 119/469 (~25%) of rows with
no direct-name treatment; how much of that 25% step 2 alone resolves is not yet measured —
run step 2 first and count before building the USDA path, since it may turn out to close
most of the gap for free (§7).

---

## 4. Rank handling: a species match is not an infraspecific match

[03 §6c](03-document-corpus.md#6-two-silent-truncation-hazards-both-hit-both-of-the-alnus-class)
established that a binomial-only regex silently misses infraspecific taxa that *are*
treated. Steps 1, 2, and 5 above fix the miss (each applies the same rank-aware header
match, just against a different name source). But a **partial** rank match — the flora treats
`Malvaviscus arboreus` but not `Malvaviscus arboreus var. drummondii` by that exact
epithet — is a separate case the algorithm must not silently resolve as a full match:

**Decision:** an infraspecific catalog entry that only matches at the species rank gets
`status = 'review'`, not `'asserted'`, carrying the species-level claim as the *candidate*
value. Reasoning: a flora's species-level statement (habitat, nativity, bloom window)
usually does extend to its varieties, but not always — a variety can carry a distinct range
or origin the species-level text doesn't speak to, and nothing in the header grammar lets
the algorithm tell which case it's in without reading the prose. This matches [04
§3.3](04-data-model.md#33-three-valued-fields-need-a-status-not-just-a-value)'s existing
`review` state exactly: "a screen fired ... a human must confirm." A full infraspecific
header match (§3 step 1, 2, or 5 succeeding at the variety's own heading) needs no
review — `status = 'asserted'` as normal.

---

## 5. Where the result lives

The identity edge and the reconciliation *event* are two different things, and only the
first already has a home. [04 §2.2](04-data-model.md#22-the-scheme)'s `taxa` table models
the edge without a new column:

```
taxa(id=1, name="Symphyotrichum oblongifolium", rank=species, usda_symbol=SYOB, resolves_to=NULL)
taxa(id=2, name="Aster oblongifolius",          rank=species, usda_symbol=NULL, resolves_to=1)
```

When step 2 or 5 matches the catalog's current name to a flora heading under an older
synonym, the old name becomes (or is confirmed as) a `taxa` row with `resolves_to` pointing
at the catalog's row, and the flora extraction in [03](03-document-corpus.md) writes its
claims against the resolved id per [04 §3.1](04-data-model.md#31-the-shape). A claim's
`citation` (e.g. `"Diggs, Lipscomb & O'Kennon 1999, p. N"`) is still the right place to
record *which page justifies the value* — that's unchanged.

But `matched_via` — which of §3's steps produced the edge — is not a citation and should
not be smeared into `claims.citation` as free text: [04 §5](04-data-model.md#5-lookups-the-index-must-serve)
already names "by field" and "missing" as lookups the index must serve for nl-41o.6, and
neither is answerable if the only record of *how* a name resolved is prose inside a
different field's citation string. Reconciliation is a per-**taxon** event (it resolves a
name, not a field), so it needs its own row, sibling to `claims` rather than folded into
it:

```
name_reconciliations
  id
  taxa_id         -- the catalog's taxa.id being reconciled
  corpus          -- "nctx-flora-1999"; a future book source gets its own row per corpus
  matched_via     -- 'direct' | 'flora-synonym' | 'usda-synonym:<ScientificName>' | 'unmatched'
  flora_taxa_id   -- nullable FK to the taxa row whose heading matched (usually the same
                     row once resolves_to is set, but kept explicit for the audit trail)
  reviewed        -- boolean; true once a review-status case (§3 step 3's ambiguous name,
                     or §4's partial rank match) has been confirmed by a human
```

One row per `(taxa_id, corpus)`. This is what nl-41o.6 counts to report "119 unresolved"
as a first-class metric, what nl-41o.8's provenance tool answers "how did this claim's
identity get established" from, and what makes an `unmatched` row (§3 step 6) visible even
though it produced no claim at all to attach a citation to.

---

## 6. Validation

[03 §6](03-document-corpus.md#6-two-silent-truncation-hazards-both-hit-both-of-the-alnus-class)'s
lesson generalizes directly: *validate against a labelled control set with known answers in
both directions*, because every bug found there was invisible in the output and obvious in
the controls. For reconciliation specifically, the control set needs several kinds of known
answer, not just "found" vs. "not found":

| Control case | Example | Expected result |
|---|---|---|
| Resolves via direct match | A species whose flora name and catalog name already agree | `matched_via = 'direct'` |
| Resolves via flora's own bracket crosswalk | `Symphyotrichum oblongifolium` → flora heading `Aster oblongifolius`, via its `[Symphyotrichum oblongifolium(Nutt.) G.L. Nesom]` bracket | `matched_via = 'flora-synonym'`, no network call |
| Resolves via USDA synonym (only when step 2 doesn't find it first) | Same pair, confirmed independently: `PlantSynonyms/40799` returns `Aster oblongifolius` among 7 records | `matched_via = 'usda-synonym:...'`, header found |
| Ambiguous USDA name | A catalog name returning alternatives but no exact match (not yet hit in this bead's measurements — **OPEN**, needs one instance from a real catalog run) | `status = 'review'`, alternatives recorded, no guess made |
| Genuinely absent | `Bouvardia ternifolia`, `Liatris punctata` — west/south TX species [03 §5] | `status = 'unknown'` after all five steps, **and** confirmed by a human that no synonym exists either (i.e. this is a true negative for the control set, not an untested one) |
| Infraspecific full match | `Bothriochloa ischaemum var. songarica` | `matched_via = 'direct'` at the variety heading, `status = 'asserted'` |
| Infraspecific partial match | A variety where only the species heading exists (none confirmed yet — **OPEN**, needs one measured from the corpus before this row of the control set can be filled in) | `status = 'review'` |
| Glued genus-species in a bracket citation | `Symphyotrichumlateriflorum` (no space) inside `Aster lateriflorus`'s bracket list, `corpus/FNCT_0210-0617-Acanth-Euph.txt:5043` | The bracket parser still extracts `Symphyotrichum lateriflorum` as a candidate name — a negative-control failure here would silently drop a flora-synonym match |

The first three and the last row are measured against the live corpus/API (§1, §2, §3
above); the ambiguous-name and infraspecific-partial-match rows are designed but not yet
hit against real data — filed as open items in §7 rather than invented.

---

## 7. Open items for other beads

- **How much of the 119-row gap step 2 (flora's own crosswalk) closes on its own is not yet
  measured.** [03 §5](03-document-corpus.md) measured 119/469 with no direct-name treatment
  before any reconciliation existed; this bead confirms the mechanism works on the headline
  case but has not run it across the full 119. Run step 2 alone first when nl-41o.3 is
  implemented and count — it may turn out the USDA round trip (steps 3–5) is needed for a
  much smaller remainder than assumed.
- **Infraspecific partial-match example.** §4's `review` policy is designed but untested
  against a real corpus hit — no variety has yet been confirmed to match only at the species
  rank. Confirm one exists (or doesn't) when nl-41o.3's extraction is implemented, and add it
  to §6's control set.
- **Ambiguous-name example.** §3 step 3's "alternatives but no exact match" branch is
  designed but not yet hit against a real catalog name. Confirm one when nl-41o.3 runs the
  full catalog and add it to §6's control set.
- **Synonym-string comparison needs the same author-citation handling as the flora header
  regex.** Step 5 compares USDA's `ScientificName` (which includes an author citation, e.g.
  `Senecio obovatus Muhl. ex Willd.`) against flora headers that also carry authors, but the
  two authorities may abbreviate differently for the same name. The comparison should
  extract just the binomial/trinomial before matching, same as `search.js`'s existing
  `binomialOf` helper does for USDA's own name field — reuse that function rather than
  writing a second one. The same extraction needs to tolerate the flora's own glued-name
  hazard (§2) on the bracket-crosswalk side.
- **Cultivars are out of scope for this algorithm entirely.** [04 §2.3](04-data-model.md#23-cultivars-inherit-by-default-override-explicitly)
  already routes a cultivar's unclaimed fields to its parent species; a flora (or any
  taxonomic work) never treats a cultivar, so reconciliation should only ever run against a
  `taxa` row of rank species/variety/subspecies, never `rank = 'cultivar'`.
- **nl-41o.9** — the source-probe MCP tooling should expose steps 3–4 (name search,
  synonym fetch) as a single read-only lookup, since even a reduced remainder after step 2
  makes per-species manual curl calls impractical during nl-41o.3's implementation.
- **nl-41o.6** — reconciliation outcomes (`name_reconciliations.matched_via` counts, §5) are
  a coverage metric in their own right, distinct from but feeding the nativity `unknown`
  count [03 §5] already names.
