#!/usr/bin/env bash
# One-time setup of the encrypted backup remote (nl-3s5.13).
#
# Creates the rclone crypt remote the nightly backup writes to, layered on the
# Google Drive remote the owner made with `rclone config` (named `gdrive`), so
# Drive only ever holds ciphertext: file contents, file names and folder names
# are all encrypted.
#
#   tools/backup/setup-crypt-remote.sh                       # run from the dev tree
#   tools/backup/setup-crypt-remote.sh --target gdrive:rewilder-backup \
#       --name rewilder-crypt --password-file .backup-crypt.env
#
# The keys (rclone's `password` and `password2`, the salt) live in the
# gitignored password file, default <repo>/.backup-crypt.env, mode 600:
#   * If the file does not exist, fresh random keys are generated and written
#     to it. KEEP AN OFFLINE COPY OF THAT FILE (print it, or put it in a
#     password manager). Both keys are needed; without them every backup is
#     unreadable, and nobody can recover them.
#   * If it exists, its keys are reused. That is how a new or rebuilt host gets
#     back at old backups: restore the file from the offline copy, then run this.
# rclone stores the keys again, obscured (reversibly: obscuring is not
# encryption), in its own config: RCLONE_CONFIG if set, else
# ~/.config/rclone/rclone.conf, where `rclone config` already put gdrive.
#
# Refuses to overwrite an existing crypt remote of the same name, so re-running
# it can never silently rotate the key. Ends with a round-trip check: writes a
# small file through the crypt remote, reads it back, deletes it.
#
# RCLONE_BIN picks the rclone binary (default: rclone on PATH).
set -euo pipefail

RCLONE="${RCLONE_BIN:-rclone}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME=rewilder-crypt
TARGET=gdrive:rewilder-backup
PASSWORD_FILE="$REPO/.backup-crypt.env"

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --password-file) PASSWORD_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "setup-crypt-remote: unknown argument $1" >&2; exit 2 ;;
  esac
done

die() { echo "setup-crypt-remote: $*" >&2; exit 1; }

command -v "$RCLONE" >/dev/null || die "rclone not found (set RCLONE_BIN)"
remotes="$("$RCLONE" listremotes)"
base="${TARGET%%:*}"
printf '%s\n' "$remotes" | grep -qx "$base:" \
  || die "the underlying remote '$base:' does not exist yet. Create it first with: $RCLONE config"
if printf '%s\n' "$remotes" | grep -qx "$NAME:"; then
  die "a remote named '$NAME:' already exists; refusing to replace it (and its key). Delete it deliberately with '$RCLONE config delete $NAME' if you really mean to."
fi

# Read one KEY=value line from the password file without sourcing it.
read_key() { sed -n "s/^$1=//p" "$PASSWORD_FILE" | head -n 1; }

if [ -e "$PASSWORD_FILE" ]; then
  echo "setup-crypt-remote: reusing the keys in $PASSWORD_FILE"
  file_target="$(read_key RCLONE_CRYPT_TARGET)"
  if [ -n "$file_target" ] && [ "$file_target" != "$TARGET" ]; then
    die "$PASSWORD_FILE records target $file_target, not $TARGET; pass --target $file_target"
  fi
else
  umask 077
  gen() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c 48; }
  cat > "$PASSWORD_FILE" <<EOF
# Rewilder backup encryption keys (rclone crypt remote '$NAME', nl-3s5.13).
# KEEP AN OFFLINE COPY. Losing both copies makes every backup unreadable.
# Never commit this file (it is gitignored). Restore steps: AGENTS.md, Data safety.
# Settings used: filename_encryption=standard directory_name_encryption=true
RCLONE_CRYPT_TARGET=$TARGET
RCLONE_CRYPT_PASSWORD=$(gen)
RCLONE_CRYPT_PASSWORD2=$(gen)
EOF
  echo "setup-crypt-remote: generated new keys in $PASSWORD_FILE"
fi
chmod 600 "$PASSWORD_FILE"

pw="$(read_key RCLONE_CRYPT_PASSWORD)"
pw2="$(read_key RCLONE_CRYPT_PASSWORD2)"
[ -n "$pw" ] && [ -n "$pw2" ] || die "$PASSWORD_FILE must hold RCLONE_CRYPT_PASSWORD and RCLONE_CRYPT_PASSWORD2"

# Obscure through stdin, so the plaintext keys are never an argument. The
# obscured values do appear briefly in `rclone config create`'s argv below,
# and obscuring is reversible, so treat that as the keys being visible to
# other processes of this user for a moment: fine on a single-user host.
obs="$(printf '%s\n' "$pw" | "$RCLONE" obscure -)"
obs2="$(printf '%s\n' "$pw2" | "$RCLONE" obscure -)"
"$RCLONE" config create "$NAME" crypt \
  remote="$TARGET" password="$obs" password2="$obs2" \
  filename_encryption=standard directory_name_encryption=true \
  --no-obscure --non-interactive >/dev/null
echo "setup-crypt-remote: created crypt remote '$NAME:' -> $TARGET"

probe=".setup-check-$$"
expected="rewilder backup setup check $$"
printf '%s' "$expected" | "$RCLONE" rcat "$NAME:$probe"
got="$("$RCLONE" cat "$NAME:$probe")"
"$RCLONE" deletefile "$NAME:$probe"
[ "$got" = "$expected" ] || die "round-trip through '$NAME:' failed"
echo "setup-crypt-remote: round-trip through '$NAME:' ok"
echo
echo "NEXT: copy $PASSWORD_FILE somewhere offline now (printout or password manager)."
