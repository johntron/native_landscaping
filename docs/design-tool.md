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
| the exact location behind `place` | `projects.location_json` (`{ lat, lng, source }`; never in a revision) | never, except to the owner: `{ lat, lng }` in `/api/ecosystem`, rounded to 3 decimals in `/api/project-location` |
| photos | files under `DATA_DIR/projects/<projects.id>/img/`, outside the served root | `GET /api/project-photo?project=<slug>&path=img/<file>` |

```
plants.csv                       shared species catalog (all projects)
plant-drawing.csv                how each species is drawn, keyed by plants.csv id (all projects)
ecology/host-genera.csv          keystone/larval-host genera per ecoregion (all projects)
ecology/plant-animal-interactions.csv  genus-keyed animal interactions (all projects)
ecology/region-fauna.csv         butterflies and moths recorded in the county (public page)
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

**A yard's location** is set by its owner in Setup mode's *Location* section
(nl-3s5.30), in two steps so a wrong geocode match is never saved silently:
*Look up* (`POST /api/project-location/preview`, `{ query }`) geocodes through
`tools/geocode.mjs` and the probe cache, drawing from `/api/geocode`'s per-caller
and shared Nominatim buckets, and shows the matched name and the point rounded
to 3 decimals; *Save this location* (`POST /api/project-location`, the same
`{ query }`) saves that match, and only a query the preview already cached, so
the save never calls Nominatim. `{ clear: true }` clears it. It is stored as
`{ lat, lng, source }`, the CLI's `--lat/--lng` shape, so feed-poller's index
queue picks up a new or moved point by its fingerprint. The example yard answers
403 and never gets a location. Out-of-region points get a warning, not a refusal
(`src/analysis/coveredRegion.js`: the EPA Level I ecoregion must be one we have
data for, and the point within our own judgement radius of Dallas).
The operator can also set it with `node tools/project-location.mjs --project <slug>
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
id,species_id,x_ft,y_ft,status,planted_on,source,source_nursery,source_sale_organizer,source_sale_event,source_sale_date,local_ecotype,drift_id
beautyberry-east,beautyberry,11.825,16.566,planted,2026-04-18,Native Gardeners,Native Gardeners,,,,,winecup-strip
```

- `id` – the plant's own id, unique within the layout.
- `species_id` – plants.csv's `id` for the species (a slug such as `fragrant-sumac`).
- `x_ft`, `y_ft` – offsets in feet from the yard origin (SW corner).
- `status` … `local_ecotype` – the plant's lifecycle (below). A file with only
  the first four columns still loads, every plant planned.
- `drift_id` – which drift the plant belongs to, if any (below). A file with no
  such column, or a blank cell, still loads; the plant is simply in no drift.

### Planned and planted (nl-3s5.22)

A placement may carry four optional fields, owned by `src/data/plantLifecycle.js`:

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
- `localEcotype`: `true`, or absent (nl-ky8): the person says this plant was
  grown from local seed or stock. Ecotype belongs to the plant, not the species,
  so it lives here beside the source. It is the person's statement, not a check,
  and may be set on a planned plant. CSV column `local_ecotype` (`yes` or blank).
  The plan draws a second ring inside the outline; a clone drops it.

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

### Drifts (nl-o47.6)

A drift (several plants of one species planted as a mass) is a **label on
plants, not a shape**: a placement may carry an optional `driftId`, one more
extra like `localEcotype` above, absent for a plant in no drift. Plants stay
first-class — each keeps its own position and lifecycle — because a drift is
planted over time and its members die and get replaced. A drift's outline,
centroid and spacing are **derived from its members, never stored**, so they
cannot disagree with the plants. One species per drift; several drifts of one
species are simply different ids. A `driftId` is a slug (the same shape a
project or view id is held to), validated by `src/data/driftId.js`'s
`isValidDriftId` everywhere a placement is read — `toPlacement`
(`src/data/placements.js`, so the server's reduction of a `POST /api/layout`
body agrees with the client), and the layout CSV's optional `drift_id` column
(`buildLayoutCsv`, `parsePlantLayoutCsv` in `src/data/plantParser.js`; a file
with no such column, or an invalid cell, loads with the plant in no drift). New
ids are minted by `src/state/plantIds.js`'s `buildDriftId`, unique in the yard
and readable (from a given name, else the species).

The pure geometry and edits a drift needs — members and their centroid, a
padded outline hull for drawing and point-in-outline hit-testing (and a
`driftOutlinePolygon` to actually DRAW that padded hull, ringing each hull
vertex and re-hulling the samples so the drawn shape agrees with the hit
region exactly, including along a straight bed edge and for a 1- or 2-member
drift), spacing (the members' median nearest-neighbour distance), phyllotaxis
clump layout, where "+" adds a member and which member "−" removes, spread,
rename, clone, dissolve, remove (delete every planned member, dissolve the
label on planted ones), and single-linkage suggestion clusters over an
existing planting — live in `src/state/driftGeometry.js` and
`src/state/driftEdits.js`, pure and unit-tested like
`plantEdits.js`/`yardEdits.js`. Every authored constant there (a spacing
factor, a suggestion-clustering distance, hull padding) is a named export
commented as our judgement, not a sourced fact. The Add plant sheet's "How
many?" (nl-o47.6.3, `addDriftFromCatalog`) is the first making method to
reach `design.html`: a count over 1 places a clump instead of one plant and
mints its `driftId`, then selects every member it just placed — which is
exactly the ids `selectPlants` needs to enter whole-drift mode, below.

**A drift always has >= 2 members** (nl-o47.6.9, the owner's REVISED design,
2026-09-28): the count stepper on the action bar (below) shows for a single
plain plant too, reading 1 with "−" disabled (Remove already deletes a lone
plant); "+" there converts it into a drift of 2 in one edit —
`driftEdits.js`'s `convertToDrift` mints a driftId from the species, places
the second member at the plant's own default spacing (`driftGeometry.js`'s
`nextMemberPosition`, the same 1-member fallback a real drift's own "+"
already reuses), and copies the plant's lifecycle onto the new member
(nl-o47.6.10). Every edit that can leave a drift with one member — the count
stepper's "−", "Remove from drift", and a drilled-in member's own Remove
(`removeDriftAwarePlant`, which every one of `src/app.js`'s three single-
plant Remove paths — the selection bar's, the detail sheet's, and the plant
context menu's — goes through instead of `plantEdits.js`'s `removePlantById`
directly) — drops the label from whatever member survives instead
(`pruneUndersizedDrift`), so 1 → 2 → 1 hands back the original plant,
unlabelled, with its original id. The tie-break a fresh 2-member drift's "−"
has to make (both members sit exactly equidistant from their own centroid —
the midpoint of a segment) goes to the MOST RECENTLY ADDED member (later in
`state.plants`), not the smaller id, which is why 1 → 2 → 1 always returns
the ORIGINAL plant rather than either one arbitrarily. `dropUndersizedDrifts`
(`src/data/driftId.js`, re-exported from `driftEdits.js`) is the same rule
for a whole plant list at once: `buildPlantsFromCsv` (a hand-edited or
imported CSV) and `plantsFromPlacements` (every history load, undo, and
redo) both call it, so a 1-member drift left over from before this rule
existed never survives a reload with its "−" enabled and ready to delete the
last plant.

**One planting status per drift** (nl-o47.6.10, strict — replaces the
original design's "each keeps its own lifecycle"): status (planned/planted),
planted date, source and local ecotype (`src/data/plantLifecycle.js`) are
shared by every member. Storage stays per placement — each member carries
the same fields, and the shopping list, the HOA packet, and
`buildLayoutCsv`/`plantsFromPlacements` read them exactly as they always
have, grouped by species and never by driftId (confirmed by inspection: none
of `src/sourcing/shoppingList.js`, `src/export/hoaPacket.js`, or
`src/data/layoutExporter.js` reads or branches on `driftId`) — the rule is
enforced entirely by the EDITS, not by a different read path:

- `setDriftLifecycle` (`driftEdits.js`) is the drift-wide counterpart of
  `plantEdits.js`'s `setPlantLifecycle`: `fields` merges over the drift's
  current shared lifecycle (`driftGeometry.js`'s `driftLifecycleSummary` —
  the FIRST member's values), checked once with `validateLifecycle`, and
  writes every member in one call, so the caller's commit is one history
  entry regardless of drift size. A refused edit, or applying values every
  member already has, changes nothing.
- The drift-wide **editor** reuses `src/interaction/plantLifecyclePanel.js`'s
  own controls rather than a second copy: `open(plantId)` resolves its
  TARGETS from `plantId`'s own driftId at that moment — a plant in no drift
  targets just itself (`setPlantLifecycle`); a drift member targets every
  CURRENT member of that drift (`setDriftLifecycle`), read fresh on every
  sync so an undo/redo is reflected immediately. This is how a drilled-in
  member's own Details already edits the whole drift, unchanged. It also
  reaches the whole drift with none drilled in, from the selection bar's
  "Planting" entry in More (`selectionDriftPlantingBtn`): `src/app.js`'s
  `openDriftPlantingSheet` opens `#detailSheet` at any one member (they are
  all the same species) with `{ drift: true }`, which
  `src/ui/detailSheet.js`'s `openDetailSheet` uses to skip
  `setTargetedPlant` — opening it from an ALREADY-active whole-drift
  selection must not drill that selection into the one representative
  member it happens to open at. The panel shows "Applies to all N plants in
  `<drift label>`", or, when a drift's members happen to disagree (older
  data, an import), the FIRST member's values with a note that the next edit
  unifies them (`driftLifecycleSummary`'s own `uniform` flag).
- `addDriftMember` ("+") and `convertToDrift` (the 1 → 2 conversion above)
  both copy the drift's/plant's own lifecycle onto the new member, so a
  drift's very first "+" already agrees with the rest. `cloneDriftAwarePlant`
  wraps `plantEdits.js`'s `clonePlantById` the same way `removeDriftAwarePlant`
  wraps `removePlantById`: a clone that stays in a drift (`clonePlantById`
  already carries `driftId` through) copies the source member's lifecycle
  instead of `clonePlantById`'s own "always planned, no source" default,
  since a clone would otherwise add a planned member to an already-planted
  drift. `src/app.js`'s three Clone paths (the selection bar's, the detail
  sheet's, and the plant context menu's) all go through it.
  `addDriftFromCatalog`'s own members need no such copy: every one is
  freshly planted from the catalog, so they start uniformly planned already.

#### Selecting, isolating, and the drift action bar (nl-o47.6.2)

Selection (nl-o47.2's Set of plant ids) gains a **drift context**, two more
`appState` fields owned by the same `src/ui/plantSelection.js`:
`selectedDriftId` (`''` for none) and `driftDrilledIn`. A drift id alone
cannot say whether the selection IS the whole drift or has been narrowed to
one of its members — a 1-member drift makes the two indistinguishable by ids
alone — so both fields are needed; see `src/state/driftSelection.js` for the
pure decisions (`driftForExactSelection`, `inferDriftContext`,
`pruneDriftContext`) and their own reasoning. `selectPlants(ids)` — the one
entry point every caller already used (right-click, the detail sheet, the Add
plant sheet's `onPick`, nl-o47.6.3's "add N of a species") — infers the
context from the ids themselves: handing it exactly one drift's current full
membership enters that drift, whole; narrowing an ALREADY-active drift
context down to one of its own members drills into it (so Details/Clone/the
detail sheet do not drop isolation the instant they touch the selection); a
cold single-plant selection invents no drift context. `drillIntoDriftMember`
and `selectDrift` are the two lower-level entry points the drag controllers
and the action bar call directly. `pruneSelection` (run everywhere
`refreshSpeciesTable` already runs) re-syncs whole mode to the drift's
CURRENT membership rather than a stale id snapshot, so a "+"/"-" elsewhere —
or an undo/redo of one — keeps showing every member and the right count.

Tap/click resolution (`src/interaction/dragController.js`, decided by the
pure `src/interaction/driftHitTest.js`): a tap/click on a member of a drift,
or inside its outline between members (the "far bigger target" the outline
exists for), selects the WHOLE drift; a further tap on a member of the
now-selected drift drills into it; while drilled in, a tap on ANOTHER member
switches straight to it; a tap outside the isolated drift's own outline
leaves it. Several overlapping outlines (an interwoven planting) resolve to
the nearest centroid first, and repeat taps into the overlap cycle between
them exactly like `tapSelection.js` already cycles overlapping plants — the
gap-tap cycle is a second, parallel tracker over drift ids rather than plant
ids. **Isolation**: while a drift is selected or drilled into, every plant
outside it dims (`[data-dimmed="true"]`, `styles.css`) and stops being a hit
target — the plan controller filters its own proximity hit-testing in JS,
and an elevation's DOM-based `findPlantIdFromEvent` gets the same exclusion
for free from `pointer-events: none` on the dimmed group (plus a defensive
driftId re-check in case a render pass hasn't caught up). Mouse has no
separate tap step, so pressing a member of an ALREADY whole-selected drift
starts the group drag immediately (the whole drift can still be dragged) and
only narrows to that one member if the press turns out to be a plain click,
resolved at pointerup since a single gesture both selects and starts a drag
here; pressing a member of an unselected drift enters it and drags the whole
group right away; pressing a member while already drilled in switches the
target immediately and drags just it. The group drag itself needed almost no
new code for touch: a drag already moves "whatever the selection currently
is" (nl-o47.2), so once a tap enters a drift the very next drag gesture picks
up every member for free, clamped as a group exactly like today, in the plan
and along an elevation's one axis alike.

**Drawing**: the selected drift's outline is drawn in the plan only (an
elevation has no y-depth to test a hull against) in the cyan "apparatus"
token (`.drift-outline`, the same family as `.plant-selection-ring`), built
from `driftOutlinePolygon` and smoothed with `buildSmoothPath` so it reads as
an organic zone rather than a faceted polygon. Members get the ordinary
selection ring, in both views, exactly as any selected plant does. None of it
— outline, dimming, or the drift context itself — may reach an export:
`src/export/exportActions.js` blanks `selectedDriftId`/`driftDrilledIn`
around every capture and snapshots/restores them around it, the same
treatment `selectedPlantIds` already got.

**The action bar** (`src/ui/selectionBar.js`) has three modes, none of them a
separate element — the module just shows/hides pieces of the one bar. A
drift's **label** is its driftId humanized (`src/data/driftId.js`
`humanizeDriftId`: hyphens to spaces, first letter capitalised) plus its
member count (`driftMemberCountLabel`) — no separate "named" flag
distinguishes a species-minted id ("winecup-2") from a person's own rename
("front-edge"); both read the same way once humanized. The bar's own
`selectionBarName` span shows this text — as plain, ellipsized text — in
EVERY mode now (nl-o47.6.9's review): a plain plant's name or "N plants" as
before, or the drift's label + count in whole-drift mode. Whole-drift mode
also shows a count `-`/N/`+` stepper (`addDriftMember`/`removeDriftMember`,
each button disabling itself with the reason `driftGeometry.js` already
computes when nothing can be added/removed — nl-o47.6.9 gives a single plain
plant this same stepper too, reading 1 with "−" disabled, its "+" going
through `convertToDrift` instead, above), Tighter/Looser spread
(`spreadDrift`, a factor per press that is a named judgement constant,
`DRIFT_SPREAD_STEP` in `src/app.js`), an inline rename text field (never
`window.prompt`, refusing an empty name or one that collides with another
drift — `renameDrift`'s own refusal, shown inline), Planting (the drift-wide
lifecycle editor, nl-o47.6.10, above), Clone drift (selects the
new one), and Remove drift (deletes every planned member and dissolves the
label on planted ones, its own label saying the two counts before it acts,
since there is no `window.confirm` either). Drilled-into-one-member mode
keeps the ordinary single-plant bar (Details/Clone/Remove act on that one
plant; `clonePlantById` already carries `driftId` through like any other
field, so cloning a member keeps the clone in the drift and
`cloneDriftAwarePlant` copies its lifecycle too, nl-o47.6.10; Remove goes
through `removeDriftAwarePlant`, nl-o47.6.9) and adds "Remove
from drift" (`removePlantFromDrift`) and "Back to drift". Nudges and Done are
shared by every mode, unchanged. Every edit commits through
`layoutHistory.commit` only once something actually changed —
`spreadDrift`/`renameDrift` return success-shaped results on a no-op
(nl-o47.6.1's own hand-off note), so `src/app.js`'s handlers check a rename
actually changed the id, and compare member positions before/after a spread,
before committing.

On a phone (nl-o47.4's `.selection-bar__primary`/`.selection-bar__more`
split, below), the rename field and its count label no longer fit the
primary row once a plain plant's own count reads there too ("Winecup d…" was
the nl-o47.6.2 review's own screenshot finding) — they live in the "More"
popover instead, alongside the count stepper, spread, and the rest; the
primary row keeps only the plain-text label, Undo, the More toggle, and
Done. Desktop is unaffected: `.selection-bar__more`'s `display: contents`
still puts the rename field back inline in the same spot, and
`styles.css`'s `[data-drift-whole="true"] .selection-bar__name { display:
none }` hides the redundant plain-text label there instead, so the two are
never shown at once on either width.

**The species table and the plan/export label** (nl-o47.6.7). The species
table (`src/render/speciesTable.js`, driven from `src/ui/speciesHighlight.js`)
gains a "Drifts" column, kept with the always-visible Label/Botanical
name/Common name columns rather than behind the row's own Details toggle —
it is a tap target, not reference data. Empty for a species with none; for
one that has drifts it shows a summary line ("Winecup — 2 drifts, 17
plants") plus one button per drift (`driftMemberCountLabel`,
`src/data/driftId.js`: "Winecup · 12 plants", the same text the action bar
above already assembles inline) and an "N single" count for whatever is
left. `groupSpeciesDrifts` (`src/render/speciesTable.js`, pure, exported for
its own unit tests) splits a species' plants into its drifts and its
singles, keyed by `getSpeciesKey` — the same lower-cased key the table
already groups ROWS by, never `driftsOfSpecies`' raw, case-sensitive
`speciesId` comparison. A drift button's click (`handleDriftClick`,
`src/ui/speciesHighlight.js`) branches on `appState.mode` exactly like
`setTargetedPlant` already does, but exclusively rather than additively:
Edit mode calls `plantSelection.selectDrift` (wired from `src/app.js`, the
same selection the drag controllers and action bar use); View mode instead
toggles a sticky highlight (`appState.highlightedDriftId`, set/cleared by
`setHighlightedDrift`/`toggleHighlightedDrift` — a click, not the species
row's own hover, so it survives until clicked again, a different drift is
picked, the drift stops existing, or the mode changes). `topView.js` and
`elevationViews.js` both accept a `highlightedDriftId` option alongside
`highlightedSpeciesKey`: when set it REPLACES the species highlight rather
than adding to it, or highlighting one drift would ring every member of the
whole species. `src/export/exportActions.js` gives it the same
blank-for-capture/snapshot/restore treatment `selectedDriftId` already gets,
since — unlike the transient hover ids there — it is sticky.

With labels on, a drift is labelled **once**, at its centroid
(`driftCentroid`), as `<humanized driftId> ×N` (`buildDriftPlanLabel`,
`src/render/labels.js`: "Winecup ×17") instead of labelling every member —
in the plan (`topView.js`; an elevation still labels every member, since it
has no single drift-wide anchor the way a centroid gives the plan one) and
so in the plan bundle and HOA packet exports, which capture that same
renderer. The label sits directly on the `<svg>`, never inside a plant's own
`g[data-plant-id]` (so it is neither counted as a plant nor draggable),
`pointer-events: none` (so the gap-tap/click hit-testing aimed at this same
centroid still lands on the plan), and clamped inside the view's own
viewBox (`clampLabelPosition`, also in `labels.js`) so it cannot draw past
the plan's edge — the plan's `<svg>` itself never clips
(`overflow: visible`, styles.css) but its parent panel does
(`overflow: hidden`), and `captureViewToPng`'s export crops to this exact
viewBox. While a drift is selected/isolated in Edit mode
(`appState.selectedDriftId`), its own members draw their individual labels
again instead of the one grouped label, so a person editing it can tell
members apart — since `selectedDriftId` is always blanked to `''` around an
export capture, every drift gets the single grouped label in every exported
PNG regardless of what was selected on screen. A plant in no drift keeps its
label exactly as before, in every view.

The shopping list and exports are unchanged by any of this: they count
plants (`src/export/hoaPacket.js`'s `summarizePlacedSpecies`,
`src/sourcing/shoppingList.js`), grouped by species, never by `driftId`.
The ecology check's rule 9 (`src/analysis/rules/drifts.js`, id `drifts`) is
titled **Massing**: it grades whether same-species plants read as one mass by
measuring spacing (`plant.width`/`x`/`y`), never the label, so a declared
drift planted too loosely does not count as a mass there. Its result names
such a drift ("Front edge is spread too thin to read as one mass") so the plan
and the check cannot silently disagree (nl-o47.6.8, the owner's choice over
counting declared drifts).

Group-selected, suggested, and painted drifts (the other three making
methods in nl-o47.6's "MAKING" list) are later beads under nl-o47.6.

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
- `nativity_nctx` – `native`, `introduced` or blank: the claim store's nativity
  claim, whose only source is the *Flora of North Central Texas* (plus
  `catalog/manual-corrections.tsv`). Blank means no asserted claim, so "not
  confirmed", never "introduced". The Edit-mode Add plant sheet badges every
  row with it and its "Native to NCTX" chip filters on it; a cultivar never
  counts as native, whatever its parent's value (`src/data/speciesSearch.js`,
  nl-5j5).

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
- Mode pills switch between View, Edit (select and drag plants), Setup (declare the yard, place
  photos), and Features (draw the yard model).
- **The Edit-mode selection (nl-o47.2): a SET of plant ids** (`appState.selectedPlantIds`),
  owned by `src/ui/plantSelection.js` (`selectPlants`, `clearSelection`, `getSelection`,
  `pruneSelection`, and since nl-o47.6.2 `drillIntoDriftMember`/`selectDrift`/
  `getDriftContext`). A drift's several members select as one Set, the multi-select case the
  Set model was built for; see "Drifts" above for the drift context two more `appState` fields
  carry alongside it. The Add plant sheet's "How many?" (nl-o47.6.3) is the caller that puts
  more than one id in it: count 1 still goes through `setTargetedPlant` below like every other
  single add, but count > 1 calls `selectPlants` directly with every new member — exactly the
  ids `inferDriftContext` reads as "enter this drift, whole." Pruned everywhere the species
  table already refreshes (add, clone, remove, undo/redo, load: `src/app.js`'s
  `refreshSpeciesTable` wrapper), so a plant that stops existing cannot linger in the
  selection; cleared on every real mode change, and for free on a project switch (the whole
  page reloads).
  `src/ui/speciesHighlight.js`'s `setTargetedPlant` also SELECTS while Edit mode is on — the
  hook every other single-plant caller routes through (right-click, the detail sheet, the Add
  plant sheet's `onPick` at count 1) without needing to know the selection module exists. Rendering draws the
  selection ring (`.plant-selection-ring`, `var(--accent)`, cyan/apparatus) instead of the
  older "targeted plant" ring while in Edit mode, so a targeted-and-selected plant shows one
  ring, not two; the target ring is unchanged in every other mode. Cleared from `appState`
  before every export capture (`src/export/exportActions.js`, copying the Set on
  snapshot/restore), so it never reaches a plan bundle or HOA packet PNG.
- **Gestures, powered by `createPlantDragController`/`createElevationDragController`
  (`src/interaction/dragController.js`), diverge by pointer type.** Mouse keeps the original
  model: press a plant to grab AND select it (`onSelectPlant`), drag to move it, exactly as
  before nl-o47.2 for a plant in no drift. A press on a drift member instead drags the whole
  drift (or, once already drilled into one member, just that plant) — see "Drifts" above for
  the deferred-drill-in timing a single mouse gesture needs that touch's separate tap step
  does not. Touch/pen no longer grabs on pointerdown at all: a **tap** — pointerdown to
  pointerup with at most `TAP_MOVEMENT_THRESHOLD_PX` of movement (~8 CSS px, a judgement call,
  `src/interaction/tapSelection.js`) — selects the nearest overlapping candidate
  (`pickPlantHits`' own order), or cycles to the next one if it repeats the previous tap's spot
  with the same overlapping candidates (the cycle order is captured on the first tap of a run
  and reused verbatim, never recomputed from a possibly reordered candidate list, so
  distance-sort jitter between two nearby taps cannot look like a new place was tapped). With a
  selection, a one-finger drag starting **anywhere on the drawing** — not necessarily on a
  selected plant — moves every selected plant by the finger's delta, clamped to the yard **as a
  group** (`src/render/groupClamp.js`: the same delta shrunk just enough that no member leaves
  the yard, so the group keeps its shape rather than each member clamping to the edge on its
  own). Only a tap may ever change the selection; a drag cannot grab a different plant. The
  pointer is captured on every touch pointerdown once Edit mode is on, whether or not anything
  is selected yet — not to block scrolling (`touch-action` alone does that) but so that a group
  move's own re-render, which runs every frame, cannot orphan the rest of the gesture by
  replacing the element that received the touch's implicit target. Hover is mouse-only:
  updating it from a touch's pointermove would chase a target ring under the finger during a
  group drag. The elevation controller records the tapped plant's id off the DOM **at
  pointerdown**, because once it captures the pointer, later events target the svg itself.
- **A selection action bar** (`src/ui/selectionBar.js`, `#selectionBar` in `design.html`) is
  fixed to the bottom of the viewport (`env(safe-area-inset-bottom)`) whenever Edit mode has a
  selection: the plant's name (or "N plants"), Details (opens the existing detail sheet), Clone
  (selects the clone), Remove (the ensuing prune clears the selection), Done, and four nudge
  arrows labelled by compass point in yard feet (`src/state/nudgeSelection.js`,
  `NUDGE_STEP_FT` = 0.5 ft, a judgement call, clamped as a group like a drag) — this is the bar
  a plain plant or a drilled-into drift member gets; a whole drift's own controls (rename,
  count, spread, clone/remove drift) are described under "Drifts" above. Arrow keys nudge
  on desktop too, while a selection exists and focus is not in a form field. Every nudge
  commits immediately as its own history entry rather than coalescing a burst into one: a
  delayed commit racing an Undo pressed in the same window could record the just-undone
  position as a new entry and drop the redo tail.
- **Each view SVG has several controllers, so none may own an inline style.** The drag,
  setup, and (on plans) feature controllers are bound to the same element; while both wrote
  `svg.style.touchAction`
  the later writer silently won and Edit mode sat at `touch-action: auto`, so the page
  scroller took every drag. Each now toggles its own class and `styles.css` combines them —
  see the comment there for why neither `pan-y` nor per-plant `touch-action` works. Since
  nl-o47.2, **`is-drag-enabled` marks Edit mode for the resting cursor only**; the class
  `touch-action` actually reads is `is-selection-active`, toggled by the drag controllers from
  the SELECTION (`setSelectionActive`), not from Edit mode outright — a drawing claims a touch
  only once something is selected, so an empty selection still scrolls like the rest of the
  page, and the tap that selects makes the very next touch on it a move. Setup and Features
  still claim every touch outright (`is-setup-enabled`, `is-features-enabled`); their own
  drags were not part of this redesign. The cursor had its own version of this sharing bug
  (nl-jfm, fixed): resting cursors come from these classes too. `applyMode` decides every lock
  state and re-syncs `is-selection-active` in one place, so exactly one kind of controller is
  ever unlocked and touch-action is never left stale after a rebuild.
- Touch is covered by `tests-e2e/touch.spec.js` under its own phone-sized Playwright project.
  It drives **real touch through CDP** (`Input.dispatchTouchEvent`, wrapped as `touchGesture`
  in `tests-e2e/helpers.js`, and `tap` for a zero-movement tap): `page.mouse` is not touch and
  `page.touchscreen` only taps, so neither exercises `touch-action` and both pass against a
  broken app. CDP synthesizes no long-press `contextmenu`, so the right-click menu cannot be
  tested on touch.
- **A client point (a mouse or touch event's clientX/clientY) becomes a viewBox point through
  `src/render/screenPoint.js`'s `clientPointToViewBox`**, the one place any of the three plan/
  elevation controllers (`dragController.js`, `setupController.js`, `featureController.js`) does
  that mapping. It reads `svg.getScreenCTM().inverse()` — the browser's own user-space↔screen
  matrix, already carrying the viewBox's scale and origin, any `preserveAspectRatio="xMidYMid
  meet"` letterbox offset, and a CSS transform on the element or an ancestor (the phone editor's
  pinch-zoom/pan, nl-o47.4, below — exactly the case this comment used to say "a future" one for) — rather than dividing
  `viewBox.width` by `getBoundingClientRect().width` on each axis separately, which is only
  right when the box happens to share the viewBox's own aspect ratio. A maximized panel on a
  phone need not (nl-o47.1): that rect-based math undercounted one axis of a drag and
  hit-tested the wrong plant whenever it let the box drift from the viewBox's shape. The matrix
  arithmetic itself (`applyMatrix`, `matrixScale`) is pure and unit-tested in `tests/screenPoint.test.js`
  without a DOM; `clientPointToViewBox` is the only part that touches `svg`.
- **A maximized panel on a phone (`@media (max-width: 960px)` in `styles.css`) keeps the
  viewBox's aspect ratio.** It used to set `aspect-ratio: auto; height: calc(100vh - 3.5rem)`,
  which is exactly the shear the comment on `.view` warns about: the SVG letterboxes under
  `meet` while the photo's CSS-background percentages (`photoPlacement.js`) stretch to the
  now-distorted box. The fixed rule instead sizes `width: min(100%, calc((100dvh - 3.5rem) *
  var(--view-aspect-ratio)))` and leaves `aspect-ratio` alone, so CSS derives the height itself
  and the box can no longer disagree with the drawing. `dvh`, not `vh`: iOS's `vh` is sized to
  the viewport once the browser chrome has hidden, not to what is on screen right now.
- Edit mode's "Add plant" button (`#addPlantBtn`) opens a sheet
  (`src/ui/addPlantSheet.js`, `.add-plant-sheet` in styles.css) — a bottom sheet
  under 640px, a centred dialog from it, the same pattern as the plant detail
  sheet — with search, "Native to NCTX" / "Favorites" filter chips, a sort
  choice, a "How many?" −/N/+ stepper (nl-o47.6.3, default 1, resetting to 1
  every time the sheet opens, bounded by `MAX_DRIFT_COUNT` — a named judgement,
  `src/state/driftEdits.js` — and placed ahead of the list so it is reachable
  on a phone before tapping a row), and a scrollable, tappable list; tapping a
  row adds that species and closes the sheet (nl-o47.3). It places the plant
  (count 1) or the whole clump (count > 1) at the centre of whatever part of
  the plan view is actually on screen — the plan SVG's own rect intersected
  with the visible viewport (`window.visualViewport` when present), mapped to
  yard feet through the plan's view transform and clamped to the declared yard
  (`src/render/yardBounds.js`) — rather than the plan's true middle, which is
  routinely scrolled off a phone screen; screen-rect math is a small pure
  helper, `src/render/visiblePlanCenter.js`, called from `src/app.js` (which
  owns the DOM/window reads) and passed into `addDriftFromCatalog`
  (`src/state/driftEdits.js`) as an optional `{ at }` point. With no part of
  the plan on screen it falls back to the plan's own middle and scrolls the
  plan into view instead. Count 1 places one plant, targeted the way a click
  on it would be (`speciesHighlight`'s `setTargetedPlant`); count > 1 places an
  evenly spaced clump of that many (driftGeometry's phyllotaxis
  `clumpPositions`, at spacing = the species' width × `SPACING_FACTOR`,
  clamped to the yard as a group) sharing one new `driftId`, as one history
  entry ("Added drift of 7 Winecup"), with every member selected
  (`plantSelection.selectPlants`) so the next drag moves the whole clump
  (nl-o47.2's group drag). The plant's own detail sheet and right-click menu
  carry Clone and Remove. All of this goes through the same commit path as a
  drag, so undo/redo and the auto-save (`POST /api/layout`) come for free —
  there is no separate confirmation step.
- The plan bundle export uses `buildLayoutCsv` to include the current layout as `planting_layout.csv`.
- SVG `<title>` tooltips (built by `render/tooltip.js`) display common + botanical names plus horticultural prefs on hover.
- When data fails to load, `src/app.js` surfaces a lightweight error banner: sign in (a 401), start a yard (an empty list), or serve the app with `node server.js`.

Keep interactions lightweight and accessible; no heavy UI frameworks are needed.

### The phone editor (nl-o47.4)

Edit mode on a phone-width screen (`max-width: 960px`, the same breakpoint the rest of the
phone layout already uses) is not the long scrolling page the other three modes still are: it
is a full-screen editor, entered and left automatically as Edit mode itself turns on and off (or
the viewport crosses the breakpoint while Edit mode stays on — a rotation, say). It solves the
three problems nl-o47's own notes named: controls scrolled out of view, no way to zoom before
dragging, and a drawing that claimed every touch leaving nothing to scroll the page by (that
last one is moot now — see "Two fingers" below).

`src/interaction/phoneEditor.js` owns the whole thing and is the only new module wired into
`src/app.js`'s `applyMode()` (enter/exit) and `render()` (the idle bar's cheap per-frame
visibility toggle). It builds on nl-o47.1's maximize mechanism rather than a parallel one:
entering the editor is "auto-maximize a view" (`appState.maximizedViewId`, the same
`.views[data-maximized]` CSS a manual Maximize/Restore toggle drives in View mode) plus a few
more pieces that only exist while it is open:

- **A top tab strip** (`#phoneEditorTabs`) replaces the per-panel Maximize/Restore toggle, which
  `body.is-phone-editor-open .view-panel__header { display: none; }` hides for the duration —
  view switching without scrolling to a panel. Plan first, then every other view in
  `project.views`' own order. Tapping a tab calls `src/app.js`'s `setMaximizedView(viewId)`,
  which always SETS the maximized view (unlike the desktop toggle's `toggleViewMaximization`,
  which flips it off on a second click of the same view — the tab strip has no "nothing
  maximized" state to flip back to). A **Fit** button next to the tabs resets zoom/pan to
  `FIT_STATE` (below); it disables itself once already there.
- **One bottom bar**, never two stacked. With nothing selected, `#phoneEditorBar` (the idle bar)
  shows month back/forward (driving the existing `#monthSlider` by dispatching its own `input`
  event, so `src/app.js`'s one month listener is still the only thing that renders a month
  change), Add plant, Plants, Undo, Redo, and Done (leaves the editor — `applyMode('view')`).
  With a selection, `#selectionBar` (unchanged logic, restructured markup — see below) takes the
  exact same fixed-bottom slot instead; the two are mutually exclusive by construction
  (`phoneEditor.js`'s `syncBar()` and `selectionBar.js`'s own `sync()` each hide their own bar on
  the other's condition) and share a `min-height` so a selection starting or ending never
  resizes the canvas above them. Add plant/Undo/Redo are the SAME real toolbar buttons
  everywhere else, not copies: `phoneEditor.js` reparents them (and `#speciesTable`, into the
  Plants sheet) into the editor's own slots while it is open and back to their normal positions
  when it closes, so every id, handler, and disabled-state keeps working unchanged on both sides
  — `#addPlantBtn`'s own click handler, `layoutHistoryController`'s undo/redo wiring, and
  `speciesHighlight.js`'s rendering into `#speciesTable` none of them know the table or the
  buttons ever moved.
- **The selection bar's "More" popover.** nl-o47.6.2's own review found the whole-drift bar at
  four rows on a phone. `src/ui/selectionBar.js`'s logic is untouched (same elements, same
  handlers); `design.html`'s markup now splits into `.selection-bar__primary` (the plain-text
  label, a More toggle, and Done — the only things that reliably fit one row at 393px once a
  single plant's own count reads there too, nl-o47.6.9) and `.selection-bar__more` (everything
  else: the drift's rename field, Details/Clone/Remove, nudges, the drift count stepper, spread,
  clone/remove drift, the drilled-in Remove-from-drift/Back-to-drift pair), shown as a popover
  anchored above the bar.
  `selectionBar.js` opens/closes it on its own button and closes it whenever the bar's context
  changes (hidden entirely, or a different drift/plain selection) — not on every `sync()` call,
  which fires on every render including a bare month tick, or pressing "Looser" twice from
  inside the popover would close it after the first press. On desktop (`min-width: 961px`)
  `.selection-bar__primary`/`.selection-bar__more`/`.selection-bar__actions` all become
  `display: contents` and the More button hides, so every control renders inline in one flat,
  wrapping row exactly as before nl-o47.4 — `order` restores the original sequence, since
  flattening three levels of grouping instead of one can no longer rely on DOM order alone to
  reproduce it.
- **The Plants sheet** (`#plantsSheet`) hosts the real `#speciesTable` (reparented in on entry,
  back out on exit) behind a bottom sheet, the same pattern as the Add plant/detail sheets. A
  drift chip inside it (`species-table__drift-chip`, nl-o47.6.7) still selects the drift through
  `speciesHighlight.js`'s own unchanged `handleDriftClick`; `phoneEditor.js` adds one more,
  delegated listener next to it that closes the sheet on that same click in Edit mode, so the
  selection it just made is not left hidden behind the sheet that made it.

**Pinch-zoom/pan** (`src/interaction/canvasGesture.js`, driven by the pure math in
`src/render/canvasZoom.js`) is a CSS `transform: translate(tx, ty) scale(scale)` on `.view`
inside its clip container (`.view-panel.is-maximized`, `overflow: clip` and zero padding while
the editor is open) — never a viewBox rewrite. The photo is a CSS background sized as
percentages of the viewBox (`src/render/photoPlacement.js`); rewriting the viewBox on zoom would
slide plants off it, while a CSS transform scales both together, and `getScreenCTM` (the
`clientPointToViewBox` bullet above) already follows a transform on the element or an ancestor —
hit-testing, drags, and drift outlines all stay correct under it with no changes of their own.

- **The gesture model**, decided in `src/interaction/canvasGesture.js` from real pointer events,
  listening on the maximized panel in BUBBLE phase (after `dragController.js`'s own svg-level
  listener has already run):
  - **Two fingers always pinch-zoom and pan**, selection or none — `dragController.js`'s own
    `handlePointerDown` hands off the instant a second touch/pen finger arrives (salvaging a
    group drag already under way exactly like a lost pointer/`pointercancel` does), so nothing
    is left fighting `canvasGesture.js` for the first finger. `pinchUpdate` (`canvasZoom.js`)
    combines zoom (from the two fingers' distance ratio) and pan (from their midpoint's own
    movement) in one pass, anchored to the CONTENT-SPACE point under the gesture's own STARTING
    midpoint for its whole duration — recomputing the anchor every frame would let a slow pinch
    drift. A finger left over after a pinch is ignored (no pan, no tap) until it, too, lifts.
  - **One finger with a selection** moves it — nl-o47.2's group drag, unchanged.
  - **One finger with nothing selected pans** — there is no page left to scroll behind a
    `position: fixed; inset: 0` editor panel, so `touch-action: none` now also applies whenever
    the editor is open (`is-phone-editor-active`, alongside `is-selection-active`/
    `is-setup-enabled`/`is-features-enabled` in the "Touch: who owns the finger" comment in
    `styles.css`) even with nothing selected. `dragController.js`'s own touch handling already
    let a "nothing selected" move pass through untouched; the one real fix it needed
    (`movedPastThreshold`, tracked regardless of selection) stops it from ALSO reading the
    release at the end of that pan as a completed tap.
  - **A tap still selects**, exactly as nl-o47.2 left it: `canvasGesture.js` never touches a
    one-finger gesture that does not move past the tap threshold.
- **Zoom limits and the "fit" state are named judgement calls** (`src/render/canvasZoom.js`):
  `MIN_ZOOM` (1 — the floor; nothing is gained by shrinking the drawing past what its own clip
  box already draws it at) and `MAX_ZOOM` (6 — chosen so a small plant's `MIN_HITBOX_RADIUS_PX`
  becomes a comfortably large on-screen target well before the drawing turns to mush).
  `FIT_STATE` (`{ scale: 1, tx: 0, ty: 0 }`) is the identity transform, but it is NOT always the
  actual resting position a viewer sees: `.view`'s own CSS keeps the viewBox's aspect ratio
  (nl-o47.1), and a drawing whose aspect ratio does not match a portrait phone's letterboxes —
  the resting position is then a CENTERED state with a nonzero `tx` or `ty`
  (`clampZoomState(FIT_STATE, bounds)`, not `FIT_STATE` itself), which is what the Fit button and
  `isAtFit`'s own `reference` parameter compare against, and what `gesture.reset()` actually
  applies. Letterboxing itself is not new here — it is the same "contain" fit the desktop
  Maximize toggle already produces on a landscape-vs-portrait mismatch — pinching in is how a
  phone makes a specific part of the drawing fill the screen; Fit is how you get the whole
  drawing back.
- **Pan bounds**: the content may slide until either edge of its (scaled) box reaches the clip
  container's own edge, and no further — panning past that would show empty margin the drawing
  does not have. Fully covered — clamp limits, pan bounds, scaling about a midpoint (both a
  one-shot `zoomAbout` for a button and the live `pinchUpdate`) — by `tests/canvasZoom.test.js`,
  with no DOM.
- Zoom/pan state is per session, held only inside `canvasGesture.js`'s own closure; it is never
  saved, and switching the maximized view (a tab, or re-entering the editor) resets to fit —
  carrying a zoom level across two different drawings would be disorienting, not a convenience.
- The page-scroll lock (item 1: "the page does not scroll while the editor is open") applies to
  both `documentElement` and `body`: `window.scrollTo`/`scrollY` act on the document's own
  "scrolling element", which is `documentElement` (`html`) in standards mode, not `body` — an
  `overflow: hidden` on `body` alone left the page still scrollable underneath the fixed panel
  (caught by `tests-e2e/touch.spec.js`'s own "the page does not scroll" test).
- **Desktop is unchanged.** The editor only ever activates for `appState.mode === 'edit'` at
  `max-width: 960px`; View, Setup, and Features modes, and every width above that breakpoint,
  keep exactly their pre-nl-o47.4 behaviour — including the desktop/View-mode manual Maximize
  toggle, still covered on its own by `tests-e2e/touch.spec.js`'s "View mode: maximizing a view
  on a phone keeps the viewBox aspect ratio" test.

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
- `src/render/screenPoint.js` – the one client-pixel↔viewBox-unit authority, through
  `svg.getScreenCTM()`; used by `dragController.js`, `setupController.js`, and
  `featureController.js` so a client point never has to become a viewBox point twice.
- `src/render/yardBounds.js` – the declared yard a plant may be dragged within.
- `src/render/visiblePlanCenter.js` – pure screen-rect math: the centre, in yard
  feet, of whatever part of the plan view is on screen (nl-o47.3).
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
- `src/interaction/dragController.js` – pointer events + hit-testing for moving plants in plan
  and elevation views; since nl-o47.2, mouse's press-and-drag and touch/pen's tap-to-select +
  drag-the-selection are two branches of the same controllers (see "Interaction and controls").
  Since nl-o47.6.2 it is also drift-aware: every hit/miss routes through
  `src/interaction/driftHitTest.js` to decide select-the-whole-drift / drill-in / leave. Since
  nl-o47.4, `handlePointerDown` also hands off to a second finger (see "The phone editor" above)
  instead of ignoring it outright, and `movedPastThreshold` tracks the tap-movement threshold
  regardless of selection, so a one-finger pan with nothing selected cannot also read as a tap.
- `src/interaction/phoneEditor.js` – the phone editor itself (nl-o47.4): entering/leaving it,
  the tab strip, reparenting the shared toolbar buttons and `#speciesTable` into its own slots
  and back, the Plants sheet, and wiring `canvasGesture.js` to whichever panel is currently
  maximized. See "The phone editor" above.
- `src/interaction/canvasGesture.js` – the DOM glue for pinch-zoom/pan (nl-o47.4): real pointer
  events in, `canvasZoom.js` calls and a CSS transform on `.view` out.
- `src/render/canvasZoom.js` – pure: the transform math behind pinch-zoom/pan (nl-o47.4) —
  clamping scale and pan to their limits, zooming about an anchor point (a button) or a live
  pinch's own start snapshot. No DOM; unit-tested in `tests/canvasZoom.test.js`.
- `src/interaction/tapSelection.js` – pure: tap-vs-drag classification and which candidate a tap
  selects or cycles to, given the previous tap.
- `src/interaction/driftHitTest.js` – pure (nl-o47.6.2): `resolveDriftAction` (what a hit or a
  miss on a member should do to the selection) and the gap-tap machinery
  (`containingDriftIdsByDistance`/`resolveGapTapAction`) for a tap between members, inside a
  drift's outline, including cycling into a different drift when two outlines overlap.
- `src/render/groupClamp.js` – pure: clamping a delta applied to every member of a selection at
  once, so a group move or nudge keeps the group's shape (generalizes `yardBounds.js`'s
  single-plant clamp to a set of points sharing one delta). Powers a drift's group drag/nudge
  too, unchanged: both already move "whatever the selection currently is."
- `src/state/selection.js` – pure: pruning a selection Set against the current plant list, and
  Set equality. `src/ui/plantSelection.js` is the stateful wrapper (owns
  `appState.selectedPlantIds`, and since nl-o47.6.2 `selectedDriftId`/`driftDrilledIn`) that
  `src/app.js` and `dragController.js` actually call.
- `src/state/driftSelection.js` – pure (nl-o47.6.2): the selection's drift-context state
  machine — `driftForExactSelection`, `inferDriftContext` (what `selectPlants(ids)` should set
  the context to), `pruneDriftContext` (what survives a prune) — behind `plantSelection.js`.
- `src/ui/selectionBar.js` – the selection action bar: Details, Clone, Remove, Done, and the
  compass nudge arrows, shared by every selection; the drift-specific controls (rename, count,
  spread, clone/remove drift, drilled-in's extra two buttons) are described under "Drifts"
  above. `src/state/nudgeSelection.js` is the pure move-by-one-step-and-clamp behind the
  arrows and the desktop keyboard bonus. Since nl-o47.4 it also owns the "More" popover's
  open/closed state (design.html's `.selection-bar__more`) — see "The phone editor" above.
- `src/history/layoutHistory.js` – the undo/redo stack: one full snapshot (placements, config, features) per revision; server-backed via `/api/history`.
- `src/history/reconcileLayout.js` – which history entry a legacy layout file was showing; used only by the import.
- `src/data/placements.js` – a plant reduced to its placement, and `sameLayout`.
- `src/history/layoutHistoryController.js` – the page's side of it: undo/redo buttons, the save-status line, `commit()` / `commitSetup()` / `commitFeatures()` (record, persist through one queue, check the server's cursor), and restoring a revision's setup and features on undo/redo.
- `src/state/plantEdits.js` – add, clone, and remove a plant; `src/state/yardEdits.js` – scale and
  shift features, patch a view. Pure, and unit-tested directly.
- `src/data/driftId.js` – a drift id's slug shape (`isValidDriftId`) and its display label
  (`humanizeDriftId`, nl-o47.6.2); `src/state/plantIds.js`'s `buildDriftId` mints one.
  `src/state/driftGeometry.js` and `src/state/driftEdits.js` – a drift's derived geometry
  (members, centroid, outline hull, the actual padded polygon to draw it, spacing, phyllotaxis
  clump layout, suggestion clusters) and its edits (add/remove a member, spread, rename, clone,
  dissolve, remove the whole drift, and `addDriftFromCatalog` — place N of one species as a
  fresh drift, nl-o47.6.3), pure like `plantEdits.js` (see "Drifts" above).
- `src/ui/speciesHighlight.js` – the table ↔ drawing link: highlighted species, targeted and
  hovered plant, and `refresh()` (rebuild the table, re-grade the ecology check). Its
  `setTargetedPlant` also selects (`src/ui/plantSelection.js`) while Edit mode is on (nl-o47.2).
- `src/render/speciesTable.js` – the species table; `src/interaction/plantMenu.js` – the plant's
  Clone/Remove menu.
- `src/export/exportActions.js` – the plan-bundle and HOA-packet downloads: render in June,
  capture every view, zip, restore the page. Covered by `tests-e2e/export.spec.js`.
- `src/ui/detailSheet.js` – the plant detail sheet: facts for the month, keystone/larval-host
  notes, and nearby animals that use the genus.
- `src/ui/addPlantSheet.js` – the Add plant sheet: search, filter chips, sort,
  the "How many?" stepper (nl-o47.6.3), and the tappable species list, over
  `src/data/speciesSearch.js` and the `/api/favorites` calls (nl-o47.3).
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
