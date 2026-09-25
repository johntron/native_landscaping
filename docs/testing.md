# Testing

[AGENTS.md](../AGENTS.md) is the map; this is the detail.

## `npm test`: the gate

`npm test` runs `tests/run-tests.cjs`, which runs two legacy CommonJS suites
(layout history, persistence) and then every `*.test.js` / `*.test.cjs` under
`tests/` with `node --test`. No dependencies are needed beyond Node. It must pass
before every commit.

## Never assert on a shipped project

**Nothing in `tests/` or `tests-e2e/` may assert on geometry or plant ids read from
`projects/<slug>/`.** Every shipped project is editable in the running app, so a
Setup-mode save or a plant drag would fail tests unrelated to the change being made.
This happened twice in two days to `example-frontyard`. Unit tests inline their config
fixture (see `LEGACY_BACKYARD` in `tests/projectConfig.test.js`).
e2e specs take their own scratch project (below).

Since nl-3s5.3 the only yard left in the repo is `projects/backyard` (the seed for the
shared example, nl-3s5.24); the rest are private and live in `app.db`. A test that
needs "a real yard" uses `backyard` and asserts only what holds for any yard (it
parses, it analyses, it survives a catalog rename), never its numbers.

## End-to-end browser tests (Playwright)

`npm run test:e2e` runs the Playwright suite in `tests-e2e/`. It boots `node server.js`
on port `8123` (override with `E2E_PORT`) and drives the real `design.html` in Chrome.

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
- **Yards live in each server's own `app.db`, seeded by the fixture** (nl-3s5.3).
  `tests-e2e/scratch-fixture.mjs` lays the yards out the old way (a directory per
  slug) and runs the real import (`server/db/projectImport.js`) into each server's
  `DATA_DIR`, owned by `E2E_USER_EMAIL`, the identity both servers run as
  (`DEV_USER_EMAIL`). `OWNER_EMAIL` is blanked for both, so a shell's value never
  seeds a real person. The main (read-only) server gets the repo's `backyard`,
  without its gitignored history or location; that is its only yard.
- **A spec that writes must use the scratch server.** Dragging a plant auto-saves via
  `POST /api/layout`, Setup mode's *Save views* posts `/api/project`, and
  *Upload photo* posts `/api/view-background`, and a shared yard is state other specs
  read. `playwright.config.js` starts a second server on `E2E_PORT + 1` over a
  throwaway root and its own `app.db`; reach it through `openScratchProject`
  (`tests-e2e/helpers.js`). Read-only specs use the default server.
- **Read what was saved through the API** (`readScratchLayout`, `readScratchHistory`,
  `readScratchFeatures` in `tests-e2e/helpers.js`, which fetch `/api/layout`,
  `/api/history` and `/api/features` as the same user). For the stored text itself or a
  yard's photo directory, `readSeededProject(dataDir, slug)` in the fixture opens that
  server's `app.db` read-only.
- **Each writing spec gets its own scratch project**, listed in `SCRATCH_PROJECTS` in
  `tests-e2e/scratch-fixture.mjs` (each is a copy of `backyard`; the fixture can write a
  custom `project.json` after the copy when a spec needs other geometry). A spec that
  opens a project *not* in that list still loads, because the app silently falls back to
  `defaultProject`, and then asserts against the wrong yard.
- The fixture lives in `os.tmpdir()` keyed by checkout, not under `test-results/`
  (Playwright wipes that at run start), and it is built only in the main process: the
  config is loaded once per worker too, and eight workers racing on one directory tear it
  apart mid-run.
- **Both e2e servers point `DATA_DIR` at a throwaway directory** (`MAIN_SERVER_DATA_DIR`
  and `SCRATCH_SERVER_DATA_DIR`, under `SCRATCH_DATA_DIR` in
  `tests-e2e/scratch-fixture.mjs`), separate for the main and scratch server so the two
  never open the same SQLite file at once. Uploaded photos land there too. This covers every
  gitignored cache DB the server opens, not just `app.db`: `data/observation-events.db`,
  `data/ecosystem.db`, `data/claims.db`, and `data/probe-cache.db` (opened per request by
  `/api/geocode` and `/api/ecoregion`) all resolve their default path through
  `tools/dataDir.js`'s `resolveDataDir()`, the same function `server/db/appDb.js`
  re-exports. No e2e server ever reads or writes the repo's real `data/`.
  - **Consequence: the main e2e server's `ecosystem.db` and `observation-events.db` start
    empty**, even though its `PUBLIC_DIR` is the repo itself. Its yards have no location
    either, so `nearbyIndexState.spec.js` asserts the page's "no location set" state. This is a deliberate
    trade-off, not an oversight: none of the specs in `tests-e2e/` assert on
    iNaturalist-derived content (nearby species/fauna matches, the feed, or
    `claims-coverage.html`/`claims-conflicts.html`). `ecology.spec.js` (the ecology
    check panel on `design.html`) reads the *committed* `ecology/host-genera.csv`.
    `habitatNearby.spec.js` (the "Habitat nearby" section of `ecosystem.html`) seeds its
    own scratch yard, `habitat-nearby`, with a made-up location and made-up anchors
    straight into the scratch server's `app.db` and `ecosystem.db` (nl-3s5.31: a yard's
    anchors are per yard now, never committed). If
    a future spec needs real cached observation data, seed it explicitly (copy or
    symlink a fixture `.db` into `SCRATCH_DATA_DIR` in `scratch-fixture.mjs`) rather than
    pointing `DATA_DIR` back at the repo's `data/`, which the running deploy also writes
    to.
- **Aim pointer gestures where the app's own hit test looks**, via `dragInPanel` /
  `plantPointerTarget` in `tests-e2e/helpers.js`. Plan views hit-test geometrically and
  the label sits on the plant centre; elevations hit-test through the DOM and their labels
  carry `pointer-events: none`, so aim at the silhouette. A group's bounding box includes
  the label and misses. `page.mouse` uses viewport coordinates and does not scroll, so
  centre the panel first (`scrollIntoView({ block: 'center' })`;
  `scrollIntoViewIfNeeded` is not enough below the fold). Each of these has produced a
  convincing false "regression".
- `test-results/` and `playwright-report/` are gitignored.
