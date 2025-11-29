# Backyard Seasonal Visualization – AGENTS Guide

You are working on a small web app that helps homeowners and landscapers
visualize a **native, seasonally dynamic landscape** in a specific backyard.

The app is intentionally **low-fidelity and diagrammatic**, not photorealistic.
It should be easy to maintain, easy to extend, and faithful to ecological reality.

---

## Project Purpose

- Visualize how a native planting design changes **month-by-month**.
- Show **three synchronized orthographic views** of the same yard:
  1. Top-down plan view
  2. South (kitchen) elevation
  3. West (patio) elevation
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
   - `renderSouthElevation` and `renderWestElevation` draw simplified profiles based on `growth_shape` and `height_ft`, honoring consistent viewBox scaling and offsets from `constants.js`.

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

- Tests use Node's built-in test runner: `npm test` (alias for `node --test`).
- No external dependencies are required to execute the suite.

---

## Important Code

- `src/app.js` controls initialization, month/scale UI, drag locking, and orchestrates rendering.
- `src/data/plantParser.js` parses `plants.csv` into normalized plant objects and applies seasonal palettes; updates here ripple through every view.
- `src/state/seasonalState.js` converts month selection into growth/flowering flags and chosen colors relied upon by the renderers.
- `src/render/topView.js` and `src/render/elevationViews.js` turn plant state into SVG geometry for the three synchronized views.
- `src/interaction/dragController.js` keeps plan-view dragging responsive and constrained; no other module should mutate plant coordinates directly.
