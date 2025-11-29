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

- Plain HTML + CSS + JavaScript (no build step required).
- Static assets:
  - `index.html` – main page and layout shell.
  - `styles.css` – layout, backgrounds, and visual styling.
  - `script.js` – CSV loading, state management, SVG rendering.
  - `plants.csv` – species database (botanical + seasonal attributes).
  - `planting_layout.csv` – per-plant placements referencing `botanical_name`.
  - Background images (PNG/SVG) for:
    - top-down view,
    - south elevation,
    - west elevation.

Assume a simple static server (e.g. VS Code Live Server, `npx serve .`,
or built-in preview). No bundler or framework is required unless explicitly
introduced in a later task.

---

## Dev Workflow

There is **no build step** yet.

Suggested local workflow (you can mention these when you need to run things):

- Serve the project root as static files:
  - Option 1 (Node): `npx serve .`
  - Option 2 (Python 3): `python -m http.server 8000`
- Open `http://localhost:8000` and load `index.html`.

If you introduce tooling (Vite, React, tests, etc.), keep it lightweight and
document the commands in this file under a new “Tooling” section.

---

## Project Structure & Responsibilities

### 1. Background Layers

- Each view has a **static background image**:
  - Top-down: yard outline, fences, turf region, curving mulched beds.
  - South elevation: sky, fence, bed, turf.
  - West elevation: sky, fence, bed, turf.
- Requirements:
  - Must be **orthographic** (no perspective, no vanishing lines).
  - Vector-like: use flat color fields and simple shapes, not noise textures.
  - Exclude columns, patio slabs, feeders, furniture, and plants.
- The JavaScript should treat backgrounds as **read-only assets**.

### 2. Plant Data (CSV)

`plants.csv` is the **single source of truth** for species attributes; `planting_layout.csv` holds per-plant coordinates and optional overrides and should reference species by full `botanical_name`.

Each row describes one plant clump or individual:

- `id`
- `common_name`
- `botanical_name`
- `x_ft`, `y_ft` – plant position in feet from a consistent origin (e.g. SW corner).
- `width_ft`
- `height_ft`
- `growth_shape` – e.g. `mound`, `vertical`, `vase`, `arch`, `creeping`.
- `growing_season_months` – range or list, e.g. `3-11` or `3,4,5`.
- `flowering_season_months`
- `flower_color` – CSS color or hex.
- `foliage_color_spring`
- `foliage_color_summer`
- `foliage_color_fall`
- `foliage_color_winter`
- `sun_pref` – `full-sun` | `part-sun` | `shade`.
- `water_pref`
- `soil_pref`

When changing behavior, **extend the CSV schema and parsing** instead of
hard-coding plant lists inside `script.js`.

### 3. Rendering Model

The rendering must be **parametric**: plant visuals are derived from data.

For every selected month:

1. Parse `plants.csv` (species) and `planting_layout.csv` (placements) to an in-memory model.
2. For each plant:
   - Compute whether it is in active growth.
   - Compute whether it is flowering.
   - Choose foliage color from the seasonal fields.
   - Choose bloom color if the month is within `flowering_season_months`.
   - If outside growing season, desaturate or fade foliage.
3. Render the plant in all three views:

**Top-down view**
- Use a simple vector blob / ellipse scaled to `width_ft`.
- Foliage is the base fill; blooms can be small circles or dots on top.
- Z-ordering is not critical, but taller plants can be drawn above low groundcovers.

**South & West elevations**
- Use simplified profiles based on `growth_shape` and `height_ft`:
  - `mound` → dome or semicircle.
  - `vertical` / `vase` → tall rounded rectangle or vase-shaped profile.
  - `creeping` → low, wide rectangle.
  - `grass`-like → narrow vertical flare.
- Height should scale consistently so users can compare plant structure.

Keep the code organized so each view has its own rendering function that
accepts the plant list and current month.

### 4. Interaction

- Provide a month selector (dropdown or slider).
- When the month changes:
  - Recompute plant states.
  - Re-render all views.
- On hover, show a tooltip with key plant info:
  - common name, botanical name, height, sun/water prefs.
- Keep interactions lightweight and accessible (no heavy UI frameworks needed).

---

## Code Style & Conventions

- Prefer **plain TypeScript-style JS** (clear types in comments / JSDoc if needed).
- Favor **pure functions** for:
  - parsing CSV into plant models,
  - computing seasonal state,
  - rendering plant shapes.
- Keep DOM queries localized; do not scatter `document.querySelector` calls.
- Avoid global mutable state other than a small, explicit app state object.
- Comment any non-obvious geometry math (coordinate transforms, scaling).

---

## Domain Rules & Constraints

- The app is intended for **native, ecologically appropriate plantings**.
- Don’t invent fake plant species; use realistic botanical names.
- Support **multiple growth forms and strata** (groundcover, perennials,
  shrubs, small trees) but keep visual vocabulary generic and reusable.
- Plants should not magically appear in months outside their growing season.
- Winter scenes should look **sparser and browner**, not evergreen unless
  the species actually is evergreen or semi-evergreen.

---

## Things to Avoid

- Do **not** couple the logic to a specific set of plants hard-coded in JS.
- Do **not** introduce heavy frameworks or complex build tooling without
  explicit instructions.
- Do **not** add UI clutter like plant tables or CRUD forms unless requested.
- Do **not** depend on external APIs; everything should run locally from static files.

---

## Good Tasks to Ask For

When the user delegates work, here are examples of useful tasks:

- “Refactor `script.js` into smaller modules for parsing, state, and rendering.”
- “Add support for a new `growth_shape` type and update all three views.”
- “Improve the month selector UI and wire it to the existing rendering logic.”
- “Add a small legend explaining colors and shapes for plants and beds.”
- “Write unit tests for the CSV parsing and seasonal state logic (if a test
  framework is added).”

---

## Tooling

- Tests use Node's built-in test runner: `npm test` (alias for `node --test`).
- No external dependencies are required to execute the suite.

## Important Code

- `src/data/plantParser.js` parses `plants.csv` into normalized plant objects and
  applies seasonal palettes; updates here ripple through every view.
- `src/state/seasonalState.js` converts month selection into growth/flowering
  flags and chosen colors that the renderers rely on.
