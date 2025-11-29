# backyard seasonal visualization – system context

This document gives high-level system and domain context so code changes stay
aligned with the real backyard and the ecological intent.

---

## site & ecological context

- Location: **Dallas, TX**, in the Blackland Prairie ecoregion. :contentReference[oaicite:0]{index=0}  
- Yard: small, mostly rectangular backyard behind a house, enclosed by an 8 ft
  privacy fence on three sides.
- Light: ~4–5 hours of **afternoon** sun; morning shade from the house; partial
  to full shade near a mature yaupon holly in the northwest corner. :contentReference[oaicite:1]{index=1}  
- Soil: compacted “black gumbo” clay, roughly neutral pH, with poor drainage. :contentReference[oaicite:2]{index=2}  
- Hydrology: French drains roughly in the center, and a planned small wildlife
  pond + bog filter that ties into the rest of the planting. :contentReference[oaicite:3]{index=3}  

Ecologically, the yard is being converted from Bermudagrass lawn into a
**native-plant–dominated system** with:

- A small wildlife pond and bog filter (approx. ~30–35 sq ft water surface). :contentReference[oaicite:4]{index=4}  
- A riparian / wicking zone around the pond.
- Upland prairie-style beds with native grasses and forbs.
- Shade guilds under and near the yaupon.

The app does **not** simulate hydrology or soil chemistry; it focuses on visual,
phenological, and structural legibility.

---

## what the app is *for*

The app is a **visual thinking tool**, not a construction drawing:

- Show how a specific native planting design looks over the **12 months of a year**.
- Communicate:
  - Which plants are present.
  - Rough size / shape / height of each plant.
  - When plants are in active growth and flowering.
  - Seasonal foliage shifts (spring flush, summer maturity, fall color, winter dormancy).
- Help a human understand:
  - Layering (groundcover → perennials → shrubs).
  - Structural “bones” vs. ephemeral color.
  - How this particular yard reads from the kitchen and patio views.

The goal is **ecological legibility**, not photo-realism.

---

## conceptual model

### 1. yard coordinate space

- The yard is modeled as a **2D rectangle in feet**.
- `x_ft`, `y_ft` in `plants.csv` are measured from a consistent **origin**:
  - origin: southwest corner of the yard (fence corner along west fence,
    closest to the house).
  - `x_ft`: increases eastward (left → right when looking from the south elevation).
  - `y_ft`: increases northward (toward the back fence).

This coordinate system is the shared basis for:

- Top-down plan view (direct mapping).
- Elevations (projecting onto the appropriate axis).

### 2. plant as a data-driven “glyph”

Each plant instance is treated as a **glyph** defined by:

- Position (`x_ft`, `y_ft`).
- Footprint (`width_ft`).
- Apparent height (`height_ft`).
- Growth shape (`growth_shape` enum).
- Seasonal state (derived from month and CSV season fields).
- Visual encodings:
  - Foliage color (seasonal).
  - Flower color (when in bloom).
  - Opacity / desaturation for dormant periods.

The **same underlying plant model** is rendered three different ways:

- Plan (top-down footprint).
- South elevation (profile against north fence).
- West elevation (profile against east fence).

### 3. phenology & seasons

For a given month (1–12), each plant is in one of several approximate states:

- **Dormant**: no active growth, maybe stems/seedheads visible.
- **Vegetative**: foliage present without blooms.
- **Flowering**: foliage + flowers (overlap with vegetative).
- **Senescing**: fading foliage, browner or more transparent.

These states are computed from CSV:

- `growing_season_months`
- `flowering_season_months`
- seasonal foliage color fields

Logic should be centralized in a **pure function** that takes
`(plant, month)` → returns a `PlantRenderState` object.

---

## non-goals / constraints

- No 3D, no perspective, no physically accurate growth simulation.
- No direct editing of plant positions in the UI (for now); editing happens via CSV.
- No external APIs or live weather; assume a “typical” Dallas climate year.
- No micro-level competition modeling (e.g., shading, root overlap); overlap is visual only.
- No detailed species-specific growth curves; height/width are taken at or near maturity.

---

## visual vocabulary principles

The app should feel:

- **Diagrammatic** – simple, flat colors, crisp edges.
- **Consistent** – same plant always looks like itself across views and months.
- **Information-dense but calm** – avoid visual noise; emphasize structure and timing.

High-level visual guidelines:

- Beds / turf / fence / sky are **background layers** and should stay stable across months.
- Plants should be distinguishable by:
  - size,
  - shape,
  - color (with a limited, reusable palette).
- Winter should look **visibly different** from peak season:
  - fewer, smaller, or more transparent glyphs,
  - muted colors,
  - but persistent woody structures (shrubs, vines) still visible if evergreen/semi-evergreen.

---

## evolution hooks

Future-friendly things Codex should respect:

- Ability to:
  - add **other CSVs** (e.g., `hardscape.csv`, `features.csv`) and render those as separate layers.
  - plug in **alternative plant data sets** for different yards without rewriting code.
  - swap backgrounds while keeping the same plant coordinate system and rendering logic.
- Keep rendering and data layers decoupled so a future user could:
  - port the model to another visualization technology (Canvas, WebGL, etc.),
  - or drive it from a different UI (e.g., React, Svelte) without redoing the domain logic.
