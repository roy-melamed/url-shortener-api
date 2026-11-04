#!/usr/bin/env bash
#
# URL-27 backup unit tests — fully isolated mock path.
#
# Runs scripts/postgres-backup.sh in a per-case sandbox where pg_dump,
# pg_dumpall, oci and curl are shadowed by mocks that record every call and
# NEVER touch a database or the network (HTTP(S) proxies are additionally
# poisoned so any real egress would fail the run). Covers:
#   object naming, manifest completeness, checksum/readback handling,
#   partial-failure behavior, one-at-a-time tmpfs staging, no-delete contract,
#   alert gating, lock/no-overlap, permission refusals, exit-code contract.
#
# Usage: bash tests/backup/run-tests.sh   (exit 0 = all tests passed)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/postgres-backup.sh"
MOCKS="$ROOT/tests/backup/mocks"
WORK="$(mktemp -d /tmp/url27-backup-tests.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
RUN_EXIT=""
RUN_OUT=""
CASE=""

ok() {
  PASS=$((PASS + 1))
  printf 'ok %d - %s\n' $((PASS + FAIL)) "$1"
}

not_ok() {
  FAIL=$((FAIL + 1))
  printf 'not ok %d - %s\n' $((PASS + FAIL)) "$1"
  if [ -n "$RUN_OUT" ] && [ -f "$RUN_OUT" ]; then
    sed 's/^/  # /' "$RUN_OUT" | tail -25
  fi
}

assert_exit() { # $1=expected $2=label
  if [ "$RUN_EXIT" = "$1" ]; then ok "$2 (exit=$RUN_EXIT)"
  else not_ok "$2 — expected exit $1, got $RUN_EXIT"; fi
}

assert_file_contains() { # $1=path $2=pattern $3=label
  if [ -f "$1" ] && grep -q "$2" "$1"; then ok "$3"
  else not_ok "$3 — pattern [$2] not found in $1"; fi
}

assert_file_absent() { # $1=path $2=label
  if [ ! -e "$1" ]; then ok "$2"
  else not_ok "$2 — $1 exists"; fi
}

new_case() { # $1=case name
  CASE="$WORK/$1"
  mkdir -p "$CASE"/{mockbin,staging,state,objstore}
  ln -s "$MOCKS"/pg_dump "$MOCKS"/pg_dumpall "$MOCKS"/oci "$MOCKS"/curl "$CASE/mockbin/"
  : >"$CASE/oci.log"
  : >"$CASE/pgdump.log"
  : >"$CASE/curl.log"
  RUN_OUT=""
}

# run_backup [KEY=VAL ...] — env -i curated run; exit captured in RUN_EXIT.
run_backup() {
  RUN_OUT="$CASE/out.log"
  env -i \
    PATH="$CASE/mockbin:/usr/bin:/bin" \
    HOME="$CASE" \
    MOCK_LOG="$CASE/oci.log" \
    MOCK_PGDUMP_LOG="$CASE/pgdump.log" \
    MOCK_CURL_LOG="$CASE/curl.log" \
    MOCK_OBJ_STORE="$CASE/objstore" \
    MOCK_SNAPSHOT_STAGING="$CASE/staging" \
    MOCK_PGDUMP_FLAGS_LOG="$CASE/pgdump-flags.log" \
    BACKUP_STAGING_DIR="$CASE/staging" \
    BACKUP_STAGING_REQUIRE_TMPFS=0 \
    BACKUP_STATE_DIR="$CASE/state" \
    BACKUP_ALLOW_NON_ROOT=1 \
    ALERT_WEBHOOK_URL="https://alerts.invalid/hooks/url27-test" \
    OCI_NAMESPACE=ax7rsgoquz1f \
    OCI_REGION=il-jerusalem-1 \
    OCI_BUCKET=url-shortener-postgres-backups \
    OCI_PREFIX=postgres \
    http_proxy="http://127.0.0.1:9" \
    https_proxy="http://127.0.0.1:9" \
    "$@" \
    /bin/bash "$SCRIPT" >"$RUN_OUT" 2>&1
  RUN_EXIT=$?
  return 0
}

oci_action_sequence() { # prints "action:basename" per oci.log line
  sed -n 's/^oci \([a-z]*\) name=\(postgres\/[^ ]*\).*$/\1 \2/p' "$CASE/oci.log" |
    while read -r action name; do printf '%s:%s\n' "$action" "${name##*/}"; done
}

staged_during() { # $1=action — prints max staged count for that action
  awk -v a="$1" '$1 == "oci" && $2 == a {
    for (i = 1; i <= NF; i++) if ($i ~ /^staged=/) { split($i, s, "="); if (s[2] + 0 > max) max = s[2] + 0 }
  } END { print max + 0 }' "$CASE/oci.log"
}

# ---------------------------------------------------------------------------
echo "# URL-27 backup mock-path unit tests"

new_case happy-path
run_backup
assert_exit 0 "happy path completes"
if [ -f "$CASE/pgdump.log" ] &&
  diff <(printf 'pg_dump db=urlshortener\npg_dump db=url8_acceptance\npg_dumpall globals=1\n') \
    "$CASE/pgdump.log" >/dev/null; then
  ok "both databases dumped then globals exported (one pg_dump per DB, --globals-only)"
else
  not_ok "unexpected dump sequence"; sed 's/^/  # /' "$CASE/pgdump.log"
fi
if grep -q -- '-Fc' "$CASE/pgdump-flags.log" &&
  grep -q -- '--globals-only' "$CASE/pgdump-flags.log" &&
  ! grep -qE -- '--no-owner|--no-privileges' "$CASE/pgdump-flags.log"; then
  ok "dump flags match the verified manual backup: pg_dump -Fc with default ownership/ACL capture"
else
  not_ok "dump flags diverge from the verified manual backup"; sed 's/^/  # /' "$CASE/pgdump-flags.log"
fi
seq_expected="put:urlshortener.dump
head:urlshortener.dump
get:urlshortener.dump
put:url8_acceptance.dump
head:url8_acceptance.dump
get:url8_acceptance.dump
put:globals.sql
head:globals.sql
get:globals.sql
put:manifest.json
head:manifest.json
get:manifest.json"
if [ "$(oci_action_sequence)" = "$seq_expected" ]; then
  ok "object sequence: 3 data objects uploaded+verified, manifest uploaded last"
else
  not_ok "unexpected oci sequence"; printf '%s\n' "$(oci_action_sequence)" | sed 's/^/  # /'
fi
if grep -q '^oci delete' "$CASE/oci.log"; then
  not_ok "no delete call issued (backup principal has no delete grant)"
else
  ok "no delete call issued (backup principal has no delete grant)"
fi
if grep -q 'file=-' "$CASE/oci.log"; then
  not_ok "uploads use a real file path, never stdin"
else
  ok "uploads use a real file path, never stdin"
fi
puts_nomultipart="$(grep '^oci put' "$CASE/oci.log" | grep -c 'nomultipart=yes')"
if [ "$puts_nomultipart" -eq 4 ]; then
  ok "all 4 puts are single-part from a real file (--no-multipart)"
else
  not_ok "all 4 puts single-part (got $puts_nomultipart of 4)"
fi
put_staged="$(staged_during put)"
head_staged="$(staged_during head)"
get_staged="$(staged_during get)"
if [ "$put_staged" -le 1 ] && [ "$head_staged" -le 1 ]; then
  ok "one object staged at a time during put/head (max put=$put_staged head=$head_staged)"
else
  not_ok "staging overlap during put/head (put=$put_staged head=$head_staged)"
fi
if [ "$get_staged" -le 2 ]; then
  ok "readback coexists with at most its own object (max get=$get_staged)"
else
  not_ok "too many staged files during readback (max get=$get_staged)"
fi
run_dir="$(sed -n 's/^oci put name=\(postgres\/[^ ]*\/manifest\.json\) .*/\1/p' "$CASE/oci.log" | sed 's|/manifest.json$||')"
if printf '%s' "$run_dir" | grep -Eq '^postgres/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'; then
  ok "unique run path mirrors verified manual layout ($run_dir)"
else
  not_ok "run path does not match postgres/YYYY/MM/DD/<stamp>-<8hex>/ ($run_dir)"
fi
for obj in urlshortener.dump url8_acceptance.dump globals.sql manifest.json; do
  assert_file_contains "$CASE/oci.log" "name=$run_dir/$obj" "object $obj referenced in uploads"
done
manifest="$CASE/objstore/$run_dir/manifest.json"
assert_file_contains "$manifest" '"schema":1' "manifest carries schema version"
assert_file_contains "$manifest" '"sha256":"' "manifest records SHA-256 per object"
sha_count="$(grep -o '"sha256":"[0-9a-f]\{64\}"' "$manifest" | wc -l)"
if [ "$sha_count" -eq 3 ]; then
  ok "manifest lists exactly 3 verified data objects with 64-hex SHA-256"
else
  not_ok "manifest object/checksum count wrong (got $sha_count)"
fi
assert_file_contains "$manifest" '"name":"'"$run_dir"'/urlshortener.dump"' "manifest names urlshortener.dump"
assert_file_contains "$manifest" '"name":"'"$run_dir"'/globals.sql"' "manifest names globals.sql"
last_success="$CASE/state/last-success"
assert_file_contains "$last_success" "\"manifest_object\":\"$run_dir/manifest.json\"" "last-success records the manifest object"
assert_file_contains "$last_success" "\"run_id\":\"" "last-success records the run id"
if [ "$(stat -c %a "$last_success")" = "600" ]; then
  ok "last-success state is mode 0600"
else
  not_ok "last-success state mode is $(stat -c %a "$last_success"), want 600"
fi
if [ -z "$(find "$CASE/staging" -mindepth 1 -print -quit)" ]; then
  ok "staging empty after successful run"
else
  not_ok "staging not emptied after run"
fi
if [ -s "$CASE/curl.log" ]; then
  not_ok "no alert sent on a successful run (heartbeat off)"
else
  ok "no alert sent on a successful run (heartbeat off)"
fi
assert_file_absent "$CASE/state/last-failure" "no last-failure state on success"

new_case non-root-refusal
run_backup BACKUP_ALLOW_NON_ROOT=0
assert_exit 4 "refuses to run as non-root without test override"
if [ -s "$CASE/pgdump.log" ] && [ -s "$CASE/oci.log" ]; then
  not_ok "no database/OCI work before root check"
else
  ok "no database/OCI work before root check"
fi

new_case missing-alert-config
run_backup "ALERT_WEBHOOK_URL="
assert_exit 2 "fails closed when no alert endpoint is configured"
if [ -s "$CASE/pgdump.log" ] || [ -s "$CASE/oci.log" ]; then
  not_ok "no dump/upload attempted without alert configuration"
else
  ok "no dump/upload attempted without alert configuration"
fi

new_case size-bound
run_backup BACKUP_MAX_OBJECT_BYTES=4
assert_exit 9 "fails closed when staged object exceeds BACKUP_MAX_OBJECT_BYTES"
if [ -s "$CASE/oci.log" ]; then
  not_ok "nothing uploaded once the size bound is exceeded"
else
  ok "nothing uploaded once the size bound is exceeded"
fi
assert_file_contains "$CASE/pgdump.log" "pg_dump db=urlshortener" "dump happened before the bound check"

new_case reserve-preflight
run_backup BACKUP_MAX_OBJECT_BYTES=999999999999
assert_exit 7 "preflight fails closed when 2*max+headroom exceeds staging free space"
if [ -s "$CASE/pgdump.log" ] || [ -s "$CASE/oci.log" ]; then
  not_ok "no dump/upload attempted when the reserve cannot be met"
else
  ok "no dump/upload attempted when the reserve cannot be met"
fi

new_case upload-failure
run_backup MOCK_OCI_FAIL_PUT_INDEX=2
assert_exit 10 "nonzero exit when an upload fails mid-run"
puts="$(grep -c '^oci put' "$CASE/oci.log")"
if [ "$puts" -eq 2 ]; then
  ok "run stops at the failed upload (2 puts attempted, no manifest)"
else
  not_ok "expected exactly 2 put attempts, got $puts"
fi
if find "$CASE/objstore" -name 'manifest.json' | grep -q .; then
  not_ok "manifest never uploaded after a data-object failure"
else
  ok "manifest never uploaded after a data-object failure"
fi
assert_file_contains "$CASE/state/last-failure" '"stage":"upload"' "last-failure records upload stage"
assert_file_contains "$CASE/curl.log" 'status":"FAILED"' "failure alert delivered"
if grep -q '^oci delete' "$CASE/oci.log"; then
  not_ok "no delete attempted after failure"
else
  ok "no delete attempted after failure"
fi
if [ -z "$(find "$CASE/staging" -mindepth 1 -print -quit)" ]; then
  ok "staging cleaned up after failed run"
else
  not_ok "staging left dirty after failed run"
fi

new_case readback-corruption
run_backup MOCK_CORRUPT_GET=1
assert_exit 11 "nonzero exit when readback SHA-256 mismatches"
assert_file_contains "$CASE/state/last-failure" '"stage":"verify"' "last-failure records verify stage"
if find "$CASE/objstore" -name 'manifest.json' | grep -q .; then
  not_ok "manifest never uploaded after a checksum failure"
else
  ok "manifest never uploaded after a checksum failure"
fi
assert_file_contains "$CASE/curl.log" 'status":"FAILED"' "failure alert delivered"

new_case lock-no-overlap
mkdir -p "$CASE/state"
( exec 8>"$CASE/state/backup.lock"; flock -n 8; sleep 30 ) &
LOCKER=$!
sleep 0.5
run_backup
kill "$LOCKER" 2>/dev/null
wait "$LOCKER" 2>/dev/null
assert_exit 5 "refuses to overlap an in-flight run (flock)"
if [ -s "$CASE/pgdump.log" ]; then
  not_ok "no dump attempted while locked"
else
  ok "no dump attempted while locked"
fi

new_case secret-file-perms
printf 'https://alerts.invalid/hooks/via-secret\n' >"$CASE/secret.env"
chmod 644 "$CASE/secret.env"
run_backup "ALERT_WEBHOOK_URL=" "ALERT_SECRET_FILE=$CASE/secret.env"
assert_exit 2 "rejects a world-readable alert secret file"
chmod 600 "$CASE/secret.env"
run_backup "ALERT_WEBHOOK_URL=" "ALERT_SECRET_FILE=$CASE/secret.env"
assert_exit 0 "accepts a root-only (0600) alert secret file"
assert_file_contains "$CASE/pgdump.log" "pg_dumpall globals=1" "secret-file run performed the full backup"

new_case invalid-db-name
run_backup 'BACKUP_DATABASES=url;drop'
assert_exit 2 "rejects a database name outside [A-Za-z0-9_]+"
if [ -s "$CASE/pgdump.log" ] || [ -s "$CASE/oci.log" ]; then
  not_ok "no work performed for an invalid database name"
else
  ok "no work performed for an invalid database name"
fi

new_case deps-fail-closed
mkdir -p "$CASE/thinbin"
ln -s "$(command -v grep)" "$CASE/thinbin/grep"
env -i \
  PATH="$CASE/thinbin" \
  HOME="$CASE" \
  BACKUP_STAGING_DIR="$CASE/staging" \
  BACKUP_STAGING_REQUIRE_TMPFS=0 \
  BACKUP_STATE_DIR="$CASE/state" \
  BACKUP_ALLOW_NON_ROOT=1 \
  ALERT_WEBHOOK_URL="https://alerts.invalid/hooks/url27-test" \
  /bin/bash "$SCRIPT" >"$CASE/out.log" 2>&1
RUN_EXIT=$?
RUN_OUT="$CASE/out.log"
assert_exit 3 "fails closed when a required tool (pg_dump) is missing"
if [ -s "$CASE/pgdump.log" ]; then
  not_ok "no dump attempted with missing dependencies"
else
  ok "no dump attempted with missing dependencies"
fi

new_case heartbeat-alert-failure
run_backup ALERT_ON_SUCCESS=1 MOCK_CURL_FAIL=1
assert_exit 13 "success-path alert delivery failure is nonzero (reporting broken)"
assert_file_contains "$CASE/state/last-success" '"manifest_object"' "backup itself succeeded (last-success written)"

new_case unique-run-ids
run_backup
first_line="$(grep '^oci put' "$CASE/oci.log" | sed -n 1p)"
run_backup
second_line="$(grep '^oci put' "$CASE/oci.log" | sed -n 5p)"
first_name="$(printf '%s' "$first_line" | sed -n 's/.*name=\(postgres\/[0-9]*\/[0-9]*\/[0-9]*\/[^/]*\)\/.*/\1/p')"
second_name="$(printf '%s' "$second_line" | sed -n 's/.*name=\(postgres\/[0-9]*\/[0-9]*\/[0-9]*\/[^/]*\)\/.*/\1/p')"
if [ -n "$first_name" ] && [ -n "$second_name" ] && [ "$first_name" != "$second_name" ]; then
  ok "two runs produce unique object prefixes ($first_name vs $second_name)"
else
  not_ok "run prefixes not unique ([$first_name] vs [$second_name])"
fi

# ---------------------------------------------------------------------------
echo "# pass $PASS fail $FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
