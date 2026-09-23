# Conflict resolution and manual corrections: precedence, corrections, and staleness

Deliverable for **nl-41o.5**. Analysis only — no precedence rule runs and no correction is
written here. Same discipline as [04](04-data-model.md)/[05](05-quality-metrics.md): every
decision states the finding it answers to, and anything not settled by evidence is marked
**OPEN**.

This bead was blocked on nothing but [nl-41o.4](04-data-model.md) (closed 2026-08-29), and
two later beads already reserved slots for its output rather than inventing their own:
[05 §4](05-quality-metrics.md)'s **Adjudication** metric is a query over the state this doc
defines; [07 §3.2](07-mcp-introspection.md)'s `claims_provenance` has a `resolutionReason`
field that has been `null` since it was specified, waiting for the rule below; §3.5's
`claims_correct` writes the file format §2 defines. Nothing here reopens those shapes —
it fills them in.

---

## 1. Precedence: per-field, and it already exists

[02 §2](02-source-inventory.md) assigned every source a role — **PRIMARY**, **PRIMARY for
X**, or **CORROBORATING** — per field, while inventorying access and licensing, not while
designing arbitration. That table *is* a precedence rule; this section states it as one
rather than deriving a new mechanism:

| Field group | Primary | Falls back to | Reasoning already on record |
|---|---|---|---|
| County distribution, the 81 characteristics (sun/water/soil ordinals, height, bloom/fruit timing, fruit load, toxicity, lifespan, commercial availability) | USDA PLANTS | — | [02 §2.1](02-source-inventory.md): public-domain, cleanest terms, broadest coverage |
| Month-precision bloom timing, light requirement as a set, deer resistance, species-level larval host, soil/water description | NPIN | USDA (coarser) | [02 §2.3](02-source-inventory.md): NPIN's Texas-regional editorial slant beats USDA's coarser ordinal for these specific fields, nothing else |
| Keystone counts (genus-level) | NWF | — | [02 §2.6](02-source-inventory.md), decided on the epic |
| County nativity (`nativity_nctx`) | The flora ([03](03-document-corpus.md)), reviewed per-taxon | *(retired — see note)* | [03 §10](03-document-corpus.md): "these disagree *by design*; the flora is more specific and should win at NCTX scale" — not a source-quality ranking, a granularity one. [02 §1](02-source-inventory.md) separately rules out BONAP as a source at all (terms forbid storing the value) |
| Local occurrence / naturalization signal | *(not admissible as a value source)* | — | [02 §2.4](02-source-inventory.md): iNaturalist's wild:captive ratio measures a different question and cannot be thresholded into nativity |

**Note on `nativity_nctx`'s retired USDA fallback (nl-scx.14, owner decision 2026-09-20):**
[nl-scx.2](02-source-inventory.md)'s USDA ingest deliberately never writes USDA's
`NativeStatuses` field as a `nativity_nctx` claim — it is stored as its own field,
`usda_native_status`, and stops there. `plantable_set` has no source filter on
`nativity_nctx='introduced'`, so an unscoped USDA fallback claim could silently shrink
the plantable set outside what this table intends, and USDA's own data is not reliably
single-valued at its L48 granularity anyway (*Achillea millefolium*'s own record carries
`L48:I|L48:N`). The fallback slot is retired, not pending: nothing will ever populate it.
`tools/claims/precedence.js`'s `nativity_nctx` order is `[NCTX_FLORA]` only.

**The rule, stated generally:** precedence is decided once per field, by which source [02](02-source-inventory.md)
already named primary for it, not computed per-claim (no confidence-weighting, no "newest
wins"). [08 §1.2](08-known-gaps.md) is this rule already applied by hand, before it had a
name: *Passiflora lutea*'s `sun_pref` moved from USDA to NPIN's directly-stated value **not
because USDA was wrong, but because NPIN is primary for that field.** §5 below turns that
exact correction into the worked example for §2's file format.

**Why per-field beats a fixed source ranking or confidence-weighting**, restated from the
bead's own framing now that §1's table makes it concrete: a fixed ranking ("USDA always
beats NPIN") would get *Passiflora lutea*'s `sun_pref` wrong — NPIN wins there specifically.
Confidence-weighting needs a number neither USDA nor the flora publishes ([04 §3.1](04-data-model.md)
already notes this), so it would have to be invented, which is the exact move
[05 §1.1](05-quality-metrics.md) rejected for the composite quality score. Per-field
precedence needs no invented number — it's a lookup against a table already produced by
source research that happened for an unrelated reason (licensing and access, not
arbitration), and it resolves the one real correction found in the wild without guessing.

### 1.1 What per-field precedence cannot resolve — and must not silently pick

[04](04-data-model.md)'s worked case, *Callicarpa americana*'s `LargeMammals` field, breaks
the table above on purpose: `Martin` says `Minor`, `Miller` says `Moderate`, and **both
come from the same source row** — `/api/PlantWildlife/{id}`, i.e. USDA — which §1's table
already ranks primary for this field. Per-field precedence answers "USDA or NPIN?" and has
nothing left to say once the disagreement is *inside* USDA, between two literature
citations (`Source: Martin` vs `Source: Miller`) it exposes without ranking them itself.

This is not a gap in §1's table — it is the case the bead named up front as one that
**must not** auto-resolve. Two literature citations disagreeing on a field observed
independently is not a data error to arbitrate; picking one (majority vote, first-seen,
alphabetical) would manufacture a false certainty an ecologist reading both papers
wouldn't have. **Any two `asserted` claims on the same `(species, field)` that disagree in
value, from sources tied under §1's precedence table (including two citations within one
API source), route to `status = 'review'` and stop — no value is exported until a human
adjudicates**, per [04 §3.3](04-data-model.md)'s three-valued status and [04 §4](04-data-model.md)
step 2's export filter. §4 below is what the app shows for that case, and it's the same
answer as a blank on purpose.

**A second, independent instance of this shape is already sitting in the queue.**
[03 §7.1](03-document-corpus.md)'s per-taxon nativity review — the reviewed input this bead
was explicitly told to consume — found two species where the disagreement is not between
sources at all but **inside the flora's own text**: `Cyperus esculentus` cites Mabberley
(1987, native to w Asia/Africa) against Tucker (1994, cosmopolitan) and quotes both without
adjudicating; `Nymphaea mexicana`'s one NCTX-area record is flagged by the flora itself as
"probably a hybrid," undermining its own citation. Same shape as Callicarpa's
`Martin`/`Miller` split — one source, internally divided, ranked highest by §1's table and
with nothing left in that table to break the tie. Both route to `review` under this
section's rule, matching [03 §7.1](03-document-corpus.md)'s own disposition ("not
resolvable to either value from this source alone").

### 1.2 The nativity review queue nl-41o.12 produced, filed under this bead's rule

[03 §7.1](03-document-corpus.md) reviewed the 17 prose-origin hits named in
[03 §4](03-document-corpus.md) and handed this bead four buckets, each of which maps onto a
state already defined above rather than needing a new one:

| Bucket (from 03 §7.1) | Count | Species | Status here |
|---|---|---|---|
| Confirmed non-native to NCTX | 7 | *Chilopsis linearis*, *Catalpa speciosa*, *Robinia pseudoacacia*, *Eschscholzia californica*, *Gymnocladus dioicus*, *Taxodium distichum*, *Tillandsia usneoides* | §1's `nativity_nctx` row applies directly — the flora outranks USDA's `L48:N` at NCTX scale. Each is a §2-format correction, ready to write once a human signs off (this bead documents the format; it does not author the 7 rows) |
| Native, confirmed or affirmed | 6 | *Quercus muehlenbergii*, *Maclura pomifera*, *Heliotropium curassavicum*, *Impatiens capensis*, *Phragmites australis*, *Stachys tenuifolia* | Non-defects — no correction needed. Listed so a future pass doesn't re-open them |
| Marginal native (edge-of-range / cultivation-spreading) | 2 | *Pinus echinata*, *Pinus taeda* | `status = 'review'` under [04 §3.3](04-data-model.md) — the flora itself declines to say in/out, so this bead's rule (adjudicate, don't guess) applies as-is |
| Flora cites conflicting sources on origin | 2 | *Cyperus esculentus*, *Nymphaea mexicana* | `status = 'review'` under §1.1's rule above — internally-divided single source, no precedence to apply |

This table is not new analysis — it sorts [03 §7.1](03-document-corpus.md)'s findings into
the states this bead defines, closing the loop that bead explicitly left open ("this table
is the reviewed input nl-41o.5's correction pass should consume"). Writing the actual 7
correction rows and the 2+2 review entries is data entry against §2's format, not a design
decision, and is left to whoever next touches `manual-corrections.tsv` — [04 §3.4](04-data-model.md)
already established the file has no reader until the claim store exists to replay into.

---

## 2. Corrections: the manual-corrections file

[04 §3.4](04-data-model.md) sketched the shape and left the exact path/format to this bead.
Deciding it now, since [07 §3.5](07-mcp-introspection.md)'s `claims_correct` tool needs a
concrete target to append to.

**Path**: `catalog/manual-corrections.tsv`, beside the other flat regional catalogs
(`catalog/blackland-prairie-natives.csv`, `catalog/dfw-nctx-natives.csv`; moved out of the
repo root 2026-09-22)
— not under `docs/data-acquisition/` (design docs, not data) and not under `data/`
(the gitignored, rebuildable `claims.db` store). Plain text, diffable, the system of record
[04 §3.4](04-data-model.md) requires because `claims.db` is gitignored and a correction has
no source to rebuild from. Tab-separated over CSV: [04 §4.1](04-data-model.md) already
forbids embedded newlines in generated CSV output, but a correction's `reason` is
hand-written prose most likely to contain a comma ("NPIN states this directly; USDA's Shade
Tolerance ordinal was inverted, see 02 §2.1") — TSV avoids quoting that field at all,
matching this repo's existing preference for the simplest format the data survives. Every
`reason` value is therefore a single line, no exceptions — the same constraint
[04 §4.1](04-data-model.md) applies to generated CSV output, applied here to the
hand-written source file instead.

**Columns**, one row per correction. Shown below wrapped across lines only for this doc's
readability — the actual file has one correction per physical line, tab-separated, no
embedded newlines in any field:

```
usda_symbol  field      value     reason                                             author                   date        supersedes_source
PALU2        sun_pref   part-sun  NPIN direct statement outranks USDA's inverted     john.syrinek@gmail.com  2026-08-29  usda-plants
                                   Shade Tolerance ordinal (02 §2.1); NPIN is primary for sun_pref (02 §2.3)
```

- **`usda_symbol`**, not `taxa.id` — a surrogate key is meaningless in a diff and would
  churn across a `claims.db` rebuild; the symbol is stable and human-legible, matching
  [02 §4](02-source-inventory.md)'s join-key recommendation. A cultivar correction
  (no symbol, [04 §2.3](04-data-model.md)) uses `usda_symbol + cultivar name`
  (`ILVO 'Nana'`) — the same pairing [04 §2.3](04-data-model.md)'s worked example already
  keys on.
- **`reason`** and **`author`** are required, no optional path around either — restates
  [04 §3.4](04-data-model.md) and [07 §3.5](07-mcp-introspection.md)'s tool contract, now
  as a file-format constraint: a row missing either is invalid and the replay step (§2.1)
  must reject it rather than import it as an unattributed edit.
- **`supersedes_source`** is what makes staleness checkable — §3 below.
- **No `species_id` foreign key into `claims.db`** — the file must remain meaningful if
  the database is deleted and rebuilt, which is the entire reason it's the system of
  record and not a table.

### 2.1 Replay: how the file becomes claim rows

On every rebuild, after all sourced claims are ingested, the manual-corrections file is
replayed last: each row inserts a `claims` row with `source = 'manual-correction'`,
`status = 'asserted'`, `citation = reason`, and `superseded_by` set on whichever claim row
this correction targets, following [04 §3.4](04-data-model.md)'s supersession logic. A
manual correction outranks every source in §1's table by construction — it is what a human
already applied §1's reasoning to and decided the table's default answer was wrong for this
one species, same as the *Passiflora lutea* case. This is also why replay must run **last**:
if a fresh USDA crawl inserted after the correction could re-claim the top of the
precedence order, replaying second is what actually prevents "the next crawl silently
undoing it" — the bead's original framing — not just the append-only claims table by
itself.

---

## 3. Staleness: pin the source version, flag drift

**A correction pins `supersedes_source` and the superseded claim's own `retrieved_at`** —
not a separate version field, because [02](02-source-inventory.md) already measured that
none of these sources publish a version or revision id (USDA: "Unknown — BELIEF. No
version or last-modified field observed", [02 §2.1](02-source-inventory.md); NPIN: same,
[02 §2.3](02-source-inventory.md)). `retrieved_at` is the only timestamp that actually
exists, so it's what gets pinned, not an invented version string.

**Drift detection is a comparison, not a new mechanism**: [07 §3.6](07-mcp-introspection.md)'s
`claims_dry_run` tool already computes "what would a re-crawl change" before writing
anything. A correction is flagged stale when a fresh claim for the same `(species, field)`
disagrees with the value the correction's `supersedes_source` claim held **at the time of
correction** — i.e. the source itself changed underneath a correction that assumed it
wouldn't. This doesn't need its own query; it's `claims_dry_run`'s existing diff, filtered
to `(species, field)` pairs with a `manual-correction` claim on top. **OPEN**: whether this
filter is a `claims_dry_run` argument or a view built on its output is an implementation
question, deferred to the epic that builds `claims_dry_run`, not decided here — the
detection logic is the part this bead owns, and it needs no new primitive.

A flagged-stale correction does **not** auto-revert. It becomes a `status = 'review'` row
alongside its own superseded claim and the new conflicting one — the same unresolved-conflict
path as §1.1, because "the source changed since a human decided against it" is exactly the
kind of disagreement that should not silently resolve itself either.

---

## 4. What an unadjudicated conflict shows in the app

**The same as `unknown`: nothing.** [04 §3.3](04-data-model.md) already made `review` a
distinct status from `asserted`, and [04 §4](04-data-model.md) step 2 already excludes
non-`asserted` claims from the generated `plants.csv`. This bead's contribution is
confirming that decision extends to conflicts, not just to unreviewed screens, and stating
why that's the right choice rather than assuming it:

- Showing *either* disputed value (say, whichever loaded first, or alphabetically-first
  source) would present a coin-flip as a fact, which is worse than a blank — [04 §4](04-data-model.md)'s
  step 2 commentary on `nl-c58` already established that a fabricated-looking value that
  silently substitutes for a real one is the worst failure mode in this whole pipeline, and
  an un-adjudicated pick reads to a user exactly like a real value.
- A blank is honest and, per [03 §5](03-document-corpus.md), already this project's
  established way to say "not established" rather than guess.
- The row is **not silently dropped from view** — it's live in `claims_conflicts`
  ([07 §3.3](07-mcp-introspection.md)), which is the human review queue
  [05 §1](05-quality-metrics.md)'s Adjudication metric counts. "Blank in the export, visible
  in the queue" is the same pattern [04 §3.3](04-data-model.md) already uses for `review`
  generally — this section just confirms multi-source disagreement is filed under the same
  status, not a fourth one.

**Promotion path**: a human resolves a `claims_conflicts` entry by calling `claims_correct`
([07 §3.5](07-mcp-introspection.md)) with the value they judge correct and why — which is
just §2's manual-correction path, not a separate promotion mechanism. There is no
"accept claim X as-is" shortcut that skips writing a reason: even agreeing with one of the
two disputed sources over the other is a judgment call by [04 §3.3](04-data-model.md)'s own
standard, and needs the same `reason`/`author` any other correction does. This keeps the
system to one write path total, per [07 §3.5](07-mcp-introspection.md)'s note that the
tool "backs a view's submit action" rather than being a second mechanism.

---

## 5. Worked example: the correction already made, in the format this bead defines

§2's example row is not hypothetical — it's [08 §1.2](08-known-gaps.md)'s *Passiflora
lutea* `sun_pref` correction (commit `1fa2a13`, dated by `git show -s --format=%ad
1fa2a13`), written in the format this bead defines instead of applied by hand as it was
originally. Tracing what replaying it would do:

Replayed (§2.1), this produces a `claims` row with `source = 'manual-correction'` that
supersedes the USDA-sourced `sun_pref` claim for *Passiflora lutea*. A future USDA re-crawl
inserts a fresh, un-superseding claim row for the same field — it does not touch
`superseded_by` — so the correction survives untouched, and `claims_provenance` on this
species now shows three rows (the original USDA claim, the correction, and any later
re-crawl) instead of one silently overwritten value. This is the concrete shape of "a
re-crawl cannot silently erase a correction," demonstrated on data this project has already
gotten wrong once.

---

## 6. Answers to the bead's acceptance criteria

| Criterion | Answer |
|---|---|
| A precedence rule, stated per-field where warranted | §1 — the table is [02](02-source-inventory.md)'s existing PRIMARY/CORROBORATING roles, read as a rule; §1.1 states what it cannot resolve and routes that to `review` instead of guessing |
| A correction record shape carrying reason, author, and the source version it was made against | §2 — `catalog/manual-corrections.tsv`, columns include `reason`, `author`, `supersedes_source`; §3 explains why `retrieved_at` stands in for a version field no source publishes |
| A guarantee that a re-crawl cannot silently erase a correction, and a described mechanism | §2.1 — replay-last ordering plus append-only `superseded_by`; §5 demonstrates it on a real correction |
| A decision on what an unadjudicated conflict shows in the app | §4 — nothing in the export (same as `unknown`), visible in the `claims_conflicts` review queue, resolved only through the same reasoned `claims_correct` path as any other correction |

---

## 7. Open items for other beads

- **The implementation epic** — builds the replay step (§2.1), the `claims_dry_run` staleness
  filter (§3, marked OPEN on which layer it belongs to), and the `claims_conflicts` /
  `claims_correct` human-facing view [07 §5](07-mcp-introspection.md) already flagged as
  waiting on this bead.
- **nl-41o.7** — cultivar override corrections use the `usda_symbol + cultivar name` keying
  from §2; still needs its own source decided for cultivar-specific fields like height,
  per [04 §2.3](04-data-model.md)'s open item, independent of this bead's format.
- **BONAP permission** ([02 §2.2](02-source-inventory.md)) — if a yes ever arrives, it adds
  a second nativity source, which would newly create the §1.1 shape of conflict (two
  values, no existing precedence between them) for the one field this project has none for
  today. Worth a one-line reminder when that permission is revisited: it doesn't just add
  coverage, it adds an arbitration case.
