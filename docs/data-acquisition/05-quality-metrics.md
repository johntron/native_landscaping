# Data quality: measures, metrics, and the route to `not-declared`

Deliverable for **nl-41o.6**. Analysis only — no metric is computed and no code changes
here.

Same discipline as [01](01-goals-and-required-fields.md)–[04](04-data-model.md): every
number below is defined as a query against the [04](04-data-model.md) claim store, not
implemented. Where a claim in this doc rests on measuring existing app code rather than the
claim store (which doesn't exist yet), it's marked **MEASURED** against the code, same
convention as the earlier docs used against live sources.

---

## 1. Chosen metric set

Six candidates were named on the bead. All six are kept — none is redundant with another,
and the bead's own caution (no composite index) is the reason to keep them separate rather
than collapse them.

| Metric | Definition | Why it earns a place |
|---|---|---|
| **Completeness** | § per-field: `count(species with an asserted claim for field F) / count(species in the plantable set)`. Per-species: `count(required fields with an asserted claim) / count(required fields)` | Two different questions, both real: per-field drives *what to collect next* (nl-41o.7's field axis); per-species drives *can this species be judged at all* (feeds §3's `not-declared` route) |
| **Provenance** | `count(claims with source IS NOT NULL) / count(claims)` — should be **100% by construction**, not by measurement | [04 §3.1](04-data-model.md) makes `source` a required column; a claim without one can't be inserted. This metric exists as a pipeline-bug tripwire, not a data-quality signal — a drop below 100% means the ingest path broke, not that a species is under-documented |
| **Agreement** | For `(species, field)` pairs with 2+ `asserted` claims: `count(claims sharing the majority value) / count(claims)`, reported per field | Surfaces fields worth distrusting generally. [03 §7](03-document-corpus.md) already found one case in the wild — the flora disagrees with `plants.csv`'s own nativity on `Anisacanthus quadrifidus var. wrightii` — so this isn't hypothetical |
| **Freshness** | `now() - retrieved_at`, bucketed, reported per source | A static source (NWF's keystone PDF, [02 §2.6](02-source-inventory.md)) needs this rarely; an API-backed one (USDA) can drift. Distinguishing them is the point — freshness alone doesn't say *how* stale is bad |
| **Adjudication** | `count(species, field) pairs with status = 'review' or unresolved multi-source disagreement`, listed, not just counted | This is nl-41o.5's work queue, produced here as a query so that bead doesn't have to define its own count |
| **Confidence (per-species roll-up)** | Not a score — see §2. A species-level answer to "can this be assessed," derived from completeness on the fields the rules that touch this species actually need | The one place a roll-up is legitimate, argued in §2 |

### 1.1 Why no composite score, and why the confidence roll-up isn't one either

The nl-jsm epic rejected a composite ecology score because the weights would be invented —
the bead for this doc restates that caution and applies it here. A single
"data quality score" would invent the same kind of weight: is a stale-but-present claim
worse than a missing one? Is disagreement on `soil_pref` as bad as disagreement on
`height_ft`? Nobody can answer that without inventing a number, so this doc doesn't.

**Completeness is different in kind, not just simpler**: it's a count, not a weighted sum.
`7 of 12 required fields have a sourced value` needs no judgment call to state. The
per-species "confidence roll-up" in §1's table is completeness applied at species
granularity — still a count (`fields present / fields required`), not a score. It answers a
narrower question than "is this data good" — it answers "is there enough data here to run
the rules that need it" — which is exactly the question §3 routes into the existing
`not-declared` status.

---

## 2. The route to `not-declared` — no fifth status

**MEASURED**, `src/analysis/ecology.js:24-29`: every rule already returns exactly one of
four statuses, closed by design (`STATUSES` is `Object.freeze`d and the panel maps four
chips and nothing else — a fifth value "would render as an unstyled blank rather than fail
loudly," per the code's own comment).

```
OK           — nothing to do
PARTIAL      — works, has a hole
GAP          — the dimension is essentially unmet
NOT_DECLARED — the input this rule needs is absent
```

`NOT_DECLARED` is already the right status for thin data — a rule that has nothing to grade
should say so, exactly the same way `analyzeEcology`'s own catch-block already does when a
rule throws (`ecology.js:76-90`). **No new status is needed or proposed.** The gap isn't in
this enum; it's upstream, and §3 measures exactly where.

### 2.1 What "thin data reaches `not-declared`" requires

A rule reaches `NOT_DECLARED` today by throwing, or by a rule body explicitly checking for
missing input and returning that status (`siteMatch`'s null-on-no-preference path is the
model — see §3). For "this species has no sourced value for width" to *become*
`NOT_DECLARED` on rule 4/10 rather than a fabricated default, two things both have to hold:

1. **The store must distinguish ABSENT from ASSERTED-EMPTY.** [04 §3.3](04-data-model.md)'s
   three-valued `status` (`asserted`/`review`/`unknown`) already does this at the claim
   level — `unknown` is a real, distinct state, not a blank string.
2. **The CSV export must preserve that distinction rather than collapsing it to `''`.**
   [04 §4](04-data-model.md) step 2 already specifies this: only `asserted` claims are
   exported; a `review`/`unknown` field is simply absent from the row. That's the mechanism
   — an absent CSV cell is what the rules must learn to read as "declare not-declared,"
   not as "assume a default."

Both are already decided in [04](04-data-model.md). This bead's job was to check whether
the *consuming* side (the rules) can currently tell the difference — §3 answers that, and
the answer is no, which is why this doc doesn't stop at "the schema is fine."

---

## 3. Can the rules currently tell "no value" from "empty value"? — No, for most fields

**Answered early by nl-41o.1, and re-read directly this session against
`src/data/plantParser.js` (createPlantFromSpecies, normalizeGrowthShape) and
`src/analysis/rules/siteMatch.js`/`birdFood.js`/`keystoneGenera.js`, because it changes what
§2 can promise — every default below confirmed unchanged from nl-41o.1's measurement:**

| Field | Blank becomes | Consequence | Status |
|---|---|---|---|
| `growth_shape` | `'mound'` (`normalizeGrowthShape`) | Rule 11 (`verticalLayers`) buckets a shapeless plant as if it had a real shape | **Fabricated, not `not-declared`** |
| `height_ft` | `1` (`createPlantFromSpecies`) | Rule 11 buckets a heightless plant as groundcover | **Fabricated** |
| `sun_pref` / `water_pref` / `soil_pref` | `''` → `siteMatch` `step()` returns `null` | Rule 8 **skips the plant with no finding, no caution, nothing** — the panel reads exactly like a fully-matched design | **Silently dropped — worse than fabricated, because nothing is reported at all** |
| `fruit_load` | `''` → `?? 1` in `birdFood` | Weighted as sparse, not flagged as unknown | **Fabricated** |
| `flower_color` | `'#d95f5f'` | Rendered as if it were a real color | **Fabricated** |

**Handled correctly today — the pattern to copy:**

| Field | Blank becomes | Why it's right |
|---|---|---|
| Month fields (`growing_season_months`, etc.) | `[]` → rule returns `not-declared` | Empty array is checked explicitly and routed to the real status |
| `width_ft` (rules 4/10) | Excluded from **both sides** of the area ratio, count of drops reported | This is the model: absence is detected, the computation adjusts, and the exclusion is *visible* in the output rather than silent |

**This is not a new finding — it's `nl-c58`, already filed** ("Blank plant fields are
silently replaced with invented values"). This bead doesn't re-file it; it establishes that
`nl-c58` is a **prerequisite of §2's route working at all**, matching [04 §4.1 /
§7](04-data-model.md)'s conclusion from the export side. Two independent beads converging
on the same fix from opposite ends (store → export vs. rules → render) is corroboration,
not duplication — worth noting because it means the fix, once made, is validated from both
directions.

**No fifth status is invented to work around this.** The fix is entirely in the direction
`width_ft` and the month fields already point: make the other five fields detect absence
explicitly and route to the existing `not-declared`/exclusion pattern, the same way those
two already do.

---

## 4. Metrics as queries

Restated as concrete queries against [04 §5](04-data-model.md)'s claim-store indexes, so
nl-41o.7's prioritization work and nl-41o.8's tooling can consume them directly rather than
re-deriving them:

```
-- Completeness, per field (drives collection priority)
SELECT field, COUNT(DISTINCT species_id) AS with_value
FROM claims WHERE status = 'asserted'
GROUP BY field
-- denominator: count(*) FROM taxa WHERE <plantable set, nl-41o.7>

-- Completeness, per species (drives "can this be judged")
-- Same cultivar caveat as the Missing query below: a cultivar's own claims alone
-- under-count it, since it inherits any field it has no override for (04 §2.3).
-- For a cultivar, union in the parent's asserted fields before counting.
SELECT species_id, COUNT(DISTINCT field) AS fields_present
FROM claims WHERE status = 'asserted' AND field IN (<required fields>)
GROUP BY species_id
-- denominator: count(required fields)

-- Missing — the query nl-41o.6 and nl-41o.7 both need and neither can proceed without,
-- per 04 §5.
-- t.resolves_to IS NULL excludes synonym rows (04 §2.2): a synonym's claims are stored
-- against the resolved species, so the synonym row itself has none and would otherwise
-- report every field missing for a species that is actually fully populated.
-- The cultivar case (04 §2.3) needs the parent walk too: a cultivar with no OWN claim for
-- a field inherits the parent's, so it isn't missing. COALESCE checks the cultivar's own
-- claim first, falling back to its parent's, before deciding the field is truly absent.
SELECT t.id, rf.field
FROM taxa t CROSS JOIN (<required fields>) rf
LEFT JOIN claims c_own ON c_own.species_id = t.id AND c_own.field = rf.field AND c_own.status = 'asserted'
LEFT JOIN claims c_parent ON c_parent.species_id = t.parent_id AND c_parent.field = rf.field AND c_parent.status = 'asserted'
WHERE t.resolves_to IS NULL
  AND c_own.id IS NULL
  AND (t.rank != 'cultivar' OR c_parent.id IS NULL)

-- Agreement, per field
SELECT field, value, COUNT(*) FROM claims
WHERE status = 'asserted' AND (species_id, field) IN (
  SELECT species_id, field FROM claims WHERE status='asserted'
  GROUP BY species_id, field HAVING COUNT(DISTINCT source) >= 2
)
GROUP BY field, value

-- Freshness, per source
SELECT source, MIN(retrieved_at), MAX(retrieved_at), AVG(julianday('now') - julianday(retrieved_at))
FROM claims GROUP BY source

-- Adjudication queue
SELECT species_id, field, source, value FROM claims WHERE status = 'review'
ORDER BY species_id, field
```

All six reuse the indexes [04 §5](04-data-model.md) already named (`(species_id, field)`,
`field`, `source`, `status`) — no new index is required for this bead's metrics.

---

## 5. Answers to the bead's acceptance criteria

| Criterion | Answer |
|---|---|
| Chosen metric set, stated reason each, no composite index | §1 — six metrics kept, reasoned individually; §1.1 explains why the per-species roll-up is a count and not a score |
| Defined route from thin data to `not-declared`, no new status | §2 — the four-status enum already covers it; the gap is upstream in whether ABSENT reaches the export as ABSENT, which [04](04-data-model.md) already fixes at the store/export layer |
| Metrics expressed as queries | §4 |
| Check: can rules tell "no value" from "empty value" today | §3 — **no**, for `growth_shape`, `height_ft`, `sun_pref`, `water_pref`, `soil_pref`, `fruit_load`, and `flower_color` (7 fields, one shared code path for the three `*_pref` fields); handled correctly for month fields and `width_ft`. `nl-c58` is the fix, and both `not-declared`-reaching mechanisms (rules and export) depend on it |

---

## 6. Open items for other beads

- **nl-c58** — confirmed here from the consuming side as well as [04](04-data-model.md)'s
  export side. Two independent analyses now converge on it as a hard prerequisite, not an
  optional cleanup.
- **nl-41o.5** — the adjudication query in §4 is offered as its work-queue source; nl-41o.5
  still owns precedence/promotion logic, not the query itself.
- **nl-41o.7** — the "missing" query in §4 is the stopping-condition input that bead's
  design already calls for; the plantable-set definition it still owes is the missing
  denominator in §4's per-field completeness query.
- **nl-41o.8** — all six queries in §4 are candidate Phase 2 tool bodies (`coverage`,
  `conflicts`); this bead deliberately writes them as SQL rather than tool signatures,
  leaving the interface design to nl-41o.8.
