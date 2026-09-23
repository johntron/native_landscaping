# Native Landscaping: Agent Guide

This is the one canonical guide for any agent (Claude, Codex, or other) working in
this repository. It is a map. The deep dives it links to hold the detail; read the
one for the area you are changing.

## Mission

> **Build power tools that help homeowners, landscapers, and the people who advise
> them plant wisely: choosing, placing, and caring for plants so each yard fits its
> site and supports the wildlife and habitat around it.**

What that commits every tool to:

- **Wiser decisions, not more information.** A tool earns its place when it changes
  what someone plants, where they plant it, or how they look after it: a species to
  choose, an invasive to skip, leaves left on the ground, a rights packet an HOA will
  accept. Showing information that leads to no decision is not the goal.
- **Grounded in what is observed and cited.** Local flora, nearby iNaturalist
  records, and published sources come before models and scores. A claim the evidence
  cannot carry does not ship, and our own judgement calls are labelled as ours.
- **Integrate with the landscape around the yard.** A yard is one patch in a larger
  network of neighbouring yards, creeks, parks and remnant prairie. The tools show
  what is already nearby and what the yard is missing, without inventing a
  connectivity score.
- **Local first.** Start with the Blackland Prairie / North Central Texas and get it
  right before going wider.

---

## The tools

Every page is a static HTML file at the repo root with one entry module under `src/`.
No bundler, no build step.

| page | entry | what it is for |
| --- | --- | --- |
| `index.html` | `src/patchnetwork/` | **Rewilder**, the landing page. The homeowner-facing argument, led by the PLANTS memory aid, with the keystone-genus screen ("What belongs here") and the invasives list. Needs no project; its handoff section opens a yard in `design.html`. |
| `design.html` | `src/app.js` | The **yard design tool**: a planting drawn month by month in a plan and compass elevations, graded by the ecological rules engine. Scoped by `?project=<slug>`. See [docs/design-tool.md](docs/design-tool.md). |
| `ecosystem.html` | `src/ecosystem/` | The **nearby ecosystem**: plants and animals reported on iNaturalist near a site, and the plant genera that would serve them. Also available as a drawer (`src/ui/ecosystemDrawer.js`) on any page with `?project=`; both compute matches through `src/ecosystem/plantMatches.view.js`. |
| `feed.html` | `src/feed/` | The **observation feed**: new iNaturalist records in saved monitoring areas, flagged for invasives, rarity, and yard relevance. |
| `fnct.html` | `src/fnct/` | The **flora index**: searchable species from the *Flora of North Central Texas*. |
| `rights.html` | (static) | **Your rights**: Texas statutes on what an HOA can and cannot forbid. Statutory information, not legal advice. |
| `claims-coverage.html`, `claims-conflicts.html` | `src/claims/` | Maintainer views over the plant-data claim store: field coverage, and conflicts awaiting a human correction. |

The **HOA submission packet** export (`src/export/hoaPacket.js`) is produced from `design.html`.

## Repo map

```
plants.csv            the species catalog every yard renders from (the single source of truth)
catalog/              wider regional lists + manual-corrections.tsv; see catalog/README.md
ecology/              sourced, genus- or place-keyed tables for the rules engine
projects/<slug>/      one yard each; listed in projects/index.json
src/                  browser code: one folder per page, plus shared analysis/, data/, render/, ui/
tools/                everything that calls a third-party API, the claim store, the usda-plants MCP server
server.js             static server + the /api persistence routes
data/                 local SQLite (gitignored); see "Data safety" below
docs/                 deep dives; docs/data-acquisition/ is the claim-store design (01-11)
tests/, tests-e2e/    Node unit tests (the gate) and Playwright specs
```

---

## Rules that hold everywhere

### Evidence

- **Don't invent plant data.** Use real botanical names. Every row in a sourced table
  carries a `source`, and a value nobody has sourced stays **blank rather than
  guessed**. "Absent" is reported as undeclared, never filled with a default.
- **No composite scores.** The rules engine reports per dimension with no roll-up,
  because the weights would be invented. **Never emit a connectivity score, gradient,
  or weighted lines** either: anchor location and distance are facts, while "how
  connected you are" is a model. Show distance and name what lies between (a road, a
  highway, continuous turf).
- **Retired, do not resurrect:** the parcel/hex habitat-scoring map (nl-3hi has the
  reasoning), and Floristic Quality Assessment as a design grader
  ([docs/ecology-rules.md](docs/ecology-rules.md#why-fqa-was-rejected)).
- **Label judgement calls.** An authored threshold (e.g. `RANGE_THRESHOLD_MI`,
  `AMPLE_SHARE`) is marked as a judgement, not presented as a sourced fact. The PLANTS
  mnemonic is our packaging of the literature, not a published framework; cite each
  letter on its own.
- **Verify every legal claim against the statute itself**
  (statutes.capitol.texas.gov, and capitol.texas.gov for bill history) before it
  reaches a page. An AI research critique once cited two 2025 bills as law; both had
  died in committee (details in nl-3hi.8).

### Privacy and licensing (this repo is public)

- Exact addresses and coordinates never reach git. A project's `place` is a short
  label; the address behind it is in the gitignored `projects/<slug>/location.json`.
- The NCTX flora PDFs may be downloaded but not redistributed. They stay local
  (`docs/data-acquisition/corpus/*.pdf` is gitignored); the extracted text is what
  code reads.
- NPIN (Lady Bird Johnson Wildflower Center) data is cleared for **non-commercial use
  with citation only**. Going commercial would mean re-clearing or removing
  NPIN-derived fields (`docs/data-acquisition/permission-requests.md`).
- Only iNaturalist photos with a `license_code` may be displayed; `null` means all
  rights reserved.

### Code

- **Plain HTML, CSS, and ES modules.** No bundler, no build step, no heavy framework
  without an explicit ask. JSDoc for parameter shapes.
- **Browser code never calls a third-party API.** iNaturalist, GloBI, USDA, NHD,
  OSM, and geocoding calls live in `tools/`. They are cached, and their results
  land in committed CSVs or local SQLite that the server reads.
- **`src/analysis/` is pure.** No DOM, no fetch. Every threshold and verdict lives in a
  rule module; renderers display what they are handed.
- **Data-driven, not hard-coded.** Species attributes come from `plants.csv`, extended
  through `src/data/plantParser.js`. Every plant object is built by
  `createPlantFromSpecies`, and every new plant id is minted through
  `src/state/plantIds.js`.
- **Colour lives in the token block at the top of `styles.css`.** The rule it encodes:
  amber means life and only data glows; cyan is the apparatus that measures it; chrome
  never glows.
- Reference apparatus (column definitions, page cites, sources) sits behind
  click-to-open disclosures (`src/ui/disclosure.js`). Caveats stay visible.

### Data safety

`data/*.db` files are gitignored. Most are rebuildable caches (`ecosystem.db`,
`probe-cache.db`, `observation-events.db`, `claims.db`): re-run the matching `tools/`
script. **Two hold state a person entered by hand and cannot be rebuilt:**

- `saved-areas.db`: monitoring areas, entered through `/api/saved-areas`. A redacted
  snapshot is exported to the tracked `data/saved-areas.export.json` on every write.
- `feed-state.db`: the feed's per-observation read/dismissed flags. It is deliberately
  kept apart from `observation-events.db` so that it survives a rebuild of that file.

A PreToolUse hook in `.claude/settings.json` blocks any `rm` whose command
mentions `data/`: inspect the file and ask before deleting anything there.

---

## Workflow

### After every change: test, commit, restart

Standing instruction and standing authorization from the repo owner. Do all three
without being asked:

```bash
npm test                     # 1. the gate
git add <paths> && git commit  # 2. stage only what you changed; the tree often has unrelated edits
docker compose restart web   # 3. restart the deployed server
```

**This repository opts into the beads "team-maintainer" profile for commits and
restarts only.** Committing and restarting are pre-authorized. **Pushing is not**:
neither `git push` nor `bd dolt push` (the latter is also denied in
`.claude/settings.json`) runs without asking first, whatever the session-close
protocol below says. A current "do not commit" from the user still wins.

The app runs in Docker: service `web` (container `native_landscaping-web-1`) on
`127.0.0.1:8080`, repo bind-mounted at `/app`, fronted by a `cloudflared` sidecar that
must **never** be restarted (it self-heals). A second service, `feed-poller`, runs
`tools/schedule-feed-poll.mjs` every `FEED_POLL_INTERVAL_MINUTES` (default 30). Restart
it too if you changed `tools/feedState/` or `tools/fetch-observation-events.mjs`.

Node does not hot-reload. `src/` is served fresh per request, but `server.js` keeps the
routes it booted with, so a POST to a route added since then returns **404, not 400**.
That 404 is the sign of a stale server. **Verify the restart instead of trusting the
command:**

```bash
docker inspect native_landscaping-web-1 --format '{{.State.StartedAt}} {{.State.Pid}}'  # before and after: both must change
curl -s http://127.0.0.1:8080/<changed module> | grep <identifier only in the new code>
```

`docker compose ps` prints *elapsed* uptime, so a real restart looks like none hours
later; compare `StartedAt`. `ps` is not in `node:22-slim`; use
`docker compose exec -T web node -e`. If a change is still not live after a verified
restart, suspect the user's open tab: the server sends `Cache-Control: no-store`, but a
page loaded before the deploy keeps its module graph until reloaded.

### Tests

`npm test` is the gate (Node only, no dependencies). `npm run test:e2e` runs Playwright
in `tests-e2e/` against the installed Chrome. Two rules that have cost real time:
**never assert on geometry or ids read from `projects/<slug>/`**, and **any spec that
writes must use the scratch server**. See [docs/testing.md](docs/testing.md).

### Tools for agents

- **Issues:** `bd` (beads), prefix `nl-`. The tracker is a local Dolt DB;
  `.beads/issues.jsonl` is a diffable export. No markdown TODO lists or plan files.
- **Code intelligence:** `codegraph` (`.mcp.json`), with the index in `.codegraph/`.
  Prefer `codegraph explore` over grep-and-read. Refresh with `codegraph sync`, or
  rebuild with `codegraph init .`.
- **Plant data:** the `usda-plants` MCP server (`tools/usda-plants/mcpServer.js`)
  exposes USDA lookups and the `claims_*` introspection tools over `data/claims.db`.
- **Editor:** `jsconfig.json` and the `typescript` devDependency exist only so the
  TypeScript language server resolves imports. Keep `typescript` at 5.x, because 7.x
  ships no `tsserver.js`.

### Where knowledge goes

One home per kind of fact, so copies cannot drift:

| kind of fact | home |
| --- | --- |
| a rule or fact about this repo that every agent needs | this file |
| the detail of one area | `docs/*.md`, linked from here |
| why a decision was made; open work | a bead (`bd create`, `bd note`) |
| a hard-won gotcha no file records yet | `bd remember`: shown to every agent at session start, so keep it short and move it here once it is general |
| a rule that must never be broken | a hook, not prose (see "Data safety") |

`CLAUDE.md` is a pointer to this file and holds nothing of its own.

## Deep dives

- [docs/design-tool.md](docs/design-tool.md): projects, the declared yard and the views
  derived from it, Setup and Features modes, photo placement and upload security, the
  plant CSVs, rendering, and interaction.
- [docs/ecology-rules.md](docs/ecology-rules.md): the rules engine, `ecology/` tables,
  local fauna, habitat anchors, site match, and the two results that look like bugs.
- [docs/testing.md](docs/testing.md): the unit gate and the Playwright suite.
- [docs/data-acquisition/](docs/data-acquisition/): the claim-store design (01-11) and
  permission requests.
- [catalog/README.md](catalog/README.md): the regional plant lists.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
