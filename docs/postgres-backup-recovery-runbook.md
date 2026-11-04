# PostgreSQL backup & recovery runbook (URL-27)

**Status:** implementation artifact — provided, **not installed, not enabled**.
**Timer state:** the shipped `deploy/systemd/url-shortener-postgres-backup.timer`
is **disabled by default** and nothing in this repository enables it.
Production installation/enablement requires a **separate human approval
naming the merged commit and the Oracle VM target** (URL-27).

Covers: daily backup operation, failure triage, and the **monthly disposable
restore procedure** (the recurring procedure is documentation-only until the
human approves the exact plan and cadence). A one-time **restore rehearsal of
the manual backup** was completed and PASSed by QA — see
`url-27-restore-rehearsal-20261103.md`; it is operational evidence for the
manual backup, not post-merge code QA.

---

## 1. What the backup does

`scripts/postgres-backup.sh` (root-only at runtime) reproduces the
owner-verified manual backup of 2026-11-03
(`postgres/2026/11/03/20261103T143556Z-93f58719/`, all four objects
SHA-256-readback verified):

1. dumps each database with `pg_dump -Fc` using **default ownership/ACL
   capture** — no `--no-owner`/`--no-privileges` — so automated backups
   faithfully match the owner-verified manual backup
   (`urlshortener`, `url8_acceptance`);
2. exports globals with `pg_dumpall --globals-only`;
3. uploads each object **one at a time** from a root-only tmpfs staging
   directory (mode 0600) to OCI Object Storage —
   namespace `ax7rsgoquz1f`, region `il-jerusalem-1`,
   bucket `url-shortener-postgres-backups`, prefix `postgres/`,
   **instance-principal auth, no credential literals anywhere in the repo**;
4. verifies every upload with HEAD + GET readback + SHA-256/size compare;
5. uploads the completion manifest **only after all three data objects pass
   verification**;
6. records `last-success` (or `last-failure`) state and delivers a failure
   alert through the configured external endpoint.

### Sizing (staging holds the object AND its full readback at once)

- `BACKUP_MAX_OBJECT_BYTES` default **512 MiB** (536870912) — fail-closed
  (exit 9) before upload when a staged object exceeds it.
- Preflight requires **`2 × BACKUP_MAX_OBJECT_BYTES + BACKUP_RESERVE_HEADROOM_BYTES`**
  free on the staging filesystem (headroom default 64 MiB → **≥1 GiB
  reserve**), and a per-object check re-verifies readback room immediately
  before each upload (exit 7 otherwise). This matches the VM's **~1.25 GiB
  `/run`** tmpfs; the old 1 GiB bound could not reserve 2× and is gone.
- Growth beyond the bound fails the run and **alerts** — raising the bound is
  a reviewed configuration change (documented in the PR/ticket), never a
  silent tweak.

### Object layout

```
postgres/<YYYY/MM/DD>/<YYYYmmddTHHMMSSZ>-<8hex>/
  urlshortener.dump     # pg_dump custom format
  url8_acceptance.dump  # pg_dump custom format
  globals.sql           # SENSITIVE — see §3
  manifest.json         # schema, run id, per-object SHA-256 + bytes
```

Run prefixes are unique per invocation. Uploads are single-part
(`--no-multipart`) from a real file path — **never streamed from stdin**:
the backup principal has **no delete grant**, so a stranded multipart upload
could never be cleaned up. The script never issues `oci … delete`.

### Schedule

`OnCalendar=*-*-* 02:00:00 UTC`, `Persistent=true` (missed runs replay after
downtime). Overlap is impossible: `Type=oneshot` plus a non-blocking `flock`
on the state lock (a concurrent run exits 5).

---

## 2. Required external configuration (blocks enablement)

The script **fails closed (exit 2) before touching the database** if no alert
endpoint exists, and the service unit requires
`EnvironmentFile=/etc/url-shortener/backup.env` (no `-` prefix — a missing
file fails the unit rather than skipping it).

`/etc/url-shortener/backup.env` — root:root, mode **0600** — must contain at
least one of:

```
ALERT_WEBHOOK_URL=https://<provider>/hooks/<id>
ALERT_SECRET_FILE=/etc/url-shortener/backup-alert.secret   # mode 0600/0400, root-owned
```

No email-provider credentials or endpoint are invented in this repository:
the alert endpoint/secret-store is a **required external configuration** owned
by the operator. Optional: `ALERT_ON_SUCCESS=1` sends a success heartbeat
(a failed heartbeat exits 13 so a broken reporting path is visible).

**The timer must remain disabled until this configuration exists.**

---

## 3. Sensitivity warnings

- **`globals.sql` is SENSITIVE.** It contains role definitions **and password
  hashes** for every role. Treat it as credential material: never copy it to
  shared locations, never paste it into tickets/chat/PRs, store it only in the
  private bucket, and delete local copies after any restore drill.
- **`urlshortener` is a SUPERUSER** on this cluster (existing
  local-socket-trust login — this ticket changes no roles or credentials).
  The globals export necessarily runs as that superuser. Per-DB dumps capture
  **default ownership/ACLs** (matching the verified manual backup), so a
  restore that imports globals first reproduces source ownership faithfully.
- Least-privilege dump roles (a dedicated `CONNECT`+`SELECT` role per DB and a
  separately controlled globals-export role) are an **open design item**
  (AD-17 follow-on #1) and require a human-approved role change — explicitly
  out of scope here.

---

## 4. Operating the backup (after approval)

```bash
# one-shot manual run (root)
/opt/url-shortener/scripts/postgres-backup.sh ; echo "exit=$?"

# unit status / logs
systemctl status url-shortener-postgres-backup.service
journalctl -u url-shortener-postgres-backup.service -n 200 --no-pager

# last success / last failure (mode 0600, root-only dir)
cat /var/lib/url-shortener/backup/last-success
cat /var/lib/url-shortener/backup/last-failure
```

Exit codes: `0` success · `2` config · `3` missing dependency · `4` not root ·
`5` lock busy · `6` unsafe staging dir · `7` staging free-space/reserve check
failed · `8` dump failed · `9` object exceeds `BACKUP_MAX_OBJECT_BYTES`
(fail-closed before upload) · `10` upload failed · `11` readback/SHA-256
mismatch · `12` state write failed · `13` success-path alert delivery failed.

### Deployment preconditions (documented, NOT performed by this change)

- **OCI CLI must be root-accessible**: the service sets `ProtectHome=yes`,
  so the existing user-level install
  (`/home/ubuntu/.local/venvs/oci-cli/bin/oci`) is unreachable for it. The
  unit's `Environment=PATH=` therefore points at the proposed location
  **`/opt/url-shortener/oci-cli/bin/oci`**, which must be provisioned (e.g.
  a root-owned venv with `oci-cli`) as part of the separately approved
  installation — **nothing is installed now**.
- **Install-path precondition for unit verification**: a raw
  `systemd-analyze verify` on the shipped units fails (exit 1) before
  deployment because `/opt/url-shortener/scripts/postgres-backup.sh` does
  not exist on the host yet — expected. CI validates the units in isolation
  with stubbed `ExecStart`/`EnvironmentFile` (`tests/unit/backup-units.test.ts`)
  instead of creating host files.
- **Manual runs** need the OCI CLI on `PATH`, e.g.
  `PATH=/opt/url-shortener/oci-cli/bin:$PATH /opt/url-shortener/scripts/postgres-backup.sh`.

Enablement (only with approval, only after §2 exists):

```bash
install -o root -g root -m 0700 /path/to/repo/scripts/postgres-backup.sh /opt/url-shortener/scripts/
install -o root -g root -m 0644 /path/to/repo/deploy/systemd/url-shortener-postgres-backup.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now url-shortener-postgres-backup.timer   # gated on §2 + approval
systemctl list-timers url-shortener-postgres-backup.timer
```

### Failure triage

| Symptom                     | Likely cause                         | Action                                                                                             |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| exit 2, "no alert endpoint" | §2 not configured                    | configure alert endpoint, keep timer disabled until done                                           |
| exit 5                      | overlap with an in-flight run        | expected no-op; check journal for the active run                                                   |
| exit 6                      | staging not tmpfs / wrong mode/owner | inspect `stat -f -c %T /run/url-shortener-backup`                                                  |
| exit 7                      | free space < 2×max+headroom reserve  | free `/run` space or review `BACKUP_MAX_OBJECT_BYTES`/`BACKUP_RESERVE_HEADROOM_BYTES` deliberately |
| exit 9                      | dump larger than bound               | investigate DB growth; raise `BACKUP_MAX_OBJECT_BYTES` deliberately                                |
| exit 10/11                  | OCI upload or readback mismatch      | retry once; if persistent, check instance-principal policy + bucket reachability                   |
| exit 13                     | alert endpoint broken                | fix endpoint — reporting is part of the backup contract                                            |
| no `last-success` update    | any of the above                     | alerts carry stage + exit code; state files carry `stage`                                          |

Alertmanager may also monitor the age of `last-success` (AD-17 observability).

---

## 5. Monthly disposable restore procedure (DOCUMENTATION ONLY)

> **Owner-requested documentation; no automation.** The owner explicitly
> requested monthly disposable restore testing **documentation** — this
> section is that manual runbook. **No restore timer or automated schedule is
> created by this ticket** (the only timer in the repo is the disabled backup
> timer). A specific owner and recurring schedule for the monthly runs remain
> **unassigned** (AD-17 follow-on #1); assigning them is a human decision.
>
> **Completed rehearsal:** a one-time **restore rehearsal of the manual
> backup** was completed and PASSed by QA on 2026-11-03 (run
> `20261103T143556Z-93f58719`, both DBs, 15 expected tables each plus
> `pgmigrations`, measured RTO 71.62 s) — sanitized evidence in
> `url-27-restore-rehearsal-20261103.md`. That rehearsal covers the manual
> backup only, not post-merge code QA. The monthly cadence below remains
> documentation-only until the human approves the exact plan and assigns an
> owner; each drill **measures RTO** and records observed counts for that
> decision.

**Never target the existing `url8-pg` container, its volume, or the live
`urlshortener`/`url8_acceptance` databases.** The drill uses a uniquely
named throwaway container with **`--network none` and no published ports** —
no network or connection to `url8-pg` of any kind.

### Preconditions

1. Human approval of this exact plan (recorded in the ticket).
2. A verified backup object chosen from the bucket, e.g.
   `postgres/2026/11/03/20261103T143556Z-93f58719/` — download all four
   objects into a fresh temp directory (mode 0700, files 0600) and verify
   each SHA-256 against `manifest.json` before starting the clock.
3. `postgres:16-alpine` already present locally (same major version as
   `url8-pg` 16.x) — the run uses **`--pull=never`**, so no registry access
   is needed (none exists on an isolated container anyway).
4. Note the start time — RTO is measured from drill start until the final
   data check passes.

### Steps (disposable, isolated — the exact approved/tested method)

```bash
set -euo pipefail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SCRATCH="url27-restore-scratch-${STAMP}"     # unique per run; NEVER url8-pg
WORKDIR="$(mktemp -d /tmp/url27-restore.XXXXXX)"   # temp dir for the drill
chmod 700 "$WORKDIR"

# Guard: refuse to run if the name ever collides with the live container.
[ "$SCRATCH" != "url8-pg" ] || { echo "REFUSED: live container name"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$SCRATCH" && { echo "REFUSED: exists"; exit 1; }

# Unique disposable PG16 cluster: NO network, NO published ports, NO named
# volume — PGDATA lives on a 512 MiB tmpfs. POSTGRES_HOST_AUTH_METHOD=trust
# is acceptable ONLY because the container has no network interface
# reachable by anything (--network none). No password is set or stored.
docker run -d --name "$SCRATCH" --network none --pull=never \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=512m \
  -e POSTGRES_USER=restore_admin \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:16-alpine

# wait for readiness (exec-based; no ports involved)
until docker exec "$SCRATCH" pg_isready -U restore_admin -q; do sleep 1; done

# 1) globals first into the maintenance DB — SENSITIVE file, local only,
#    deleted from the container immediately after use
docker cp "$WORKDIR/globals.sql" "$SCRATCH:/tmp/globals.sql"
docker exec "$SCRATCH" psql -v ON_ERROR_STOP=1 -U restore_admin -d postgres -f /tmp/globals.sql
docker exec "$SCRATCH" rm -f /tmp/globals.sql

# 2) each custom archive is restored with --create so its named database is
#    NEWLY CREATED inside the scratch cluster (globals were imported first,
#    so ownership applies faithfully — no --no-owner/--no-privileges)
docker cp "$WORKDIR/urlshortener.dump" "$SCRATCH:/tmp/"
docker cp "$WORKDIR/url8_acceptance.dump" "$SCRATCH:/tmp/"
docker exec "$SCRATCH" pg_restore --create --exit-on-error -d postgres /tmp/urlshortener.dump
docker exec "$SCRATCH" pg_restore --create --exit-on-error -d postgres /tmp/url8_acceptance.dump
docker exec "$SCRATCH" rm -f /tmp/urlshortener.dump /tmp/url8_acceptance.dump

# 3) schema / basic data checks — observed counts are RECORDED AS-IS;
#    there is no source row-count baseline unless one was captured first
docker exec "$SCRATCH" psql -U restore_admin -d urlshortener -c "SELECT 1;"   # must succeed
docker exec "$SCRATCH" psql -U restore_admin -d url8_acceptance -c "SELECT 1;" # must succeed
docker exec "$SCRATCH" psql -U restore_admin -d urlshortener -c "\dt"
docker exec "$SCRATCH" psql -U restore_admin -d url8_acceptance -c "\dt"
docker exec "$SCRATCH" psql -U restore_admin -d urlshortener -c \
  "SELECT (SELECT count(*) FROM users) AS users,
          (SELECT count(*) FROM links) AS links,
          (SELECT count(*) FROM click_event_dedup) AS dedup;"
docker exec "$SCRATCH" psql -U restore_admin -d url8_acceptance -c \
  "SELECT (SELECT count(*) FROM users) AS users,
          (SELECT count(*) FROM links) AS links,
          (SELECT count(*) FROM click_event_dedup) AS dedup;"
# expect: 15 URL-8 tables + pgmigrations in EACH created database; FK check clean:
docker exec "$SCRATCH" psql -U restore_admin -d urlshortener -c \
  "SELECT conname FROM pg_constraint WHERE contype='f' AND NOT convalidated;"  # expect: 0 rows

# 4) measured RTO — record elapsed wall time in the drill notes
# 5) cleanup — RESTRICTED to this uniquely named container and this temp
#    directory (plus the SENSITIVE globals copy); nothing else exists
docker rm -f "$SCRATCH"
rm -rf "$WORKDIR"
unset STAMP SCRATCH WORKDIR
```

### Drill record (fill in per run)

| Field                                        | Value                                               |
| -------------------------------------------- | --------------------------------------------------- |
| Backup object (run id)                       |                                                     |
| SHA-256 verified before restore              | yes/no                                              |
| Globals restored                             | yes/no                                              |
| `urlshortener` restored + observed counts    | users/links/dedup (as observed — no baseline)       |
| `url8_acceptance` restored + observed counts | users/links/dedup (as observed — no baseline)       |
| Source row-count baseline captured?          | yes/no (optional; without it no comparison is made) |
| FK validation clean                          | yes/no                                              |
| **Measured RTO** (start → final check)       |                                                     |
| Defects/risks observed                       |                                                     |
| Approver of this drill                       |                                                     |

The live `url8-pg` container, its volume, the Docker networks, the host
firewall, OCI networking/buckets, and cloud IAM are **untouched** by this
procedure.

---

## 6. Retention (configured)

Design §14.6 approves **7-day retention**, now **configured as a 7-day
Object Lifecycle DELETE rule on the `postgres/` prefix** (owner-confirmed
2026-11-04). The instance policy remains **no-delete**: the backup principal
cannot and does not delete anything — pruning is the bucket lifecycle rule's
job, and the script never issues `oci … delete`.

- **Console-verify the lifecycle rule (and the bucket's at-rest encryption
  key) before production timer enablement** — verification is an operator
  step, not a repo change.
- **Multipart abort is not confirmed** for the lifecycle rule; the script's
  uploads are deliberately single-part (`--no-multipart`), so stranded
  multipart objects are not expected from this flow.

## 7. Remaining external configuration / blockers

| #   | Item                                                                                                                                                                                                                                                                                                 | Owner     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Alert endpoint/recipient + protected secret-injection mechanism (§2) — gates timer enablement                                                                                                                                                                                                        | Human/ops |
| 2   | Console verification before production timer enablement: 7-day lifecycle DELETE rule on `postgres/` **and** bucket at-rest encryption key (objects are server-side encrypted with Oracle's default managed key; TLS in transit; a CMK/Security Zone change, if ever desired, is a separate approval) | Human/ops |
| 3   | Least-privilege per-DB dump role + separate globals-export role (currently the `urlshortener` SUPERUSER)                                                                                                                                                                                             | Human     |
| 4   | Restore-test cadence/target/owner + numeric RPO/RTO targets                                                                                                                                                                                                                                          | Human     |
| 5   | Production installation/enablement approval naming the merged commit + Oracle VM target (script, units, root-accessible OCI CLI at `/opt/url-shortener/oci-cli/bin/oci`)                                                                                                                             | Human     |

**Encryption note (no blocker):** OCI Object Storage encrypts objects at
rest with its default Oracle-managed key and transfers use TLS — the verified
manual objects are already server-side encrypted. No client-side encryption
or key handling is added here; bucket-key verification is item 2 above.
