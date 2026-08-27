# Source inventory: access, coverage, and licensing

Deliverable for **nl-41o.2**. Analysis only — nothing here collects or writes plant data.

Same discipline as [01](01-goals-and-required-fields.md): every claim is **MEASURED**
(probed this session) or **BELIEF** (from documentation, unverified). Field numbers refer
to the required-fields table in §2 of that document.

Date of measurements: 2026-08-27.

---

## 1. The headline: county nativity has no redistributable source

BONAP was the only identified candidate for field 14 (county nativity), which the epic
calls its highest-leverage item. **MEASURED — its terms forbid what this repo would need
to do.** From <http://www.bonap.org/citation.html>, verbatim:

> **Notice** — All materials on this website are copyrighted and belong to the Biota of
> North America Program (BONAP). Reproduction or use of any material found on this site
> (e.g., distribution maps, **biological attribute information**, images, etc.) requires
> advance written permission from the Biota of North America Program.

The parenthetical is decisive. It is not limited to maps or images — "biological attribute
information" is exactly the class of thing a nativity column is. This repo commits its data
files, so BONAP **can inform a value but cannot be one**, which is the distinction
nl-41o.2 was written to settle.

**This is a plan-shaping finding, not an obstacle to route around.** No amount of
engineering produces a redistributable county-nativity column from BONAP. The options are:
seek written permission (a real option, and free to ask); find another source; or define
the plantable set without it. **That choice belongs to nl-41o.7**, which now has the
constraint stated rather than assumed.

Access note, separately: bonap.org and bonap.net are **HTTP-only** — an HTTPS request is
refused outright. Any tool that silently upgrades to HTTPS reports the site as down rather
than as restricted, which is a misleading failure mode worth knowing about.

---

## 2. Source rows

### 2.1 USDA PLANTS — **PRIMARY**

| | |
|---|---|
| **Fields covered** | County presence (13); 81 characteristics incl. sun (9), water (10), soil + breadth (11, 12), height (5), bloom/fruit timing (2, 3), fruit load (4), commercial availability (18), plus toxicity, lifespan, spread rates, fruit persistence; synonyms (17); vertebrate forage |
| **Granularity** | **County** for distribution; species for everything else |
| **Access** | Unauthenticated JSON API at `plantsservices.sc.egov.usda.gov/api`. No key. 42 documented paths (Swagger at `/swagger/v1/swagger.json`) |
| **Rate limits** | None published. This repo self-imposes 1 req/s in `usdaClient.js` — keep it |
| **Terms** | **US Government work → public domain.** Redistributable without restriction. The cleanest licensing position of any source here |
| **Identifiers** | Numeric `Id` (e.g. 70468) and USDA symbol (`QUSH`). Symbol is the stable public key; numeric Id is what most endpoints take |
| **Update cadence** | Unknown — BELIEF. No version or last-modified field observed |
| **Role** | **Primary for everything it covers** |

Known faults, all MEASURED and all previously documented in this repo:

- `POST /api/plants-search-results` returns a server-side SQL timeout for every payload
  shape tried. Its siblings `/api/characteristicSearchResults` and
  `/…ResultsDownload` are a **different** bulk path and remain unprobed — a cheap,
  high-upside target for nl-41o.9.
- `Shade Tolerance` values run **opposite** to USDA's own Swagger enum (verified 14/15 vs
  0/15 in `mapCharacteristics.js`). This caused commit `ed9d75c`. Any light field from any
  source must be checked the same way.
- `/api/PlantPollinator/{id}` exists and returns `[]` for every species tried, including
  both milkweeds — see [01 §3.6](01-goals-and-required-fields.md).

### 2.2 BONAP — **REJECTED as a value source; usable only to inform**

| | |
|---|---|
| **Fields covered** | County nativity (14) — native vs adventive, the one thing USDA cannot do |
| **Granularity** | County |
| **Access** | **HTTP only** (HTTPS refused). Maps are images; no API or bulk download found |
| **Terms** | **Advance written permission required for any reproduction or use**, explicitly including "biological attribute information" — quoted in §1 |
| **Identifiers** | Kartesz taxonomy, which is not USDA's. A name-resolution problem on top of the licensing one |
| **Update cadence** | Floristic Synthesis v1.0, 2015; site footer 2014 — BELIEF, and it suggests the data is not actively revised |
| **Role** | **Neither primary nor corroborating.** May be consulted by a human to inform a judgement; may not be stored, redistributed, or cited as the source of a committed value |

Worth doing regardless of this bead: **ask BONAP for written permission.** It costs an
email, the project is non-commercial, and a yes would unblock the epic's headline field
outright. Nothing else here has that risk/reward shape.

### 2.3 LBJ Wildflower Center (NPIN) — **PRIMARY for horticultural and regional fields**

Substantially more valuable than the epic credited it, and it **reverses three verdicts**
from [01](01-goals-and-required-fields.md) — see §3 below.

| | |
|---|---|
| **Fields covered** | Bloom time **by month** (2); **light requirement as a SET** (12-light); water use (10); soil description + soil moisture set (11); commercial availability (18); **deer resistance**; **species-level larval host**; nectar source; "attracts"; propagation; CaCO₃/cold/heat tolerance; height. **No width** |
| **Granularity** | Species, with a Texas/regional editorial slant |
| **Access** | HTML species pages at `wildflower.org/plants/result.php?id_plant=<USDA symbol>`. No API. **MEASURED: reachable by plain `curl` with a browser User-Agent — CHLI2, QUSH and ILVO all returned HTTP 200 with full content** |
| **Rate limits** | Unknown. Unread `robots.txt` means no declared crawl-delay is available |
| **Terms** | **UNREAD — and that is the finding.** `/robots.txt`, `/terms`, `/copyright`, `/privacy` and `/collections/` all return a Cloudflare challenge or 403, while species pages serve normally. The terms could not be read without working around the protection, which was **not attempted** |
| **Identifiers** | **USDA symbol**, directly in the URL — the strongest evidence for the join key (§4) |
| **Update cadence** | Unknown — BELIEF |
| **Role** | **Primary** for month-precision timing, light breadth, deer resistance and larval hosts; **corroborating** for soil and water |

**The access verdict is deliberately narrow.** Species pages are reachable at low volume;
that is measured on three pages, not a coverage guarantee, and it says nothing about
whether bulk retrieval is permitted — because the document that would say so is
unreachable. **Treat NPIN as usable, rate-unknown, terms-unread.** Resolving the terms is
a nl-41o.9 task, and the honest route is to email the Center rather than to probe harder.

### 2.4 iNaturalist — **CORROBORATING ONLY, and weaker than it first appears**

| | |
|---|---|
| **Fields covered** | Local occurrence; a cultivated/wild flag per observation |
| **Granularity** | Observation-level, aggregable to county (Dallas County TX = `place_id` 1281) |
| **Access** | `api.inaturalist.org/v1`. No key for reads. MEASURED working |
| **Terms** | Observations default to **CC BY-NC**; some CC0/CC BY. Occurrence *facts* are arguably not copyrightable at all. This project would redistribute a **derived aggregate count**, not observations — a cleaner position than redistributing records, but one to state explicitly in the provenance |
| **Identifiers** | iNat taxon ids (76290, 128755 …) — **a third namespace**, mapping to neither USDA symbols nor Kartesz names |
| **Update cadence** | Continuous |
| **Role** | **Corroborating only. Not admissible as a nativity determination — see below** |

**`establishment_means` does not work for this purpose. MEASURED:** requesting
`/v1/taxa/{id}?place_id=1281` does **not** filter, and the returned `listed_taxa` are
sparse and idiosyncratic (Israel; Carson City; a regional park in Williamson County). **No
Dallas County listing exists for any of the four species tried.** These are crowd-curated
per-place checklists that exist only where someone made one.

**The cultivated:wild ratio looked promising and then failed its own test.** Counting
research-grade wild observations against captive ones in Dallas County:

| Species | Wild (research) | Captive | Ratio | |
|---|---|---|---|---|
| *Lagerstroemia indica* (crape myrtle) | 2 | 594 | **297.0** | planted-only exotic — the high end |
| *Chilopsis linearis* (desert willow) | 52 | 147 | **2.83** | the species the epic wants excluded |
| *Quercus shumardii* | 240 | 59 | 0.25 | |
| *Prunus mexicana* (Mexican plum) | 332 | 49 | 0.15 | |
| ***Nandina domestica*** | **1033** | **111** | **0.11** | **invasive exotic — on this repo's own avoid list** |
| *Packera obovata* | 282 | 16 | 0.06 | |
| *Solanum elaeagnifolium* | 488 | 1 | 0.00 | weedy native — the low end |
| *Ambrosia trifida* | 1989 | 0 | 0.00 | weedy native — the low end |

The first four species were chosen knowing the answer; the last four were added to bracket
the range from cases not picked for effect. That is what exposed the flaw.

**The ratio measures NATURALIZATION, not NATIVITY.** *Nandina domestica* scores **0.11** —
better than Shumard oak, better than Mexican plum — because it genuinely escapes and
reproduces across DFW. It is carried in this repo's `dfw-avoid-non-natives.csv` as
`sacred-bamboo`, one of the region's worst invasive shrubs. **A nativity filter built on
this ratio would admit it and exclude nothing that matters.**

The signal is real but answers a different question: *"does this reproduce here on its
own, or is it only ever planted?"* That is genuinely useful — it is a strong separator at
the extremes (297 vs 0.00) — but it is not nativity, and **no threshold on it can be made
into nativity.** Choosing such a cutoff would be exactly the invented weight this project
rejected for the composite ecology score and for FQA.

**No threshold is proposed here.** Whether the signal is admissible at all is nl-41o.7's
call when it defines the plantable set. Two further cautions for that decision:
low-observation species will be noise, and the captive flag depends on observers setting
it correctly, which is inconsistent.

### 2.5 GBIF — **CORROBORATING; valuable for licensing metadata**

| | |
|---|---|
| **Fields covered** | Occurrence records aggregated across datasets, incl. the iNat research-grade feed |
| **Granularity** | Occurrence-level; county via GADM identifiers (unprobed) |
| **Access** | `api.gbif.org/v1`, no key. MEASURED: *Chilopsis linearis* returns 2,267 Texas occurrences |
| **Terms** | **A machine-readable `license` field per record and per dataset** — the iNat research-grade dataset returns `http://creativecommons.org/licenses/by-nc/4.0/legalcode` |
| **Identifiers** | GBIF `usageKey` — **a fourth namespace**, with a `/species/match` endpoint that resolves names to it |
| **Role** | **Corroborating.** Its real value is structural, not floristic |

That per-record `license` field is worth more to this project than the occurrence data.
**nl-41o.4 should model licence as a first-class property of a claim**, because at least
one real source already emits it, and the BONAP result in §1 proves the store must be able
to answer "may this value be published?" per value rather than per source.

`establishmentMeans` was `undefined` on the record sampled, so GBIF is not a shortcut to
field 14 either. County filtering via GADM is unprobed — a nl-41o.9 target.

### 2.6 NWF Keystone lists — **PRIMARY for keystone counts, already in use**

| | |
|---|---|
| **Fields covered** | `lep_host_species`, `bee_specialist_species` (15) |
| **Granularity** | **Genus × ecoregion.** Not species, and [01 §3.6](01-goals-and-required-fields.md) measured that no source improves on this |
| **Access** | A single PDF. MEASURED still reachable: HTTP 200, `application/pdf`, 371,750 bytes |
| **Terms** | Not assessed — BELIEF. Already transcribed into `ecology/host-genera.csv` with per-row sources |
| **Identifiers** | Genus name |
| **Update cadence** | Static; a versioned publication |
| **Role** | **Primary**, unchanged |

Extraction hazard, already documented in AGENTS.md and worth restating: the two-column
layout drops `Alnus` from a line-wise read, and wrapped rows put the count on the following
line. Any re-extraction must be checked against a species known to belong.

### 2.7 NPSOT — **CORROBORATING; the cleanest access permission here**

| | |
|---|---|
| **Fields covered** | Regional recommendation lists. `npsot_dfw_recommended` is already a column, 100% populated, 57 yes / 412 no |
| **Granularity** | Ecoregion / DFW area |
| **Access** | WordPress site plus ecoregion PDFs. **MEASURED: `robots.txt` returns 200 and explicitly permits plant profiles with `Crawl-delay: 10`**, disallowing only admin, search and event paths |
| **Terms** | Site terms not read; the robots policy is an explicit, machine-readable crawl permission with a stated rate — the only source here that provides one |
| **Identifiers** | Botanical names in prose/PDF |
| **Role** | **Corroborating** — a curated "worth planting here" signal, not a floristic authority |

Extraction hazard, already paid for once: the NPSOT ecoregion PDF packs two species per row
behind `1.`/`2.` prefixes, and a column-anchored regex silently drops the second — that
alone cost Shumard oak, live oak, eastern redcedar and four more.

### 2.8 Texas A&M AgriLife — **NOT ASSESSED**

Named as a candidate in the bead; **not probed this session.** Recorded as unassessed
rather than guessed at. Plausible for regional horticultural guidance and commercial
availability, both of which NPIN already covers — so it is a low-priority follow-up, not a
gap. A row here would be invention, which is the thing this epic exists to avoid.

---

## 3. Corrections owed to document 01

Three verdicts in [01](01-goals-and-required-fields.md) were scoped to USDA and stated too
broadly. NPIN falsifies them. The USDA measurements themselves are unchanged.

| 01 said | Corrected |
|---|---|
| §3.3 / §3.8: light tolerance breadth "does not exist at any source", so R8's light check "stays a point check forever" | **Wrong as stated.** USDA has no light range — that stands. But NPIN publishes a light **set**: *Ilex vomitoria* returns `Sun, Part Shade, Shade`; *Chilopsis linearis* returns `Sun`. R8's light row becomes **fixable if NPIN is reachable at volume** — an access question, not a source gap |
| §3.6: species-level insect association data does not exist | **Too broad.** No *API* publishes it — `/api/PlantPollinator` is empty, measured. But NPIN curates it per species as text: *Ilex vomitoria* → "Larval Host: Henrys Elfin butterfly"; *Chilopsis linearis* → "White-winged moth". Unstructured and of unknown coverage, but it exists, and it is the same kind of curated claim `host-genera.csv` already carries |
| §4: deer resistance ruled OUT — "no authoritative source; every list is anecdotal" | **Reversed.** NPIN publishes `Deer Resistant: Moderate` as a structured field. Whether it belongs in scope is now a value judgement rather than a sourcing impossibility — reopened for nl-41o.7 |

**What does not change:** mature width (field 7) is absent from NPIN too. *Ilex vomitoria*
gives "Size Notes: 12-45 feet" and *Chilopsis linearis* "Up to about 40 feet tall" — height
only, in prose. Across USDA's 81 characteristics and NPIN's full field set, **no source
catalogued here publishes mature width.** That confirms [01 §3.4](01-goals-and-required-fields.md)
and leaves nl-41o.3's book corpus as the sole route, which is what un-defers rules 9 and 12.

Corrections are applied to document 01 in the same commit as this file.

---

## 4. Join key recommendation

**Recommendation: the USDA symbol** (`QUSH`, `PRME`, `CHLI2`), with the numeric USDA `Id`
carried alongside as the API access key.

Argued from three independent sources rather than asserted:

1. **NPIN keys on it directly in its URL** — `result.php?id_plant=PRME`. The second-most
   valuable source joins to the first for free, with no name matching at all.
2. **The draft CSVs already carry it at 100%** — `usda_symbol` is populated for all 469
   rows of `blackland-prairie-natives.csv` and all 61 of `dfw-nctx-natives.csv`. MEASURED.
3. **It is stable and public**, unlike the numeric `Id`, and USDA is the one source whose
   licensing is unrestricted — so the join key is not encumbered by anyone's terms.

**Four namespaces are in play** and the plan should name them: USDA symbols, Kartesz names
(BONAP), iNat taxon ids, GBIF `usageKey`. GBIF's `/species/match` resolves names into its
own key and is the only automated cross-walk measured working; everything else is name
matching, with the failure modes `regionFilter.js` already documents (a bare binomial drags
in every infraspecific record, and the extras skew western).

**What the symbol cannot address — cultivars.** The catalog carries
`Ilex vomitoria 'Nana'` and `Muhlenbergia reverchonii 'Undaunted'`. No botanical database
indexes cultivars: USDA, NPIN, BONAP and GBIF all key on the species. A cultivar can join
to its *species* record and inherit species-level facts, but the traits that make a
cultivar worth choosing — 'Nana' is a 3 ft dwarf where the species reaches 45 ft — are
exactly the ones that do **not** inherit, and height feeds rule 11 directly.

So the data model needs a species/cultivar distinction where a cultivar is a first-class
row that **inherits by default and overrides explicitly**, with overridden values carrying
their own provenance. That belongs to **nl-41o.4**; this bead's contribution is that the
constraint is now measured across all four sources rather than suspected.

Related and already solved: the *synonym* half of identity has an authoritative source —
`/api/PlantSynonyms/{id}` returns *Senecio obovatus* for *Packera obovata*, the exact
mapping `host-genera.csv` carries by hand. See [01 §3.6c](01-goals-and-required-fields.md).

---

## 5. Required fields NO catalogued source covers

After eight sources, exactly two required fields remain unsourced, and they fail for
different reasons:

| Field | Why unsourced | Route |
|---|---|---|
| **Mature width** (7) | Genuinely unpublished. Absent from USDA's 81 characteristics and from NPIN's field set. Not a licensing problem — the data does not exist in machine-readable form | **nl-41o.3** book corpus. This is what un-defers rules 9 and 12 |
| **County nativity** (14) | **A licensing problem, not a data problem.** BONAP has it and forbids reuse; USDA has presence without nativity; iNaturalist measures naturalization, which admits *Nandina* | Ask BONAP for permission; or define the plantable set without it (**nl-41o.7**) |

Everything else in [01 §3.7](01-goals-and-required-fields.md) has at least one source with
acceptable terms. **That is a better position than the epic assumed** — it opened expecting
county-level data to be the central obstacle, and the obstacle turned out to be narrower
and differently shaped: one field blocked by copyright, one by the absence of any
publication at all.

---

## 6. Open items for nl-41o.9

1. **`/api/characteristicSearchResults` and `/…Download`** — a different bulk path from the
   one known to time out. If either works it replaces per-species fetching wholesale.
   Cheapest high-upside probe available.
2. **NPIN at volume** — does per-species retrieval hold beyond three pages, and at what
   rate? Pair with an email to the Center, since the terms page is unreachable.
3. **GBIF county filtering via GADM** — would give a licence-tagged second opinion on
   county presence.
4. **`/api/PlantWildlife` fill rate** — carried over from [01 §6](01-goals-and-required-fields.md).
5. **NPIN larval-host coverage** — §3 found the field on two of two species examined. If it
   is broadly populated it is a meaningful addition to rule 5, which today depends entirely
   on hand-curated rows.
