# URL-27 — Disposable restore rehearsal: operational evidence (sanitized)

**Scope statement:** this is a **restore rehearsal of the owner-verified
manual backup** (run `20261103T143556Z-93f58719`). It is **not post-merge
code QA** and must not be cited as QA evidence for any merged commit. Code QA
for this ticket is a separate, later milestone on the PR.

**Verdict: PASS**

| Field                                    | Value                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup run rehearsed                     | `20261103T143556Z-93f58719` (manual backup, 2026-11-03)                                                                                       |
| Performed by                             | Pam (QA) — disposable scratch environment                                                                                                     |
| Outcome                                  | **PASS**                                                                                                                                      |
| Measured RTO (drill start → final check) | **71.62 s**                                                                                                                                   |
| `urlshortener` restored                  | yes — 15 expected tables + `pgmigrations`                                                                                                     |
| `url8_acceptance` restored               | yes — 15 expected tables + `pgmigrations`                                                                                                     |
| Globals restored                         | yes (roles imported into the scratch cluster only)                                                                                            |
| Observed restored row counts             | `urlshortener` users/links/click_event_dedup = **0/0/0**; `url8_acceptance` users/links/click_event_dedup = **1/1/0** — observed values only  |
| Source row-count baseline                | **none** — no backup-time or live-source row-count baseline was captured, and **no source comparison was performed**                          |
| `SELECT 1`                               | succeeded in both restored databases                                                                                                          |
| Isolation                                | scratch container only — no network, no published ports; the live `url8-pg` container, its volume, and the live databases were never targeted |
| Secrets in this report                   | none — no globals contents, password hashes, connection strings, or credentials are reproduced here                                           |

## What was verified

1. All four backup objects downloaded and SHA-256 verified against
   `manifest.json` before the drill started.
2. Globals imported into the disposable cluster (roles present; sensitive
   file deleted after use).
3. Both custom-format dumps restored completely, each into its newly created
   database.
4. Schema check: 15 expected application tables present in **each** database
   plus the `pgmigrations` bookkeeping table.
5. `SELECT 1` succeeded in both restored databases; row counts were
   **recorded exactly as observed** (`urlshortener` 0/0/0,
   `url8_acceptance` 1/1/0 for users/links/click_event_dedup). **No source
   row-count baseline or comparison was made** — these figures show what the
   restore contains, not parity with a source snapshot.
6. Full cleanup of drill material afterwards (uniquely named container and
   its temp directory).

## What this does and does not prove

- **Proves:** the manual backup object set is recoverable end-to-end into an
  isolated PostgreSQL 16 environment within a ~72-second RTO, with schema and
  observed data present.
- **Does not prove:** row-count parity with any source (no baseline existed
  to compare against); anything about the automated backup script, systemd
  units, or any merged code — those are exercised by the mock-path unit tests
  (`tests/backup/`) and the CI gates, and will be QA'd on the merged SHA in
  the normal flow.
- The monthly restore runbook is documented as the owner requested, but **no
  restore timer is created**; the recurring owner/schedule stays unassigned
  (runbook §5).

## Evidence hygiene

Sanitized operational record: run identifier, verdict, timing, table/row-count
outcomes, and isolation facts only. The sensitive `globals.sql` contents,
password hashes, connection strings, and credentials are intentionally
excluded (runbook §3).
