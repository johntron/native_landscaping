# Document corpus: the NCTX flora, and what extracting from it actually costs

Deliverable for **nl-41o.3**. Analysis only — nothing here collects or writes plant data.
The extractor described below is a throwaway probe that lives in a scratchpad, not code in
this repo.

Same discipline as [01](01-goals-and-required-fields.md) and
[02](02-source-inventory.md): every claim is **MEASURED** (probed this session) or
**BELIEF** (from documentation, unverified).

Date of measurements: 2026-08-27.

---

## 1. Headline

The flora **does** supply nativity — but through the channel this bead did *not* expect,
and the channel it *did* expect turns out to be worth almost nothing here.

| Channel | What it is | Granularity | Verdict |
|---|---|---|---|
| The `I` symbol | An explicit editorial flag at the end of a treatment | **Continental** | **Reliable and near-useless.** Same granularity USDA's `L48:I` already gives, which [01](01-goals-and-required-fields.md) ruled out |
| The prose origin statement | `Native of Mexico and sw U.S.` in the description text | **Regional / sometimes county** | **The valuable channel — a screen, not a classifier, and it needs a third screen beside it** (§4.1) |

The bead was written expecting the `I` symbol to be the prize and the prose to be a bonus.
It is the reverse. Detail in §3 and §4.

Three further results, each of which changes what the implementation epic has to build:

- **A name-reconciliation layer is a hard prerequisite, not an enhancement** (§5). 119 of
  469 catalog rows get no treatment, and the verified cause is 1999 nomenclature, not
  absence.
- **Two silent-truncation hazards of the Alnus class were hit and measured** (§6). Both
  produced *wrong verdicts*, not errors. One turned a known invasive honeysuckle into a
  native.
- **The corpus contradicts the catalogs already in this repo** (§7), including on the
  epic's own worked example.

And one correction to carry back: **the flora does not supply mature width** (§8). The
bead's note that it "un-defers rules 9 and 12" is stale and is corrected there.

---

## 2. The corpus is in hand, free, and text-native

**MEASURED.** *Shinners & Mahler's Illustrated Flora of North Central Texas* (Diggs,
Lipscomb & O'Kennon, 1999; BRIT/Austin College), published as a free complete PDF set at
<http://artemis.austincollege.edu/acad/bio/gdiggs/NCTXpdf.htm>. All six volumes are on
this machine already.

| Volume | Pages | PDF | Extracted |
|---|---|---|---|
| FrontMatter-Intro | 1–108 | 5.8 MB | 4,982 lines |
| Keys-Ferns-Gymnos | 109–209 | 1.6 MB | 4,988 lines |
| Acanth-Euph | 210–617 | 35.7 MB | 18,081 lines |
| Fab-Zygo | 618–1076 | 41.9 MB | 20,259 lines |
| Acor-Zanni | 1077–1352 | 18.4 MB | 11,933 lines |
| Appendices-Glossary | 1353–1456 | 1.2 MB | 5,294 lines |

**`pdftotext -layout` is sufficient. No OCR.** This is real embedded text, not scans, which
removes the bead's single biggest assumed risk and the entire OCR-error-that-looks-like-data
failure mode. **The Python/pdfplumber/tesseract stack this bead was pre-authorized to
install is not needed for this corpus** — `/usr/bin/pdftotext`, already present, does the
job. Revisit only if a horticultural source (§8) turns out to be scanned.

**Citation is solved exactly.** `pdftotext` emits one form-feed per page, and the counts
match the filename ranges with zero drift:

| Volume | Form-feeds | Pages in range | |
|---|---|---|---|
| Acanth-Euph | 408 | 617 − 210 + 1 = 408 | ✓ |
| Fab-Zygo | 459 | 1076 − 618 + 1 = 459 | ✓ |
| Acor-Zanni | 276 | 1352 − 1077 + 1 = 276 | ✓ |

So `page = first_page_in_filename + formfeed_index` is exact, verified independently on
three volumes. A book-sourced value can carry a real, checkable citation —
`Diggs, Lipscomb & O'Kennon 1999, p. 771` — which answers the bead's citation question. The
running headers (`ILLUSTRATED FLORA OF NORTH CENTRAL TEXAS 771`) corroborate but are not
needed, and are not reliable on their own: they appear on only some pages, and they begin
with the form-feed character, so a `^ *` anchor silently matches none of them.

**Licensing: fact extraction only.** A soil tolerance or a nativity flag is a fact, not
expression. The pipeline must store **extracted values plus a page citation, never
excerpts**. That rule applies to this analysis too: the PDFs and every text dump stay in
the scratchpad and out of the repo — they are 100 MB of copyrighted text, and committing
them would be both bloat and a licensing problem.

---

## 3. The `I` symbol: reliable, and the wrong granularity

**MEASURED.** The front matter (p. 11) defines it, verbatim:

> For naturalized plants whose place of origin is **outside the continental United
> States**, the symbol I is placed at the end of the species' taxonomic treatment; plants
> for which this symbol is not given are native to the continental United States.

It survives extraction cleanly — `Native from India to e Asia. I` (Nandina). And it is
accurate. Two independent checks:

**Controls.** Against `dfw-avoid-non-natives.csv` (the negative set) and `plants.csv` (the
positive set):

| Set | n | Carries `I` | Result |
|---|---|---|---|
| Known non-natives, with a treatment | 10 | **10** | **no leaks** |
| Known natives (`plants.csv`) | 47 | **0** | **no false positives** |

**Calibration against a published figure.** The front matter states 2,223 species of which
394 (17.7%) are introduced. The probe matched 2,272 treatments and found 415 carrying `I`
(18.3%) — within ~2% on both counts. The small over-count is expected and explained: the
span rule occasionally runs past a treatment's end into a plate-caption block (seen
directly on *Prunella vulgaris*).

**And yet it is nearly worthless for this project.** Its granularity is *continental*, so
it draws exactly the line USDA's `usda_native_status` already draws — the line
[01](01-goals-and-required-fields.md) identified as useless, because it scores desert
willow and Mexican plum identically. Confirmed directly:

> `Chilopsis linearis` — **no `I` symbol.** Correctly so: the sw U.S. is inside the
> continental United States.

Anything the `I` symbol would tell us, `usda_native_status` already told us. Its real value
is as a **cheap, high-precision negative filter** — it catches Old World escapes sitting in
a file labelled "natives" (§7) — not as the county-nativity field the epic needs.

---

## 4. The prose origin statement: the valuable channel, and only a screen

The same front-matter passage continues, and this sentence is the one that matters:

> However, **all species not native to North Central Texas have their area of origin
> indicated in the descriptions.**

That is an editorial promise of exactly the granularity the epic wants, and it **resolves
the epic's own worked example**, which the `I` symbol could not:

| Species | Prose | Reading |
|---|---|---|
| `Chilopsis linearis` | `Native of Mexico and sw U.S. ... CULTIVATED and long persists, PLANTED ALONG HIGHWAYS, ESCAPES; Tarrant Co.` | **not** native to NCTX |
| `Prunus mexicana` | `Woods and thickets, various soils; se and e TX w to West Cross Timbers` — a plain range, no origin statement | native to NCTX |

**But the presence of an origin phrase is a flag to review, not a verdict.** Across the
469-row catalog the probe surfaced 17 prose hits with no `I`, and reading them shows at
least three distinct senses:

- **Genuine non-NCTX origin** — `Chilopsis linearis`, `Catalpa speciosa`
  (`Native of Mississippi Valley`), `Robinia pseudoacacia` (`Native of e U.S.`).
- **A comparison to a *different* species** — `Stachys tenuifolia | native of the
  Trans-Pecos **can be distinguished from the species above by**...`. The phrase is about
  the neighbouring taxon, not this one.
- **Cosmopolitan, or affirming nativity** — `Phragmites australis | Native of North
  America, South America, Eurasia, Africa, and Australia`; `Impatiens capensis | native to
  North America including e TX`.

So the design is: **prose match ⇒ queue for review; never auto-assign.** A regex verdict on
this channel would invent data at a rate the controls already expose — see §6, where the
naive version mislabelled 4 of 47 known natives as introduced.

### 4.1 The converse does *not* hold on its own — measured, 11.6% leak

The controls in §3 show the prose fires when present, and that known NCTX natives are
silent (41/41). **Neither tests the inference the epic actually depends on: that silence
implies native.** The 41 positives genuinely *are* NCTX natives, so their silence is
consistent with the rule without testing it. The at-risk population is different: species
native to the continental U.S. but *not* to North Central Texas, present here as cultivated
escapes — the `Chilopsis` class.

That population self-identifies in the prose, which makes it testable. **MEASURED:** of the
2,272 treatments, **199 use escape or cultivation language** (`escapes`, `adventive`,
`Cultivated and`, `long persists`, `naturaliz-`). If the editorial promise held perfectly,
every one would also carry an `I` or an origin statement.

| | |
|---|---|
| At-risk treatments (escape/cultivation language) | 199 |
| Carrying `I` or an origin phrase | 174 |
| **Leaks — escape language, no origin, no `I`** | **25 (12.6%)** |

**So the silence inference leaks, and the bead's convention cannot stand alone as an
auto-classifier.** Reading the leaks shows why, and it is not a tuning problem:

| Species | What the flora actually says |
|---|---|
| `Pavonia lasiopetala` | `Cultivated and spreading in landscapes; Tarrant Co.; **native in** rocky woods of Edwards Plateau and s TX` |
| `Salvia greggii` | `**Native in** rocky soils of c, w, and s TX **probably s of nc TX**` |
| `Ilex vomitoria` | `Commonly cultivated ... also **naturalized in Dallas and Tarrant cos.**; **mainly se, e, and sc Texas**` |
| `Hesperaloe parviflora` | `spreading from cultivation in Brown Co. ... [escaped?]; **otherwise mostly much further w in sw TX**` |

The first two are a one-word regex gap — the flora writes `native **in**`, and
`Native (of\|from\|to)` misses it. **Adding `in` recovers only 2 of the 25** (leak 12.6% →
11.6%), at a cost of one newly-flagged row in `plants.csv` (`Pavonia lasiopetala` — a true
positive). Worth doing, but it is not the fix.

The remaining 23 are the real finding: **the origin signal is often carried by the
distribution sentence, not by any `native ...` phrase.** `mainly se, e, and sc Texas` and
`otherwise mostly much further w in sw TX` say plainly that the species' range lies outside
NCTX, in a form no keyword matches. Extracting that requires reading a range, not matching
a pattern — a materially harder job, and the same second extraction §4's granularity note
already defers.

**The design that follows, and it closes the leak by routing rather than by classifying:**

1. `I` symbol ⇒ **introduced** (reliable, continental).
2. `native of/from/to/**in**` phrase ⇒ **review**.
3. **escape or cultivation language ⇒ review, even with no origin phrase.** This screen is
   what catches the 23, and it exists only because the converse test was run.
4. otherwise ⇒ **native by silence**, at NCTX scale.

Screen (3) is the one a reasonable implementation would have omitted. By construction it
covers the whole at-risk population, so the residual risk moves out of the silent class and
into a queue. **MEASURED cost of doing it — small enough to be read by a human:**

| | native by silence | review | introduced (`I`) | unknown |
|---|---|---|---|---|
| `plants.csv` (47) | 36 (76.6%) | **6 (12.8%)** | 0 | 5 (10.6%) |
| `blackland-prairie-natives.csv` (469) | 323 (68.9%) | **23 (4.9%)** | 4 (0.9%) | 119 (25.4%) |

**Granularity, stated honestly.** The flora licenses a claim at *North Central Texas*
scale, not Dallas County. County detail does appear in the prose (`Tarrant Co.`,
`adventive in Dallas Co.`, `w to West Cross Timbers`), but harvesting it is a **second,
harder extraction** than the origin-statement screen, and should be scoped separately.
NCTX-level nativity is still a large step up from `L48:N`, and is the deliverable to plan
around.

---

## 5. "No treatment" is a third value, and conflating it invents data

**MEASURED.** Of 469 rows in `blackland-prairie-natives.csv`, **119 matched no treatment**.
That is not 119 non-natives, and it is not 119 natives.

The verified cause is largely **synonymy — the flora is 1999**:

> `Symphyotrichum oblongifolium` — no match. It **is** treated, as
> `Aster oblongifolius Nutt., ... AROMATIC ASTER`.

Some are genuine absences (`Bouvardia ternifolia`, `Liatris punctata`, `Eupatorium/
Conoclinium greggii` return zero hits under any spelling tried) — consistent with their
being west/south Texas species outside the NCTX flora. But **absence cannot be distinguished
from a name change without reconciliation**, so even the true absences are not trustworthy
evidence today.

Consequences for the implementation epic:

1. **Classify three-valued: `native` / `introduced` / `unknown`.** `unknown` writes a
   BLANK, per the `host-genera.csv` rule. Collapsing `unknown` into `native` is the failure
   that would silently promote non-natives into recommendations.
2. **Name reconciliation is a prerequisite, not a nice-to-have.** USDA PLANTS publishes
   synonyms (field 17 in [01](01-goals-and-required-fields.md)) and is the obvious source.
   Resolve each catalog name to its 1999 basionym/synonym set *before* searching the flora.
3. **Report the unknown count as a coverage metric**, not as a silent gap — this feeds
   nl-41o.6.

---

## 6. Two silent-truncation hazards, both hit, both of the Alnus class

The bead said *assume every layout lies until checked*. Both hazards below produced
**confident wrong answers rather than errors**, and both were caught only by running the
controls.

**(a) A wrapped ALL-CAPS common name is indistinguishable from a genus heading.** Genus
headings look like `PODOPHYLLUM MAY-APPLE, MANDRAKE`, so "stop the treatment at an all-caps
line" is the obvious rule. It is wrong. `Lonicera maackii`'s common names wrap onto a second
line:

```
Lonicera maackii (Rupr.) Maxim., (...), AMUR
HONEYSUCKLE, BUSH HONEYSUCKLE, TREE HONEYSUCKLE, ...
```

The rule fired on line 2, truncated the treatment to four lines, dropped the trailing `I` —
and **a known invasive honeysuckle in the negative control set came back
`native-by-silence`.** Fix: a heading only counts if it follows a blank line. That restored
the negative set to 10/10.

**(b) Genus-synopsis text bleeds past the treatment end.** Without a stop rule at all, the
span ran into the *next* taxon's discussion and its `native to ...` was attributed to the
wrong species — **4 false "introduced" verdicts out of 47 known natives (8.5%)**, including
`Lupinus texensis | native to Europe, the Mediterranean, Ethiopia, and s Africa` (that is
the *genus* Lupinus) and `Engelmannia peristenia | native to the Americas; some contain
alkaloids`. Bounding the span at genus headings and `REFERENCES:` blocks removed all four.

**(c) A binomial-only header regex misses infraspecific taxa.** `Bothriochloa ischaemum var.
songarica` read as `no-treatment`, but it is treated — the header is
`Genus species (Auth.) Keng var. epithet (Auth.) Auth., (`, which a `Genus species Author, (`
pattern cannot match. Any production extractor must handle varieties and subspecies, which
matters because this repo's catalogs are full of them
(`Malvaviscus arboreus var. drummondii`, `Achillea millefolium var. occidentalis`).

The general lesson, and it is the same one the Alnus drop taught: **validate against a
labelled control set with known answers in both directions.** Every one of these three bugs
was invisible in the output and obvious in the controls.

---

## 7. The corpus contradicts catalogs already in this repo

Running both channels over `blackland-prairie-natives.csv` (469 rows, *labelled natives*):

**Four carry the flora's explicit `I`** — i.e. the flora says they originate outside the
continental U.S.:

| Species | Flora |
|---|---|
| `Poa pratensis` | `Native of the Old World (despite the common name)` |
| `Bothriochloa barbinodis` | `Native of c and e Asia` |
| `Digitaria ciliaris` | `presumably introduced from the Old World` (hand-verified) |
| `Prunella vulgaris` | `I` (hand-verified) |

**Seventeen more carry a non-NCTX origin statement to review**, `Chilopsis linearis` among
them — the epic's worked example, found by the pipeline rather than by hand.

And `plants.csv`, the live catalog, has one:

> `Anisacanthus quadrifidus var. wrightii` — *"Used in landscapes and escapes; **adventive
> in Dallas Co. but not well-established** (E. McWilliams, pers. comm.); **native to
> Edwards Plateau**."*

This is the epic's finding #1 confirmed on real data: a plant sold and planted locally as a
Texas native, which the regional flora says is adventive here with its native range
elsewhere. It was in the *positive control set* — the set assumed to be all-native — which
is a useful reminder that the answer key was itself a belief.

**No action on these files yet.** This bead is analysis; correcting catalog rows belongs to
the collection epic, and each correction needs the review pass §4 describes. Filed as
evidence, not as a change.

---

## 8. Correction: the flora does not supply mature width

**MEASURED, and it contradicts a note on this bead.** nl-41o.3's notes say it "is what
un-defers rules 9 and 12 (nl-jsm.7)". That is stale and should not be relied on.

The flora gives height only — `Shrub or small tree to 10 m tall`, `Evergreen shrub to ca.
1.5 m tall`. It is a taxonomic flora, not a horticultural manual; spread is not a character
it treats. Combined with the earlier findings that USDA publishes none of width/spread/crown
across its 81 characteristics, and that NPIN gives height-only prose, the position is:

**No source catalogued by this epic publishes mature width.** It requires a horticultural
book — an in-copyright, purchase-required class of source, none of which is in hand. So
this bead does **not** un-defer nl-jsm.7. That cross-reference is corrected on both beads.

The corpus therefore splits in two:

- **(a) The NCTX flora** — free, verified, text-clean, in hand. Supplies **nativity**
  (§3–4), bloom months (`Late Feb–early Apr`), habitat, soil notes, and height.
- **(b) Horticultural sources for width** — **unresolved, blocked on acquisition and
  licensing.** Not scoped here.

---

## 9. Answers to the bead's questions

| Question | Answer |
|---|---|
| **Corpus** | The NCTX flora, free and legitimately downloadable. Fact extraction only; store values + page citations, never excerpts. Horticultural books for width remain unacquired (§8) |
| **Extraction** | `pdftotext -layout`, no OCR. Three silent-truncation hazards found and fixed; a labelled control set in both directions is mandatory (§6) |
| **Chunking** | **Species-keyed, as the bead assumed — and the species key must be a reconciled name set, not a string** (§5) |
| **Retrieval** | No index needed. Treatments have a regular header; a direct header scan over 65k lines is fast and exact. Embeddings would add failure modes for no gain |
| **Citation** | `Diggs, Lipscomb & O'Kennon 1999, p. N`, page computed exactly from form-feed offsets (§2) |
| **Confidence** | Two tiers, and they differ by *kind*: the `I` symbol is an explicit editorial flag (high confidence, low value); a prose origin statement is a **screen requiring review** before it becomes a value (§4), and **escape/cultivation language is a third screen** without which the silence inference leaks at ~12% (§4.1). `unknown` is a fourth state that stays blank. Feeds nl-41o.5 |

## 10. Open items for other beads

- **nl-41o.4** — the claim model must carry three-valued nativity with an explicit
  `unknown`, a review state for screened prose claims, and a page-level citation shape.
- **nl-41o.5** — arbitration between USDA `L48:N` (continental) and the flora's NCTX-level
  prose. These disagree *by design*; the flora is more specific and should win at NCTX
  scale.
- **nl-41o.6** — reconciliation coverage (the 119) is a first-class metric.
- **nl-41o.7** — NCTX-level nativity is now a real, free, redistributable-as-facts option.
  That materially changes the calculus [02](02-source-inventory.md) left open when BONAP
  was ruled out.
- **nl-jsm.7** — remains deferred. Width has no source (§8).
- **Unfiled, and the largest remaining extraction question** — reading NCTX-nativity out of
  the *distribution sentence* (`mainly se, e, and sc Texas`). It is the residual 11.6% in
  §4.1 and the only route to county-level rather than region-level nativity. Harder than
  everything above; scope it before assuming it.
