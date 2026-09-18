# Known data gaps: what's been fixed, what's open, and what has no source

A running log, not an analysis deliverable. Every entry below is a *concrete* gap that
either was found and fixed in `plants.csv` / `ecology/host-genera.csv`, or is tracked as an
open bead. The point is to keep a pattern-catalog so the same shape of gap gets caught
faster next time, rather than re-discovered species by species.

Each entry states: what the gap looked like, how it was found, and the fix (or, for open
items, the bead tracking it).

---

## 1. Fixed

### 1.1 Blank fields silently fabricated instead of routing to `not-declared` (nl-c58, `504b86d`)

Three ecology rules graded plants on invented defaults rather than saying the input was
missing: `siteMatch` skipped a plant with no declared sun/water/soil, with no finding at
all — a catalog with zero site data read as a perfect match. `birdFood` weighted an
undeclared `fruit_load` as sparse. `verticalLayers` bucketed an undeclared height as a 1 ft
groundcover via the same default `createPlantFromSpecies` uses for rendering (rendering
*needs* a fallback number to draw something; grading must not reuse that number as if it
were real). Fixed by adding `classifyDeclaredLayer`, which returns `null` on genuinely
undeclared shape/height instead of defaulting, and by making `siteMatch`'s summary line —
not just its findings — say so.

**Pattern**: a rendering fallback and a grading fallback are different things, even when
they're computed by the same function. A rule must never grade on a value that exists only
because the renderer needed *something* to draw.

### 1.2 USDA-thin species backfilled from LBJ/NPIN (`1fa2a13`)

USDA had almost nothing for Pitcher's clematis (`Clematis pitcheri`) and angularfruit
milkvine (`Matelea gonocarpos`) — two of the three low-climbers in the catalog. NPIN
(wildflower.org, LBJ Wildflower Center) filled in flowering months, flower color, height,
and sun/water/soil/foliage color for both, fetched by USDA symbol under this project's
LBJ non-commercial-use permission (`docs/data-acquisition/permission-requests.md`).

Two existing values were corrected in the same pass, both because NPIN is this project's
stated primary source for that field (`02-source-inventory.md` §2.3), not because USDA was
"wrong": *Passiflora lutea* `sun_pref` moved from USDA's inferred `shade` (derived from a
Shade Tolerance ordinal) to NPIN's directly-stated `part-sun`; `flowering_season_months`
moved from USDA's coarse "Summer" label to NPIN's literal Mar–Oct range.

**Pattern**: when two sourced values disagree, the fix isn't "trust the newer one" — it's
"trust whichever source this project already named primary for that specific field."
Guessing defeats the point of having a source-priority doc at all.

### 1.3 Three low-climbers missing `width_ft` (this session)

`pitchers-clematis`, `yellow-passionflower`, `angularfruit-milkvine` all had blank
`width_ft`. Confirmed structural, not just unresearched — see §3.1. Filled from targeted
web lookups instead: 2.5 ft (Eco Blossom Nursery's "AT A GLANCE" spec for *Clematis
pitcheri*), 3 ft (midpoint of NC Extension's 2–4 ft for *Passiflora lutea*), and 3 ft
(**estimated**, not sourced — no nursery or extension page publishes a spread for
*Matelea gonocarpos* either; picked as consistent with the other two similarly-sized
vines rather than left blank).

Also added `estimateWidthFt` in `src/data/plantParser.js` — a per-`growth_shape` median
width/height ratio, computed once from the catalog — to replace the flat "default to 1 ft"
every previously-undeclared-width species silently got. This doesn't create new sourced
data; it makes the *rendering* fallback shape-aware instead of uniformly wrong, the same
distinction §1.1 draws between a rendering default and a graded value.

**Pattern**: before treating a blank field as "not yet collected," check whether it's
actually uncollectable from every source this project can use (§3.1) — the fix is
different (targeted manual research, clearly flagged when estimated) from the fix for a
field that's merely behind on collection.

### 1.4 `host-genera.csv` missing a genus present in the catalog (this session)

*Matelea gonocarpos* (angularfruit milkvine) placements weren't counting toward the
larval-hosts rule (rule 5) — not because the rule fabricated a pass (§1.1's bug class),
but because `Matelea` had no row at all in `ecology/host-genera.csv`, so the lookup
correctly, silently found nothing. It isn't on the NWF top-30 keystone list (same reason
`Asclepias` needed its own hand-sourced row rather than riding the keystone columns — see
`larvalHosts.js`'s own comment). NPSOT's profile for the plant's current accepted name,
*Gonolobus suberosus*, states directly: "Larval host: Monarch and Queen butterflies." Added
as a `Matelea` row, plus a `Gonolobus,synonym_of,Matelea` row (matching the existing
`Packera → Senecio` pattern) so the row resolves under either name — the exact synonymy
risk `06-name-reconciliation.md` was written about, just encountered in `host-genera.csv`
instead of the flora corpus.

**Pattern**: a genus absent from a lookup table reads identically to "genuinely
undocumented" and "nobody's added it yet." Every genus newly added to `plants.csv` needs
its genus checked against `host-genera.csv`, not just its own species-level fields —
`ecology/host-genera.csv` is a second catalog with its own completeness gap, separate from
`plants.csv`'s.

### 1.5 First oak batch promoted from `blackland-prairie-natives.csv` (nl-41o.13, this session)

Closes the gap nl-41o.13 named: `index.html`'s PLANTS mnemonic tells a homeowner oaks
qualify (via `keystoneScreen.js` reading `blackland-prairie-natives.csv`), but
`design.html`'s placement tool only ever loaded `plants.csv`, which had zero `Quercus`.
Promoted the 5 of the catalog's 15 oaks with `npsot_dfw_recommended = yes` (a sourced NPSOT
DFW-chapter column already on the row, used as the selection criterion instead of a
judgment call about range) — bur oak, blackjack oak, Shumard's oak, post oak, live oak.
Not promoted: the other 10, including `Quercus muehlenbergii`, which is one of
nl-41o.12's 17 still-unreviewed prose-origin hits — a real example of that open review
gating a promotion, caught by checking the list before writing rows rather than after.

The 22 base columns copied straight across unchanged, blanks included — `width_ft` was
blank for all 15 oaks in the source (consistent with §3.1: no general source exists), and
per nl-41o.13's own instruction this was left blank rather than defaulted or estimated.
`Quercus` already had a row in `ecology/host-genera.csv` (253 lep-host species), so no
§1.4-shaped gap here.

**Found while verifying, not while sourcing — a rendering/data-semantics mismatch, left
open rather than papered over:** `height_ft` was copied from `usda_height_mature_ft`
(a real, sourced USDA field) as-is — 100 ft for bur oak and Shumard's oak. Placing bur oak
in the 30x22 ft `backyard` project produces a ~70-100 ft estimated canopy (via
`estimateWidthFt`'s `vase` ratio, computed from small perennials, applied here to a tree)
that swallows the entire yard. This is not a rendering bug — verified in the browser that
the computed radius is real, not `NaN` or mis-scaled — and arguably it's the *correct*
answer: a full-grown bur oak's potential canopy genuinely does not fit a small residential
lot. But it is a semantic mismatch against the rest of the catalog, whose existing tree
rows (`yaupon-holly` 18 ft, `oklahoma-redbud` 20 ft) record realistic landscape/cultivated
mature size, not USDA's wild/record potential. Left as the sourced USDA value rather than
replaced with an unsourced "typical" estimate — per the epic's discipline, an honest
oversized number beats an invented plausible one — but this discrepancy needs a decision
(does `height_ft` mean "potential" or "expected in cultivation"?) before the full 469-row
promotion, not just for oaks. Not filed as a new bead: it's exactly the kind of prioritization
question nl-41o.7 exists to answer.

Verified end-to-end: `npm test` catches the fixed intent directly (see
`tests/ecology.test.js`'s "both shipped projects analyse without throwing" — updated in the
same change, since it previously asserted, as fact, that the catalog *could not* supply
Quercus). In the browser, all 5 oaks appear in `design.html`'s ADD PLANT list, place without
error, and `keystoneGenera.js`'s suggestion engine now recommends them by name where it
previously couldn't.

**Pattern**: promoting a genus the ecology rules already know about (via `host-genera.csv`)
surfaces correctly in the rules engine the moment the species exists in `plants.csv` — no
rule code needed to change. The work is entirely in the data: picking a sourced subset
(not judgment), copying blanks as blanks, and catching cross-references to still-open
review beads (nl-41o.12) before publishing a row they'd invalidate.

---

## 2. Open (tracked as beads — not duplicated here, just indexed)

| Bead | Gap |
|---|---|
| nl-9a6 | `plants.csv` still records one preferred soil per species; USDA's soil triple is 100%-filled in the regional CSVs and already collapses to the tolerance set rule 8 wants — only the live 47-row catalog is behind. |
| nl-yud | `mapCharacteristics.js` reads 26 of 81 USDA characteristics; commercial availability, fruit/seed persistence, toxicity, lifespan, and spread rate are fetched and discarded. |
| nl-clm | AGENTS.md still describes `soil_pref` as a single value; the code (and regional CSVs) have treated it as a comma-separated set for a while. |
| nl-5c8 | Two `plants.csv` values fall outside the vocabulary the code accepts (`fruit_load: 'low'`, `soil_pref: 'clay-loam'`) — both silently drop to `''`/no-match rather than erroring, so they grade as absent instead of as unrecognized. |
| nl-41o.11 | 22 catalog rows (21 in `blackland-prairie-natives.csv`, 1 in `plants.csv`) contradict the NCTX flora's nativity verdict — measured, not yet corrected. |
| nl-41o.5 | No conflict-resolution/manual-correction mechanism yet — a re-run of any future crawl would silently erase a hand-researched correction like §1.2 or §1.3 above. |
| nl-41o.7 | No stated prioritization for which species/fields get collected next. |
| nl-jsm.7 | Rules 9 (drift/clumping) and 12 (mature-size spacing) are deferred; 12 specifically needs `width_ft`, which §3.1 says has no general source. |

Run `bd show <id>` for full detail on any of these.

---

## 3. Structural gaps — more collection will not fix these

### 3.1 `width_ft` has no general source

Confirmed absent, not just uncollected, across every source this project can use:
USDA's full 81-characteristic set, NPIN's full field set (`87db298`), and the NCTX flora
(`fa98521` — the flora was hypothesized as the width source and turned out not to carry
it). The only route that has worked so far is per-species manual lookup against nursery or
extension pages (§1.3), which do not exist for every species and are sometimes themselves
silent (angularfruit milkvine's estimate). `estimateWidthFt`'s per-shape ratio table
(§1.3) is a rendering fallback, not a substitute for a real value — it should never be
read as "this species' width is known."

### 3.2 County-level nativity has no redistributable source

BONAP's terms require advance written permission for reuse of "distribution maps,
biological attribute information, images" — exactly what a nativity column is — and this
repo commits its data files publicly, so BONAP can *inform* a value but can't back one
that ships in the repo (`87db298`). The NCTX flora fills this instead (`950f775`), but
only via a prose-convention inference ("no explicit origin statement ⇒ native") that leaks
at roughly 12.6% against species that are US-native but not NCTX-native cultivated
escapes, and needs a review pass rather than blind trust (`fa98521`).

### 3.3 Synonymy is a standing risk for every book/prose-sourced field

119 of 469 catalog rows matched no NCTX flora treatment on a straight name join — the
cause was 1999-vintage nomenclature (*Symphyotrichum oblongifolium* is treated as *Aster
oblongifolius*), not absent data (`fa98521`, resolved by `06-name-reconciliation.md`).
§1.4's `Matelea`/`Gonolobus` fix is the same failure mode surfacing in a hand-maintained
CSV rather than the flora corpus — any lookup table keyed on a genus or species name that
predates a taxonomic revision is exposed to this, not just the flora-matching pipeline.
