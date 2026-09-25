# Native Landscaping: Agent Guide

This is the one canonical guide for any agent (Claude, Codex, or other) working in
this repository. It is a map. The deep dives it links to hold the detail; read the
one for the area you are changing.

## Mission

> **Build power tools that help homeowners, landscapers, and the people who advise
> them plant wisely: choosing, placing, and caring for plants so each yard fits its
> site and supports the wildlife and habitat around it.**

What that commits every tool to:

- **Wiser decisions, not more information.** A tool earns its place when it changes
  what someone plants, where they plant it, or how they look after it: a species to
  choose, an invasive to skip, leaves left on the ground, a rights packet an HOA will
  accept. Showing information that leads to no decision is not the goal.
- **Grounded in what is observed and cited.** Local flora, nearby iNaturalist
  records, and published sources come before models and scores. A claim the evidence
  cannot carry does not ship, and our own judgement calls are labelled as ours.
- **Integrate with the landscape around the yard.** A yard is one patch in a larger
  network of neighbouring yards, creeks, parks and remnant prairie. The tools show
  what is already nearby and what the yard is missing, without inventing a
  connectivity score.
- **Local first.** Start with the Blackland Prairie / North Central Texas and get it
  right before going wider.

---

## The tools

The suite is called **Rewilder**. Every page is a static HTML file at the repo root
with one entry module under `src/`; no bundler, no build step. The pages share one nav,
in the order a homeowner walks them: learn why it matters, see what is nearby, design
the yard, buy the plants, defend it. That order, the labels, and the "<page> · Rewilder" title format
live in `src/ui/siteRoute.js`. The nav is plain HTML on each page, and
`tests/siteNav.test.js` fails if any copy drifts from it. The table below follows the
same order.

| page | entry | what it is for |
| --- | --- | --- |
| `index.html` | `src/patchnetwork/` | **Start here.** The homeowner-facing argument, led by the PLANTS memory aid, with the keystone-genus screen ("What belongs here") and the invasives list. Needs no project; its handoff section opens a yard in `design.html`. |
| `ecosystem.html` | `src/ecosystem/` | **What's nearby**: streams and green space near the site ("Habitat nearby", from `ecology/anchors.csv`: name and straight-line distance only, OSM green space marked not checked), plants and animals reported on iNaturalist nearby (a per-yard index `feed-poller` builds once the yard has a location; [docs/ecology-rules.md](docs/ecology-rules.md#the-nearby-species-index-dataecosystemdb)), and the plant genera that would serve them. Also available as a drawer (`src/ui/ecosystemDrawer.js`) on any page with `?project=`; both compute matches through `src/ecosystem/plantMatches.view.js`. |
| `feed.html` | `src/feed/` | **New sightings**: new iNaturalist records in saved monitoring areas, flagged for invasives, rarity, and yard relevance. |
| `design.html` | `src/app.js` | **Your yard**, the design tool: a planting drawn month by month in a plan and compass elevations, graded by the ecological rules engine. Scoped by `?project=<slug>`. See [docs/design-tool.md](docs/design-tool.md). |
| `sourcing.html` | `src/sourcing/` | **Buy plants**: dated native plant sales around DFW (upcoming vs. recently held, split by the viewer's local date) and the NPSOT NICE! partner nurseries of the Dallas, North Central and Trinity Forks chapters, from the sourced tables in `sourcing/`. Sale dates go stale: re-check each organizer's page and bump `checked_on` each spring and fall. |
| `rights.html` | (static) | **Your rights**: Texas statutes on what an HOA can and cannot forbid. Statutory information, not legal advice. |
| `fnct.html` | `src/fnct/` | **Flora index**: searchable species from the *Flora of North Central Texas*. Reference. |
| `claims-coverage.html`, `claims-conflicts.html` | `src/claims/` | Maintainer views over the plant-data claim store (not in the nav): field coverage, and conflicts awaiting a human correction. |

The **HOA submission packet** export (`src/export/hoaPacket.js`) is produced from `design.html`.

## Repo map

```
plants.csv            the species catalog every yard renders from (the single source of truth); claim-backed botany only
plant-drawing.csv     how each species is drawn (colours, flowers), keyed by plants.csv id; our judgement, with a source
catalog/              wider regional lists + manual-corrections.tsv; see catalog/README.md
ecology/              sourced, genus- or place-keyed tables for the rules engine
sourcing/             sourced nursery and plant-sale tables behind sourcing.html
projects/backyard/    the one yard still in git: seeds the shared example at startup only when none exists (yards live in app.db)
src/                  browser code: one folder per page, plus shared analysis/, data/, render/, ui/
tools/                everything that calls a third-party API, the claim store, the usda-plants MCP server
server.js, server/     the HTTP server: server.js dispatches to server/routes/{project,ecosystem,feed,claims}.js, then static files
data/                 local SQLite (gitignored); see "Data safety" below
docs/                 deep dives; docs/data-acquisition/ is the claim-store design (01-11)
tests/, tests-e2e/    Node unit tests (the gate) and Playwright specs
```

---

## Rules that hold everywhere

### Evidence

- **Don't invent plant data.** Use real botanical names. Every row in a sourced table
  carries a `source`, and a value nobody has sourced stays **blank rather than
  guessed**. `tests/sourcedTables.test.js` enforces the `source` column on every
  `ecology/` and `sourcing/` table and on `plant-drawing.csv`. "Absent" is reported as undeclared, never filled with a default.
- **No composite scores.** The rules engine reports per dimension with no roll-up,
  because the weights would be invented. **Never emit a connectivity score, gradient,
  or weighted lines** either: anchor location and distance are facts, while "how
  connected you are" is a model. Show distance and name what lies between (a road, a
  highway, continuous turf).
- **Retired, do not resurrect:** the parcel/hex habitat-scoring map (nl-3hi has the
  reasoning), and Floristic Quality Assessment as a design grader
  ([docs/ecology-rules.md](docs/ecology-rules.md#why-fqa-was-rejected)).
- **Label judgement calls.** An authored threshold (e.g. `RANGE_THRESHOLD_MI`,
  `AMPLE_SHARE`) is marked as a judgement, not presented as a sourced fact. The PLANTS
  mnemonic is our packaging of the literature, not a published framework; cite each
  letter on its own.
- **Verify every legal claim against the statute itself**
  (statutes.capitol.texas.gov, and capitol.texas.gov for bill history) before it
  reaches a page. An AI research critique once cited two 2025 bills as law; both had
  died in committee (details in nl-3hi.8).

### Privacy and licensing (this repo is public)

- Exact addresses and coordinates never reach git. A project's `place` is a short
  label; the address behind it is in `app.db` (`projects.location_json`), set by the
  yard's owner in Setup mode (nl-3s5.30) or by the operator with
  `tools/project-location.mjs`. Yards themselves are private to their owner and live in
  `app.db` too, not in the repo (nl-3s5.3). The one exception is the shared read-only
  example yard (nl-3s5.24): a location-free copy of the owner's backyard, owned by the
  system user `example@rewilder.invalid`, readable by any signed-in user, refreshed with
  `tools/refresh-example-yard.mjs`. It keeps the backyard's place label, so viewers see
  that place's nearby habitat and species (owner decision 2026-09-24).
- The NCTX flora PDFs may be downloaded but not redistributed. They stay local
  (`docs/data-acquisition/corpus/*.pdf` is gitignored); the extracted text is what
  code reads.
- NPIN (Lady Bird Johnson Wildflower Center) data is cleared for **non-commercial use
  with citation only**. Going commercial would mean re-clearing or removing
  NPIN-derived fields (`docs/data-acquisition/permission-requests.md`).
- Only iNaturalist photos with a `license_code` may be displayed; `null` means all
  rights reserved.

### Code

- **Plain HTML, CSS, and ES modules.** No bundler, no build step, no heavy framework
  without an explicit ask. JSDoc for parameter shapes.
- **Browser code never calls a third-party API.** iNaturalist, GloBI, USDA, NHD,
  OSM, and geocoding calls live in `tools/`. They are cached, and their results
  land in committed CSVs or local SQLite that the server reads.
- **`src/analysis/` is pure.** No DOM, no fetch. Every threshold and verdict lives in a
  rule module; renderers display what they are handed.
- **Data-driven, not hard-coded.** Species attributes come from `plants.csv`, extended
  through `src/data/plantParser.js`. Every plant object is built by
  `createPlantFromSpecies`, and every new plant id is minted through
  `src/state/plantIds.js`.
- **Colour lives in the token block at the top of `styles.css`.** The rule it encodes:
  amber means life and only data glows; cyan is the apparatus that measures it; chrome
  never glows.
- Reference apparatus (column definitions, page cites, sources) sits behind
  click-to-open disclosures (`src/ui/disclosure.js`). Caveats stay visible.

### Data safety

`data/*.db` files are gitignored. Most are rebuildable caches (`ecosystem.db`,
`probe-cache.db`, `observation-events.db`, `claims.db`): re-run the matching `tools/`
script. **One holds state a person entered by hand and cannot be rebuilt: `app.db`**,
with the yard photos beside it under `DATA_DIR/projects/`. Both are backed up nightly,
together, encrypted, to Google Drive: see [Backups](#backups) below.

- `app.db` (`server/db/appDb.js`, numbered migrations in `server/db/migrations/`) holds
  users, the saved monitoring areas entered through `/api/saved-areas` (`saved_areas`,
  with a nullable `owner_id` foreign key to `users`: each area has one owner, every
  feed and saved-area route is scoped to it in SQL, and an unowned area is visible to
  nobody, admins included; nl-3s5.5), the feed's per-observation
  read/dismissed flags (`feed_state`, kept out of `observation-events.db` so it survives
  a rebuild of that file), and every yard (`projects`: config, features, location, history
  cursor, owner; `history_entries`: one revision stream per yard across planting, setup and features, each a full snapshot, since nl-3s5.20; photos are kept while any revision names them), since nl-3s5.3. `web`
  opens it once at startup (`ctx.db.app`), applies migrations, seeds `OWNER_EMAIL` as
  admin, and runs the one-time legacy import below. `feed-poller` opens it with
  `openAppDbWithoutMigrating`, which never migrates, seeds or imports, and waits for
  `web` if the schema is behind. The migration runner is safe with both processes
  starting at once. `DATA_DIR` controls where it lives; tests and the e2e scratch server
  point it at a throwaway directory instead.
- Every write also exports a local snapshot of all users' saved areas (rounded
  coordinates, names, owners) to `data/saved-areas.export.json` under `DATA_DIR`. It is
  gitignored, not tracked: area names can identify people, and it holds every user's
  areas (nl-3s5.5). The backups make it redundant and it is not backed up itself. Retiring
  it means dropping the three `exportSavedAreasJson` calls in `server/routes/feed.js`, then
  `exportPath`, `exportSavedAreasJson` and `restoreSavedAreasFromExport` in
  `tools/savedAreas/savedAreasDb.js` and their tests.
- **Retired:** `saved-areas.db` and `feed-state.db`. Their tables moved into `app.db`
  (nl-3s5.11): `server/db/legacyImport.js` copied them once, recorded in `app.db`'s
  `app_meta` table, and never writes the old files. Nothing opens them any more. Archive
  them once the first backup has been verified; the steps are under [Backups](#backups).
  Never copy a `.db` alone: recent rows may sit only in its `-wal`.
  `node tools/import-legacy-app-data.mjs --dry-run` compares their row counts with
  `app.db`, read-only.
- **Yard photos** are files, not rows: `DATA_DIR/projects/<projects.id>/img/` (so
  `data/projects/` by default, gitignored). Hand-uploaded and not rebuildable either:
  back them up with `app.db`, as a set, because each directory is named by the row id
  it belongs to. They are outside the served root; `GET /api/project-photo` serves
  them to the yard's owner only, plus the shared example yard's to any signed-in user.
- **Retired:** `projects/<slug>/` as the store. `tools/import-projects.mjs` copied the
  yards into `app.db` once (recorded as `legacy_import.projects`) and never writes the
  files; web does not run it on start. See
  [docs/design-tool.md](docs/design-tool.md#importing-yards-from-files).

A PreToolUse hook in `.claude/settings.json` blocks any `rm` whose command
mentions `data/`: inspect the file and ask before deleting anything there.

#### Backups

`tools/backup/run-backup.mjs` (nl-3s5.13), run nightly at 03:30 by a **systemd user
timer** on the host (`tools/backup/systemd/rewilder-backup.{service,timer}`). It takes a
consistent `VACUUM INTO` snapshot of `app.db` (opened read-only, never through
`appDb.js`) and copies `DATA_DIR/projects/` into a private temp dir. It checks
`integrity_check` and writes a `MANIFEST.json` of sha256s and per-table row counts.
It uploads the result to `rewilder-crypt:snapshots/<YYYY-MM-DDTHHMMSSZ>/`, with the
manifest last as the completion marker, checks it with `rclone cryptcheck`, then prunes.
`rewilder-crypt` is an rclone **crypt** remote over `gdrive:rewilder-backup`, so Drive
holds only encrypted contents and encrypted file and folder names. The job refuses any
`BACKUP_REMOTE` that is not type `crypt`.

- **Why a host timer**, not a compose service: rclone and its Drive OAuth token stay on
  the host and out of every container, and `node:22-slim` has no rclone. Lingering is on
  for the user, so the timer runs while nobody is logged in, and `Persistent=true`
  catches up on a night the host was off. Failures land in the journal.
- **Config:** the owner's default `~/.config/rclone/rclone.conf` holds both `gdrive`
  (from `rclone config`) and `rewilder-crypt` (from the setup script; keys obscured,
  which is reversible, not encryption). The keys themselves are in the gitignored
  `.backup-crypt.env` at the root of the dev tree (mode 600: `RCLONE_CRYPT_PASSWORD`, the
  salt `RCLONE_CRYPT_PASSWORD2`, and the target). **The owner keeps an offline copy.
  Without both keys every backup is unreadable.**
- **Retention:** the newest snapshot of each of the 14 most recent days that have one,
  plus the newest of each of the 8 most recent ISO weeks (`tools/backup/retention.js`,
  tested in `tests/backupRetention.test.js`). A folder without a manifest is a failed
  run, pruned once a newer complete snapshot exists. A folder whose name is not a
  timestamp is never touched. On Drive, pruned folders go to the Drive trash
  (ciphertext).
- **Failure is loud:** the service exits 1 and skips the prune. It logs to
  `journalctl --user -u rewilder-backup.service`, and `systemctl --user --failed` lists
  it. `DATA_DIR/backup-status.json` (gitignored) records `lastSuccessAt`,
  `lastSnapshot`, `lastError` and row counts, for a future admin page. If `lastSuccessAt`
  is more than a day or two old, the backup is broken.
- **Not backed up, on purpose.** `.env` holds the tunnel token and the Access settings,
  all re-issuable from the Cloudflare dashboard. Encrypting it into the same archive
  would widen what a leaked key exposes, for little gain. The crypt keys and
  `rclone.conf` stay out too: a backup that needs its own key to open cannot hold that
  key, and the gdrive token comes back by re-running `rclone config`. Caches, the
  retired legacy dbs, and `saved-areas.export.json` are also left out.
  `catalog/manual-corrections.tsv`, appended by `/api/claims-correct`, is tracked in
  git, so only appends not yet committed are at risk.

**One-time activation** (the owner, then the orchestrator), from the dev tree:

```bash
#   0. tools/backup/ merged to main (which deploys it); the unit runs the deploy tree's copy
git -C ../native_landscaping-deploy ls-files tools/backup   # must list run-backup.mjs
rclone config                                    # 1. owner: create remote `gdrive` (Google Drive, OAuth)
tools/backup/setup-crypt-remote.sh               # 2. creates rewilder-crypt -> gdrive:rewilder-backup and
                                                 #    .backup-crypt.env; refuses to replace an existing remote
#   3. owner: copy .backup-crypt.env offline NOW (password manager or printout)
mkdir -p ~/.config/systemd/user                  # 4. install the timer
cp tools/backup/systemd/rewilder-backup.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now rewilder-backup.timer
systemctl --user start rewilder-backup.service   # 5. first run, now (blocks until done)
journalctl --user -u rewilder-backup.service -n 30 && cat data/backup-status.json
rclone lsd gdrive:rewilder-backup                # 6. Drive shows only encrypted names
node tools/backup/restore.mjs list               #    the crypt view shows the snapshot
systemctl --user list-timers rewilder-backup.timer
```

Then do a test restore against Drive (below, steps 1 to 2 only), and archive the legacy
dbs:

```bash
d=$(date +%F); a=$(mktemp -d)
for f in saved-areas feed-state; do
  sqlite3 -readonly "data/$f.db" "VACUUM INTO '$a/$f.db'"   # includes rows still in the -wal
done
rclone copy "$a" "rewilder-crypt:archive/legacy-$d" && rclone cryptcheck "$a" "rewilder-crypt:archive/legacy-$d"
mkdir -p ~/rewilder-legacy-$d
for f in data/{saved-areas,feed-state}.db{,-wal,-shm}; do [ -e "$f" ] && mv "$f" ~/rewilder-legacy-$d/; done
```

**Restore.** Fetching never writes into `DATA_DIR`; putting a snapshot live is a separate,
deliberate step. On a new host, first put back `.backup-crypt.env` from the offline
copy, run `rclone config` for `gdrive`, then `tools/backup/setup-crypt-remote.sh` (it
reuses the keys in the file).

```bash
node tools/backup/restore.mjs list                       # 1. pick a snapshot, or use `latest`
r=$(mktemp -d)/snap; node tools/backup/restore.mjs fetch latest "$r"
                                                         # 2. downloads, checks every sha256,
                                                         #    integrity_check and per-table row counts
docker compose stop web feed-poller                      # 3. never cloudflared
old=~/rewilder-pre-restore-$(date +%FT%H%M); mkdir -p "$old"
for f in app.db app.db-wal app.db-shm projects; do [ -e "data/$f" ] && mv "data/$f" "$old"/; done
                                                         # 4. move aside, never rm; a stale -wal left
                                                         #    beside the restored db would be replayed onto it
cp "$r/app.db" data/app.db && cp -a "$r/projects" data/projects   # 5. db and photos as one set
docker compose up -d --no-deps web feed-poller           # 6. then check a yard and its photos load
```

### Identity

The site sits behind Cloudflare Access (Google SSO). `server/identity.js` verifies the
`Cf-Access-Jwt-Assertion` JWT (RS256 only, audience, issuer, expiry) against the team's
certs, fetched and cached by `tools/accessCerts.js`, and attaches `ctx.user`
(`{ id, email, isAdmin }`, or `null`) to every request. A verified email gets a `users`
row in `app.db` on first sight: Access policy membership is the invite list. The
`Cf-Access-Authenticated-User-Email` header is never trusted, because anything on the
host can reach the server directly and forge it. Identity is attached, not yet enforced.

- `CF_ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`) and `CF_ACCESS_AUD` (the
  Access application's AUD tag) configure it. Unset, or with the certs unreachable,
  every request is anonymous (fail closed); a warning logs at startup.
- `DEV_USER_EMAIL` makes every request that user with no JWT, for local dev and the
  Playwright servers (`playwright.config.js`). **Never set it in production.** It logs
  loudly at startup and is ignored whenever either `CF_ACCESS_*` var is set.

---

## Workflow

### After every change: test, then commit (a commit on main deploys itself)

Standing instruction and standing authorization from the repo owner. Do both
without being asked:

```bash
npm test                       # 1. the gate
git add <paths> && git commit  # 2. stage only what you changed; the tree often has unrelated edits
```

**This repository opts into the beads "team-maintainer" profile for commits and
deploys only.** Committing and deploying are pre-authorized. **Pushing is not**:
neither `git push` nor `bd dolt push` (the latter is also denied in
`.claude/settings.json`) runs without asking first, whatever the session-close
protocol printed by `bd prime` says. A current "do not commit" from the user still wins.

**Production is not this working tree.** The app runs in Docker: service `web`
(container `native_landscaping-web-1`) on `127.0.0.1:8080`, fronted by a `cloudflared`
sidecar that must **never** be restarted (it self-heals). A second service,
`feed-poller`, runs `tools/schedule-feed-poll.mjs` every `FEED_POLL_INTERVAL_MINUTES`
(default 30). Both mount a separate git worktree, `../native_landscaping-deploy`
(a sibling of this tree; override with `DEPLOY_DIR`), detached at a commit of main.
Only `data/`, `catalog/` (for `manual-corrections.tsv`) and `node_modules/jszip` are
mounted from this tree, so what users write stays here and the deploy tree is never
written to. (`projects/` is not mounted (nl-3s5.28): `/app/projects` is just the
deploy tree's own tracked seed, `projects/backyard`, which nothing serves.) An
uncommitted code edit is not live, and neither is a
commit on any branch other than main. `npm run serve` and the e2e scratch server
still run straight from this tree for local work.

**A commit or merge on main deploys itself.** The hooks in `.githooks/` (enabled once
per clone with `npm run setup`, which points `core.hooksPath` at this tree's
`.githooks/` by absolute path, so worktrees on older branches keep their hooks) run
`tools/deploy.sh` after `post-commit` and `post-merge`, but only when the current
branch is `main`. A fast-forward merge fires `post-merge`, not `post-commit`, so both
are hooked. Agent worktree branches and detached HEADs never deploy. The hooks chain
to `.beads/hooks/` first, so the beads and git-lfs hooks still run. `git pull --rebase`
onto main fires neither hook: deploy by hand afterwards.

`tools/deploy.sh` (run it by hand any time: `tools/deploy.sh`):

1. creates the deploy worktree if it is missing;
2. runs `git checkout --detach` to main's tip in it, refusing if the tree has local changes;
3. restarts `web`. It also restarts `feed-poller` when the deployed range touched code
   the poller loads: `tools/feedState/`, `tools/savedAreas/`,
   `tools/fetch-observation-events.mjs`, `tools/fetch-ecosystem-index.mjs`,
   `tools/ecosystemIndexQueue.js`, `tools/projectSite.mjs`, `tools/geocode.mjs`,
   `tools/dataDir.js`, `tools/schedule-feed-poll.mjs`, `tools/inatShared.mjs`,
   `tools/usda-plants/probeCache.js`, `tools/*Db.js`, `server/db/`, `src/data/`, or
   `src/analysis/establishmentMeans.js`. That is the import closure of `tools/schedule-feed-poll.mjs`, so widen the list in the
   script when the closure grows. If `docker-compose.yml` or `package*.json` changed,
   or a container still mounts something other than the deploy tree, it runs
   `docker compose up -d --no-deps --force-recreate web feed-poller` instead (and
   rebuilds the image first if dependencies changed), because `restart` keeps old
   mounts. `--no-deps` is what keeps `cloudflared` untouched;
4. checks that `StartedAt`/`Pid` changed, that `/` answers 200, and, if the range
   changed a served file, that the live copy matches the commit;
5. on any failure, stops with a loud `DEPLOY FAILED`, puts the deploy tree back on its
   previous commit and restarts on it. A failed deploy never undoes the commit; fix the
   cause and re-run `tools/deploy.sh`.

**Check that the deploy happened** instead of trusting the output:

```bash
git config --get core.hooksPath                        # <this tree>/.githooks, or nothing deploys
git -C ../native_landscaping-deploy log -1 --oneline   # must match: git log -1 --oneline main
docker inspect native_landscaping-web-1 --format '{{.State.StartedAt}} {{.State.Pid}}'  # changed since before the commit
curl -s http://127.0.0.1:8080/<changed module> | grep <identifier only in the new code>
```

Always run `docker compose` from this tree, never from the deploy worktree. The
compose file pins `name: native_landscaping`, but its relative paths resolve against
the directory it runs from. Never run a bare `docker compose up`: name the services and
pass `--no-deps`, so `cloudflared` is left alone.

Node does not hot-reload, and a commit that is not on main is not deployed. `server.js`
and `server/` keep the routes they booted with, so a POST to a route added since then
returns **404, not 400**. That 404 is the sign of a stale server: check the deploy.
`docker compose ps` prints *elapsed* uptime, so a real restart looks like none hours
later; compare `StartedAt`. `ps` is not in `node:22-slim`; use
`docker compose exec -T web node -e`. If a change is still not live after a verified
deploy, suspect the user's open tab: the server sends `Cache-Control: no-store`, but a
page loaded before the deploy keeps its module graph until reloaded.

### Tests

`npm test` is the gate (Node only, no dependencies). `npm run test:e2e` runs Playwright
in `tests-e2e/` against the installed Chrome. Two rules that have cost real time:
**never assert on geometry or ids read from `projects/<slug>/`**, and **any spec that
writes must use the scratch server**. See [docs/testing.md](docs/testing.md).

### Tools for agents

- **Issues:** `bd` (beads), prefix `nl-`. The tracker is a local Dolt DB;
  `.beads/issues.jsonl` is a diffable export. No markdown TODO lists or plan files.
- **Code intelligence:** `codegraph` (`.mcp.json`), with the index in `.codegraph/`.
  Prefer `codegraph explore` over grep-and-read. Refresh with `codegraph sync`, or
  rebuild with `codegraph init .`.
- **Plant data:** the `usda-plants` MCP server (`tools/usda-plants/mcpServer.js`)
  exposes USDA lookups and the `claims_*` introspection tools over `data/claims.db`.
- **Editor:** `jsconfig.json` and the `typescript` devDependency exist only so the
  TypeScript language server resolves imports. Keep `typescript` at 5.x, because 7.x
  ships no `tsserver.js`.

### Where knowledge goes

One home per kind of fact, so copies cannot drift:

| kind of fact | home |
| --- | --- |
| a rule or fact about this repo that every agent needs | this file |
| the detail of one area | `docs/*.md`, linked from here |
| why a decision was made; open work | a bead (`bd create`, `bd note`) |
| a hard-won gotcha no file records yet | `bd remember`: shown to every agent at session start, so keep it short and move it here once it is general |
| a rule that must never be broken | a hook, not prose (see "Data safety") |

`CLAUDE.md` is a pointer to this file and holds nothing of its own. `bd setup claude --check`
warns that it has no beads section. That is intended: don't run `bd setup claude` to
"fix" it, because the beads section below already reaches Claude through the import.

## Deep dives

- [docs/design-tool.md](docs/design-tool.md): projects, the declared yard and the views
  derived from it, Setup and Features modes, photo placement and upload security, the
  plant CSVs, rendering, and interaction.
- [docs/ecology-rules.md](docs/ecology-rules.md): the rules engine, `ecology/` tables,
  local fauna, habitat anchors, site match, and the two results that look like bugs.
- [docs/testing.md](docs/testing.md): the unit gate and the Playwright suite.
- [docs/data-acquisition/](docs/data-acquisition/): the claim-store design (01-11) and
  permission requests.
- [catalog/README.md](catalog/README.md): the regional plant lists.

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
