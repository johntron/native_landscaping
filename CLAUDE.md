# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

**Read [AGENTS.md](AGENTS.md) first** — it is the canonical project guide (purpose, tech
stack, module layout, domain rules, tooling). This file only carries the issue-tracker
integration below.

Tooling shortcuts: `npm test` (Node test suite), `npm run test:e2e` (Playwright browser
tests in `tests-e2e/`), `npm run serve` (static + persistence
server), `codegraph explore/node/callers/impact` for code intelligence (also available as
`codegraph_*` MCP tools).

Multi-project layout: `plants.csv` at the root is the shared species catalog; each yard
lives in `projects/<slug>/` (`project.json`, `planting_layout.csv`, `img/`, and an
optional `features.json`) and is listed in `projects/index.json`. The active project comes
from `?project=<slug>`; switching reloads the page. **`/` is the patch-network argument**
(`index.html`, project-agnostic); the yard tool is `design.html`, entered by picking a yard in
the argument page's handoff section.

**`project.json` declares one yard** — `yardFt` (east-west × north-south), `paddingFt`,
`elevationFt` (above/below the ground line), `pxPerFt` — and **every view's rectangle is
derived from it**, so two views of one yard cannot disagree about how big it is. Panels are
sized `extentFt × pxPerFt` at one page-wide screen scale (`src/render/pageScale.js`), which
is what makes them line up and puts every elevation's ground on the same row. What a view
still declares is its id, type, `viewFrom`, labels, `viewerAtFt`, and its photograph. The
**photo is placed, not fitted**: `photoFt` is the rectangle of yard the image covers,
dragged and corner-resized on the drawing, always at the image's own aspect (loaded once
per path into `photoAspects`). Nothing writes a view rectangle back to the file. **Setup
mode** shows one view at a time, with its window widened 30% so a photo reaching past the
view can still be grabbed, the yard and its origin drawn over it, and everything outside
the view dimmed — that is what the other modes crop. Draggable there: the photo, its four
corners, and each elevation's camera, which lives on the plan as one object with its
direction arrow. Shrinking the yard below the planting is reported, never auto-repaired: the panel
names what is outside and offers *scale the whole design to fit* or *move inside*.
Older per-view `extentFt`/`originFt` files are migrated on load — their rectangles become
their photos' placements, so no picture moves. Detail callouts (`backgroundFrom`) are gone.
*Upload photo* resizes and re-encodes a picked image in the browser and posts it to
`/api/view-background` (the server names the file and refuses anything that is not a
WebP/JPEG/PNG by its bytes; never SVG).

`features.json` is the yard model — beds, hardscape, walls, the house footprint —
authored once in FEET and projected into every view by
`src/render/featureProjection.js`, never drawn per view; it loads through
`GET /api/features` and saves through `POST /api/features` (fetching the file
directly would log a console 404 for every project that has never drawn one), and
elevations sort features and plants into ONE far-to-near list so a fence hides the
shrub behind it; features are drawn in the fourth toolbar mode, **Features**, on a plan
view only (elevations are derived and read-only), and like Setup mode it saves only when
asked. Elevations are driven by a `viewFrom` compass direction, and a plant drag is
clamped to the shared yard rather than to the view it is dragged in — see the
"Projects" section of AGENTS.md for the axis/mirror table, the schema, and how
to add a project.

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
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm test                     # Node test suite — the gate
npm run test:e2e             # Playwright browser tests in tests-e2e/
docker compose restart web   # deploy: restart the running server (never cloudflared)
```

## Git and deploy policy — this repository OPTS IN

The Beads block below describes a *conservative* default in which an agent does
not commit without being asked. **This repository overrides that.** The standing
instruction from the repository owner is:

> After each change, once tests pass, commit it **and** restart the deployed
> server (`docker compose restart web`). Both steps, every time, without asking.

Treat that as the **team-maintainer** profile the block refers to: committing and
restarting are pre-authorized. Two limits still hold — **pushing to `origin` is
not** covered, nor is `bd dolt push`; ask first. And a current "do not commit"
instruction from the user still wins over this file.

`docker compose ps` reports *elapsed* uptime, so a real restart reads "Up 2
hours" hours later and looks like it never happened. Verify with
`docker inspect … {{.State.StartedAt}} {{.State.Pid}}` before and after, and check
the served bytes carry the change. Full detail — including why the restart is
required even though `src/` is bind-mounted — is under **Dev Workflow** in
[AGENTS.md](AGENTS.md), which is canonical.

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
