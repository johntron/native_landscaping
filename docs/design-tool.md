# The yard design tool (`design.html`)

Deep dive for `design.html` and `src/app.js`: how a project declares its yard, how
every view is derived from it, Setup and Features modes, photo placement and upload,
the plant CSVs, rendering, and interaction. [AGENTS.md](../AGENTS.md) is the map;
read this when you are working in `src/render/`, `src/interaction/`, `src/data/`, or
`projects/`.

## Projects

The app hosts **multiple projects** — separate yards, each with its own background
images, canvas dimensions, and compass orientation. They share one species catalog
(`plants.csv` at the repo root); each project's *selection* of species is implicit
in its own `planting_layout.csv`.

```
plants.csv                       shared species catalog (all projects)
ecology/host-genera.csv          keystone/larval-host genera per ecoregion (all projects)
ecology/plant-animal-interactions.csv  genus-keyed animal interactions (all projects)
ecology/nearby-fauna.csv         animal species reported nearby, keyed by place
ecology/anchors.csv              streams and green space near the site, keyed by place
projects/index.json              { defaultProject, projects: [{ id, name }] }
projects/<slug>/project.json     the yard in feet, plus views[]: labels, photos
                                 (and optional ecoregion + site + place, for the ecology check)
projects/<slug>/planting_layout.csv
projects/<slug>/features.json    yard features in feet; optional, absent means none
projects/<slug>/location.json    exact address/coords behind `place` (gitignored, never committed)
projects/<slug>/img/…            that project's background images
projects/<slug>/layout-history.json   (generated, gitignored)
```

**Adding a project**: create `projects/<slug>/` with the four items above, then add
`{ "id": "<slug>", "name": "…" }` to `projects/index.json`. Slugs must match
`^[a-z0-9][a-z0-9_-]*$` — they become both URL and file path segments, and the
server rejects anything else (`src/data/projectPaths.js`).

**Prefer the Setup mode toolbar over hand-editing `project.json`.** It edits the
yard, adds/reorders/removes views, and places each view's photograph by dragging
it on the drawing; *Save views* writes the file back through `POST /api/project`.
Hand-editing works too, but Setup mode cannot produce a geometry the renderers
disagree with.

### The yard, and the views derived from it

A project declares **one yard**, in feet, and every view's rectangle follows from
it. This is the single most load-bearing fact about the format:

| key | meaning |
| --- | --- |
| `yardFt` | how far the yard runs `width` east-west and `depth` north-south |
| `paddingFt` | margin drawn around it on every side |
| `elevationFt` | `above` and `below` the ground line, shared by every elevation |
| `pxPerFt` | drawing resolution; viewBox units per foot |

From those, `deriveViewGeometry` gives each view its `originFt`, `extentFt`, and
`viewBox`:

- a **plan** covers `yardFt` plus `paddingFt` on all four sides;
- an **elevation** covers whichever yard axis runs across it — width for a view
  from the north or south, depth for one from the east or west — plus the same
  margin at both ends, and `above + below` of height.

Three things fall out, and each one used to be a defect:

- **The panels line up.** Every view is drawn at one screen scale
  (`src/render/pageScale.js`), sized `extentFt × pxPerFt`, so a foot is the same
  size everywhere and a view covering twice as much yard is twice as wide.
- **The elevations share a ground row.** Identical `above`/`below` means
  identical panel heights; bottom-aligning them is all the alignment there is.
- **The shared yard cannot shrink.** `resolveYardBounds` returns the declared
  yard. The old model derived it from whatever the views overlapped, so
  reframing one view narrowed where plants could live in all of them — silently,
  and occasionally to nothing.

What a view still declares is what genuinely differs between views:

| key | meaning |
| --- | --- |
| `id` | slug; addresses the panel (`data-view-panel`), its SVG (`<id>Svg`), and its export PNG |
| `type` | `plan` (looking down) or `elevation` (looking horizontally) |
| `viewFrom` | elevations only — the compass side the viewer stands on |
| `label`, `sublabel` | panel headings; omitted when they match the defaults |
| `background` | image path relative to the project directory |
| `photoFt` | where that photo sits, as a rectangle of yard — see below |
| `viewerAtFt` | elevations only: where the camera stands on the **depth** axis; defaults to half the margin outside the edge it is taken from |

**Nothing writes a view rectangle back.** `serializeProjectConfig` emits the yard
and the per-view fields above and no geometry at all, which is what stops a save
from re-acquiring rectangles that can disagree.

Two older shapes are read and migrated on load by `normalizeProjectConfig`: the
per-view `extentFt`/`originFt` form (the yard is taken from the plan, the
headroom from the tallest elevation, and **each view's old rectangle becomes its
photograph's placement**, so no picture moves), and the pixel-authored
`{plan, elevations[]}` form before it. Detail callouts and `backgroundFrom` are
gone; a stale `backgroundFrom` in a file is ignored rather than honoured.

### What Setup mode is

Setup shows **one view at a time** — the selected one, scaled to the page — plus
the list to switch between them. Every panel used to draw guides so the foot
grid could be compared across views, because each view carried its own rectangle
and had to be aligned against its neighbours by eye. A declared yard leaves
nothing to align, and the page's whole width spent on one drawing beats four
small ones. `src/render/pageScale.js` sizes it, with a larger height budget when
focused and a ceiling on either dimension; margins for an aspect ratio that
demands them are fine.

Over that drawing: the yard's outline, its `0, 0` corner named on the canvas, an
elevation's ground line, and a foot grid on whole yard feet. All fixed
reference. Plants and features are **hidden by default** and switched on from
the panel — setup is about the yard, and a full planting drawn over a photo is
noise — except while something is stranded, when the plants *are* the subject
and the switch says so instead of pretending to turn them off.

**The camera is the one thing that moves.** Where an elevation is looked at from
is the only per-view number the yard cannot supply, and it is a position on that
elevation's depth axis — which runs into the page in its own drawing and is a
line on the plan. So it is drawn and dragged on the plan, and the patch a drag
reports belongs to a *different* view than the one under the pointer. Camera,
direction arrow, and the band of yard behind it are ONE object: they were two
marks for a while, a bar on the yard edge and a dashed line elsewhere, which is
the same fact drawn twice in two places that could disagree.

An elevation that declares no camera is still drawn one, half a margin outside
the edge it is taken from, so there is something to pick up — but marked *not
set* and with no band behind it, because absent still means cull nothing. The
default is deliberately a DRAWING concern (`defaultViewerAt`, used by the
overlay) and never written into the view: a camera outside the yard culls no
plant — a plant is never culled by any camera, only features are — but it
culls features, which are. Writing it in cost example-frontyard's `west`
elevation a bed it had drawn the day before. The first drag is what commits a
real position.

### When the yard no longer contains the design

A view can no longer miss the yard, but the yard is a number a person can type
below what is standing in it, and `resolveYardBounds` clamps only new drags — a
plant already outside cannot be dragged back. So the Setup panel counts and
names them, with how far out each one is.

**Never repaired automatically.** Resizing is exploratory — you type 6, look,
type 8 — so a yard edit redraws and reports and touches no coordinate; only a
button moves anything, and each press is one entry in the layout history. The
two actions are two *intents*, not two transforms, and the panel says so:

- **Scale the whole design to fit** is the "I mis-measured" correction. Every
  plant and every feature moves together, uniformly, about the yard's corner, so
  the design keeps its shape. Never enlarging — growing a design to fill a yard
  is not a repair — and never per-axis, because non-uniform scaling distorts the
  spacing between plants, which is most of what a planting plan is.
- **Move inside the boundary** is the "that ground is gone" correction, and
  touches only what is stranded. Available per plant as well as in bulk.

Scaling is about the yard's corner, so it can only pull in what overshoots the
far side; a plant off the south or west edge sits at a negative coordinate and
shrinking pushes it further out. That case says so rather than leaving a button
that appears to do nothing. And a scale saves the features it moved, unlike
every other feature edit: the layout is written the moment it changes, so
leaving them for a separate *Save features* would land a reload in exactly the
half-scaled state the action exists to prevent.

### Placing the photograph

`photoFt` — `{ originFt, extentFt }` in the view's own coordinates — says which
rectangle of yard the image covers, and `src/render/photoPlacement.js` maps it
through the view's transform into the pixels the panel and the PNG export both
need. Absent means "fills the panel", painted `background-size: contain` so an
uncalibrated image is shown whole rather than distorted.

Two gestures set it, on the drawing in Setup mode:

- **drag the photo** to slide it (`resolvePhotoDrag`);
- **pull a corner** to resize it (`resolvePhotoResize`), about the corner
  diagonally opposite, at one scale for both axes.

Corners only, and one scale only. A photograph has a true shape and the drawing
is the yard, so nothing here is allowed to stretch it — an edge handle would
have to. Three things make that hold:

- **The intrinsic aspect is loaded.** A gesture on a photo with no placement yet
  starts from `containPhotoFt`, the rectangle CSS is *already* drawing it at,
  which needs the image's own proportions. `app.js` keeps a `photoAspects` map
  keyed by path (content-hashed by the upload endpoint, so a cached aspect
  cannot belong to another image) and re-renders when a load lands. Starting
  from the PANEL's rectangle instead — the yard's shape, for want of that
  number — is what made the first attempt stretch every picture it touched
  (nl-0di), 4% on backyard and 39% on a 16:9 upload.
- **Both gestures work in feet**, through `xToAxis`/`yToHeight`, so a mirrored
  elevation needs no special case: "min" is the low axis value whether that is
  drawn on the left or the right, and a corner handle is named by the corner of
  the photo *in feet* that it is. Naming them by pixel position put "min y" at
  the top of a plan, where yard y is highest, so pulling one corner pinned the
  wrong opposite.
- **Resizing takes one scale factor**, from whichever axis the pointer moved
  further on relative to the current size.

**Setup widens the drawing's window** (`workingBox`, `viewBoxAttribute`) by 30%
of its larger dimension on every side — same units, same origin, just a larger
view of the same coordinates, so nothing else has to change. A photo is
routinely bigger than the yard it covers, and one you can only see the middle of
cannot be positioned. Two consequences: the setup controller reads the SVG's own
`viewBox` rather than the view's declared one, and the photo is drawn as an
`<image>` in the overlay rather than as the panel's CSS background, which would
be clipped to its element. Everything outside the view's own rectangle is dimmed
— that is exactly what the other modes crop away.

*Upload photo* puts a background on the selected view without touching the
filesystem: the browser decodes the picked file, scales it to at most 2400 px on
its long edge, and re-encodes it as WebP, stepping down a quality ladder until
it fits roughly 800 KB (`src/data/backgroundUpload.js`). The bytes go up as the
raw body of `POST /api/view-background`, and the **server** names the file —
`img/<view-id>-<content-hash>.webp` — so nothing a client sends becomes a path.
The hash is not decoration: the stored `background` string has to change for the
drawing to re-fetch anything, so a replacement photo lands on a new path and the
view's earlier uploads are deleted. A new photo also clears `photoFt`: a
placement describes a rectangle of a *particular* image.
`src/data/backgroundStore.js` holds the guards; see "Uploading a background".

**Pixels per foot is derived, never authored per view**: `viewBox.width /
extentFt.width`, and the height must agree with it or `createViewTransform`
rejects the view as non-uniformly scaled. Derived geometry cannot produce one,
which is the point. `src/render/viewTransform.js` is the single feet↔pixel
authority; renderers, drag controllers, and the setup overlay all go through it.
The toolbar's Scale control is **zoom only** — it multiplies the page scale and
never touches plant coordinates or the geometry in `project.json`.

The active project comes from `?project=<slug>`, falling back to `defaultProject`.
Switching projects **reloads the page** rather than re-initializing in place: the
render loop, history stack, and drag controllers are each built once against a
single project, and a reload keeps that simple and the URL linkable.

`projects/example-frontyard/` is a sample showing a tall narrow yard,
north/east/south elevations, and photographs placed rather than fitted.

**When a photo and the drawing disagree**, overlay the one piece of hand-traced
geometry (`features.json`) on the background photo and look: whichever placement puts
the traced shapes on the things they trace is right. Serve a scratch HTML page (one SVG
holding an `<image>` and a `<polygon>`) over `python -m http.server`, because the browser
tools block `file://`. This is how example-frontyard's stale plan origin was found.

### Yard features

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

### Elevation orientation

Yard coordinates: origin at the SW corner, **x increases east, y increases north**.
Each elevation declares `viewFrom` — the compass side the viewer stands on — and
`src/render/elevationOrientation.js` derives the rest:

| `viewFrom` | horizontal axis | mirrored | farthest plants |
| ---------- | --------------- | -------- | --------------- |
| `south`    | x               | no       | high y          |
| `north`    | x               | yes      | low y           |
| `east`     | y               | no       | low x           |
| `west`     | y               | yes      | high x          |

An elevation also has a **camera**, and until `viewerAtFt` it had none: with no
depth position the observer sits at infinity, so everything in the yard is in
front of it. A wall standing between the photographer and the bed was then drawn
*over* the bed in the view shot from the far side — the one place it is behind
the camera. `viewerAtFt` is one number in yard feet on the view's depth axis
(`x` for `east`/`west`, `y` for `north`/`south`). The side follows `farIsHigh`
rather than the compass name: `south` and `west` stand at the LOW end of that
axis — south of the yard, west of it — while `north` and `east` stand past its
far side. It defaults to half the margin outside that edge, which is where a
person stands to photograph their yard and which culls nothing.

**Absent means cull nothing.** No project has to declare one, and one that does
not draws exactly what it drew before — the opposite default from
`normalizeFeatures`, which refuses a missing height because there a default
hides a shape. Zero is a real position, so every test is on finiteness, never
truthiness.

One rule follows from it, and a plant is deliberately exempt:

- **A feature entirely behind the camera is culled** from that elevation
  (`isBehindViewer` in `src/render/elevationOrder.js`). The test is on
  `depthFt.far`, the edge least behind the camera — not on `depthFt.near`, which
  is what the sort reads — so a fence the camera stands in the middle of keeps
  the behaviour it already had rather than half-vanishing.
- **A plant is never culled, and never bounded by a camera either.**
  `resolveYardBounds` used to narrow the depth axis to the nearest observer so a
  plant could never be dragged behind one, but a plant was never culled to begin
  with — the narrowing bought nothing but a smaller buildable area, and two
  cameras facing each other (as on the Walkway project) could squeeze it to a
  sliver. A plant is bounded by the declared yard alone; going past a camera
  only changes how it sorts in that one elevation's depth order (`elevationOrder.js`),
  never whether it is drawn.

**The cull is drawn on the PLAN, in Setup mode** — a dashed line at each
elevation's `viewerAtFt` with the yard behind it tinted, labelled on the side
that elevation can still see, and emphasised while that view is selected. It has
to be the plan: `viewerAtFt` lives on the depth axis, which in its own elevation
runs into the page, so every point of that picture is at every depth and there
is nowhere in it to put the line. On a plan the same number is a line and the
region past it is a shape. A camera outside the plan's rectangle clamps its band
to the drawing, so it reads as "all of this" or as nothing, which is what it means.

Mirrored views reflect about the viewBox centre, so `originFt.x` always means the
**near** edge — which mirroring puts on the *right* for `north` and `west`. Go
through `viewTransform`'s `axisToX` / `xToAxis` and that is automatic; do the
subtraction in feet by hand and it is not.

### Yard bounds

**A plant is clamped to the declared yard, never to the view it is being dragged
in** (`resolveYardBounds` in `src/render/yardBounds.js`): `0..yardFt.width` on x,
`0..yardFt.depth` on y, and nothing narrows it further. An elevation's rectangle
includes drawing margin that is not plantable ground, so clamping to the view
under the pointer let a plant reach a coordinate the plan cannot draw, and it
silently vanished from the plan. No camera narrows the yard either; see
"Elevation orientation" above for why a plant is never culled.

Because every view is derived from the one yard, views can no longer disagree
about where plants may live. The remaining failure is a yard typed smaller than
the planting, which Setup mode reports; see "When the yard no longer contains the
design".

## Background layers

- Each view's **static background image** is declared in its `project.json` as a
  path relative to the project directory, and applied by `src/render/viewConfig.js`.
  A stylesheet cannot vary backgrounds per project, so `styles.css` no longer sets them.
- An **unplaced** photo is painted `background-size: contain`, not stretched to
  the panel: it has no rectangle of its own yet, so it is shown whole rather than
  distorted to a shape it has no reason to share. Once it is placed,
  `photoPlacement.js` overrides both size and position with the rectangle the
  photo actually covers. **A photo never reshapes a view** — the view is the
  yard, and an upload leaves the yard alone.
- The panel is `extentFt × --page-px-per-ft` on both axes, one scale for the
  page (`src/render/pageScale.js`). The scale is chosen so the widest view fits
  the container or the tallest fits 70vh, whichever binds first, so a tall yard
  scales the whole page down rather than running page-long on its own.
- Requirements:
  - Must be **orthographic** (no perspective, no vanishing lines).
  - Vector-like: use flat color fields and simple shapes, not noise textures.
  - Exclude columns, patio slabs, feeders, furniture, and plants.
- JavaScript treats backgrounds as **read-only assets** while drawing — overlays are
  SVG only. The one writer is Setup mode's *Upload photo*, which replaces a view's
  background wholesale and never edits pixels in place.

### Uploading a background

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

## Plant data (CSV)

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
- `sun_pref`, `water_pref` – single values.
- `soil_pref` – an accepted-soil SET, comma-separated (e.g. `sandy,loamy,clay`);
  `checkSoil` in `src/analysis/rules/siteMatch.js` splits on `[,/|]` and tests
  membership. `nl-9a6` migrated the rows USDA's characteristics endpoint
  actually has a soil_coarse/medium/fine triple for — 23 of 56 species — to a
  real accepted set. The other 33 have no USDA characteristics record at all
  (not a fetch failure — USDA covers only ~2,200 species nationwide) and still
  hold one PREFERRED soil with no tolerance data, so rule 8's soil stopgap
  (see the comment atop `siteMatch.js`) stays in place for those.
- Optional `dormant_color`, `flowerColor`, or alias fields handled by `plantParser`.

When changing behavior, **extend the CSV schema and parsing** (see `src/data/plantParser.js`) instead of hard-coding plant properties inside rendering logic.

## Rendering model

Rendering is **data-driven**. For every selected month:

1. `buildPlantsFromCsv` merges species + layout rows into renderable objects.
2. `computePlantState` determines active growth, flowering, and foliage colors.
3. `renderViews` hands the plant state list to each view renderer:
   - `renderTopView` draws foliage/bloom circles scaled to `width_ft`.
   - `renderElevationView` draws simplified profiles based on `growth_shape` and
     `height_ft`, mapping feet to pixels through the view's own `viewTransform`.

Top view uses the yard coordinate system (origin at SW corner, y increasing north). Elevations reuse the same data but map either x or y as horizontal distance to convey layering depth. Taller plants naturally overlap because each renderer clears and repopulates its SVG every frame (`render/topView.js`, `render/elevationViews.js`).

## Interaction and controls

- Month selector (`#monthSelect`) controls seasonal state.
- Scale input + slider are **zoom**: they multiply the page scale and nothing else, with bounds in `SCALE_LIMITS`. Physical scale belongs to the project's `yardFt`.
- Mode pills switch between View, Edit (drag plants), Setup (declare the yard, place photos), and Features
  (draw the yard model).
- Lock toggle enables/disables drag-to-move behavior powered by `createPlantDragController`, which clamps edits to the declared yard and triggers rerenders.
- **Each view SVG has several controllers, so none may own an inline style.** The drag,
  setup, and (on plans) feature controllers are bound to the same element; while both wrote
  `svg.style.touchAction`
  the later writer silently won and Edit mode sat at `touch-action: auto`, so the page
  scroller took every drag. Each now toggles its own class (`is-drag-enabled`,
  `is-setup-enabled`, `is-features-enabled`) and `styles.css` combines them — see the comment
  there for why neither `pan-y` nor per-plant `touch-action` works. The cursor had the same
  bug (nl-jfm, fixed): resting cursors now come from those classes too. `applyMode` decides all the lock states in
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

## Key modules

- `src/app.js` – application entry point; wires up DOM, loads CSVs, drives rendering loop and drag/export controls.
- `src/constants.js` – canonical sizes, offsets, and scale defaults shared across modules.
- `src/data/csvLoader.js` – fetch + minimalist CSV parser (also used by tests).
- `src/data/projectConfig.js` – project index/config loading, normalization, and slug validation.
- `src/data/projectPaths.js` – server-side resolution of a project's data files (path-traversal guard).
- `src/render/elevationOrientation.js` – compass → axis/mirror/depth mapping for elevations.
- `src/render/viewTransform.js` – the one feet↔pixel authority, wrapping that mapping.
- `src/render/yardBounds.js` – the declared yard a plant may be dragged within.
- `src/render/photoPlacement.js` – which photo a view draws, and where in the panel it lands.
- `src/render/pageScale.js` – the one screen scale every panel is drawn at.
- `src/data/backgroundUpload.js` – browser-side resize/re-encode, and the upload POST.
- `src/data/backgroundStore.js` – server-side upload guards: allowed types, magic-byte
  sniff, and the filename the server (never the client) chooses.
- `src/interaction/setupMode.js` – Setup mode itself: the panel, the one-view setup overlay, validation of every view edit (`applyViewEdit`), photo upload, and the scale-to-fit / move-inside actions. The setup controllers and the photo-aspect cache they read stay in `app.js`.
- `src/interaction/setupPanel.js`, `src/interaction/setupController.js`, `src/render/setupOverlay.js` – Setup mode's yard form and stranded-plant list, the camera drag, and the guides.
- `src/interaction/featuresMode.js` – Features mode itself: the panel, the plan overlay, and edit → validate → save for features.json. The controllers stay built in `app.js`'s `rebuildViews` beside the drag and setup controllers.
- `src/interaction/featurePanel.js`, `src/interaction/featureController.js`, `src/render/featureOverlay.js` – Features mode's list, plan-only drag handles, and selection outline.
- `src/data/plantParser.js` – merges species/layout CSVs, normalizes month specs, aliases, and seasonal palettes.
- `src/data/layoutExporter.js` – converts in-memory plants back to CSV with consistent precision/escaping.
- `src/render/*` – view configuration, SVG helpers, tooltip builder, plan view and elevation renderers.
- `src/state/seasonalState.js` – pure logic for foliage/bloom state per month.
- `src/interaction/dragController.js` – pointer events + hit-testing for moving plants in plan view.
- `src/history/layoutHistory.js` – the undo/redo stack; server-backed via `/api/history`.
- `src/state/plantEdits.js` – add, clone, and remove a plant; `src/state/yardEdits.js` – scale and
  shift features, patch a view. Pure, and unit-tested directly.
- `src/render/speciesTable.js` – the species table; `src/interaction/plantMenu.js` – the plant's
  Clone/Remove menu.
- `src/export/exportActions.js` – the plan-bundle and HOA-packet downloads: render in June,
  capture every view, zip, restore the page. Covered by `tests-e2e/export.spec.js`.
- `src/ui/detailSheet.js` – the plant detail sheet: facts for the month, keystone/larval-host
  notes, and nearby animals that use the genus.
- `src/ui/projectPicker.js` – the project picker and new-project form; `src/ui/controls.js` – the
  month slider, zoom controls, scale bars, and button/download helpers.

Persistence routes (`/api/layout`, `/api/history`, `/api/history/cursor`, `/api/project`,
`/api/features`, `/api/view-background`) all require `?project=<slug>` and write inside
that project's directory only. `design.html` loads JSZip from `node_modules/`, so run
`npm install` once before serving.

## Domain and code rules for this tool

- Plants do not appear in months outside their growing season; dormant months
  desaturate foliage. Winter reads **sparser and browner** unless the species is
  evergreen or semi-evergreen per the data.
- Support every growth form and stratum (groundcover to small tree) with one generic,
  reusable visual vocabulary. Diagrammatic, not photorealistic.
- Every `id` in a `planting_layout.csv` is **unique**: ids address plants for dragging,
  cloning, and highlighting, so a repeat makes every later row unreachable.
  `parsePlantLayoutCsv` rejects duplicates with a `LayoutDataError`. Mint ids through
  `src/state/plantIds.js` (`buildCloneId`, `buildNewPlantId`).
- DOM queries stay in `src/app.js`; the only global mutable state is `appState`.
- Comment any non-obvious geometry: coordinate transforms, scaling, hit-testing.
