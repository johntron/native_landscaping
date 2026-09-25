# The yard design tool (`design.html`)

Deep dive for `design.html` and `src/app.js`: how a project declares its yard, how
every view is derived from it, Setup and Features modes, photo placement and upload,
the plant CSVs, rendering, and interaction. [AGENTS.md](../AGENTS.md) is the map;
read this when you are working in `src/render/`, `src/interaction/`, `src/data/`, or
`server/routes/project.js` and `server/db/projectStore.js`.

## Projects

The app hosts **multiple projects** — separate yards, each with its own background
images, canvas dimensions, and compass orientation. They share one species catalog
(`plants.csv` at the repo root); each project's *selection* of species is implicit
in its own layout.

### Where a yard lives (nl-3s5.3)

A yard is **private to the person who made it**, and lives in `app.db`
(`server/db/projectStore.js`, migration `server/db/migrations/003_projects.sql`),
not in the repo:

| what | where | how the browser gets it |
| --- | --- | --- |
| the yard list | `projects` rows for the caller (`owner_id`), oldest first; the oldest is the default | `GET /api/projects` |
| the config (the yard in feet, `views[]`, optional `ecoregion`, `site`, `place`) | `projects.config_json` (the copy at the cursor), stored as saved, normalized on read | `GET`/`POST /api/project` |
| the revision history behind undo/redo (planting, setup and features) | `history_entries` (one row per revision: `kind`, placements, `config_json`, `features_json`) and `projects.history_cursor` | `GET /api/history`, `POST /api/layout`, `POST /api/history/cursor` |
| yard features | `projects.features_json` (the copy at the cursor; NULL means none drawn) | `GET`/`POST /api/features` |
| the exact location behind `place` | `projects.location_json` | never, except `{ lat, lng }` to the owner in `/api/ecosystem` |
| photos | files under `DATA_DIR/projects/<projects.id>/img/`, outside the served root | `GET /api/project-photo?project=<slug>&path=img/<file>` |

```
plants.csv                       shared species catalog (all projects)
plant-drawing.csv                how each species is drawn, keyed by plants.csv id (all projects)
ecology/host-genera.csv          keystone/larval-host genera per ecoregion (all projects)
ecology/plant-animal-interactions.csv  genus-keyed animal interactions (all projects)
ecology/nearby-fauna.csv         animal species reported nearby, keyed by place
ecology/anchors.csv              streams and green space near the site, keyed by place
projects/backyard/               the one yard still tracked: seed data for the shared
                                 read-only example (nl-3s5.24), in the old file layout
```

What follows from that:

- **Every `?project=<slug>` is resolved among the caller's own yards.** Slugs are
  unique per owner, not globally. `server/http.js`'s `loadOwnedProject`, handed
  `findCallerProject`, answers 401 to an anonymous caller and the same 404 to a
  slug that does not exist and to someone else's; admins get no bypass. That holds
  on every route that takes a yard, `/api/ecosystem` included, and
  `tests/projectAuthorization.test.js` proves it route by route (nl-3s5.4). No
  route takes a yard from a request body or the path. `/api/ecosystem`'s species
  rows are keyed by yard (app.db `projects.id`, nl-3s5.6), never by the free-text
  `place` label, so `?project=` is required and no label one user types reaches
  another's rows. The shared example shows the index of the yard it was refreshed
  from, with no location. See [the nearby-species index](ecology-rules.md#the-nearby-species-index-dataecosystemdb).
- **`projects.visibility` is `'private'`.** Triggers (migration 004) let the column
  hold only `'private'` or `'public'`, and `'public'` is reserved for the public
  view (nl-3s5.10): the store assigns only `'private'` and no route reads a
  visibility from a request.
- **History is the yard.** There is no stored `planting_layout.csv` any more: the
  layout is the entry at the cursor. `GET /api/layout?project=<slug>` exports it
  as the CSV the file used to be (`id,species_id,x_ft,y_ft`, now followed by
  the lifecycle columns below), and nothing reads one back.
- **One revision stream for the planting, the setup and the features**
  (nl-3s5.20, migration 005). Every `POST /api/layout`, `POST /api/project` and
  `POST /api/features` appends one revision (`kind` `planting`, `setup` or
  `features`), and all three share one `seq` per yard, so Undo and Redo step
  across them. Each row is a full snapshot (placements, config, features), so
  `POST /api/history/cursor` restores any revision with one row read, and
  rewrites `projects.config_json`, `features_json` and `name` from it in the
  same transaction. Those columns stay the copy at the cursor, so everything
  that reads the projects row is unchanged. A save after an undo drops the redo
  tail, whatever its kinds: a plant move after undoing a *Save views* deletes
  that setup revision. The first save of a yard with no history seeds revision 0
  with the yard as it was, so the page's stack and the stored one keep the same
  indices. Entries from before 5.20 became planting revisions carrying the
  yard's setup and features as they were at the migration, because there was
  no older history of either. The location is not a revision.
- **`GET /api/history` sends `config` and `features` only where they change**
  from the entry before (always on the first); an entry without the key carries
  the previous one's, and `features: null` means none drawn. Every snapshot
  would be over a megabyte for a yard with a few hundred revisions.
- **The page and the server must agree on every index**
  (`src/history/layoutHistoryController.js`). Every request goes through one
  queue in the order the stack changed; each save is recorded locally when sent
  and the server's answer annotates that entry; a refused save is taken back off
  the stack if nothing came after it. The server's cursor is checked, never
  adopted: if it disagrees (another tab saved, or a tab opened before a deploy),
  the page stops offering undo and says to reload. A *Save views* or *Save
  features* that would store what the current revision already holds sends
  nothing, so pressing Save twice is not two undo steps.
- **Each save is one transaction** (`BEGIN IMMEDIATE`, nothing awaited inside it,
  because `ctx.db.app` is one connection shared by every request). Two tabs saving
  the same yard are serialized: both entries land, in order, and no write is torn.
  The later one does not know about the earlier one, so its layout wins at the
  cursor; the other is one undo away. Refusing a stale tab's save outright (a 409
  on a base-entry mismatch) is not done yet.
- **Nothing under `projects/` is served.** `server/static.js` no longer lists it; a
  photo is only reachable through the owner-checked route, which also sends
  `X-Content-Type-Options: nosniff` and a sandboxing CSP.

**Adding a project**: *+ New project* in the design tool (`POST /api/projects`),
which gives it one plan view and no history. Slugs must match
`^[a-z0-9][a-z0-9_-]*$`; the photo path a view names is held to
`img/<name>.(webp|png|jpg|jpeg|svg)` (`src/data/projectPaths.js`).

**A yard's location** is set with `node tools/project-location.mjs --project <slug>
--lat <n> --lng <n>` (or `--address "..."`); run it with no value to see whether
one is set, without printing it. The fetch scripts read it, and `place`, through
`tools/projectSite.mjs`. `--owner <email>` (else `OWNER_EMAIL`, else the sole
admin) says whose yard, since slugs are per owner.

### Importing yards from files

`tools/import-projects.mjs` copies yards laid out the old way
(`<dir>/index.json` and `<dir>/<slug>/{project.json, features.json, location.json,
layout-history.json, planting_layout.csv, img/}`) into `app.db`, once
(`server/db/projectImport.js`, recorded as `legacy_import.projects` in `app_meta`).

```bash
node tools/import-projects.mjs --dry-run [--projects-dir <dir>] [--slug <slug> ...]
node tools/import-projects.mjs          [--projects-dir <dir>] [--slug <slug> ...]
```

- **Copy, never move.** Source files are only read. Photos are copied byte for byte
  (checked by hash) to `DATA_DIR/projects/<id>/img/`.
- **The layout file still wins, once.** Each yard's `planting_layout.csv` picks its
  cursor exactly as the old client did on load (`src/history/reconcileLayout.js`,
  which now runs here and nowhere else): the matching entry becomes the cursor, and
  a CSV that matches none is appended as "Layout file edited outside the app". A
  yard with a CSV and no history gets it as an "Initial layout" entry.
- **Fail closed.** A listed yard without `project.json`, a history that does not
  parse (only a *missing* one reads as empty), a layout row without a species id,
  or yards on disk with no `index.json` throw before anything is written, and no
  marker is recorded. So does a copy that does not verify inside the transaction
  (entry count, cursor, config/features/location text, photo count), rolling back
  and removing the photo directories that run made.
- **Owner:** `OWNER_EMAIL`, else the sole admin; with neither, nothing is imported.
  A slug the owner already has is left alone and reported as `skipped-exists`.
- **`--dry-run`** opens `app.db` read-only and migrates nothing, so it works on the
  live file with web up and on a schema that has no `projects` table yet. It prints
  counts and yes/no only, never a location or a config body.
- **Web never runs it on start**, unlike `server/db/legacyImport.js`. The commit that
  stopped tracking the private yards deletes their tracked files from any tree it is
  merged into, and an import on the restart after that merge would have found the
  yards half gone. Stop web, import, then deploy.

**Setup mode is how a yard's config changes.** It edits the yard,
adds/reorders/removes views, and places each view's photograph by dragging it on
the drawing; *Save views* stores it through `POST /api/project` as one setup
revision, which Undo takes back (the buttons show in Edit, Setup and Features
modes). Undo restores a setup by replacing the project, not merging onto it, so
a field the older setup lacked comes back absent. The ecology tables are loaded
once for the ecoregion the page opened with, so an undo that changes the
ecoregion is checked against the old tables until a reload. (The config is
still called `project.json` below: it is the same JSON the file held.)

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
button moves anything, and each press is one planting revision in the history
(two when a scale or a move also saves features, one each). The
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
view's earlier uploads are deleted, except any a revision still names (below). A new photo also clears `photoFt`: a
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

`tests-e2e/scratch-fixture.mjs`'s `FRONTYARD_SAVE_VIEWS` is a sample of a tall
narrow yard with north/east/south elevations and photographs placed rather than
fitted.

**When a photo and the drawing disagree**, overlay the one piece of hand-traced
geometry (`features.json`) on the background photo and look: whichever placement puts
the traced shapes on the things they trace is right. Serve a scratch HTML page (one SVG
holding an `<image>` and a `<polygon>`) over `python -m http.server`, because the browser
tools block `file://`. This is how example-frontyard's stale plan origin was found.

### Yard features

Beds, hardscape, fences, and the house footprint are **yard geometry in feet
shared by every view**, so they live in the yard's features (`features.json` as
was, `projects.features_json` now) rather than in `project.json`, which holds
per-view presentation. There is one model
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
features*, which records one features revision that Undo can take back.

Features load through `GET /api/features` and save through `POST /api/features`
(`loadProjectFeatures` / `persistFeatures` in `src/data/persistence.js`). Most
projects have never drawn a feature, and the endpoint answers those with an empty
list rather than an error. Each save is a revision in the yard's one history
(nl-3s5.20); `POST /api/features` answers the saved list plus `revision`.

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
  path relative to the yard (`img/<file>`), loaded through `GET /api/project-photo`
  (`projectAssetPath` in `src/data/projectConfig.js`), and applied by
  `src/render/viewConfig.js`.
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
  the photo route returns it as `image/svg+xml`, which executes script when opened
  directly, so an uploaded SVG would be stored XSS against everyone who opens the
  project. (The route's sandboxing CSP is a second line, not a reason to relax this.)
- **Size**: capped at 8 MB, checked as chunks arrive rather than from
  `Content-Length` (a claim, not a fact). Over the cap the request is paused,
  answered with 413, and only then destroyed — destroying first drops the
  connection before the explanation reaches the client.
- **Path**: the filename is built from the validated view id, a SHA-256 prefix of
  the content, and an extension derived from the *sniffed* type, then re-checked
  for containment inside the yard's `img/` under `DATA_DIR`. View ids are slugs on
  the same pattern as project ids, for the same reason: this one becomes a filename.
- **Write**: temp file then rename (`writeFileAtomic`), so a crash never
  leaves a half-written photo. Superseded uploads for that view are removed
  afterwards, best effort — the new background is already usable, so tidying up
  must not fail the request.
- **Kept while any revision names it** (nl-3s5.20). Undo can bring back a setup
  that shows an older photo, so neither sweep (superseded uploads on upload,
  orphaned ones on *Save views*) deletes a file that any revision's config, or the
  current config, references (`referencedBackgroundNames` in
  `server/db/projectStore.js`, scanning every `background` key). An upload no
  revision ever saved is still swept, and so is a photo whose only revisions were
  truncated by a save after an undo, at the next sweep. A photo swept before
  5.20 is gone; a restored setup that names a missing file draws no photo (the
  route answers 404) rather than failing.

The client-side re-encode is a second line of defence as well as a size
reduction: the uploaded bytes are ones the canvas produced from decoded pixels,
so EXIF, colour profiles, and anything appended to the original file do not
survive the round trip. EXIF *orientation* is applied during decode
(`imageOrientation: 'from-image'`) and baked into the pixels, which is what keeps
a phone photo from landing sideways.

## Plant data (CSV)

`plants.csv` is the **single source of truth** for species attributes, shared by every project, and `plant-drawing.csv` beside it says how each species is drawn (below); each yard's layout holds per-plant coordinates (in feet) and references each species by **plants.csv's `id`**, never by botanical name. The layout is stored as history placements (below); `GET /api/layout` exports it as `planting_layout.csv`.

Each layout row describes one plant clump or individual:

```
id,species_id,x_ft,y_ft,status,planted_on,source,source_nursery,source_sale_organizer,source_sale_event,source_sale_date
beautyberry-east,beautyberry,11.825,16.566,planted,2026-04-18,Native Gardeners,Native Gardeners,,,
```

- `id` – the plant's own id, unique within the layout.
- `species_id` – plants.csv's `id` for the species (a slug such as `fragrant-sumac`).
- `x_ft`, `y_ft` – offsets in feet from the yard origin (SW corner).
- `status` … `source_sale_date` – the plant's lifecycle (below). A file with only
  the first four columns still loads, every plant planned.

### Planned and planted (nl-3s5.22)

A placement may carry three optional fields, owned by `src/data/plantLifecycle.js`:

- `status`: `'planted'`, or absent for planned (the default, so every placement
  saved before this had its canonical form already). Only the two states exist;
  a future one (`'removed'`) must be added to `LIFECYCLE_STATUSES` before anything
  writes it, because until then it is dropped and the plant reads as planned.
- `plantedOn`: `YYYY-MM-DD`, optional, only on a planted plant. JSON keys are
  camelCase like `speciesId`; the CSV column is `planted_on`, like `species_id`.
- `source`: `{ name, ref? }`. `name` is free text that can name anywhere ("a
  neighbour's division", "Big Box #123"), cleaned of control characters and cut
  to 120 characters, and always escaped when shown. `ref` is set only when the
  person clicks a suggestion from `sourcing/nurseries.csv` or
  `sourcing/plant-sales.csv`. Those tables have no id column, so a ref names its
  row by the row's own values: `{ table: 'nurseries', name }` or
  `{ table: 'plant-sales', organizer, event, startDate }`. A ref that no longer
  resolves (sale rows are pruned each season) is normal, and only the name shows.
  Typed text is never matched on anyone's behalf.

Two checks: `normalizeLifecycle` is structural, never throws and never reads the
clock, and runs inside `toPlacement`, so the client's snapshot, the server's
reduction of a `POST /api/layout` body and every history read keep only canonical
values (an invalid one is dropped). `validateLifecycle` adds "not in the future"
(against the viewer's local date) and is what the detail sheet's lifecycle
section (`src/interaction/plantLifecyclePanel.js`) runs before it commits. Every
edit there is one planting revision, so Undo takes it back. A clone starts
planned, with no source.

In the drawings a planned plant keeps its month's colours and draws its outline
dashed; a planted one draws it solid (`src/render/plantStatus.js`, presentation
attributes so the exported PNGs match); a plant is the same elements either way,
only its outline's dash differs. The HOA letter counts how many of each
species are already planted and, when any are, says what the two outlines mean.

### Species are keyed by id, not by name (nl-3s5.18)

Botanical names change: the flora renames things (`ecology/fnct-name-changes.csv`
exists for that reason), and a yard keyed by name turned into "Unknown plant" the
day a plants.csv row was corrected, while the old epithet-only fallback could land
on the wrong species altogether. So plants.csv's `id` is the only species key in
layouts, history, the rules and the exports:

- **Plants carry `speciesId`.** `createPlantFromSpecies` copies it from the species
  row; `buildLayoutCsv` writes it and **refuses** a plant without one, rather than
  write a row nothing can read back. `getSpeciesKey` (the grouping key for
  highlighting, the rules engine and the HOA species list) is the lower-cased
  `speciesId`. Never `.id`, which on a plant is the plant's own id.
- **History entries** (`history_entries.plants_json`; `layout-history.json` before
  nl-3s5.3) hold placements only (nl-3s5.19):
  each plant is `{ id, speciesId, x, y }`, plus any optional per-plant field that is
  not a species attribute (`src/data/placements.js` draws that line, and carries
  such fields through untouched). A displayed plant is always
  `createPlantFromSpecies(species, placement)`, via `plantsFromPlacements`, so undo
  after a catalog correction shows the correction. The server reduces whatever a
  client posts to placements, so an old tab cannot put attributes back. A legacy
  full-object snapshot still loads the same way (its attributes are ignored); one
  from before species ids falls back to its botanical name, as below, and one that
  resolves to nothing is kept verbatim. `tools/migrate-history-placements.mjs
  <projects-dir> [--dry-run]` reduces old files, with a backup per changed file
  (run it, like `tools/migrate-species-ids.mjs`, on files before importing them).
- **History is the layout** (nl-3s5.3). The page shows the entry at the stored
  cursor and nothing else. The old rule that the layout file wins over history
  applies once, when a yard is imported from files (see "Importing yards from
  files"), because there is no stored file left to disagree with.
- **plants.csv ids are required and unique**; `parseSpeciesCsv` throws otherwise.
  Renaming an `id` orphans every yard that uses it, so don't. Renaming a
  `botanical_name` is safe (`tests/plantParser.test.js` proves it).
- **Name matching survives only for legacy input** (a `botanical_name` layout column,
  an old history snapshot, an import), all in `src/data/speciesResolver.js`: the full
  name exactly, then `catalog/species-synonyms.csv`. **Never** by epithet, and never
  by stripping a variety or cultivar to reach its parent. The synonym table is
  generated from the claim store's `taxa.resolves_to` by
  `tools/link-species-taxa.mjs`, because browser code cannot query SQLite.
- **`plants.csv`'s `taxon_id`** links each row to `taxa.id` in `data/claims.db`
  (exact-name match only, blank otherwise). It is a link into the store, never a key a yard uses:
  taxa ids are autoincrement values assigned in seeding order, so reordering
  plants.csv and rebuilding the store renumbers them. Re-run
  `node tools/link-species-taxa.mjs` after a rebuild; the claims exporter writes the
  same column.
- **Migrating old files:** `node tools/migrate-species-ids.mjs <projects-dir> --dry-run`,
  then without `--dry-run`. It rewrites old-shape `planting_layout.csv` files and adds
  `speciesId` to history snapshots, backs up each changed file to
  `<file>.bak-<timestamp>`, reports (and leaves alone) anything it cannot resolve
  confidently, and is a no-op on files already migrated.

### plants.csv is botany, plant-drawing.csv is how we draw it (nl-3s5.21)

Every `plants.csv` column is identity or a claim-store field, so the claims
exporter (`tools/claims/exportPlantsCsv.js`, `PLANTS_CSV_HEADER`) can own the
whole file. How the design tool **draws** a species is our judgement, not a
sourced fact, so it lives in `plant-drawing.csv` at the repo root with a `source`
column naming its author (`tests/sourcedTables.test.js` enforces it). It sits at
the root beside `plants.csv`, not in `catalog/`, because production mounts
`catalog/` from the dev tree: the two halves of the catalog must always be served
from the same commit.

`parseSpeciesCsv(plantsCsv, drawingCsv)` joins them by `id` and refuses a species
with no drawing row, a drawing row for an unknown id, a repeated id, a drawing row
with no `source`, and a `plants.csv` that still carries a drawing column. Called
with one argument it reads the drawing columns from the species rows themselves,
which is what a plan bundle exported before the split holds. The plan bundle
now carries both files.

`plants.csv` columns:

- `id` – the species key every layout, history entry and rule uses (see above).
- `common_name`
- `botanical_name`
- `taxon_id` – the linked `taxa.id` in the claim store, or blank.
- `growth_shape` – e.g. `mound`, `vertical`, `vase`, `arch`, `creeping`, `grass`.
- `width_ft`, `height_ft`. `width_ft` has no claims: the store tracks it and
  `tools/claims/unsourceableRegister.js` records why no source carries it.
- `growing_season_months` – range or list, e.g. `3-11` or `3,4,5`.
- `flowering_season_months`
- `sun_pref`, `water_pref` – single values from `SITE_VOCABULARY`
  (`src/data/projectConfig.js`); anything else, a list included, is a
  `LayoutDataError` at parse.
- `soil_pref` – an accepted-soil SET, comma-separated (e.g. `sandy,loamy,clay`).
  `parseSpeciesCsv` splits it once into an array (`plant.soilPref`) and checks
  every member against `SITE_VOCABULARY.soil`; an unknown or repeated member is a
  `LayoutDataError`, never kept or dropped quietly. Consumers use the array and
  never re-split. `nl-9a6` migrated the rows USDA's characteristics endpoint
  actually has a soil_coarse/medium/fine triple for — 23 of 56 species — to a
  real accepted set. The other 33 have no USDA characteristics record at all
  (not a fetch failure — USDA covers only ~2,200 species nationwide) and still
  hold one PREFERRED soil with no tolerance data, so rule 8's soil stopgap
  (see the comment atop `siteMatch.js`) stays in place for those.
- `fruit_season_months`, `fruit_load`

`plant-drawing.csv` columns (`DRAWING_COLUMNS` in `src/data/plantParser.js`):

- `id` – plants.csv's `id`; exactly one row per species.
- `flower_color`, `foliage_color_spring/summer/fall/winter`, `fruit_color` – hex.
  The claim store holds USDA flower, summer-foliage and fruit colour claims (a
  colour name mapped to a swatch), but the hex drawn is this authored one.
- `inflorescence`, `flower_count_hint`, `flower_zone` – the flowers as drawn.
- `source` – who authored the row.

Optional `dormant_color`, `flowerColor`, or alias fields are still handled by `plantParser`.

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
  All three go through the same commit path as a drag, so undo/redo and the auto-save
  (`POST /api/layout`) come for free — there is no separate confirmation step.
- The plan bundle export uses `buildLayoutCsv` to include the current layout as `planting_layout.csv`.
- SVG `<title>` tooltips (built by `render/tooltip.js`) display common + botanical names plus horticultural prefs on hover.
- When data fails to load, `src/app.js` surfaces a lightweight error banner: sign in (a 401), start a yard (an empty list), or serve the app with `node server.js`.

Keep interactions lightweight and accessible; no heavy UI frameworks are needed.

---

## Key modules

- `src/app.js` – application entry point; wires up DOM, loads CSVs, drives rendering loop and drag/export controls.
- `src/constants.js` – canonical sizes, offsets, and scale defaults shared across modules.
- `src/data/csvLoader.js` – fetch + minimalist CSV parser (also used by tests).
- `src/data/projectConfig.js` – project index/config loading, normalization, and slug validation.
- `src/data/projectPaths.js` – server-side resolution of a yard's photo path under `DATA_DIR` (path-traversal guard).
- `server/db/projectStore.js` – yards in `app.db`: lookups scoped by owner, the history transactions, the photo directory.
- `server/db/projectImport.js`, `tools/import-projects.mjs` – the one-time copy of yards from files (see "Importing yards from files").
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
- `src/data/speciesResolver.js` – the one place a layout row, history snapshot or import finds its species: id, then exact name, then the synonym table.
- `src/data/layoutExporter.js` – converts in-memory plants back to CSV with consistent precision/escaping.
- `src/render/*` – view configuration, SVG helpers, tooltip builder, plan view and elevation renderers.
- `src/state/seasonalState.js` – pure logic for foliage/bloom state per month.
- `src/interaction/dragController.js` – pointer events + hit-testing for moving plants in plan view.
- `src/history/layoutHistory.js` – the undo/redo stack: one full snapshot (placements, config, features) per revision; server-backed via `/api/history`.
- `src/history/reconcileLayout.js` – which history entry a legacy layout file was showing; used only by the import.
- `src/data/placements.js` – a plant reduced to its placement, and `sameLayout`.
- `src/history/layoutHistoryController.js` – the page's side of it: undo/redo buttons, the save-status line, `commit()` / `commitSetup()` / `commitFeatures()` (record, persist through one queue, check the server's cursor), and restoring a revision's setup and features on undo/redo.
- `src/state/plantEdits.js` – add, clone, and remove a plant; `src/state/yardEdits.js` – scale and
  shift features, patch a view. Pure, and unit-tested directly.
- `src/ui/speciesHighlight.js` – the table ↔ drawing link: highlighted species, targeted and hovered plant, and `refresh()` (rebuild the table, re-grade the ecology check).
- `src/render/speciesTable.js` – the species table; `src/interaction/plantMenu.js` – the plant's
  Clone/Remove menu.
- `src/export/exportActions.js` – the plan-bundle and HOA-packet downloads: render in June,
  capture every view, zip, restore the page. Covered by `tests-e2e/export.spec.js`.
- `src/ui/detailSheet.js` – the plant detail sheet: facts for the month, keystone/larval-host
  notes, and nearby animals that use the genus.
- `src/ui/projectPicker.js` – the project picker and new-project form; `src/ui/controls.js` – the
  month slider, zoom controls, scale bars, and button/download helpers.

Persistence routes (`/api/project`, `/api/layout`, `/api/history`, `/api/history/cursor`,
`/api/features`, `/api/view-background`, `/api/project-photo`) all require a signed-in
caller and `?project=<slug>`, resolved among that caller's yards only; `/api/projects`
lists and creates them. `design.html` loads JSZip from `node_modules/`, so run
`npm install` once before serving.

## Domain and code rules for this tool

- Plants do not appear in months outside their growing season; dormant months
  desaturate foliage. Winter reads **sparser and browner** unless the species is
  evergreen or semi-evergreen per the data.
- Support every growth form and stratum (groundcover to small tree) with one generic,
  reusable visual vocabulary. Diagrammatic, not photorealistic.
- Every plant `id` in a layout is **unique**: ids address plants for dragging,
  cloning, and highlighting, so a repeat makes every later row unreachable.
  `parsePlantLayoutCsv` rejects duplicates with a `LayoutDataError`, which is what stops
  an import of a hand-edited CSV with a repeat. Mint ids through
  `src/state/plantIds.js` (`buildCloneId`, `buildNewPlantId`).
- DOM queries stay in `src/app.js`; the only global mutable state is `appState`.
- Comment any non-obvious geometry: coordinate transforms, scaling, hit-testing.
