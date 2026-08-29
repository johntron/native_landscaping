# Data model: species identity, claims, and provenance

Deliverable for **nl-41o.4**. Analysis only — no store is created and no code changes here.
This is the schema the implementation epic builds against.

Same discipline as [01](01-goals-and-required-fields.md), [02](02-source-inventory.md), and
[03](03-document-corpus.md): every design choice states the finding it answers to, and
anything not settled by evidence is marked **OPEN**, not guessed.

---

## 1. Two things this bead does not do

- It does not pick the precedence rule between disagreeing sources (arbitration is
  **nl-41o.5**).
- It does not design the coverage/quality report (**nl-41o.6**), beyond naming the lookups
  the index must serve so that bead has something to query.

The store engine (SQLite, WAL, `data/claims.db`, gitignored) was decided on the epic
2026-08-27; this bead owns the schema inside it.

---

## 2. Identity

### 2.1 The three cases already measured

| Case | Example | Source | Status |
|---|---|---|---|
| **Synonym** | `Packera obovata` / `Senecio obovatus` | `/api/PlantSynonyms/{id}` returns the mapping [03 §5](03-document-corpus.md); confirmed against `host-genera.csv`'s hand-written `synonym_of` column | **Sourceable** |
| **Variety / subspecies** | `Cercis canadensis var. texensis`, `Bothriochloa ischaemum var. songarica` | Botanical nomenclature; matched directly in USDA and (with a rank-aware header regex) in the NCTX flora | **Sourceable, needs rank-aware matching** — [03 §6c](03-document-corpus.md) documents a binomial-only regex silently missing these |
| **Cultivar** | `Ilex vomitoria 'Nana'`, `Muhlenbergia reverchonii 'Undaunted'` | None. USDA, NPIN, BONAP, and GBIF all key on the species [02 §4](02-source-inventory.md) | **Not sourceable — must be modeled, not resolved** |

A fourth case belongs here too, named but not yet measured against a real pair:

| Case | Example | Status |
|---|---|---|
| **Hybrid** | (none confirmed in the current catalogs) | **OPEN** — no hybrid has been hit yet. Defer a specific shape until one appears in a collected species; do not design against a hypothetical |

### 2.2 The scheme

One `species` row per taxonomic concept, keyed on the **USDA symbol** (`QUSH`, `PRME`,
`CHLI2`) per the join-key recommendation in [02 §4](02-source-inventory.md). A `taxa` table
separates the *name* from the *concept* a symbol identifies, because synonymy is a
name-to-name mapping and more than one name can resolve to the same concept:

```
taxa
  id            -- surrogate key
  scientific_name   -- e.g. "Aster oblongifolius", "Symphyotrichum oblongifolium"
  rank          -- species | variety | subspecies | cultivar
  parent_id     -- for variety/subspecies/cultivar: the species row; NULL for species
  usda_symbol   -- nullable; cultivars and some varieties have none
  resolves_to   -- nullable FK to another taxa.id; set when this name is a synonym
```

- **Synonym**: `resolves_to` points at the accepted name. `Aster oblongifolius.resolves_to
  = Symphyotrichum oblongifolium`. A claim is always stored against the *resolved* id, never
  the synonym, so two names never fork a species' claim history.
- **Variety/subspecies**: `parent_id` points at the species. Rank-aware matching means a
  probe or extractor must try `Genus species var. epithet` before falling back to
  `Genus species`, per the header-regex hazard in [03 §6c](03-document-corpus.md).
- **Cultivar**: `parent_id` points at the species, `rank = 'cultivar'`, `usda_symbol = NULL`.
  This is the row §2.3 covers.

**Worked example — the load-bearing synonym case:**

```
taxa(id=1, name="Symphyotrichum oblongifolium", rank=species, usda_symbol=SYOB, resolves_to=NULL)
taxa(id=2, name="Aster oblongifolius",          rank=species, usda_symbol=NULL, resolves_to=1)
```

A flora extraction that matches on `Aster oblongifolius` (id=2) stores its claims against
`species_id=1`. Querying "what do we know about Symphyotrichum oblongifolium" never needs
to know the flora used the old name.

### 2.3 Cultivars: inherit by default, override explicitly

Decided direction, from the epic notes and [02 §4](02-source-inventory.md): a cultivar is a
first-class `taxa` row (`rank = 'cultivar'`, `parent_id` = the species). It does **not**
copy its parent's claims into new rows — copying would duplicate provenance and go stale
silently when the species record is corrected. Instead, reads walk the chain:

> To resolve field `F` for a cultivar: look for a claim on the cultivar's own `taxa.id`
> first; if none exists, fall back to the parent species' claim.

**Worked example — the case that forces this design:**

| | `Ilex vomitoria` (species) | `Ilex vomitoria 'Nana'` (cultivar) |
|---|---|---|
| `height_ft` | 45 (USDA) | **override: 3** (nursery tag / grower spec — source TBD by nl-41o.7) |
| `sun_pref` | Sun, Part Shade, Shade (NPIN) | *no claim* → inherits the species' value |
| `soil_pref` | sandy,loamy,clay (USDA) | *no claim* → inherits |

Only `height_ft` is overridden; everything else falls through. This is why a copy-on-create
model is wrong — it would need every future correction to the species applied twice.
`width_ft` inherits the same way once a source for it exists ([03 §8](03-document-corpus.md)
is a firm "no source yet," not a case for skipping the override mechanism).

**Consequence for nl-41o.7**: the cultivar's own override claims need their own sourcing,
same rules as species claims — "invent nothing" applies per-row, not per-species.

---

## 3. Claims

### 3.1 The shape

```
claims
  id
  species_id      -- taxa.id (already resolved through §2.2's synonym walk)
  field           -- e.g. "nativity_nctx", "sun_pref", "height_ft"
  value           -- text; multi-valued fields (sun_pref's set) are comma-joined, same
                     convention as plants.csv today
  status          -- see §3.3 — asserted | review | unknown
  source          -- e.g. "usda-plants-characteristics", "nctx-flora"
  citation        -- e.g. "Diggs, Lipscomb & O'Kennon 1999, p. 771"; NULL for API sources,
                     which cite their own endpoint+id instead (see below)
  retrieved_at
  confidence      -- nullable; not every source publishes one (USDA and the flora don't;
                     a manual correction can state one)
  license_id       -- FK, see §3.2
  superseded_by    -- nullable FK to claims.id; see §3.4
```

Two sources disagreeing is two rows with the same `(species_id, field)` and different
`value`/`source`. Nothing is overwritten on ingest — that is what makes arbitration
(nl-41o.5) and "what did source X actually say" (nl-41o.8's provenance tool) both possible
from the same table.

**Citation for API-sourced claims**: the flora's page-citation shape (§2, above) doesn't
apply to USDA/NPIN records. Store the endpoint and the id/symbol the request used
(`usda-plants:PlantCharacteristics:QUSH`) in `citation` for those — the point is the same
one [03 §2](03-document-corpus.md) makes for the flora: a claim without something that lets
a human or a probe re-derive it is not a claim, it's an assertion.

### 3.2 License is a property of the claim, not the source

**Decided on the epic, confirmed by two independent findings since:**

- BONAP's terms forbid redistributing "biological attribute information" outright —
  fixed, and it is the *source* that's blocked. [02 §1]
- GBIF emits a machine-readable `license` field **per record**, proving sources themselves
  routinely vary license by row, not just by source. [02 §2.5]
- LBJ/NPIN's grant is **conditional on this project's business model**, not fixed at
  extraction time: "personal/non-commercial: yes; commercial: no," per the 2026-08-28 reply
  recorded in
  [permission-requests.md](permission-requests.md). [nl-e77]

Three different shapes of constraint, so a single boolean `publishable` on the claim is the
wrong shape — a boolean evaluated once at extraction time can't represent a grant that
changes truth value if the project's status changes later. Model the **grant**, and
evaluate it at export time, not at ingest time:

```
licenses
  id
  source            -- "npin", "usda-plants", "nctx-flora", ...
  grant             -- e.g. "personal-noncommercial", "unrestricted", "facts-only"
  condition         -- nullable free text: "void if project becomes commercial" for NPIN;
                       NULL for USDA (unrestricted, no condition)
  citation_required -- text or NULL, e.g. "Courtesy of Lady Bird Johnson Wildflower Center"
```

`claims.license_id` points at the grant that covered the extraction. The CSV export
(§4) is where "may this value be published?" gets *evaluated* — joining `licenses` against
the project's current commercial status (today: non-commercial, so NPIN-derived claims
pass) — rather than baked into the claim as a fixed answer that a status change would
silently leave wrong. **This is why license lives on the claim, but the export logic, not
storage, is what re-evaluates it.**

### 3.3 Three-valued fields need a status, not just a value

[03 §5](03-document-corpus.md) measured this directly for nativity: `unknown` ("no
treatment found — synonymy unresolved") is a distinct state from both `native` and
`introduced`, and collapsing it into `native` is the exact failure mode that promotes a
non-native into a recommendation. [03 §4] adds a fourth state for the prose-origin channel:
a claim can be **flagged for human review** rather than either asserted or blank.

So `claims.status` is not just bookkeeping — three values, used across any book-sourced
field, not only nativity:

| `status` | Meaning | `value` |
|---|---|---|
| `asserted` | Source gives a value directly and it needs no review | populated |
| `review` | A screen fired (prose origin statement, escape/cultivation language) — a human must confirm before this counts as `asserted` | populated (candidate value) or NULL if the screen fired with no candidate |
| `unknown` | No claim could be formed (no treatment found, name unreconciled) | NULL |

A `review` row is a real row, not a rejected one — it is what lets nl-41o.8's "conflicts"
tool surface a queue, and what lets nl-41o.6 count "23 species need a human look" instead of
silently reporting them as either missing or wrong.

### 3.4 Corrections

A manual correction is a new claim row with `source = 'manual-correction'`, a required
`citation` (the reason) and an author — matching nl-41o.5/nl-41o.8's rule that a correction
needs a reason and an author, not a silent UPDATE. `superseded_by` on the row it corrects
records which claim the correction replaces, so history is never destroyed: querying "what
did we used to think" is a normal query (`superseded_by IS NOT NULL`, follow the chain),
not an audit-log reconstruction. This is also what makes a re-crawl safe — a fresh
extraction inserts new rows; it never touches `superseded_by`, so it cannot silently undo a
correction the way an UPDATE-in-place store would.

**But `claims.db` is gitignored and rebuildable (epic tooling decision), and a correction is
exactly the class of claim that has no source to rebuild from.** So the claim row above is
not the system of record for a correction — it's a cache of one. The epic's tooling notes
already name the actual artifact: **"a plain-text manual-corrections file" is committed
alongside `plants.csv`.** That file, not a row in the gitignored store, is authoritative:

```
data-acquisition/manual-corrections.txt   (or similar; exact path is nl-41o.5's call)
  species_id (or usda_symbol), field, value, reason, author, date
```

On every rebuild, the file is replayed as the last ingestion step, producing correction
claim rows with fresh `id`s and `superseded_by` reconstructed by re-running the same
supersession logic against whatever the sourced claims currently say. So `superseded_by` in
`claims.db` is **derived, not authoritative** — the committed file is what a diff reviews
and what survives a rebuild; the database row is only ever a projection of it, symmetric
with how `plants.csv` itself is a projection (§4).

---

## 4. Export: the app keeps reading a flat `plants.csv`

**Decision: yes, keep the flat CSV as a generated projection.** Reasoning:

- It was already decided at the epic level (2026-08-27 tooling notes) — this bead confirms
  rather than reopens it, and states why.
- `src/data/plantParser.js` and everything downstream expects flat rows; changing that
  surface is a much larger, riskier change than adding a generator that targets the format
  already consumed.
- It keeps the "reviewable in a diff" constraint the epic's ACCEPTANCE CRITERIA names
  explicitly — `git diff plants.csv` stays a two-line change a human can read, where a
  `git diff claims.db` would be meaningless binary noise (which is also why `claims.db` is
  gitignored, per the epic's tooling decision).

**Export logic, stated because it's where §3.2's license evaluation and §3.3's status
filtering both land:**

1. For each `(species, field)`, resolve to one value via nl-41o.5's precedence rule
   (arbitration is out of scope here — the export just calls it).
2. Only `status = 'asserted'` claims are eligible. `review` rows are excluded from the
   export entirely until a human promotes them to `asserted` — this is what keeps the
   silence-leak population (§3.3) out of the published catalog by construction, not by
   discipline, **provided the excluded field lands as a genuine blank downstream.**
   **It does not, today: `nl-c58` (open bug) measures `src/data/plantParser.js` filling
   several blank fields with fabricated defaults** — blank `growth_shape` becomes
   `'mound'`, blank `height_ft` becomes `1`, blank `sun_pref`/`water_pref`/`soil_pref`
   silently skip rule 8 with no finding at all. An excluded `review` row on any of those
   fields would be *worse* than publishing the unreviewed value — it would be published as
   a different, invented value with no trace it was ever missing. **`nl-c58` is therefore a
   hard prerequisite of this export design, not an unrelated bug**: the three-valued model
   in §3.3 only holds once a blank reliably reads as blank all the way through the app.
3. Check the resolved claim's `license_id` grant against the project's current commercial
   status. A claim whose grant is voided (e.g. NPIN, if the project ever turns commercial)
   is dropped from the export, not from the store — the underlying claim is still true and
   still queryable, it's just not publishable under current terms.
4. Cultivar rows resolve per §2.3 (own claim, else parent's) before the same two filters
   apply.

### 4.1 The parser constraint on export, decided here

A note recorded on this bead measured that `src/data/csvLoader.js`'s `parseCsv` splits on
newlines **before** honoring quotes, so it cannot represent a field containing an embedded
newline — and a book-sourced reason string (a manual correction's citation, a flora
excerpt-derived note) is exactly the kind of value likely to contain one.

**Decision: the export forbids embedded newlines rather than fixing the parser.**
Reasoning: no field in the current 47/469/61-row catalogs has ever needed one (measured on
this bead's predecessor), the fix touches a parser every existing view depends on for a
benefit no current data needs, and forbidding is enforceable at a single point (the
generator) rather than requiring every future writer of `plants.csv`-shaped data to remember
the constraint. The generator replaces `\n` with a space and logs when it does, so a
truncated value is visible in the generator's own output rather than silently mangled in
the CSV. If a future field genuinely needs multi-line text, that is the trigger to revisit
the parser — not a reason to fix it preemptively now.

---

## 5. Lookups the index must serve

Named because nl-41o.6's metrics and nl-41o.8's Phase 2 tools both consume these, and
"what is missing" is not optional per nl-41o.8's design notes:

| Lookup | Used by |
|---|---|
| By species: all claims for a `taxa.id`, resolved through synonymy | app export, provenance tool |
| By field: all claims for a given field across all species | coverage metrics, field-sniff style audits |
| By source: all claims a given source contributed | licensing re-evaluation when a source's terms change; "what would re-crawling source X touch" |
| By status: all `review` rows | the human review queue nl-41o.5 needs, and nl-41o.8's "conflicts" tool |
| **Missing**: species with no claim (of any status) for a given field | nl-41o.6's coverage metric and nl-41o.7's stopping condition — the query neither of those beads can proceed without |
| By license grant: all claims whose `license_id` has a `condition` | re-evaluation trigger if the project's commercial status ever changes (§3.2) |

All six are answerable with an index on `(species_id, field)`, one on `field` alone, one on
`source`, and one on `status` — ordinary SQLite indexes, no denormalization needed given the
row counts in play (~500 species × ~40 fields × 3–5 sources ≈ 60–100k rows, per the epic's
tooling notes).

---

## 6. Answers to the bead's acceptance criteria

| Criterion | Answer |
|---|---|
| Identity scheme covering synonyms, varieties, cultivars | §2 — `taxa` table, `resolves_to` for synonyms, `parent_id` for rank and cultivars, worked through on the Packera/Aster and Ilex vomitoria 'Nana' cases |
| Claim record shape holding two disagreeing sources | §3.1 — one row per `(species_id, field, source)`, nothing overwritten on ingest |
| Flat-projection decision, with reasoning | §4 — keep it; reasons given, not just asserted |
| Lookups the index must serve, including "what is missing" | §5 |
| How this stays reviewable in a diff | §4 — the generated `plants.csv` is what's reviewed, same as today; §3.4 — the plain-text manual-corrections file is the committed, diffable system of record for corrections; `claims.db` is gitignored and rebuildable in both cases, so it is never the diff surface |

---

## 7. Open items for other beads

- **nl-41o.5** — owns the precedence rule the export calls in step 1 of §4, and the
  human-facing side of `status = 'review'` promotion.
- **nl-41o.6** — the "missing" lookup in §5 is the metric; report `unknown` and `review`
  counts separately, per [03 §5](03-document-corpus.md)'s three-valued rule.
- **nl-41o.7** — cultivar override claims (height, spread) need a source decided; §2.3 flags
  this as unresolved, not a schema gap.
- **nl-41o.8** — §5's six lookups are the query surface Phase 2's coverage/provenance/
  conflicts tools should expose; the "missing" query in particular is the one this doc and
  nl-41o.8's design notes both call non-optional.
- **Hybrids (§2.1)** — no worked example exists yet. Revisit when one is hit in real data
  rather than designing a shape for a case not yet observed.
- **nl-c58** — reclassified by §4 step 2 from an unrelated app bug to a hard prerequisite:
  the export's "exclude non-asserted claims" design only keeps unreviewed data out of the
  catalog if a blank field actually renders as blank, not as a fabricated default. Fix
  before the export ships, not after.
