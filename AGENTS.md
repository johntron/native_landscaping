# Backyard Seasonal Visualization – AGENTS Guide

You are working on a small web app that helps homeowners and landscapers
visualize a **native, seasonally dynamic landscape** in a specific backyard.

The app is intentionally **low-fidelity and diagrammatic**, not photorealistic.
It should be easy to maintain, easy to extend, and faithful to ecological reality.

---

## Project Purpose

- Visualize how a native planting design changes **month-by-month**.
- Show **three synchronized orthographic views** of the same yard:
  1. Plan (looking down)
  2. South (kitchen) elevation
  3. East (patio) elevation
- Make it easy to update the design by editing a **CSV of plants** instead of
  hard-coding plant data.
- Help people understand **structure, layering, and phenology** (growth +
  flowering seasons) of native plants, especially in Blackland prairie /
  Dallas-area conditions.

The priority is **ecological legibility and usability**, not UI flashiness.

---

## Current Tech Stack

- Plain HTML + CSS + ES modules (no bundler or build step).
- `index.html` loads `src/app.js`, which orchestrates CSV loading, state, and rendering.
- `styles.css` handles layout plus the diagrammatic backdrops (WebP files in `img/`).
- Data lives in `plants.csv` (species) and `planting_layout.csv` (placements).
- All JavaScript is split into focused modules under `src/`:
  - `constants.js` – global geometry + month constants.
  - `data/` – CSV fetching/parsing and exporting.
  - `render/` – SVG utilities, top view, elevations, and shared config.
  - `state/` – seasonal computations per plant.
  - `interaction/` – drag controller for repositioning plants.

---

## Dev Workflow

There is **no build step**.

Suggested local workflow:

- Serve the project root as static files:
  - Option 1 (Node): `npx serve .`
  - Option 2 (Python 3): `python -m http.server 8000`
- Open `http://localhost:8000` and load `index.html`.
- Run automated tests when updating parsing/state logic: `npm test`.

If you introduce tooling (Vite, React, tests, etc.), keep it lightweight and
document the commands in this file under a new “Tooling” section.

---

## Project Structure & Responsibilities

### 1. Background Layers

- Each view has a **static background image** referenced in `styles.css`:
  - `img/top view.webp`, `img/front view.webp`, `img/side view.webp`.
- Requirements:
  - Must be **orthographic** (no perspective, no vanishing lines).
  - Vector-like: use flat color fields and simple shapes, not noise textures.
  - Exclude columns, patio slabs, feeders, furniture, and plants.
- JavaScript should treat backgrounds as **read-only assets**; overlays are SVG only.

### 2. Plant Data (CSV)

`plants.csv` is the **single source of truth** for species attributes and seasonal palettes; `planting_layout.csv` holds per-plant coordinates (in feet) and must reference species via `botanical_name` (with optional `species_epithet`).

Each layout row describes one plant clump or individual:

- `id`
- `botanical_name`
- `x_ft`, `y_ft` – offsets in feet from the yard origin (SW corner).

Each species row contains:

- `common_name`
- `botanical_name`
- `growth_shape` – e.g. `mound`, `vertical`, `vase`, `arch`, `creeping`, `grass`.
- `width_ft`, `height_ft`
- `growing_season_months` – range or list, e.g. `3-11` or `3,4,5`.
- `flowering_season_months`
- `flower_color`
- `foliage_color_spring/summer/fall/winter`
- `sun_pref`, `water_pref`, `soil_pref`
- Optional `dormant_color`, `flowerColor`, or alias fields handled by `plantParser`.

When changing behavior, **extend the CSV schema and parsing** (see `src/data/plantParser.js`) instead of hard-coding plant properties inside rendering logic.

### 3. Rendering Model

Rendering is **data-driven**. For every selected month:

1. `buildPlantsFromCsv` merges species + layout rows into renderable objects.
2. `computePlantState` determines active growth, flowering, and foliage colors.
3. `renderViews` hands the plant state list to each view renderer:
   - `renderTopView` draws foliage/bloom circles scaled to `width_ft`.
- `renderSouthElevation` and `renderEastElevation` draw simplified profiles based on `growth_shape` and `height_ft`, honoring consistent viewBox scaling and offsets from `constants.js`.

Top view uses the yard coordinate system (origin at SW corner, y increasing north). Elevations reuse the same data but map either x or y as horizontal distance to convey layering depth. Taller plants naturally overlap because each renderer clears and repopulates its SVG every frame (`render/topView.js`, `render/elevationViews.js`).

### 4. Interaction & Controls

- Month selector (`#monthSelect`) controls seasonal state.
- Scale input + slider keep plan/elevation overlays in sync with physical dimensions; bounds live in `SCALE_LIMITS`.
- Lock toggle enables/disables drag-to-move behavior powered by `createPlantDragController`, which clamps edits to the viewBox and triggers rerenders.
- Export button uses `buildLayoutCsv` to download the current layout so edits can be saved back to `planting_layout.csv`.
- SVG `<title>` tooltips (built by `render/tooltip.js`) display common + botanical names plus horticultural prefs on hover.
- When data fails to load, `src/app.js` surfaces a lightweight error banner with instructions to serve CSVs over HTTP.

Keep interactions lightweight and accessible; no heavy UI frameworks are needed.

---

## Code Layout Highlights

- `src/app.js` – application entry point; wires up DOM, loads CSVs, drives rendering loop and drag/export controls.
- `src/constants.js` – canonical sizes, offsets, and scale defaults shared across modules.
- `src/data/csvLoader.js` – fetch + minimalist CSV parser (also used by tests).
- `src/data/plantParser.js` – merges species/layout CSVs, normalizes month specs, aliases, and seasonal palettes.
- `src/data/layoutExporter.js` – converts in-memory plants back to CSV with consistent precision/escaping.
- `src/render/*` – view configuration, SVG helpers, tooltip builder, plan view and elevation renderers.
- `src/state/seasonalState.js` – pure logic for foliage/bloom state per month.
- `src/interaction/dragController.js` – pointer events + hit-testing for moving plants in plan view.
- `styles.css` – responsive layout, control styling, and background assignments.
- `tests/` – Node test runner suite covering CSV parsing, plant merging, seasonal state, and CSV export.

---

## Code Style & Conventions

- Prefer **plain TypeScript-style JS** (clear parameter shapes via comments / JSDoc).
- Favor **pure functions** for:
  - parsing CSV into plant models,
  - computing seasonal state,
  - rendering plant shapes.
- Keep DOM queries localized (`src/app.js` owns them); avoid scattering `document.querySelector`.
- Avoid global mutable state other than the explicit `appState` object.
- Comment any non-obvious geometry math (coordinate transforms, scaling, pointer hit-testing).

---

## Domain Rules & Constraints

- The app is intended for **native, ecologically appropriate plantings**.
- Don’t invent fake plant species; use realistic botanical names.
- Support **multiple growth forms and strata** (groundcover, perennials, shrubs, small trees) but keep the visual vocabulary generic and reusable.
- Plants should not appear in months outside their growing season; dormant months should desaturate foliage.
- Winter scenes should look **sparser and browner**, unless the species is evergreen/semi-evergreen per data.

---

## Things to Avoid

- Do **not** couple the logic to a specific set of plants hard-coded in JS.
- Do **not** introduce heavy frameworks or complex build tooling without explicit instructions.
- Do **not** add UI clutter like plant tables or CRUD forms unless requested.
- Do **not** depend on external APIs; everything should run locally from static files.

---

## Good Tasks to Ask For

When the user delegates work, here are examples of useful tasks:

- “Refactor `plantParser` or `seasonalState` to handle a new growth attribute and update renderers accordingly.”
- “Add support for a new `growth_shape` type and update all three views.”
- “Improve the month selector UI or scale controls while keeping them wired to the existing rendering logic.”
- “Add a small legend explaining colors and shapes for plants and beds.”
- “Write unit tests for new CSV fields or drag/export edge cases (using `npm test`).”

---

## Tooling

- Run `npm test` to execute `node tests/run-tests.cjs`, which covers the layout history stack and the persistence module (ensuring the app hits `/api/layout` when committing changes).
- Run `npm run serve` (or `node server.js`) to launch the bundled static + persistence server that exposes `/api/layout` for saving the layout and `/api/history` for the changelog.
- No external dependencies are required to execute the suite. Run `npm install` once before serving the app: `index.html` loads JSZip from `node_modules/jszip/dist/jszip.min.js`.

### Code intelligence (CodeGraph)

`codegraph` indexes this repo into `.codegraph/` (gitignored, machine-local). It is
also wired up as an MCP server via `.mcp.json`, so the `codegraph_*` tools are
available in-session. Prefer these over blind grepping when tracing behavior:

```bash
codegraph explore "seasonal state"   # relevant symbols + call paths in one shot
codegraph node computePlantState     # one symbol's source + caller/callee trail
codegraph callers buildPlantsFromCsv # who calls this
codegraph impact renderTopView       # what a change would ripple into
codegraph affected src/state/seasonalState.js  # which tests to run
codegraph sync                       # refresh index after large refactors
```

Rebuild from scratch with `codegraph init .` if the index looks stale.

### Issue tracking (beads)

Task tracking lives in `bd` (see the Beads Issue Tracker block below), not in
markdown TODO lists. Issue IDs use the `nl-` prefix. `export.auto` is on, so once
the first issue is created `.beads/issues.jsonl` appears and stays a diffable
snapshot of the tracker in git (the tracker itself is the Dolt DB, not the JSONL).

### Editor / LSP

`jsconfig.json` exists solely so the TypeScript language server can resolve
cross-file ES module imports (`checkJs` is off — this stays plain JS, and there
is still no build step). `typescript` is a devDependency for the same reason.

---

## Important Code

- `src/app.js` controls initialization, month/scale UI, drag locking, and orchestrates rendering.
- `src/data/plantParser.js` parses `plants.csv` into normalized plant objects and applies seasonal palettes; updates here ripple through every view.
- `src/state/seasonalState.js` converts month selection into growth/flowering flags and chosen colors relied upon by the renderers.
- `src/render/topView.js` and `src/render/elevationViews.js` turn plant state into SVG geometry for the three synchronized views.
- `src/interaction/dragController.js` keeps plan-view dragging responsive and constrained; no other module should mutate plant coordinates directly.

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

