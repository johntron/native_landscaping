#!/usr/bin/env bash
# Deploy main's tip to the live site (nl-3s5.12).
#
# Production does not run from the dev working tree. `web` and `feed-poller`
# bind-mount a separate git worktree (default: ../native_landscaping-deploy,
# a sibling of the dev tree) detached at a commit of main. This script:
#
#   1. creates that worktree if it is missing,
#   2. moves it to main's tip (git checkout --detach),
#   3. restarts `web`, and `feed-poller` if the deployed range touched code it
#      loads, or recreates both (`up -d --no-deps`) when the running containers
#      still mount something else or the compose file / dependencies changed,
#   4. verifies that the container really restarted and that the server
#      answers,
#   5. on any failure after step 2, puts the worktree back on the commit it
#      was on, restarts once more to bring the old code back, and exits
#      non-zero with a loud message. It never leaves the site half-deployed.
#
# It never touches `cloudflared`: every compose call names its services, and
# `up` always carries --no-deps.
#
# Run by .githooks/post-commit and post-merge after a commit or merge on main.
# Safe to run by hand at any time: `tools/deploy.sh`.
#
# Environment:
#   DEPLOY_DIR       deploy worktree path (default: <dev tree>/../native_landscaping-deploy).
#                    Exported to compose, which reads the same variable.
#   DEPLOY_URL       base URL to check (default: http://127.0.0.1:8080)
#   DEPLOY_TIMEOUT   seconds to wait for the server to answer (default: 60)
set -euo pipefail

# Git exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and friends to hooks. Left
# set, `git -C <deploy tree>` would act on the dev tree's repository and index.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)

log() { printf 'deploy: %s\n' "$*"; }
banner() {
  {
    printf '\n'
    printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    printf '!!! DEPLOY FAILED: %s\n' "$*"
    printf '!!! Fix the cause, then re-run: tools/deploy.sh\n'
    printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  } >&2
}
announced=0
die() { announced=1; banner "$*"; exit 1; }

# Every non-zero exit is loud, including one `set -e` causes with no die()
# message, and once the deploy tree has moved, every failure rolls it back.
rolled_forward=0
on_exit() {
  local status=$?
  trap - EXIT
  [ "$status" = 0 ] && exit 0
  [ "$announced" = 1 ] || banner "a command failed with status $status (see the output above)"
  [ "$rolled_forward" = 1 ] && rollback
  exit "$status"
}
trap on_exit EXIT

# --- Locate the dev tree (the main worktree), whichever worktree or cwd ran us.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
common_dir=$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir) ||
  die "not inside a git repository ($script_dir)"
dev_root=$(dirname "$common_dir")
[ "$(git -C "$dev_root" rev-parse --show-toplevel 2>/dev/null)" = "$dev_root" ] ||
  die "could not resolve the main worktree from $common_dir"
compose_file="$dev_root/docker-compose.yml"
[ -f "$compose_file" ] || die "no compose file at $compose_file"

deploy_dir=${DEPLOY_DIR:-"$dev_root/../native_landscaping-deploy"}
deploy_dir=$(realpath -m "$deploy_dir")
export DEPLOY_DIR="$deploy_dir"
base_url=${DEPLOY_URL:-http://127.0.0.1:8080}
timeout_s=${DEPLOY_TIMEOUT:-60}

compose() { docker compose -f "$compose_file" --project-directory "$dev_root" "$@"; }
# Checkouts in the deploy tree run no hooks: beads' post-checkout would sync its
# database from that tree, and the .githooks dispatcher has nothing to do there.
git_nohooks() { git -c core.hooksPath=/dev/null "$@"; }

# One deploy at a time: a merge and a hand run can overlap.
exec 9>"$common_dir/deploy.lock"
flock -w 300 9 || die "another deploy has held $common_dir/deploy.lock for 5 minutes"

# --- The commit to deploy: main's tip. Never HEAD of whatever branch ran us.
target=$(git -C "$dev_root" rev-parse --verify --quiet 'refs/heads/main^{commit}') ||
  die "no local branch main"
log "deploying main $(git -C "$dev_root" log -1 --format='%h %s' "$target")"

# --- 1. The deploy worktree.
if [ ! -e "$deploy_dir" ]; then
  log "creating deploy worktree at $deploy_dir"
  git_nohooks -C "$dev_root" worktree add --detach "$deploy_dir" "$target" >/dev/null ||
    die "git worktree add $deploy_dir failed"
fi
deploy_common=$(git -C "$deploy_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
  die "$deploy_dir exists but is not a git worktree (move it aside, or set DEPLOY_DIR)"
[ "$deploy_common" = "$common_dir" ] ||
  die "$deploy_dir is a worktree of a different repository ($deploy_common)"
[ "$(git -C "$deploy_dir" rev-parse --show-toplevel)" = "$deploy_dir" ] ||
  die "$deploy_dir is inside a worktree, not the root of one"
# Mountpoints Docker would otherwise create inside the worktree as root, which
# `git worktree remove` then cannot delete without sudo. All gitignored.
mkdir -p "$deploy_dir/node_modules/jszip"

# Nothing may have been edited in the deploy tree: runtime writes go to the dev
# tree's data/, projects/ and catalog/ (see docker-compose.yml). A local change
# here is a bug, and checking out over it would lose it.
if [ -n "$(git -C "$deploy_dir" status --porcelain --untracked-files=no)" ]; then
  git -C "$deploy_dir" status --short --untracked-files=no >&2
  die "the deploy worktree $deploy_dir has local changes; inspect them before deploying"
fi
previous=$(git -C "$deploy_dir" rev-parse HEAD)

# --- What the range touched decides how much to restart.
changed=""
if [ "$previous" != "$target" ]; then
  changed=$(git -C "$dev_root" diff --name-only "$previous" "$target")
fi
touched() { [ -n "$changed" ] && grep -Eq "$1" <<<"$changed"; }

# feed-poller loads its code once at boot. This list is the import closure of
# tools/schedule-feed-poll.mjs (checked 2026-09-23); widen it when that grows.
FEED_POLLER_CODE='^tools/(feedState/|savedAreas/|fetch-observation-events\.mjs$|schedule-feed-poll\.mjs$|inatShared\.mjs$|usda-plants/probeCache\.js$|[^/]*Db\.js$)'
restart_poller=0
touched "$FEED_POLLER_CODE" && restart_poller=1

rebuild=0
touched '^package(-lock)?\.json$' && rebuild=1

# `restart` keeps a container's old mounts and config. Recreate instead when the
# running container does not mount the deploy tree at /app (the first cutover,
# or a changed DEPLOY_DIR), or the compose file or dependencies changed.
container_of() { compose ps -q "$1" 2>/dev/null | head -n1; }
app_mount_of() {
  docker inspect "$1" --format '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}' 2>/dev/null
}
state_of() { docker inspect "$1" --format '{{.State.StartedAt}} {{.State.Pid}}' 2>/dev/null || true; }

web_id=$(container_of web)
poller_id=$(container_of feed-poller)
recreate=0
reason=""
if [ -z "$web_id" ] || [ "$(app_mount_of "$web_id")" != "$deploy_dir" ]; then
  recreate=1; reason="web does not mount $deploy_dir at /app"
elif [ -z "$poller_id" ] || [ "$(app_mount_of "$poller_id")" != "$deploy_dir" ]; then
  recreate=1; reason="feed-poller does not mount $deploy_dir at /app"
elif touched '^docker-compose\.yml$'; then
  recreate=1; reason="docker-compose.yml changed"
elif [ "$rebuild" = 1 ]; then
  recreate=1; reason="package.json or package-lock.json changed"
fi

web_before=$( [ -n "$web_id" ] && state_of "$web_id" || true )
poller_before=$( [ -n "$poller_id" ] && state_of "$poller_id" || true )

# --- Build before touching anything, so a failed build changes nothing.
if [ "$rebuild" = 1 ]; then
  log "dependencies changed: rebuilding the image"
  compose build web feed-poller || die "docker compose build failed; nothing was changed"
fi

# --- 2. Move the deploy tree. From here on, a failure rolls back (on_exit).
rollback() {
  set +e
  printf '\ndeploy: FAILED after moving the deploy tree; rolling back to %s\n' "$previous" >&2
  if git_nohooks -C "$deploy_dir" checkout --quiet --detach "$previous"; then
    if [ "$recreate" = 1 ]; then
      compose up -d --no-deps --force-recreate web feed-poller >&2 || true
    else
      compose restart web feed-poller >&2 || true
    fi
    printf 'deploy: deploy tree is back on %s and web/feed-poller were restarted on it;\n' \
      "$(git -C "$deploy_dir" log -1 --format='%h %s' "$previous")" >&2
    printf 'deploy: check %s before trusting it.\n' "$base_url/" >&2
  else
    printf 'deploy: ROLLBACK CHECKOUT ALSO FAILED; %s is in an unknown state.\n' "$deploy_dir" >&2
  fi
}

git_nohooks -C "$deploy_dir" checkout --quiet --detach "$target" ||
  die "git checkout --detach $target in $deploy_dir failed"
rolled_forward=1

# --- 3. Restart. Services are always named; `up` always has --no-deps, so
# cloudflared is never recreated or restarted.
if [ "$recreate" = 1 ]; then
  log "recreating web and feed-poller ($reason)"
  compose up -d --no-deps --force-recreate web feed-poller || die "docker compose up failed"
  restart_poller=1
elif [ "$restart_poller" = 1 ]; then
  log "restarting web and feed-poller (the range touched feed-poller code)"
  compose restart web feed-poller || die "docker compose restart failed"
else
  log "restarting web"
  compose restart web || die "docker compose restart web failed"
fi

# --- 4. Verify. The process must be new, and the server must answer.
check_restarted() { # service before-state
  local id after
  id=$(container_of "$1")
  [ -n "$id" ] || die "no $1 container after the restart"
  after=$(state_of "$id")
  [ "$(docker inspect "$id" --format '{{.State.Running}}')" = true ] || die "$1 is not running"
  [ -n "$after" ] && [ "$after" != "$2" ] ||
    die "$1 did not restart (StartedAt/Pid unchanged: $after)"
  [ "$(app_mount_of "$id")" = "$deploy_dir" ] ||
    die "$1 mounts $(app_mount_of "$id") at /app, not $deploy_dir"
  log "$1 restarted: $after"
}
check_restarted web "$web_before"
[ "$restart_poller" = 1 ] && check_restarted feed-poller "$poller_before"

status=""
for _ in $(seq "$timeout_s"); do
  status=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$base_url/" || true)
  [ "$status" = 200 ] && break
  sleep 1
done
[ "$status" = 200 ] || die "$base_url/ answered '$status', not 200, after ${timeout_s}s"
log "$base_url/ answered 200"

# If the range changed a file the server serves straight from the deploy tree,
# make sure the live copy is the deployed one. Many commits change none (the
# static allowlist in server/static.js is narrow), and that is fine.
# projects/ and catalog/ are served from the dev tree's mounts, so they are skipped.
served=$(printf '%s\n' "$changed" |
  grep -E '^([a-z0-9-]+\.(html|css)|plants\.csv|src/.+\.js|(ecology|sourcing)/[a-z0-9-]+\.csv)$' || true)
for path in $served; do
  git -C "$dev_root" cat-file -e "$target:$path" 2>/dev/null || continue # deleted
  expected=$(git -C "$dev_root" show "$target:$path" | sha256sum)
  actual=$(curl -s --max-time 10 "$base_url/$path" | sha256sum)
  [ "$expected" = "$actual" ] || die "$base_url/$path does not match $path at $target"
  log "$path is live"
  break # one file is proof enough that the mount is right
done

trap - EXIT
log "deployed $(git -C "$deploy_dir" log -1 --format='%h %s')"
