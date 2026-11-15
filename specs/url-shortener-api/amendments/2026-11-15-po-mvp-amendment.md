# Product Owner Amendment — MVP Demonstration Scope

**Status:** Approved Product Owner amendment, dated 2026-11-15  
**Specification owner:** Jim Halpert — Specification Agent  
**Base:** `origin/main` at `01962f8a25cd141d99c669cece4811b8a059ce0b`  
**Relationship to PRD:** This is a versioned amendment to the immutable approved `PRD.md` (dated 2026-10-08). It does not overwrite, reinterpret, or alter that historical document. The working requirements artifact records the amended active MVP scope while preserving superseded requirements and rationale here.

## 1. Product Owner decision

The MVP demonstration shall demonstrate specification-driven development, autonomous multi-agent orchestration, RAG/vector search, LLM integrations, evaluations, and a functional REST URL-shortener API. It shall be publicly deployed on the existing Oracle Cloud VM/infrastructure, reusing what exists and avoiding new infrastructure/resource creation and over-engineered scaling.

The active account scope is email/password registration and login, email verification, JWT authentication, and API keys for programmatic access. Google/GitHub social login is deferred. CAPTCHA and formal penetration testing are deferred. Basic rate limiting, input validation, password hashing, secret protection, ordinary security regression tests, independent code review, CI, post-merge QA, and Roy's exact release-artifact approval before deployment remain in scope.

No deployment, credential/secret operation, infrastructure change, Jira change, or application/architecture implementation is authorized by this amendment.

## 2. Requirement reconciliation

### Retained product requirements

- `FR-1.2`, `FR-1.3`, `AC-FR-1.2`, `AC-FR-1.3`: email verification before creation, JWT authentication, and API-key authentication remain active.
- `FR-2.1`–`FR-2.6`, `FR-3.1`–`FR-3.3`, `FR-4`–`FR-7`: link creation/management, ownership, redirects, privacy-preserving analytics, QR, and REST/error behavior remain active, subject to existing unresolved product questions.
- `FR-8.1`–`FR-8.2` and their acceptance criteria remain active as a minimal, testable abuse limit and `429` contract. The specific PostgreSQL weighted sliding-window architecture in design `D-10`/`AD-7` is not a product requirement in this amendment.
- `NFR-5` remains active for authentication, email verification, ownership, input validation, password hashing, secrets, and basic abuse limiting. CAPTCHA is expressly deferred below.
- The PR #19 encoded-path bypass fix and targeted regression tests remain required. No scope reduction or alternate raw-path interpretation is approved by this amendment.

### Superseded or deferred requirements

| Historical item | Amendment treatment | Rationale |
|---|---|---|
| `FR-1.1`, `AC-FR-1.1`, `AC-01` Google/GitHub branches | **Deferred, not deleted** | PO selected email/password only for the MVP demonstration. Social-login implementation and acceptance are future scope. |
| `FR-2.7`, `AC-FR-2.7`, `AC-11`, and CAPTCHA portions of `NFR-5` | **CAPTCHA deferred, not deleted** | PO selected basic rate limiting without CAPTCHA for this MVP. The requirement remains historical traceability and must not be reported as verified/passed. |
| `FR-8.1` implementation detail in design `D-10`/`AD-7` | **Design constraint relaxed** | Active requirement is bounded and testable rate limiting; implementation may be simple and reversible. Per-process limits may not provide multi-instance/global enforcement. A shared mechanism may be used only if already present and justified; no new infrastructure is implied. |
| PRD serverless/AWS platform text (`PRD.md:37`, `131-132`, `170`) and superseded AWS design decisions | **Superseded for active MVP target; preserved historically** | PO selected the existing Oracle Cloud VM/infrastructure. No AWS migration, deletion, or ticket-history rewrite is authorized. |
| Formal penetration testing / broad adversarial simulation | **Deferred, not deleted** | No reviewed PRD/spec/Jira/AGENTS artifact mandates a formal pentest or broad red-team exercise. Focused ordinary regression tests remain required, including PR #19's encoded-path cases. |

### New amendment requirements (stable amendment IDs)

- **PO-MVP-1 — Demonstration scope:** The demonstration shall provide evidence of SDD and autonomous multi-agent orchestration, RAG/vector search, LLM integrations, evaluations, and a functional REST URL-shortener API. No corpus, model/provider, evaluation threshold, or user flow is selected by this amendment.
- **PO-MVP-2 — Public target:** The demonstration shall use the existing Oracle Cloud VM/infrastructure and shall not require creation of new infrastructure/resources. The exact existing resource mapping and runtime behavior are architecture/inventory work, not invented here.
- **PO-MVP-3 — Active account/auth scope:** The MVP shall support email/password registration and login, email verification, JWT authentication, and API keys for programmatic access. Social login is not part of the active MVP acceptance path.
- **PO-MVP-4 — Security baseline:** The MVP shall retain access control/ownership, input validation, password hashing, secret protection, basic bounded rate limiting, and ordinary security regression tests. CAPTCHA and formal penetration testing are deferred and remain explicitly unexecuted until separately approved.
- **PO-MVP-5 — Release safeguards:** Independent code review, required CI, post-merge QA, and Roy's human approval bound to the actual immutable release artifact shall precede deployment. This does not authorize a new AWS pipeline or weaken repository exact-head gates.

## 3. Acceptance evidence

For `PO-MVP-1`, evidence shall identify the demonstration artifacts and executed checks for each named goal without asserting an unapproved corpus, provider, threshold, or flow. The exact artifact, commands, results, and limitations belong in the later QA/evidence report.

For `PO-MVP-2`, evidence shall identify the existing target mapping and show that no new infrastructure/resource was created or deployed as part of this amendment. Unknown inventory remains a blocker, not a pass.

For `PO-MVP-3` and `PO-MVP-4`, tests shall cover registration/login, verification gating, JWT/API-key authentication, ownership denial, malformed/invalid input, password-hash behavior, secret non-leakage, bounded rate-limit behavior, and the PR #19 encoded-path regression cases. CAPTCHA and formal pentesting shall be labeled deferred/unexecuted.

For `PO-MVP-5`, evidence shall show the exact reviewed commit, successful required CI, independent review, exact merged-main post-merge QA, Roy's approval bound to the same release artifact and target, and no deployment before that approval. Repository operating gates remain governed by `AGENTS.md`; this amendment does not modify them.

## 4. Jira scope/update plan — not executed

No Jira issue is changed by this PR. After specification and architecture review, Michael/Jim should update active scopes without altering completed history:

1. **URL-9 / URL-21 / URL-22:** retain completed/active email/password, JWT, API-key, and middleware work. Add a scope note that Google/GitHub social-login branches are deferred from the active MVP; do not remove completed implementation evidence.
2. **URL-10:** retain the minimal rate-limit contract and its tests; mark CAPTCHA production/live-vendor work deferred for the PO MVP. Preserve URL-10's completed limiter evidence and do not rewrite its historical acceptance.
3. **URL-25 (if active):** defer/close the live CAPTCHA adapter path only through a normal Jira decision transition; preserve its blocked/vendor history and do not claim AC-11 fully passed.
4. **URL-19:** AWS infrastructure scope is superseded for the active OCI target, but completed AWS design/code/evidence remains historical. Do not delete or rewrite the issue; add a superseded-for-active-MVP note only if Michael obtains the valid transition/update authority.
5. **URL-20:** AWS CI/CD scope is superseded for active deployment, while completed CI/release evidence remains preserved. Do not repurpose it as an OCI ticket. Any OCI-specific work requires a separate approved scope after architecture reconciliation.
6. **Adjacent active security/release tickets:** update only after the exact requirement IDs and acceptance evidence are reconciled. No ticket should claim CAPTCHA, social login, pentesting, or deployment success when deferred/unexecuted.

This plan intentionally distinguishes **superseded active scope** from **completed historical work**. It does not create tickets, transition issues, edit acceptance criteria, or alter Jira history.

## 5. Product-level ambiguities for Roy

- Which existing Oracle resource/container provides the public REST endpoint, and what exact public URL/HTTPS path is approved? No implementation detail is invented here.
- What existing mechanism, if any, provides a simple shared rate-limit state? If none exists, approve the documented per-process limitation for the single-instance demonstration or require a separate existing shared mechanism; do not create infrastructure implicitly.
- What exact RAG corpus, vector-search store, LLM provider/model, integration boundary, evaluation set, and evaluation thresholds will be used? These are intentionally not selected by this amendment and must be resolved before their acceptance evidence is finalized.
- What exact release target identifier binds Roy's approval to deployment? The artifact-binding rule remains required; the value is not invented here.

## 6. SDD hand-off boundary

This amendment updates requirements only. It does not alter `design.md`, implement code, create infrastructure, change Jira, deploy, or perform architecture reconciliation. Dwight's assigned session remains blocked by the prior provider `cyber_policy` result; no prompt, retry, restart, model/account switch, or alternate path was used. Architecture-dependent implementation and ticket updates stop pending reviewer access and architecture reconciliation.
