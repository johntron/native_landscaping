# Backyard Seasonal Visualization – AGENTS Guide

You are working on a small web app that helps homeowners and landscapers
visualize a **native, seasonally dynamic landscape** in a specific backyard.

The app is intentionally **low-fidelity and diagrammatic**, not photorealistic.
It should be easy to maintain, easy to extend, and faithful to ecological reality.

---

## Project Purpose

- Visualize how a native planting design changes **month-by-month**.
- Show **synchronized orthographic views** of the same yard — a plan (looking
  down), an elevation per compass side the yard is viewed from, and any detail
  callouts. Each project declares its own set in `project.json`; the backyard
  ships plan + south (kitchen) + east (patio).
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

### 0. Projects

The app hosts **multiple projects** — separate yards, each with its own background
images, canvas dimensions, and compass orientation. They share one species catalog
(`plants.csv` at the repo root); each project's *selection* of species is implicit
in its own `planting_layout.csv`.

```
plants.csv                       shared species catalog (all projects)
projects/index.json              { defaultProject, projects: [{ id, name }] }
projects/<slug>/project.json     views[]: extent + origin in feet, backgrounds, labels
projects/<slug>/planting_layout.csv
projects/<slug>/features.json    yard features in feet; optional, absent means none
projects/<slug>/img/…            that project's background images
projects/<slug>/layout-history.json   (generated, gitignored)
```

**Adding a project**: create `projects/<slug>/` with the four items above, then add
`{ "id": "<slug>", "name": "…" }` to `projects/index.json`. Slugs must match
`^[a-z0-9][a-z0-9_-]*$` — they become both URL and file path segments, and the
server rejects anything else (`src/data/projectPaths.js`).

**Prefer the Setup mode toolbar over hand-editing `project.json`.** It adds,
reorders, and removes views, edits each one's extent and origin in feet, and lets
you drag the crop rectangle, ground line, and near edge directly on the drawing;
*Save views* writes the file back through `POST /api/project`. Hand-editing works
too, but Setup mode cannot produce a geometry the renderers disagree with.

*Upload photo* puts a background on the selected view without touching the
filesystem: the browser decodes the picked file, scales it to at most 2400 px on
its long edge, and re-encodes it as WebP, stepping down a quality ladder until
it fits roughly 800 KB (`src/data/backgroundUpload.js`). The bytes go up as the
raw body of `POST /api/view-background`, and the **server** names the file —
`img/<view-id>-<content-hash>.webp` — so nothing a client sends becomes a path.
The hash is not decoration: the stored `background` string has to change for the
drawing to re-fetch anything, so a replacement photo lands on a new path and the
view's earlier uploads are deleted. `src/data/backgroundStore.js` holds the
guards; see "Uploading a background" below.

The fastest way to get a view's `extentFt` right is *Measure a known length*:
arm it, drag across something in the background photo whose real length you know
— a fence panel, a driveway, a doorway — and type that length. The photo fills
the viewBox, so the span solves the whole view's scale
(`resolveRulerCalibration` in `src/render/setupOverlay.js`). A plan's corner and
an elevation's near edge sit on a photo edge at any scale and stay put; the
ground line scales with the extent so it keeps the photo row it was placed on.

#### The views[] schema

A project declares `views[]`, and every view is authored **in feet**:

| key | meaning |
| --- | --- |
| `id` | slug; addresses the panel (`data-view-panel`), its SVG (`<id>Svg`), and its export PNG |
| `type` | `plan` (looking down) or `elevation` (looking horizontally) |
| `viewFrom` | elevations only — the compass side the viewer stands on |
| `extentFt` | how much yard the view covers, `{ width, height }` |
| `originFt` | the yard coordinate at the viewBox's bottom-left corner |
| `viewBox` | drawing resolution in px; **derived, not a scale** — see below |
| `label`, `sublabel` | panel headings; omitted when they match the defaults |
| `background` | image path relative to the project directory |
| `backgroundFrom` | id of a view to borrow (and crop) a background from |

**Pixels per foot is derived, never authored**: `viewBox.width / extentFt.width`,
and the height must agree with it or `createViewTransform` rejects the view as
non-uniformly scaled. `src/render/viewTransform.js` is the single feet↔pixel
authority; renderers, drag controllers, and the setup overlay all go through it.
The toolbar's Scale control is **zoom only** — it resizes panels on screen and
never touches plant coordinates or the geometry in `project.json`.

For an elevation, `originFt.x` is the value of the horizontal axis at the view's
**near** edge and `originFt.y` is the ground height at the bottom edge, so a
negative `originFt.y` lifts the ground line into the drawing.

A **detail callout** is just another view with a smaller `extentFt`, a non-zero
`originFt`, and `backgroundFrom` pointing at the full view: it re-uses that
view's photo cropped to its own rectangle (`src/render/backgroundCrop.js`), on
screen and in the exported PNG alike. The source must look at the yard the same
way — same `type`, and same `viewFrom` for elevations. Any number of views is
fine; `projects/example-frontyard/` ships four.

The legacy pixel-authored shape — `{ plan, elevations[] }` with `viewBox`,
`bottomOffsetPx`, `leftOffsetPx`, and a project-wide `defaultPixelsPerInch` — is
still read and migrated on load by `normalizeProjectConfig`, so an old
`project.json` keeps working. Nothing writes it back: saves always emit
`views[]`.

The active project comes from `?project=<slug>`, falling back to `defaultProject`.
Switching projects **reloads the page** rather than re-initializing in place: the
render loop, history stack, and drag controllers are each built once against a
single project, and a reload keeps that simple and the URL linkable.

`projects/example-frontyard/` is a throwaway template showing portrait dimensions,
north/west elevations, and a detail callout cropped out of the plan photo; delete
it once you have real projects.

#### Yard features

Beds, hardscape, fences, and the house footprint are **yard geometry in feet
shared by every view**, so they live in `projects/<slug>/features.json` rather
than in `project.json`, which holds per-view presentation. There is one model
and every view is a projection of it — never a drawing per view, which is how
the house ends up drawn three times and the three disagree.

Three primitives, each carrying a footprint *and* a height because it has to
appear in both a plan and an elevation:

| type | authored as | plan | elevation |
| --- | --- | --- | --- |
| `surface` | `footprintFt` polygon, no height | filled polygon | a band on the ground line |
| `wall` | `pathFt`, ≥ 2 points | open path | rectangle, base to base + height |
| `box` | `footprintFt` polygon | filled footprint | silhouette rectangle |

`baseFt` lets a feature sit on a step; `style.strokeWidthFt` is in feet like
everything else, so a feature keeps its weight when a view is rescaled.
`normalizeFeatures` rejects loudly where a default would hide a shape — a wall
or box with no positive `heightFt` is refused, because a zero-height wall
renders as nothing at all. An absent file is *not* an error: it means no
features.

Silhouettes are deliberately crude rectangles, and `src/render/featureProjection.js`
does every mapping through `viewTransform`. In an elevation the axis span is
taken in **pixels after `axisToX`**, never in feet: a mirrored view maps the
larger axis value to the smaller x, so a min/max in feet puts the rectangle's
left edge on its right. Two silhouettes come out degenerate and both are
legitimate — a surface has no height, a wall seen end-on has no width — and
since SVG draws neither a zero-width nor a zero-height rect at all, both are
drawn as a line at their stroke weight.

Draw order differs by view type, and `src/render/elevationOrder.js` owns it. A
plan has no depth, so features go beneath the plants in authoring order. An
elevation sorts features and plants into **one** list far-to-near, which is the
payoff: a fence between the viewer and a shrub actually hides it. An extended
footprint is drawn whole at its nearest edge rather than split at each plant —
exactly right for a box, since nothing is planted inside a house.

**Features are drawn in Features mode, on a PLAN view only.** A footprint lives in
plan space and a height is a number in a form field, so elevations stay derived and
read-only — that restriction is most of what keeps the editor small. Select a shape
by clicking it, drag it to move, drag a vertex to reshape; the list adds, deletes,
and reorders (array order is the plan's z-order). Every gesture reports a *candidate*
through `onChange` and the app validates it with `normalizeFeatures` before it becomes
live, so a refused edit leaves the drawing on the last good state. A new wall or box
is created with a real `heightFt` on purpose: the normalizer refuses one without a
positive height, and the first frame of a new fence must not be what trips that guard.
Unlike a plant drag and like Setup mode, editing does **not** auto-save — press *Save
features*.

Features load through `GET /api/features` and save through `POST /api/features`
(`loadProjectFeatures` / `persistFeatures` in `src/data/persistence.js`). The
load deliberately does *not* fetch `features.json` off disk: most projects have
never drawn a feature, and a static fetch for a missing file makes the browser
log a 404 on every page load. Like `project.json` and unlike the layout, there
is no undo stack — features are setup.

#### Elevation orientation

Yard coordinates: origin at the SW corner, **x increases east, y increases north**.
Each elevation declares `viewFrom` — the compass side the viewer stands on — and
`src/render/elevationOrientation.js` derives the rest:

| `viewFrom` | horizontal axis | mirrored | farthest plants |
| ---------- | --------------- | -------- | --------------- |
| `south`    | x               | no       | high y          |
| `north`    | x               | yes      | low y           |
| `east`     | y               | no       | low x           |
| `west`     | y               | yes      | high x          |

Mirrored views reflect about the viewBox centre, so `originFt.x` always means the
**near** edge — which mirroring puts on the *right* for `north` and `west`. Go
through `viewTransform`'s `axisToX` / `xToAxis` and that is automatic; do the
subtraction in feet by hand and it is not.

#### Yard bounds

**A plant is clamped to the yard, never to the view it is being dragged in**
(`src/render/yardBounds.js`). The two are not the same: an elevation's near-edge
inset is drawing margin rather than plantable ground, so its rectangle can start
before the yard's zero and end past its far side. Clamping to the view under the
pointer therefore let a plant reach a coordinate the plan view cannot draw, and
it silently vanished from the plan.

The yard is **the first plan view's rectangle, narrowed to what the first
elevation for each compass direction can draw**. Later views of either kind are
detail callouts — they show part of the yard by definition, and a plant outside
one is not lost. If the primary views do not overlap at all, the plan view wins.

### 1. Background Layers

- Each view's **static background image** is declared in its `project.json` as a
  path relative to the project directory, and applied by `src/render/viewConfig.js`.
  A stylesheet cannot vary backgrounds per project, so `styles.css` no longer sets them.
- A photo is painted `background-size: contain`, **not** stretched to the panel. A
  photo whose aspect differs from the view's would otherwise be scaled differently
  on each axis, and a plant placed at the right height in feet would sit at the
  wrong height against the photo; uniform scaling keeps the photo and the drawing
  agreeing, and letterboxes rather than lying. A background authored to the view's
  own ratio — every image in `projects/backyard/`, all 800×600 against an 800×600
  viewBox — fills the panel exactly as before. **A photo never reshapes a view**:
  `extentFt` is the author's yard geometry and an upload leaves it alone.
- The panel is bounded by capping its **width**, not its height
  (`width: min(100%, calc(70vh * var(--view-aspect-ratio)))`). With `width: 100%` a
  `max-height` would constrain both axes, which drops `aspect-ratio` and brings the
  stretching back; capping width leaves height free to follow the ratio, so a tall
  view gets a narrower panel instead of a page-long one.
- Requirements:
  - Must be **orthographic** (no perspective, no vanishing lines).
  - Vector-like: use flat color fields and simple shapes, not noise textures.
  - Exclude columns, patio slabs, feeders, furniture, and plants.
- JavaScript treats backgrounds as **read-only assets** while drawing — overlays are
  SVG only. The one writer is Setup mode's *Upload photo*, which replaces a view's
  background wholesale and never edits pixels in place.

#### Uploading a background

`POST /api/view-background?project=<slug>&view=<id>` takes the image as the raw
request body. Deliberately not multipart: there is one file, its name is not the
client's to choose, and a parser we would have to write is the largest attack
surface the feature could have. The server therefore never decodes the image —
it only checks it.

- **Type**: `Content-Type` must be `image/webp`, `image/jpeg`, or `image/png`,
  *and* the leading bytes must agree with it. A declared type is a string the
  client picked; the magic-byte sniff is what stops an HTML document being
  stored as `north.webp`. **SVG is excluded on purpose and must stay excluded** —
  `serveStaticFile` returns it as `image/svg+xml`, which executes script, so an
  uploaded SVG would be stored XSS against everyone who opens the project.
- **Size**: capped at 8 MB, checked as chunks arrive rather than from
  `Content-Length` (a claim, not a fact). Over the cap the request is paused,
  answered with 413, and only then destroyed — destroying first drops the
  connection before the explanation reaches the client.
- **Path**: the filename is built from the validated view id, a SHA-256 prefix of
  the content, and an extension derived from the *sniffed* type, then re-checked
  for containment inside the project's `img/`. View ids are slugs on the same
  pattern as project ids, for the same reason: this one becomes a filename.
- **Write**: temp file then rename, like `writeJsonAtomic`, so a crash never
  leaves a half-written photo. Superseded uploads for that view are removed
  afterwards, best effort — the new background is already usable, so tidying up
  must not fail the request.

The client-side re-encode is a second line of defence as well as a size
reduction: the uploaded bytes are ones the canvas produced from decoded pixels,
so EXIF, colour profiles, and anything appended to the original file do not
survive the round trip. EXIF *orientation* is applied during decode
(`imageOrientation: 'from-image'`) and baked into the pixels, which is what keeps
a phone photo from landing sideways.

### 2. Plant Data (CSV)

`plants.csv` is the **single source of truth** for species attributes and seasonal palettes, shared by every project; each project's `projects/<slug>/planting_layout.csv` holds per-plant coordinates (in feet) and must reference species via `botanical_name` (with optional `species_epithet`).

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
   - `renderElevationView` draws simplified profiles based on `growth_shape` and
     `height_ft`, mapping feet to pixels through the view's own `viewTransform`.

Top view uses the yard coordinate system (origin at SW corner, y increasing north). Elevations reuse the same data but map either x or y as horizontal distance to convey layering depth. Taller plants naturally overlap because each renderer clears and repopulates its SVG every frame (`render/topView.js`, `render/elevationViews.js`).

### 4. Interaction & Controls

- Month selector (`#monthSelect`) controls seasonal state.
- Scale input + slider are **zoom**: they resize the panels on screen only, with bounds in `SCALE_LIMITS`. Physical scale belongs to each view's `extentFt`.
- Mode pills switch between View, Edit (drag plants), Setup (define views), and Features
  (draw the yard model).
- Lock toggle enables/disables drag-to-move behavior powered by `createPlantDragController`, which clamps edits to the viewBox and triggers rerenders.
- **Each view SVG has several controllers, so none may own an inline style.** The drag,
  setup, and (on plans) feature controllers are bound to the same element; while both wrote
  `svg.style.touchAction`
  the later writer silently won and Edit mode sat at `touch-action: auto`, so the page
  scroller took every drag. Each now toggles its own class (`is-drag-enabled`,
  `is-setup-enabled`, `is-features-enabled`) and `styles.css` combines them — see the comment
  there for why neither `pan-y` nor per-plant `touch-action` works. `svg.style.cursor` still
  has this bug and now has three writers (nl-jfm). `applyMode` decides all the lock states in
  one place, so exactly one kind of controller is ever unlocked.
- Touch is covered by `tests-e2e/touch.spec.js` under its own phone-sized Playwright project.
  It drives **real touch through CDP** (`Input.dispatchTouchEvent`, wrapped as `touchGesture`
  in `tests-e2e/helpers.js`): `page.mouse` is not touch and `page.touchscreen` only taps, so
  neither exercises `touch-action` and both pass against a broken app. CDP synthesizes no
  long-press `contextmenu`, so the right-click menu cannot be tested on touch.
- Edit mode's "Add plant" picker places one plant of the chosen species at the middle of
  the plan view; the plant's own detail sheet and right-click menu carry Clone and Remove.
  All three go through the same commit path as a drag, so undo/redo and the auto-save to
  `planting_layout.csv` come for free — there is no separate confirmation step.
- Export button uses `buildLayoutCsv` to download the current layout so edits can be saved back to `planting_layout.csv`.
- SVG `<title>` tooltips (built by `render/tooltip.js`) display common + botanical names plus horticultural prefs on hover.
- When data fails to load, `src/app.js` surfaces a lightweight error banner with instructions to serve CSVs over HTTP.

Keep interactions lightweight and accessible; no heavy UI frameworks are needed.

---

## Code Layout Highlights

- `src/app.js` – application entry point; wires up DOM, loads CSVs, drives rendering loop and drag/export controls.
- `src/constants.js` – canonical sizes, offsets, and scale defaults shared across modules.
- `src/data/csvLoader.js` – fetch + minimalist CSV parser (also used by tests).
- `src/data/projectConfig.js` – project index/config loading, normalization, and slug validation.
- `src/data/projectPaths.js` – server-side resolution of a project's data files (path-traversal guard).
- `src/render/elevationOrientation.js` – compass → axis/mirror/depth mapping for elevations.
- `src/render/viewTransform.js` – the one feet↔pixel authority, wrapping that mapping.
- `src/render/yardBounds.js` – the shared yard a plant may be dragged within.
- `src/render/backgroundCrop.js` – which photo a view draws, and which patch of it.
- `src/data/backgroundUpload.js` – browser-side resize/re-encode, and the upload POST.
- `src/data/backgroundStore.js` – server-side upload guards: allowed types, magic-byte
  sniff, and the filename the server (never the client) chooses.
- `src/interaction/setupPanel.js`, `src/interaction/setupController.js`, `src/render/setupOverlay.js` – Setup mode's form, on-canvas handles, and guides.
- `src/interaction/featurePanel.js`, `src/interaction/featureController.js`, `src/render/featureOverlay.js` – Features mode's list, plan-only drag handles, and selection outline.
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
- Every `id` in a project's `planting_layout.csv` must be **unique**. Ids address plants
  for dragging, cloning, and hover/target highlighting, so a repeat makes every row after
  the first unreachable. `parsePlantLayoutCsv` rejects duplicates with a `LayoutDataError`,
  and the app shows the id and row numbers in an error banner. Anything that adds a plant
  must mint its id through `src/state/plantIds.js` so it cannot collide — `buildCloneId`
  when copying an existing plant, `buildNewPlantId` when placing one from the catalog.
- Every plant object, whether it came from `planting_layout.csv` or was added in the
  browser, is built by `createPlantFromSpecies` (`src/data/plantParser.js`). Keep it that
  way: two builders would let the two paths drift into different plant shapes.

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
- Run `npm run serve` (or `node server.js`) to launch the bundled static + persistence server. `/api/layout`, `/api/history`, `/api/history/cursor`, `/api/project`, `/api/features`, and `/api/view-background` are all scoped by a required `?project=<slug>` query parameter and write inside that project's directory only.
- No external dependencies are required to execute `npm test`; `npm run test:e2e` needs the `@playwright/test` devDependency (see below). Run `npm install` once before serving the app: `index.html` loads JSZip from `node_modules/jszip/dist/jszip.min.js`.

### End-to-end browser tests (Playwright)

`npm run test:e2e` runs the Playwright suite in `tests-e2e/`. It boots `node server.js`
on port `8123` (override with `E2E_PORT`) and drives the real `index.html` in Chrome.

- Specs live in `tests-e2e/`, **not** `tests/` — `tests/run-tests.cjs` auto-discovers every
  `*.test.js`/`*.test.cjs` under `tests/` and runs it with `node --test`, which cannot
  execute Playwright specs. Keeping them apart lets `npm test` stay dependency-free.
- `playwright.config.js` uses `channel: 'chrome'`, i.e. the Chrome already installed on
  the machine. `npm install` alone never fetches a browser (Playwright ≥1.5x has no
  postinstall download); browsers only arrive via an explicit `npx playwright install`,
  which this suite does not need. If Chrome is missing, either install Chrome or run
  `npx playwright install chromium` and drop the `channel` option.
- Assert on **DOM and text, not screenshots**. `renderTopView` stamps every plant group
  with `data-plant-id`, `data-name`, and `data-species-key`; those are the query handles
  (`tests-e2e/helpers.js` wraps the common ones). Screenshot diffs are noisy here because
  the renderers deliberately jitter canopy outlines.
- **A spec that writes must use the scratch server.** Dragging a plant auto-saves via
  `POST /api/layout`, Setup mode's *Save views* posts `/api/project`, and
  *Upload photo* posts `/api/view-background` — any of which would rewrite the
  repo's `projects/` if pointed at the default server.
  `playwright.config.js` starts a second server on `E2E_PORT + 1` over a throwaway
  root built by `tests-e2e/scratch-fixture.mjs`; reach it through `openScratchProject`
  (`tests-e2e/helpers.js`). Read-only specs use the default server.
- `test-results/` and `playwright-report/` are gitignored.

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
- `src/render/topView.js` and `src/render/elevationViews.js` turn plant state into SVG geometry for each of the project's views.
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

