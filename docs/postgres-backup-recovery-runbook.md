# PostgreSQL backup & recovery runbook (URL-27)

**Status:** implementation artifact — provided, **not installed, not enabled**.
**Timer state:** the shipped `deploy/systemd/url-shortener-postgres-backup.timer`
is **disabled by default** and nothing in this repository enables it.
Production installation/enablement requires a **separate human approval
naming the merged commit and the Oracle VM target** (URL-27).

Covers: daily backup operation, failure triage, and the **monthly disposable
restore procedure** (documentation only until the human approves the exact
plan — no restore has been run by this ticket).

---

## 1. What the backup does

`scripts/postgres-backup.sh` (root-only at runtime) reproduces the
owner-verified manual backup of 2026-11-03
(`postgres/2026/11/03/20261103T143556Z-93f58719/`, all four objects
SHA-256-readback verified):

1. dumps each database with `pg_dump -Fc --no-owner --no-privileges`
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
  The globals export necessarily runs as that superuser; the per-DB dumps run
  with `--no-owner --no-privileges` so restored objects do not inherit
  ownership semantics from the source.
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
`5` lock busy · `6` unsafe staging dir · `7` insufficient free space ·
`8` dump failed · `9` object exceeds `BACKUP_MAX_OBJECT_BYTES` (fail-closed
before upload) · `10` upload failed · `11` readback/SHA-256 mismatch ·
`12` state write failed · `13` success-path alert delivery failed.

Enablement (only with approval, only after §2 exists):

```bash
install -o root -g root -m 0700 /path/to/repo/scripts/postgres-backup.sh /opt/url-shortener/scripts/
install -o root -g root -m 0644 /path/to/repo/deploy/systemd/url-shortener-postgres-backup.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now url-shortener-postgres-backup.timer   # gated on §2 + approval
systemctl list-timers url-shortener-postgres-backup.timer
```

### Failure triage

| Symptom                     | Likely cause                         | Action                                                                           |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| exit 2, "no alert endpoint" | §2 not configured                    | configure alert endpoint, keep timer disabled until done                         |
| exit 5                      | overlap with an in-flight run        | expected no-op; check journal for the active run                                 |
| exit 6                      | staging not tmpfs / wrong mode/owner | inspect `stat -f -c %T /run/url-shortener-backup`                                |
| exit 9                      | dump larger than bound               | investigate DB growth; raise `BACKUP_MAX_OBJECT_BYTES` deliberately              |
| exit 10/11                  | OCI upload or readback mismatch      | retry once; if persistent, check instance-principal policy + bucket reachability |
| exit 13                     | alert endpoint broken                | fix endpoint — reporting is part of the backup contract                          |
| no `last-success` update    | any of the above                     | alerts carry stage + exit code; state files carry `stage`                        |

Alertmanager may also monitor the age of `last-success` (AD-17 observability).

---

## 5. Monthly disposable restore procedure (DOCUMENTATION ONLY)

> **Not executed by URL-27.** Restore testing is documentation-only until the
> human approves this exact plan. Approved owner, cadence, and numeric
> RPO/RTO targets remain open (AD-17 follow-on #1); this drill **measures
> RTO** and records it for that decision.

**Never target the existing `url8-pg` container, its volume, or the live
`urlshortener`/`url8_acceptance` databases.** The drill uses a throwaway
container with **no network and no published ports**.

### Preconditions

1. Human approval of this exact plan (recorded in the ticket).
2. A verified backup object chosen from the bucket, e.g.
   `postgres/2026/11/03/20261103T143556Z-93f58719/` — download all four
   objects to a root-only tmpfs directory (mode 0600) and verify each
   SHA-256 against `manifest.json` before starting the clock.
3. `postgres:16-alpine` image available locally (same major version as
   `url8-pg` 16.x).
4. Note the start time — RTO is measured from drill start until the final
   data check passes.

### Steps (disposable, isolated)

```bash
set -euo pipefail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SCRATCH="url27-restore-scratch-${STAMP}"     # NEVER url8-pg — see guard below

# Guard: refuse to run if the name ever collides with the live container.
[ "$SCRATCH" != "url8-pg" ] || { echo "REFUSED: live container name"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$SCRATCH" && { echo "REFUSED: exists"; exit 1; }

# Disposable cluster: private user-defined network, NO published ports,
# --network none is used for the restore phase (docker exec/docker cp do not
# need networking). Anonymous scratch volume only — never url8-pg's volume.
docker volume create "${SCRATCH}-vol" >/dev/null
docker run -d --name "$SCRATCH" --network none \
  -e POSTGRES_USER=restore -e POSTGRES_PASSWORD=restore-only \
  -e POSTGRES_DB=scratch -v "${SCRATCH}-vol":/var/lib/postgresql/data \
  postgres:16-alpine

# wait for readiness (exec-based; no ports involved)
until docker exec "$SCRATCH" pg_isready -U restore -q; do sleep 1; done

# 1) globals first (roles) — SENSITIVE file, local only, delete after
docker cp ./globals.sql "$SCRATCH:/tmp/globals.sql"
docker exec "$SCRATCH" psql -v ON_ERROR_STOP=1 -U restore -d postgres -f /tmp/globals.sql
docker exec "$SCRATCH" rm -f /tmp/globals.sql

# 2) both databases
docker cp ./urlshortener.dump "$SCRATCH:/tmp/"
docker cp ./url8_acceptance.dump "$SCRATCH:/tmp/"
docker exec "$SCRATCH" pg_restore -U restore -d scratch --no-owner --no-privileges /tmp/urlshortener.dump
docker exec "$SCRATCH" pg_restore -U restore -d scratch --no-owner --no-privileges /tmp/url8_acceptance.dump

# 3) schema / basic data checks
docker exec "$SCRATCH" psql -U restore -d scratch -c "\dt"
docker exec "$SCRATCH" psql -U restore -d scratch -c \
  "SELECT (SELECT count(*) FROM users) AS users,
          (SELECT count(*) FROM links) AS links,
          (SELECT count(*) FROM click_event_dedup) AS dedup;"
# expect: the 15 URL-8 tables present; row counts >= the source's pre-drill
# counts for users/links; FK check clean:
docker exec "$SCRATCH" psql -U restore -d scratch -c \
  "SELECT conname FROM pg_constraint WHERE contype='f' AND NOT convalidated;"  # expect: 0 rows

# 4) measured RTO — record elapsed wall time in the drill notes
# 5) cleanup — remove ALL drill material, including the sensitive globals
docker rm -f "$SCRATCH"
docker volume rm "${SCRATCH}-vol"
rm -f ./globals.sql ./urlshortener.dump ./url8_acceptance.dump
unset STAMP SCRATCH
```

### Drill record (fill in per run)

| Field                                   | Value  |
| --------------------------------------- | ------ |
| Backup object (run id)                  |        |
| SHA-256 verified before restore         | yes/no |
| Globals restored                        | yes/no |
| `urlshortener` restored + row counts    |        |
| `url8_acceptance` restored + row counts |        |
| FK validation clean                     | yes/no |
| **Measured RTO** (start → final check)  |        |
| Defects/risks observed                  |        |
| Approver of this drill                  |        |

The live `url8-pg` container, its volume, the Docker networks, the host
firewall, OCI networking/buckets, and cloud IAM are **untouched** by this
procedure.

---

## 6. Retention (open — requires a delete grant)

Design §14.6 approves **7-day retention** on OCI Object Storage, but the
backup principal has **no delete grant** by instruction, so this
implementation **never prunes**. Old objects accumulate until an operator
either grants a scoped, lifecycle-policy-based retention rule (preferred —
set a bucket lifecycle rule, no principal delete grant needed) or approves a
deletion procedure. Retention pruning is therefore an explicit blocker, not
an oversight.

## 7. Remaining external configuration / blockers

| #   | Item                                                                                                                                                                                                                                | Owner     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Alert endpoint/recipient + protected secret-injection mechanism (§2) — gates timer enablement                                                                                                                                       | Human/ops |
| 2   | 7-day retention mechanism (bucket lifecycle rule vs delete grant)                                                                                                                                                                   | Human/ops |
| 3   | Dump encryption: design §14.6 requires encrypted dumps; encryption key management is open (AD-17 follow-on #1) and the verified manual flow uploaded unencrypted custom dumps — **needs a human ruling before encryption is added** | Human     |
| 4   | Least-privilege per-DB dump role + separate globals-export role (currently the `urlshortener` SUPERUSER)                                                                                                                            | Human     |
| 5   | Restore-test cadence/target/owner + numeric RPO/RTO targets                                                                                                                                                                         | Human     |
| 6   | Production installation/enablement approval naming the merged commit + Oracle VM target                                                                                                                                             | Human     |
