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

The app runs in **Docker**, not as a bare `npm run serve`: `docker-compose.yml`
defines service `web` (container `native_landscaping-web-1`) on
`127.0.0.1:8080`, with the repo bind-mounted at `/app` and a `cloudflared`
sidecar in front of it. The bind mount means the code on disk *is* the code in
the container; only the node process can be stale.

### After every change: test, commit, restart

This is a standing instruction, not a suggestion, and it is standing
authorization — do all three without being asked:

```bash
npm test                     # 1. gate
git add … && git commit      # 2. commit the change
docker compose restart web   # 3. restart the DEPLOYED server
```

Restart **every time**, even though `src/` is bind-mounted and served fresh per
request so only `server.js` strictly needs it (see “Restarting the server”
below). The point is that the deployed process is known-current after every
change rather than reasoned about case by case. Never restart `cloudflared` —
it self-heals, and its token is what keeps this project's tunnel separate from
every other one on the host.

Pushing to `origin` is **not** part of this loop; ask first.

For a throwaway static server with no persistence API, `npx serve .` or
`python -m http.server 8000` still work. Run `npm test` when touching parsing or
state logic. If you introduce tooling (Vite, React, etc.), keep it lightweight
and document the commands under “Tooling”.

### Restarting the server

Node does not hot-reload, so a long-running process keeps serving the routes it
booted with while happily serving updated `src/` files on reload. A POST to a
route added after the server started falls through to the static handler and
returns **404, not 400** — that 404 is the signature of a stale server, not of a
missing route.

**Verify the restart; do not trust the command's output.**

```bash
docker inspect native_landscaping-web-1 --format '{{.State.StartedAt}} {{.State.Pid}}'   # before
docker compose restart web
docker inspect native_landscaping-web-1 --format '{{.State.StartedAt}} {{.State.Pid}}'   # after — both must change
docker compose exec -T web node -e "console.log(process.uptime())"                       # ~0 on a real restart
```

Two traps:

- `docker compose ps` prints **elapsed** uptime. Two hours after a real restart
  it reads `Up 2 hours`, which looks exactly like a restart that never happened.
  That is the display, not a failure — compare `StartedAt` instead.
- `ps` is not installed in `node:22-slim`. Use `docker compose exec -T web node -e`.

Then confirm the served bytes actually carry the change — `curl` the module and
grep for an identifier that only exists in the new code.

If someone reports a change is still not live after a *verified* restart,
suspect their browser tab rather than the server: `server.js` sends
`Cache-Control: no-store`, so nothing is cached, but a page loaded before the
deploy keeps its ES module graph until an actual reload.

---

## Project Structure & Responsibilities

### 0. Projects

The app hosts **multiple projects** — separate yards, each with its own background
images, canvas dimensions, and compass orientation. They share one species catalog
(`plants.csv` at the repo root); each project's *selection* of species is implicit
in its own `planting_layout.csv`.

```
plants.csv                       shared species catalog (all projects)
ecology/host-genera.csv          keystone/larval-host genera per ecoregion (all projects)
projects/index.json              { defaultProject, projects: [{ id, name }] }
projects/<slug>/project.json     the yard in feet, plus views[]: labels, photos
                                 (and optional ecoregion + site, for the ecology check)
projects/<slug>/planting_layout.csv
projects/<slug>/features.json    yard features in feet; optional, absent means none
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

#### The yard, and the views derived from it

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

#### What Setup mode is

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

#### When the yard no longer contains the design

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

#### Placing the photograph

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

`projects/example-frontyard/` is a throwaway template showing a tall narrow yard,
north/east/south elevations, and photographs placed rather than fitted; delete it
once you have real projects.

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

Because the yard is shared, **one view's geometry silently shrinks where plants
and features may live in every other view**. Reframing the plan with a corner
handle and leaving the elevations behind strands them in the old coordinate
frame: the yard collapses to whatever corner still overlaps, or — if an
elevation misses the plan entirely — to nothing that view can draw at all.
Nothing on the canvas shows it. So `describeYardBounds` reports the resulting
rectangle, the plan's, and which view holds each edge that differs, and **Setup
mode reads it out under "Shared yard" on every edit, before Save**; a view that
overlaps the plan nowhere is called out in red there and, for a project already
saved that way, in `#projectNotice` at boot. That is the guard — `resolveYardBounds`
itself still falls back to the plan silently on purpose, because a drag needs
some bound.

The other half of alignment is the **foot grid, which every view draws in Setup
mode** — not just the selected one. Grid lines land on whole yard feet so the
same 5 ft line appears in the same place in every view, which is only a
reference if you can see it in more than one at a time. Handles, the ruler, and
pointer capture still belong to the selected view alone; the neighbours are
drawn at reduced opacity so they read as reference rather than as targets.

### 1. Background Layers

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
- Scale input + slider are **zoom**: they multiply the page scale and nothing else, with bounds in `SCALE_LIMITS`. Physical scale belongs to the project's `yardFt`.
- Mode pills switch between View, Edit (drag plants), Setup (declare the yard, place photos), and Features
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

## Ecological Analysis

The app grades a planting against ecological rules and reports **per dimension with
no composite score** — a 0–100 roll-up would need weights nobody can justify, so
each dimension reports for itself and the reader decides what to fix first. Six
dimensions ship: bloom succession (6), fall/winter bird food (7), vertical layers
(11), keystone genera (4/10), larval hosts (5), and site match (8).

```
ecology/host-genera.csv          one genus-keyed table, shared by rules 4, 5, 10
src/analysis/ecology.js          the registry; analyzeEcology(ctx) -> one result per rule
src/analysis/hostGenera.js       parse + index the table, resolving synonym_of
src/analysis/months.js           month-set helpers ("Oct-Feb", not "Oct, Nov, Dec, …")
src/analysis/rules/*.js          one file per rule: { id, title, evaluate(ctx) }
src/render/ecologyPanel.js       the panel above the species table — presentation only
```

**`src/analysis/` is pure.** No DOM, no fetch, no judgement made outside it. Every
threshold and verdict lives in a rule module; `ecologyPanel.js` renders what it is
handed and must not invent a status of its own.

**`status` is a closed set of four** — `ok` (nothing to do), `partial` (works, has a
hole), `gap` (the dimension is essentially unmet), `not-declared` (the input this
rule needs is absent). The panel maps exactly four chips, so a fifth value would
render as an unstyled blank rather than fail loudly. `analyzeEcology` normalizes
anything else to `not-declared`, and a rule that **throws** becomes a
`not-declared` row naming the failure: the analysis is advisory and must never be
the reason a yard stops rendering.

`ctx` is built once by `buildEcologyContext` — `{ plants, species, placedSpecies,
unplacedSpecies, placedGenera, hostGenera, site, ecoregion }`. `plants` are the
objects `createPlantFromSpecies` already minted; **the analysis never builds its own
plant shape**, or the two paths drift and a rule grades a plant the renderer would
draw differently. Rules count by *species*, not by plant: a drift of nineteen asters
is one answer to "what blooms in October", not nineteen. Rule 11 reuses
`classifyPlantLayer` rather than re-bucketing by height, for the same reason.

### `ecology/host-genera.csv`

Rules 4, 5, and 10 all reduce to "what does this genus do for insects", so they
share **one checked-in table** rather than three. Per-species columns on
`plants.csv` were rejected: 48 rows of hand-researched booleans is expensive and
invites invention.

Columns: `genus, ecoregion, lep_host_species, bee_specialist_species, larval_hosts,
synonym_of, source`.

- The keystone counts are the NWF *Keystone Native Plants* top-30 lists for **EPA
  Level I ecoregion 9, Great Plains** — where Dallas and the Blackland Prairie sit —
  transcribed verbatim from
  <https://www.nwf.org/-/media/Documents/PDFs/Garden-for-Wildlife/Keystone-Plants/NWF-GFW-keystone-plant-list-ecoregion-9-great-plains.pdf>.
  Extract with `pdftotext -layout` and **check twice**: the two-column layout drops
  `Alnus` (164) from a line-wise read of the caterpillar column, and wrapped rows put
  the count on the following line. `Salix`, `Solidago`, and `Helianthus` appear on
  both lists and are ONE row with both columns filled.
- `larval_hosts` covers documented relationships the keystone lists miss —
  `Asclepias`→monarch, `Passiflora`→gulf fritillary. **Rule 5 reads this column, not
  the keystone counts**: `Asclepias` is on neither top-30 list, so deriving rule 5
  from keystone membership would report a monarch garden as hostless.
- `synonym_of` is load-bearing. NWF files ragwort under `Senecio`; the catalog and
  both layouts use `Packera obovata`. Without the mapping the frontyard's ragwort is
  silently missed.
- `ecoregion` is a column, so **a second region is a data change, not a code change**.
- **Every row carries a `source`, and a genus with nothing sourced stays blank rather
  than guessed** — see "Don't invent fake plant data" above.

### `project.json`: `ecoregion` and `site`

```json
"ecoregion": "9",
"site": { "sun": "part-sun", "water": "medium", "soil": "clay" }
```

Both optional, and a partial `site` is allowed: what is undeclared is reported as
undeclared, never guessed. Vocabularies are `SITE_VOCABULARY` in
`src/data/projectConfig.js`. **`serializeProjectConfig` whitelists fields** — a field
added only to the normalizer survives in memory and vanishes the first time Setup
mode saves, with no error, so both halves must be touched and
`tests/projectConfig.test.js` asserts the round trip.

### `sun_pref` and `water_pref` are REQUIREMENTS, not tolerances

Commit `ed9d75c` fixed exactly this inversion once already. `full-sun` means *needs a
lot of light* (little bluestem, Indiangrass); `shade` means *needs little* (Carex
blanda, inland sea oats). So rule 8's comparison is **asymmetric, not a distance**:

| direction | failure |
|---|---|
| wants more light than the site gives | weak bloom, stems flopping — real at one step, hard at two |
| wants less light than the site gives | scorch — mild at one step, real at two |
| wants more water than the site gives | droughts out |
| wants less water than the site gives | rots |

Soil is set membership, not a scale. Both directions on both scales are covered in
`tests/ecology.test.js`; keep them covered.

### Two results that look like bugs and are not

- **Keystone genera read weak, and cannot be fixed from the catalog.** Only six of
  the catalog's 42 genera are keystone in ecoregion 9 — `Helianthus`, `Solidago`,
  `Symphyotrichum`, `Verbesina`, `Vernonia`, and `Packera` (via `Senecio`) — and
  **none are woody**. `Quercus` alone hosts 253 caterpillar species and the catalog
  carries no oak. The rule names the missing heavy hitters as a gap to close, not as
  an error.
- **Rule 4/10 measures footprint AREA**, `π(width/2)²`, not head-count: rule 10 is
  about how the yard's ground is spent. `createPlantFromSpecies` defaults `width` to
  1, so a species with a blank `width_ft` would silently contribute 1 ft² — harmless
  for a perennial, badly wrong for a tree. Such plants are excluded from **both**
  sides of the ratio and the finding says how many.

### Why FQA was rejected

Floristic Quality Assessment grades how intact a **remnant's existing flora** is —
the wrong instrument for a design. Its FQI metric rewards species richness, which
directly contradicts the drift and concentration rules; and no verified North Central
Texas C-value list is in hand, so implementing it would mean inventing plant data.
Don't re-propose it.


---

## Code Layout Highlights

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
- `src/interaction/setupPanel.js`, `src/interaction/setupController.js`, `src/render/setupOverlay.js` – Setup mode's yard form and stranded-plant list, the camera drag, and the guides.
- `src/interaction/featurePanel.js`, `src/interaction/featureController.js`, `src/render/featureOverlay.js` – Features mode's list, plan-only drag handles, and selection outline.
- `src/data/plantParser.js` – merges species/layout CSVs, normalizes month specs, aliases, and seasonal palettes.
- `src/data/layoutExporter.js` – converts in-memory plants back to CSV with consistent precision/escaping.
- `src/render/*` – view configuration, SVG helpers, tooltip builder, plan view and elevation renderers.
- `src/analysis/ecology.js` – the ecological rules registry; pure, no DOM. See **Ecological Analysis**.
- `src/analysis/hostGenera.js` – the genus-keyed keystone/larval-host table and its synonym resolution.
- `src/render/ecologyPanel.js` – the per-dimension check above the species table; presentation only.
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
- Run `npm run serve` (or `node server.js`) to launch the bundled static + persistence server locally — but the deployed instance is the Docker `web` service, and every change ends with `docker compose restart web`; see **Dev Workflow**. `/api/layout`, `/api/history`, `/api/history/cursor`, `/api/project`, `/api/features`, and `/api/view-background` are all scoped by a required `?project=<slug>` query parameter and write inside that project's directory only.
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

