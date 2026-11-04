#!/usr/bin/env bash
#
# url-shortener-api — URL-27: one-shot PostgreSQL backup to OCI Object Storage.
#
# Reproduces the owner-verified manual backup flow (2026-11-03,
# postgres/2026/11/03/20261103T143556Z-93f58719/) as a single, fail-closed
# script intended to be run by the systemd service
# deploy/systemd/url-shortener-postgres-backup.service (daily 02:00 UTC timer,
# DISABLED by default — see docs/postgres-backup-recovery-runbook.md).
#
# Safety contract (design §14.6, ticket URL-27):
#   * root-only at runtime; staging happens in a root-only tmpfs directory,
#     ONE object at a time, mode 0600;
#   * uploads are single-part (`oci ... --no-multipart`) from a real file path —
#     NEVER from stdin (a stdin multipart upload can strand an incomplete object
#     when a failure abort is denied; the backup principal has no delete grant);
#   * every object is size-checked against BACKUP_MAX_OBJECT_BYTES and
#     fail-closed BEFORE upload, then HEAD + GET readback + SHA-256 compared;
#     staging must hold the staged object AND its full readback at once, so
#     preflight requires 2 * BACKUP_MAX_OBJECT_BYTES +
#     BACKUP_RESERVE_HEADROOM_BYTES of free staging space;
#   * the completion manifest is uploaded only after all three data objects
#     (two pg_dump custom dumps + globals) pass readback verification;
#   * no `oci ... delete` is ever issued (the instance policy is no-delete;
#     7-day retention is the bucket lifecycle rule's job — runbook §6);
#   * alert endpoint/secret is REQUIRED external configuration; without it the
#     script exits before touching the database, and the timer must stay
#     disabled until it exists.
#
# Exit codes:
#   0 success            7 staging free-space/reserve check failed
#   2 configuration      8 pg_dump / pg_dumpall failed
#   3 missing dependency 9 staged object exceeds BACKUP_MAX_OBJECT_BYTES
#   4 not root           10 OCI upload failed
#   5 lock busy          11 readback/SHA-256 verification failed
#   6 staging dir unsafe 12 state write failed
#                       13 success-path alert delivery failed (ALERT_ON_SUCCESS=1)
set -u

SCRIPT_VERSION="1.0.0"
SCRIPT_NAME="url27-backup"

# ---------------------------------------------------------------------------
# Configuration (env-overridable; NO secrets have defaults — none belong in Git)
# ---------------------------------------------------------------------------
OCI_NAMESPACE="${OCI_NAMESPACE:-ax7rsgoquz1f}"
OCI_REGION="${OCI_REGION:-il-jerusalem-1}"
OCI_BUCKET="${OCI_BUCKET:-url-shortener-postgres-backups}"
OCI_PREFIX="${OCI_PREFIX:-postgres}"
OCI_AUTH="${OCI_AUTH:-instance_principal}"

# Existing superuser login over local socket trust — NEVER changed by this
# script (URL-27: no role/credential changes). `urlshortener` is a SUPERUSER;
# globals export necessarily runs with it. See runbook sensitivity notes.
BACKUP_PGHOST="${BACKUP_PGHOST:-/var/run/postgresql}"
BACKUP_PGUSER="${BACKUP_PGUSER:-urlshortener}"
BACKUP_DATABASES="${BACKUP_DATABASES:-urlshortener url8_acceptance}"

BACKUP_STAGING_DIR="${BACKUP_STAGING_DIR:-/run/url-shortener-backup}"
BACKUP_STAGING_REQUIRE_TMPFS="${BACKUP_STAGING_REQUIRE_TMPFS:-1}"
BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/url-shortener/backup}"
# 512 MiB default: staging holds the staged object AND its full readback at
# once, so preflight reserves 2*max + headroom (VM /run is only ~1.25 GiB).
# Growth beyond the bound fails closed (exit 9) and alerts — raising it is a
# reviewed configuration change, never a silent tweak.
BACKUP_MAX_OBJECT_BYTES="${BACKUP_MAX_OBJECT_BYTES:-536870912}"
BACKUP_RESERVE_HEADROOM_BYTES="${BACKUP_RESERVE_HEADROOM_BYTES:-67108864}"

# Required external alert configuration (AD-17: protected secrets outside
# Git). Either the webhook URL itself (root-only env file) or a root-only
# secret file containing it. No provider is invented here.
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
ALERT_SECRET_FILE="${ALERT_SECRET_FILE:-}"
ALERT_ON_SUCCESS="${ALERT_ON_SUCCESS:-0}"

# Test-only escape hatches (never set by the shipped systemd unit):
#   BACKUP_ALLOW_NON_ROOT=1        run outside root (unit-test sandbox only)
BACKUP_ALLOW_NON_ROOT="${BACKUP_ALLOW_NON_ROOT:-0}"

STAGING_TMP=""
RUN_ID=""
CURRENT_STAGE="startup"
LAST_SUCCESS_AT="never"

log() {
  local level="$1"; shift
  # stderr: log lines must never pollute $(...) command substitutions
  # (alert_url() output is captured by the config gate).
  printf '[%s] %s level=%s stage=%s run_id=%s msg=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$level" \
    "$CURRENT_STAGE" "${RUN_ID:-none}" "$*" >&2
}

# JSON string escaping for values we generated or charset-validated.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

cleanup() {
  if [ -n "$STAGING_TMP" ] && [ -d "$STAGING_TMP" ]; then
    find "$STAGING_TMP" -mindepth 1 -delete 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Failure path: state + best-effort alert, then nonzero exit.
# ---------------------------------------------------------------------------
write_state_file() { # $1=path $2=contents ; root-only 0600
  local tmp="$1.tmp.$$"
  printf '%s\n' "$2" >"$tmp" || return 1
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$1" || { rm -f "$tmp"; return 1; }
}

alert_url() {
  # Resolves the REQUIRED external alert endpoint. Empty when unconfigured.
  if [ -n "$ALERT_SECRET_FILE" ]; then
    local perms owner url
    perms="$(stat -c %a "$ALERT_SECRET_FILE" 2>/dev/null)" || return 0
    case "$perms" in
      400|600) ;;
      *)
        log error "alert secret file $ALERT_SECRET_FILE has mode $perms (need 400/600)"
        return 0
        ;;
    esac
    if [ "$(id -u)" -eq 0 ]; then
      owner="$(stat -c %u "$ALERT_SECRET_FILE" 2>/dev/null || echo unknown)"
      if [ "$owner" != "0" ]; then
        log error "alert secret file $ALERT_SECRET_FILE is not root-owned (uid=$owner)"
        return 0
      fi
    fi
    url="$(head -n1 "$ALERT_SECRET_FILE" 2>/dev/null | tr -d '[:space:]')"
    printf '%s' "$url"
    return 0
  fi
  printf '%s' "$ALERT_WEBHOOK_URL"
}

send_alert() { # $1=status $2=stage $3=code $4=message ; 0 = delivered or unconfigured
  local url status stage code msg payload_file payload url_value payload_dir
  url_value="$(alert_url)"
  if [ -z "$url_value" ]; then
    log warn "alert not sent: no external alert endpoint configured"
    return 0
  fi
  if ! printf '%s' "$url_value" | grep -Eq '^https://[^[:space:]\"'\''\\]+$'; then
    log error "alert endpoint is not a bare https:// URL — refusing to send"
    return 1
  fi
  status="$1"; stage="$2"; code="$3"; msg="$4"
  payload_dir="$STAGING_TMP"
  if [ -z "$payload_dir" ] || [ ! -d "$payload_dir" ]; then
    payload_dir="$BACKUP_STATE_DIR"
  fi
  if [ -z "$payload_dir" ] || [ ! -d "$payload_dir" ]; then
    log warn "alert not sent: no root-only directory available for the payload"
    return 0
  fi
  payload_file="$payload_dir/.alert.json"
  payload="$(printf '{"service":"%s","status":"%s","run_id":"%s","stage":"%s","exit_code":%s,"error":"%s","last_success_at_utc":"%s"}' \
    "$SCRIPT_NAME" "$status" "${RUN_ID:-none}" "$stage" "$code" \
    "$(json_escape "$msg")" "$LAST_SUCCESS_AT")"
  printf '%s' "$payload" >"$payload_file" 2>/dev/null || return 1
  chmod 600 "$payload_file" 2>/dev/null || true
  # URL travels via -K stdin config (never argv, which is world-readable in
  # /proc); payload travels via a root-only 0600 file.
  if printf 'url = "%s"\nheader = "Content-Type: application/json"\n' "$url_value" |
    curl -K - --max-time 30 -fsS --data-binary "@$payload_file" >/dev/null 2>&1; then
    rm -f "$payload_file"
    log info "alert delivered status=$status stage=$stage"
    return 0
  fi
  rm -f "$payload_file"
  log error "alert delivery FAILED status=$status stage=$stage"
  return 1
}

fail() { # $1=exit-code $2=stage $3=message
  local code="$1" stage="$2" msg="$3"
  CURRENT_STAGE="$stage"
  log error "stage=$stage exit=$code msg=$msg"
  if [ -d "$BACKUP_STATE_DIR" ]; then
    write_state_file "$BACKUP_STATE_DIR/last-failure" \
      "$(printf '{"run_id":"%s","failed_at_utc":"%s","stage":"%s","exit_code":%s,"error":"%s","last_success_at_utc":"%s"}' \
        "${RUN_ID:-none}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$stage" "$code" \
        "$(json_escape "$msg")" "$LAST_SUCCESS_AT")" \
      || log error "could not persist last-failure state"
  fi
  send_alert "FAILED" "$stage" "$code" "$msg" || true
  exit "$code"
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ] && [ "$BACKUP_ALLOW_NON_ROOT" != "1" ]; then
  log error "refusing to run: root required (BACKUP_ALLOW_NON_ROOT=1 is test-only)"
  exit 4
fi

CURRENT_STAGE="config"
# Required alert endpoint — fail closed BEFORE any database work (URL-27:
# timer enablement is gated on this external configuration existing).
_alert_value="$(alert_url)"
if [ -z "$_alert_value" ]; then
  log error "no alert endpoint configured — set ALERT_WEBHOOK_URL (root-only env file) or ALERT_SECRET_FILE"
  exit 2
fi
case "$BACKUP_MAX_OBJECT_BYTES:$BACKUP_RESERVE_HEADROOM_BYTES" in
  *[!0-9:]* | :* | *:) fail 2 config "byte bounds must be positive integers" ;;
esac
if [ "$BACKUP_MAX_OBJECT_BYTES" -le 0 ] || [ "$BACKUP_RESERVE_HEADROOM_BYTES" -le 0 ]; then
  fail 2 config "byte bounds must be > 0"
fi
case "$ALERT_ON_SUCCESS" in 0 | 1) ;; *)
  fail 2 config "ALERT_ON_SUCCESS must be 0 or 1" ;;
esac
if [ -n "$OCI_PREFIX" ] && ! printf '%s' "$OCI_PREFIX" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  fail 2 config "OCI_PREFIX contains unsupported characters"
fi
[ -n "$BACKUP_DATABASES" ] || fail 2 config "BACKUP_DATABASES is empty"
for _db in $BACKUP_DATABASES; do
  if ! printf '%s' "$_db" | grep -Eq '^[A-Za-z0-9_]+$'; then
    fail 2 config "unsupported database name '$_db' (want [A-Za-z0-9_]+)"
  fi
done
unset _alert_value _db

CURRENT_STAGE="deps"
for _bin in pg_dump pg_dumpall oci sha256sum flock stat date od curl find mv chmod \
  mkdir awk sed df grep head tr cut; do
  command -v "$_bin" >/dev/null 2>&1 || {
    log error "missing required executable: $_bin"; exit 3
  }
done
unset _bin

CURRENT_STAGE="lock"
mkdir -p "$BACKUP_STATE_DIR" 2>/dev/null || { log error "cannot create state dir $BACKUP_STATE_DIR"; exit 6; }
chmod 700 "$BACKUP_STATE_DIR" 2>/dev/null || { log error "cannot chmod state dir"; exit 6; }
if [ "$(id -u)" -eq 0 ]; then
  [ "$(stat -c %u "$BACKUP_STATE_DIR")" = "0" ] || { log error "state dir not root-owned"; exit 6; }
fi
# Read last success for alert context (best effort).
if [ -f "$BACKUP_STATE_DIR/last-success" ]; then
  LAST_SUCCESS_AT="$(grep -o '"finished_at_utc":"[^"]*"' "$BACKUP_STATE_DIR/last-success" 2>/dev/null |
    head -n1 | cut -d'"' -f4)"
  LAST_SUCCESS_AT="${LAST_SUCCESS_AT:-unknown}"
fi
exec 9>"$BACKUP_STATE_DIR/backup.lock" || { log error "cannot open lock file"; exit 6; }
if ! flock -n 9; then
  log warn "another backup run holds the lock — refusing to overlap"
  exit 5
fi

CURRENT_STAGE="staging"
mkdir -p "$BACKUP_STAGING_DIR" 2>/dev/null || { log error "cannot create staging dir $BACKUP_STAGING_DIR"; exit 6; }
chmod 700 "$BACKUP_STAGING_DIR" 2>/dev/null || { log error "cannot chmod staging dir"; exit 6; }
if [ "$(stat -c %a "$BACKUP_STAGING_DIR")" != "700" ]; then
  log error "staging dir mode is not 700"; exit 6
fi
if [ "$(id -u)" -eq 0 ]; then
  [ "$(stat -c %u "$BACKUP_STAGING_DIR")" = "0" ] || { log error "staging dir not root-owned"; exit 6; }
fi
if [ "$BACKUP_STAGING_REQUIRE_TMPFS" = "1" ]; then
  if [ "$(stat -f -c %T "$BACKUP_STAGING_DIR")" != "tmpfs" ]; then
    log error "staging dir $BACKUP_STAGING_DIR is not on tmpfs — refusing to stage dumps in persistent storage"
    exit 6
  fi
fi
STAGING_TMP="$BACKUP_STAGING_DIR"
export PGHOST="$BACKUP_PGHOST"
export PGUSER="$BACKUP_PGUSER"

# ---------------------------------------------------------------------------
# Object naming: postgres/<YYYY/MM/DD>/<YYYYmmddTHHMMSSZ>-<8hex>/<file>
# (mirrors the owner-verified manual run layout)
# ---------------------------------------------------------------------------
CURRENT_STAGE="naming"
UTC_DATE="$(date -u +%Y/%m/%d)"
RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_HEX="$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
RUN_ID="${RUN_STAMP}-${RUN_HEX}"
RUN_PREFIX="${OCI_PREFIX}/${UTC_DATE}/${RUN_ID}"
log info "starting run prefix=$RUN_PREFIX databases=$(printf '%s' "$BACKUP_DATABASES" | tr ' ' ',')"

# ---------------------------------------------------------------------------
# Upload + verify one staged file -> object $1 (relative name), kind $2
# ---------------------------------------------------------------------------
upload_verified() { # $1=object-name $2=local-file $3=kind $4=sha256 $5=bytes
  local obj="$1" file="$2" kind="$3" sha="$4" bytes="$5"
  local readback="$STAGING_TMP/.readback.$$"

  CURRENT_STAGE="upload"
  log info "uploading object=$obj bytes=$bytes kind=$kind"
  if ! oci os object put \
    --namespace-name "$OCI_NAMESPACE" \
    --bucket-name "$OCI_BUCKET" \
    --name "$obj" \
    --file "$file" \
    --region "$OCI_REGION" \
    --auth "$OCI_AUTH" \
    --no-multipart \
    --force; then
    rm -f "$readback"
    fail 10 upload "oci object put failed for $obj"
  fi
  if ! oci os object head \
    --namespace-name "$OCI_NAMESPACE" \
    --bucket-name "$OCI_BUCKET" \
    --name "$obj" \
    --region "$OCI_REGION" \
    --auth "$OCI_AUTH"; then
    rm -f "$readback"
    fail 10 upload "oci object head failed for $obj"
  fi

  CURRENT_STAGE="verify"
  if ! oci os object get \
    --namespace-name "$OCI_NAMESPACE" \
    --bucket-name "$OCI_BUCKET" \
    --name "$obj" \
    --file "$readback" \
    --region "$OCI_REGION" \
    --auth "$OCI_AUTH"; then
    rm -f "$readback"
    fail 11 verify "oci object readback (GET) failed for $obj"
  fi
  local rb_sha rb_bytes
  rb_sha="$(sha256sum "$readback" | awk '{print $1}')"
  rb_bytes="$(stat -c %s "$readback")"
  rm -f "$readback"
  if [ "$rb_sha" != "$sha" ] || [ "$rb_bytes" != "$bytes" ]; then
    fail 11 verify "SHA-256/size readback mismatch for $obj (local=$sha/$bytes remote=$rb_sha/$rb_bytes)"
  fi
  log info "verified object=$obj sha256=$sha bytes=$bytes"
}

# Stage ONE dump at a time: dump -> bound -> upload+verify -> remove -> next.
backup_dump() { # $1=local-file $2=object-name $3=kind $4=sha256 (globals path builds sha after)
  local file="$1" obj="$2" kind="$3" sha="$4" bytes
  bytes="$(stat -c %s "$file")"
  if [ "$bytes" -gt "$BACKUP_MAX_OBJECT_BYTES" ]; then
    fail 9 bound "staged object $obj is $bytes bytes, exceeds BACKUP_MAX_OBJECT_BYTES=$BACKUP_MAX_OBJECT_BYTES — not uploaded"
  fi
  # The readback temporarily doubles the footprint: refuse to upload when the
  # staging fs can no longer hold a full copy alongside the staged object.
  local free_now
  free_now="$(staging_free)"
  if ! printf '%s' "$free_now" | grep -Eq '^[0-9]+$' || [ "$free_now" -lt "$bytes" ]; then
    fail 7 space "staging free space '$free_now' cannot hold readback ($bytes bytes) for $obj — not uploaded"
  fi
  upload_verified "$obj" "$file" "$kind" "$sha" "$bytes"
  # Manifest entry — appended only after upload+readback verification.
  OBJECTS_JSON="${OBJECTS_JSON:+$OBJECTS_JSON,}{\"name\":\"$(json_escape "$obj")\",\"kind\":\"$kind\",\"sha256\":\"$sha\",\"bytes\":$bytes}"
  rm -f "$file"
}

dump_database() { # $1=database
  local db="$1" out sha
  CURRENT_STAGE="dump"
  out="$STAGING_TMP/${db}.dump"
  rm -f "$out"
  if ! pg_dump -Fc -d "$db" -f "$out"; then
    rm -f "$out"
    fail 8 dump "pg_dump failed for database $db"
  fi
  [ -f "$out" ] || fail 8 dump "pg_dump produced no file for $db"
  chmod 600 "$out" || fail 6 staging "cannot restrict permissions on $out"
  sha="$(sha256sum "$out" | awk '{print $1}')"
  backup_dump "$out" "${RUN_PREFIX}/${db}.dump" "pg_dump_custom" "$sha"
}

dump_globals() {
  local out sha
  CURRENT_STAGE="dump"
  out="$STAGING_TMP/globals.sql"
  rm -f "$out"
  # SENSITIVE: roles/password hashes. Runs as the urlshortener SUPERUSER.
  if ! pg_dumpall --globals-only -f "$out"; then
    rm -f "$out"
    fail 8 dump "pg_dumpall --globals-only failed"
  fi
  [ -f "$out" ] || fail 8 dump "pg_dumpall produced no file"
  chmod 600 "$out" || fail 6 staging "cannot restrict permissions on $out"
  sha="$(sha256sum "$out" | awk '{print $1}')"
  backup_dump "$out" "${RUN_PREFIX}/globals.sql" "pg_dumpall_globals" "$sha"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
CURRENT_STAGE="space"
staging_free() { # prints free bytes on the staging fs (empty on failure)
  df -PB1 "$STAGING_TMP" | awk 'NR==2 {print $4}'
}
free_bytes="$(staging_free)"
if ! printf '%s' "$free_bytes" | grep -Eq '^[0-9]+$'; then
  fail 6 staging "cannot determine free space for $STAGING_TMP"
fi
# Staging must hold the staged object AND its full readback at once:
# reserve >= 2 * max object + headroom before dumping anything.
required_free=$(( BACKUP_MAX_OBJECT_BYTES * 2 + BACKUP_RESERVE_HEADROOM_BYTES ))
if [ "$free_bytes" -lt "$required_free" ]; then
  fail 7 space "staging free space $free_bytes < required reserve 2*BACKUP_MAX_OBJECT_BYTES+headroom=$required_free (max=$BACKUP_MAX_OBJECT_BYTES headroom=$BACKUP_RESERVE_HEADROOM_BYTES)"
fi

OBJECTS_JSON=""
for db in $BACKUP_DATABASES; do
  dump_database "$db"
done
dump_globals

# Manifest — uploaded only after all three data objects passed verification.
CURRENT_STAGE="manifest"
pg_version="$(pg_dump --version | head -n1 | sed 's/["\\]//g')"
manifest="$STAGING_TMP/manifest.json"
printf '{"schema":1,"script_version":"%s","run_id":"%s","created_at_utc":"%s","pg_client_version":"%s","databases":"%s","namespace":"%s","region":"%s","bucket":"%s","objects":[%s]}\n' \
  "$SCRIPT_VERSION" "$RUN_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pg_version" \
  "$(json_escape "$BACKUP_DATABASES")" "$OCI_NAMESPACE" "$OCI_REGION" "$OCI_BUCKET" \
  "$OBJECTS_JSON" >"$manifest" || fail 12 state "cannot write manifest"
chmod 600 "$manifest" || fail 6 staging "cannot chmod manifest"
manifest_sha="$(sha256sum "$manifest" | awk '{print $1}')"
upload_verified "${RUN_PREFIX}/manifest.json" "$manifest" "manifest" "$manifest_sha" \
  "$(stat -c %s "$manifest")"
rm -f "$manifest"

CURRENT_STAGE="complete"
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! write_state_file "$BACKUP_STATE_DIR/last-success" \
  "$(printf '{"run_id":"%s","finished_at_utc":"%s","manifest_object":"%s","script_version":"%s"}' \
    "$RUN_ID" "$finished_at" "${RUN_PREFIX}/manifest.json" "$SCRIPT_VERSION")"; then
  fail 12 state "cannot persist last-success state"
fi
log info "run complete manifest=${RUN_PREFIX}/manifest.json"

if [ "$ALERT_ON_SUCCESS" = "1" ]; then
  if ! send_alert "OK" "complete" 0 "backup run completed"; then
    CURRENT_STAGE="alert"
    fail 13 alert "success-path alert delivery failed"
  fi
fi
exit 0
