# MCP introspection surface: tool catalog

Deliverable for **nl-41o.8**. Analysis only — no tool in §3 (Phase 2) is built here; §2
(Phase 1) documents tools already built by **nl-41o.9**, which this bead's own design
authorized to go first. Same discipline as [04](04-data-model.md)/[05](05-quality-metrics.md):
each tool states the finding or decision it answers to.

---

## 1. Extend vs. new server — decided

**Extend `tools/usda-plants`; do not add a second server.** This was decided on the epic
2026-08-27 and executed by nl-41o.9 (`usda_probe`, `usda_probe_target_fields` live in
`tools/usda-plants/mcpServer.js`). Restated here because it's this bead's acceptance
criterion, not just nl-41o.9's implementation note:

- The alternative — a second server for introspection tools — creates exactly the
  overlapping-vocabulary risk this bead's own design notes warned against: two servers
  both exposing something named `probe` or `fetch` with different arguments is a worse
  outcome than one server with more tools.
- Everything in §2 and §3 below shares a vocabulary with the four existing collection
  tools (`usda_search_by_location`, `usda_search_by_name`, `usda_fetch_details`,
  `usda_download_plant_list`) — plant ids, species symbols, source names — so splitting
  them into a second process would duplicate that vocabulary rather than reuse it.
- Phase 2 tools query `data/claims.db`, not the USDA API, so "extend usda-plants" means
  the *server process*, not that every tool becomes USDA-specific. Tool names below are
  prefixed by capability (`claims_*`), not forced into the `usda_*` namespace nl-41o.9
  already used for source-specific tools.
- **The server keeps the name `usda-plants` even though half its tools (§3) have nothing
  USDA-specific about them.** Renaming it to something claim-store-neutral was considered
  and rejected: the file is already wired into this session and any client config as
  `usda-plants`, and a rename buys naming purity at the cost of every existing caller's
  config breaking for a server that is, in practice, "the plant-data MCP server" — which
  is what `usda-plants` already reads as to anyone who doesn't parse it literally. If a
  future source (the NCTX flora, NPIN) gets its own probe tool the way `usda_probe` did,
  that's the point at which the name stops fitting and a rename is worth the churn — not
  now, on the strength of Phase 2 alone.

---

## 2. Phase 1 — built by nl-41o.9, cataloged here

| Tool | Read/write | Arguments | Returns |
|---|---|---|---|
| `usda_probe` | read | `plantId: int`, `force?: bool` | Raw USDA profile + characteristics for one plant, unnormalized, plus per-target-field population flags. Cached in `data/probe-cache.db`; `force` bypasses the cache. |
| `usda_probe_target_fields` | read | *(none)* | The current target-field list `usda_probe` sniffs against (key, label, note), so a caller knows what's being checked before reading a batch of probe results. |

**Run state — the third Phase 1 capability named in this bead's original design — is not
built and stays undesigned here.** Checked against the code (`usdaClient.js`,
`fetchDetails.js`): there is no queue, no persisted in-flight/failed/rate-limited state —
`usda_fetch_details` runs synchronously within one tool call and returns its errors inline
when it finishes. A "run state" tool would have nothing to introspect; designing its
shape now would be designing against a hypothetical queue, the same mistake §2.1 of
[04](04-data-model.md) refused to make for hybrids. **Revisit when collection becomes an
actual background/queued process** (a later epic, per nl-41o.9's own scope note that
collection is out of scope for it) — at that point "what's queued, in flight, failed,
rate-limited, what a retry would do" becomes answerable from real state instead of
invented.

---

## 3. Phase 2 — needs the claim store (nl-41o.4, now closed)

The tools below query `data/claims.db` and together cover all six lookups
[04 §5](04-data-model.md) named and all six queries [05 §4](05-quality-metrics.md)
expressed as SQL: `claims_coverage` (by field, missing, completeness), `claims_provenance`
(by species), `claims_conflicts` (by status, agreement), `claims_sources` (by source, by
license grant, freshness), `claims_correct` (corrections), `claims_dry_run` (what a
re-crawl or export would change). None of these existed to build against until nl-41o.4
closed 2026-08-29; they're specified now because the schema is real, but **not
implemented in this bead** — nl-41o.8 is design only, matching nl-41o.9's own restraint
("resist the rest — coverage and provenance need the claim store and building them
against a guess at the model will have to be redone").

### 3.1 `claims_coverage` — read

Wraps [05 §4](05-quality-metrics.md)'s completeness and "missing" queries — one query
serving both the quality report and the work queue, per this bead's original design note.

- **Arguments**: `field?: string` (omit for all fields), `species?: string` (USDA symbol
  or `taxa.id`, omit for all species).
- **Returns**: for each `(species, field)` in scope — `status: "asserted" | "review" |
  "unknown" | "missing"`, `assertedCount`, `sourcesAsserting: string[]`. `"missing"` is
  the [04 §5](04-data-model.md) Missing lookup (no claim at all, any status) — kept
  distinct from `"unknown"` (a claim row exists, source said it couldn't tell) because
  they mean different next actions: `unknown` means the source was checked and had
  nothing; `missing` means no source has been checked yet.
- Cultivar and synonym resolution applied per [04 §2](04-data-model.md) before reporting
  — a cultivar with no own claim reports its parent's status, not `missing`.

### 3.2 `claims_provenance` — read

Answers "what did source X actually say for this field, and why did it win" —
[04 §3.1](04-data-model.md)'s point that a claim without a citation is an assertion, not
a claim.

- **Arguments**: `species: string`, `field: string`.
- **Returns**: every claim row for `(species, field)` — `value`, `status`, `source`,
  `citation`, `retrievedAt`, `confidence`, `supersededBy` — plus `resolved: { value,
  source } | null` and `resolutionReason: string | null`.
- **`resolutionReason` is `null` until nl-41o.5 lands.** The precedence rule that decides
  which of several disagreeing claims wins is nl-41o.5's open design (still unstarted as
  of this bead), not this bead's to invent. The tool's *shape* — one field for the
  resolved value, one for the reason it won — is decided now so nl-41o.5 has a slot to
  fill rather than a new tool to design; the *rule* is not. Until then this tool still
  answers "what does every source say," which is useful on its own for the disagreement
  cases [03 §7](03-document-corpus.md) already found.

### 3.3 `claims_conflicts` — read

The adjudication queue from [05 §4](05-quality-metrics.md), plus multi-source
disagreements not yet flagged `review`.

- **Arguments**: `field?: string` (omit for all).
- **Returns**: list of `{ species, field, claims: [{value, source, status}, ...] }` for
  every `(species, field)` with either `status = 'review'` or 2+ `asserted` claims that
  disagree in value. Two distinct causes bucketed together deliberately — both need a
  human, whether the disagreement is source-vs-source or a screen that fired on one
  source.
- Read-only. The correction path is §3.5, a separate tool — per this bead's own design
  note that a read tool and its write counterpart are different risk classes and
  "surfacing a conflict" must not double as "resolving one."

### 3.4 `claims_sources` — read

Covers the three [04 §5](04-data-model.md)/[05 §4](05-quality-metrics.md) lookups the
other three tools don't: by source, by license grant, and freshness. Grouped into one
tool rather than three because all three answer the same underlying question — "what is
true about source X, and would re-checking it matter" — from one row per source, not
one row per claim.

- **Arguments**: `source?: string` (omit for all sources).
- **Returns**, per source: `claimCount`, `claimCountByField`, `retrievedAtMin`,
  `retrievedAtMax`, `avgAgeDays` ([05 §4](05-quality-metrics.md)'s freshness query),
  and `license: { grant, condition, citationRequired }` ([04 §3.2](04-data-model.md)).
- **Why license lives here and not in `claims_coverage`**: a license grant is a property
  of the source's extraction terms, not of any one claim's field — [04 §3.2](04-data-model.md)
  models it as evaluated at export time against the project's *current* commercial
  status, so the useful question is "which sources have a `condition` that export
  re-evaluates," answerable per-source in one row, not per-claim. This is also the tool
  that answers 04 §5's "what would re-crawling source X touch" — `claimCount`/
  `claimCountByField` for one source is exactly that blast radius, without needing the
  full dry-run machinery of §3.6 below.

### 3.5 `claims_correct` — write

- **Arguments**: `species: string`, `field: string`, `value: string`, `reason: string`
  (**required**), `author: string` (**required**). No optional path around either —
  matching [04 §3.4](04-data-model.md)'s rule that a correction without both is
  indistinguishable from a silent edit.
- **Returns**: the appended correction record, plus the file path it was written to.
- **What it actually writes**: per [04 §3.4](04-data-model.md), a correction's system of
  record is the committed plain-text manual-corrections file, not a `claims.db` row
  directly — `claims.db` is gitignored/rebuildable and has no source to rebuild a
  correction from. So this tool appends to that file (exact path/format is nl-41o.5's
  call, not decided here) and lets the next rebuild replay it into a claim row with
  `source = 'manual-correction'`, `superseded_by` set per the existing supersession
  logic. It does not write `claims.db` directly, so the tool's effect is only visible
  after the next rebuild — stated here so a caller doesn't expect `claims_provenance` to
  reflect a correction immediately after calling this.
- This is the one tool in the whole surface with write side effects. Everything else in
  §2 and §3 is read-only by construction (queries against USDA or `claims.db`, nothing
  persisted outside the probe cache).

### 3.6 `claims_dry_run` — read

Unlike run state (§2), this one *is* designable now: [04 §4](04-data-model.md) already
specifies the export pipeline step by step (resolve precedence → filter to `asserted` →
evaluate license grant → walk cultivar inheritance), and that pipeline is exactly what a
dry run replays without writing `plants.csv`. It doesn't need a collection process to
exist — only the claim store and the export logic, both already specified — so deferring
it the way §2 defers run state would be withholding a design the bead already has the
pieces for, not waiting on a missing substrate.

Two distinct triggers, both real, both answerable from the store alone:

- **Export dry run** — "if I ran the CSV export right now, what would change from the
  committed `plants.csv`?" Runs [04 §4](04-data-model.md)'s four steps against the
  current store and diffs the result against the existing file.
- **Re-crawl dry run, scoped to a source** — "if source X were re-fetched, which claims
  would be added or superseded?" This is `claims_sources`' blast-radius answer (§3.4)
  taken one step further: not just *how many* claims a source contributed, but what a
  fresh extraction would change given the current precedence rule — new claims for
  previously-`missing` fields, and existing claims that would newly lose or win an
  arbitration.

- **Arguments**: `mode: "export" | "recrawl"`, `source?: string` (required when
  `mode = "recrawl"`).
- **Returns**: `{ added: [...], changed: [{species, field, from, to}], newlyExcluded:
  [...] }` — `added` and `changed` in both modes; `newlyExcluded` (a claim that would
  drop out of the export because its license grant no longer covers it, per
  [04 §3.2](04-data-model.md)) only populated in `export` mode, since license
  re-evaluation is an export-time concern, not a re-crawl one.
- **Depends on nl-41o.5's precedence rule** the same way `claims_provenance` (§3.2) does
  — until that rule is decided, `changed`/arbitration outcomes can't be computed, though
  `added` (a field with no current claim at all) doesn't need precedence and is
  answerable today from `claims_coverage`'s "missing" data alone.
- Read-only — a dry run reports what a write *would* do; it never performs one. The write
  path stays `claims_correct` (§3.5) for manual corrections and, later, whatever the
  collection epic's real ingest tool is for sourced claims (out of scope here, same as
  run state).

---

## 4. Read/write separation

Stated as the acceptance criterion asks, not just implied by §3's individual entries:

| Tool | Class |
|---|---|
| `usda_probe`, `usda_probe_target_fields` | read |
| `claims_coverage`, `claims_provenance`, `claims_conflicts`, `claims_sources`, `claims_dry_run` | read |
| `claims_correct` | **write** — the only one |

One write tool total. It requires `reason` and `author` as non-optional arguments (§3.5),
and its write target is a committed, diffable file, not a direct database mutation — so
"what changed and why" is always answerable from `git log` on that file, the same
diff-reviewability property [04 §4](04-data-model.md) already committed the whole store
design to.

---

## 5. Human-facing view, not just a tool

This bead's design notes flagged that some introspection "deserves a human-facing view in
the app, not only an agent tool." Sorting the seven real tools (§2–3, excluding run
state, the one still-undesigned capability):

| Tool | Agent tool only, or also a view? | Why |
|---|---|---|
| `usda_probe` / `usda_probe_target_fields` | Agent tool only | Investigation-phase instrument (nl-41o.9's stated purpose) — used during analysis beads, not by an end user of the app |
| `claims_coverage` | **Also a view** | This is the same shape as a project status page — "7 of 12 required fields sourced for this species" is exactly what nl-41o.6's completeness metric is *for*, and a human deciding what to collect next benefits from scanning it visually more than from calling a tool per species |
| `claims_provenance` | Agent tool only, for now | Useful for debugging a specific disagreement, but a per-field provenance drill-down is a lot of UI for a case that (per [03 §7](03-document-corpus.md)) has been hit exactly once so far. Revisit if `claims_conflicts` volume makes this a frequent human task rather than an occasional one |
| `claims_conflicts` | **Also a view** | This *is* the human review queue nl-41o.5 needs a promotion workflow for — "here are the unadjudicated fields, pick a value" is inherently an interactive task, not a one-shot query. Building it as an agent-only tool would mean a human either uses the agent as a UI or the queue never gets worked |
| `claims_sources` | Agent tool only | A per-source health check is a debugging/planning question ("is USDA stale, does NPIN's grant still cover us"), asked occasionally and best answered on demand rather than kept as a standing screen |
| `claims_dry_run` | Agent tool only | A preview step used right before running an export or a re-crawl — naturally invoked as part of that action rather than browsed on its own |
| `claims_correct` | Agent tool + should back a view's submit action | The write path a `claims_conflicts` view's "resolve this" button calls — same tool, two callers, not two implementations |

Not a new bead by itself — recorded so nl-41o.5 (which owns the human-facing promotion
workflow) and whoever eventually builds the app-side view know which two tools they're
building against.

---

## 6. Answers to the bead's acceptance criteria

| Criterion | Answer |
|---|---|
| A named tool per capability area, with arguments and return shape | §2 (Phase 1, built) and §3 (Phase 2: `claims_coverage`, `claims_provenance`, `claims_conflicts`, `claims_sources`, `claims_correct`, `claims_dry_run` — all six of [04 §5](04-data-model.md)/[05 §4](05-quality-metrics.md)'s lookups covered, per §3's opening); run state explicitly deferred with reasoning rather than guessed |
| Read and write tools clearly separated, corrections requiring reason + author | §4; `claims_correct` (§3.5) is the sole write tool and rejects a correction missing either field |
| A decision on extending the existing usda-plants server vs adding one | §1 — extend, already executed by nl-41o.9; server keeps its name despite non-USDA tools, reasoned explicitly |
| A note on which introspection deserves a human-facing view, not just a tool | §5 — `claims_coverage` and `claims_conflicts` (plus `claims_correct` as the view's write action); the rest stay agent-only for now |

---

## 7. Open items for other beads

- **nl-41o.5** — owns the precedence rule `claims_provenance`'s `resolutionReason` (§3.2)
  and `claims_dry_run`'s `changed` (§3.6) report, and the exact file path/format
  `claims_correct` (§3.5) writes to. All three slots are shaped here, not filled.
- **A future collection/ingest epic** — owns `run_state` (§2), the one capability with no
  real process yet to introspect.
- **App-side work** — `claims_coverage` and `claims_conflicts` (§5) are candidates for a
  human-facing view once nl-41o.5's promotion workflow exists to give the conflicts view
  something to submit.
