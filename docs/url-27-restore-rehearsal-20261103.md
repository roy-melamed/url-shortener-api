# URL-27 — Disposable restore rehearsal: operational evidence (sanitized)

**Scope statement:** this is a **restore rehearsal of the owner-verified
manual backup** (run `20261103T143556Z-93f58719`). It is **not post-merge
code QA** and must not be cited as QA evidence for any merged commit. Code QA
for this ticket is a separate, later milestone on the PR.

**Verdict: PASS**

| Field                                    | Value                                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup run rehearsed                     | `20261103T143556Z-93f58719` (manual backup, 2026-11-03)                                                                                                                                                    |
| Performed by                             | Pam (QA) — disposable scratch environment                                                                                                                                                                  |
| Outcome                                  | **PASS**                                                                                                                                                                                                   |
| Measured RTO (drill start → final check) | **71.62 s**                                                                                                                                                                                                |
| `urlshortener` restored                  | yes — 15 expected tables + `pgmigrations`                                                                                                                                                                  |
| `url8_acceptance` restored               | yes — 15 expected tables + `pgmigrations`                                                                                                                                                                  |
| Globals restored                         | yes (roles imported into the scratch cluster only)                                                                                                                                                         |
| Core row counts                          | users/links/idempotency_records/click_event_dedup spot counts **matched the source** at rehearsal time (exact figures kept in QA's session record; deliberately not duplicated in this sanitized artifact) |
| Isolation                                | scratch container only — no network, no published ports; the live `url8-pg` container, its volume, and the live databases were never targeted                                                              |
| Secrets in this report                   | none — no globals contents, password hashes, connection strings, or credentials are reproduced here                                                                                                        |

## What was verified

1. All four backup objects downloaded and SHA-256 verified against
   `manifest.json` before the drill started.
2. Globals imported into the disposable cluster (roles present; sensitive
   file deleted after use).
3. Both custom-format dumps restored completely.
4. Schema check: 15 expected application tables present in **each** database
   plus the `pgmigrations` bookkeeping table.
5. Core row-count spot checks matched the source database.
6. Full cleanup of drill material afterwards (container, volume, local files).

## What this does and does not prove

- **Proves:** the manual backup object set is recoverable end-to-end into an
  isolated PostgreSQL 16 environment within a ~72-second RTO, with schema and
  core data intact.
- **Does not prove:** anything about the automated backup script, systemd
  units, or any merged code — those are exercised by the mock-path unit tests
  (`tests/backup/`) and the CI gates, and will be QA'd on the merged SHA in
  the normal flow.
- The monthly recurring restore procedure remains documentation-only until
  the human approves the exact plan and cadence (runbook §5).

## Evidence hygiene

Sanitized operational record: run identifier, verdict, timing, table/row-count
outcomes, and isolation facts only. The sensitive `globals.sql` contents,
password hashes, connection strings, and credentials are intentionally
excluded (runbook §3).
